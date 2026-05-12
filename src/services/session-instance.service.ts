/**
 * SessionInstanceService
 *
 * Manages multiple independent OpenCode sessions per agent.
 * Each session has its own SSE stream, heartbeat, and pending prompt.
 * This allows parallel processing across different sessions.
 */

import type { PersistentAgent } from "./agent-db.service.js";
import type { AgentDbService } from "./agent-db.service.js";
import { resolveDir } from "./persistent-agent.service.js";

export interface AgentSendResult {
    output: string;
    sessionId?: string;
}

/** A queued prompt waiting to be sent once the session becomes idle */
export interface QueuedPrompt {
    prompt: string;
    /** Called with the result when the queued prompt finishes executing */
    onResult: (result: AgentSendResult) => Promise<void>;
    /** Called when the queued prompt starts executing (before sendPrompt) */
    onDequeue?: () => Promise<void>;
}

/** Callback when a session has a pending question for the user */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OnQuestionCallback = (sessionId: string, agentId: string, req: any) => Promise<void>;

/** Callback when the model/session reports an error */
export type OnSessionErrorCallback = (sessionId: string, agentId: string, errorMessage: string) => Promise<void>;

/** Summary sent on each heartbeat tick */
export interface HeartbeatSummary {
    sessionId: string;
    agentId: string;
    minutesRunning: number;
    lastToolName: string;
    lastText: string;
    messageCount: number;
    filesModified: number;
    isNearTimeout?: boolean;
    recentFiles: string[];
    lastBashCmd: string;
    streamConnected?: boolean;
    secondsSinceLastEvent?: number;
    sessionStatus?: "busy" | "retry" | "idle";
}

/** Callback on each heartbeat tick (only while a prompt is in-flight) */
export type OnHeartbeatCallback = (summary: HeartbeatSummary) => Promise<void>;

/** Callback to clear the heartbeat message when a prompt completes */
export type OnHeartbeatClearCallback = (sessionId: string, agentId: string) => Promise<void>;

/** Called when a session.idle arrives for a session not initiated via Telegram */
export type OnExternalSessionIdleCallback = (
    sessionId: string,
    agentId: string,
    output: string,
) => Promise<void>;

/** Called when the bot reconnects and finds a busy session */
export type OnAdoptSessionCallback = (
    sessionId: string,
    agentId: string,
    userId: number,
) => Promise<{ chatId: number; msgId: number } | null>;

/** Called when an adopted session resolves */
export type OnAdoptSessionResultCallback = (
    sessionId: string,
    agentId: string,
    chatId: number,
    msgId: number,
    result: AgentSendResult,
) => Promise<void>;

/** Called when a persisted heartbeat cannot be recovered */
export type OnLostPromptCallback = (
    sessionId: string,
    agentId: string,
    chatId: number,
    msgId: number,
) => Promise<void>;

/** Lookup for persisted heartbeat placeholders */
export type HeartbeatLookup = (
    sessionId: string,
) => { chatId: number; msgId: number } | undefined;

/** Represents a single independent OpenCode session */
interface SessionInstance {
    sessionId: string;
    agentId: string;
    agent: PersistentAgent;
    status: "idle" | "busy" | "retry";
    sseController?: AbortController;
    pendingPrompt?: PendingPrompt;
    heartbeatTimer?: NodeJS.Timeout;
    lastSseEventAt: number;
    createdAt: number;
    promptQueue: QueuedPrompt[];
    activeChildSessions: Set<string>;
}

interface PendingPrompt {
    sessionId: string;
    resolve: (result: AgentSendResult) => void;
    reject: (err: Error) => void;
    startedAt: number;
}

/** Heartbeat interval while a prompt is in-flight */
const HEARTBEAT_INTERVAL_MS = 20 * 1000;

/** File-modifying tool names */
const FILE_WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

export class SessionInstanceService {
    /** Map of sessionId → SessionInstance */
    private sessions: Map<string, SessionInstance> = new Map();

    /** Map of agentId → Set of sessionIds for that agent */
    private agentSessions: Map<string, Set<string>> = new Map();

    /** Callbacks */
    private onQuestion?: OnQuestionCallback;
    private onSessionError?: OnSessionErrorCallback;
    private onHeartbeat?: OnHeartbeatCallback;
    private onHeartbeatClear?: OnHeartbeatClearCallback;
    private onExternalSessionIdle?: OnExternalSessionIdleCallback;
    private onAdoptSession?: OnAdoptSessionCallback;
    private onAdoptSessionResult?: OnAdoptSessionResultCallback;
    private onLostPrompt?: OnLostPromptCallback;
    private heartbeatLookup?: HeartbeatLookup;

    /** Set of question IDs already forwarded (deduplication) */
    private forwardedQuestionIds: Set<string> = new Set();

    constructor(private readonly agentDb: AgentDbService) {}

    // ─── Callback registration ───────────────────────────────────────────────

    setOnQuestionCallback(cb: OnQuestionCallback): void {
        this.onQuestion = cb;
    }

    setOnSessionErrorCallback(cb: OnSessionErrorCallback): void {
        this.onSessionError = cb;
    }

    setOnHeartbeatCallback(cb: OnHeartbeatCallback): void {
        this.onHeartbeat = cb;
    }

    setOnHeartbeatClearCallback(cb: OnHeartbeatClearCallback): void {
        this.onHeartbeatClear = cb;
    }

    setOnExternalSessionIdleCallback(cb: OnExternalSessionIdleCallback): void {
        this.onExternalSessionIdle = cb;
    }

    setOnAdoptSessionCallback(cb: OnAdoptSessionCallback): void {
        this.onAdoptSession = cb;
    }

    setOnAdoptSessionResultCallback(cb: OnAdoptSessionResultCallback): void {
        this.onAdoptSessionResult = cb;
    }

    setOnLostPromptCallback(cb: OnLostPromptCallback): void {
        this.onLostPrompt = cb;
    }

    setHeartbeatLookup(lookup: HeartbeatLookup): void {
        this.heartbeatLookup = lookup;
    }

    // ─── Session lifecycle ───────────────────────────────────────────────────

    /**
     * Create a new independent session for an agent.
     * Returns the new session ID.
     */
    async createSession(agent: PersistentAgent): Promise<string> {
        const host = agent.host || "localhost";
        const baseUrl = `http://${host}:${agent.port}`;
        const workdir = resolveDir(agent.workdir);

        console.log(`[SessionInstance.createSession] Creating session for agent "${agent.name}" at ${baseUrl}`);

        let modelConfig: { id: string; providerID: string; modelID: string } | undefined;
        if (agent.model) {
            const parts = agent.model.split("/");
            if (parts.length === 2) {
                modelConfig = { id: agent.model, providerID: parts[0], modelID: parts[1] };
                console.log(`[SessionInstance.createSession] Using model: ${modelConfig.id}`);
            }
        }

        const createRes = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(workdir)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: "",
                system: agent.role || undefined,
                model: modelConfig,
                permission: [
                    { permission: "command", pattern: "*", action: "allow" },
                    { permission: "file", pattern: "*", action: "allow" },
                    { permission: "network", pattern: "*", action: "allow" },
                    { permission: "browser", pattern: "*", action: "allow" },
                ],
            }),
            signal: AbortSignal.timeout(10000),
        });

        console.log(`[SessionInstance.createSession] Session creation response status: ${createRes.status}`);

        if (!createRes.ok) {
            const errorText = await createRes.text().catch(() => "N/A");
            console.error(`[SessionInstance.createSession] Session creation failed: ${createRes.status} - ${errorText}`);
            throw new Error(`Create session failed: ${createRes.status} ${errorText}`);
        }

        const sess = await createRes.json() as any;
        const sessionId = sess.id as string;
        console.log(`[SessionInstance.createSession] Session created with ID: ${sessionId}`);

        // Create and store the session instance
        const instance: SessionInstance = {
            sessionId,
            agentId: agent.id,
            agent,
            status: "idle",
            lastSseEventAt: Date.now(),
            createdAt: Date.now(),
            promptQueue: [],
            activeChildSessions: new Set(),
        };

        this.sessions.set(sessionId, instance);

        // Track this session under its agent
        const agentSessionSet = this.agentSessions.get(agent.id) ?? new Set();
        agentSessionSet.add(sessionId);
        this.agentSessions.set(agent.id, agentSessionSet);

        // Start SSE stream for this session
        this.startSseStream(instance);

        return sessionId;
    }

    /**
     * Delete a session and clean up resources.
     */
    async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        console.log(`[SessionInstance.deleteSession] Deleting session "${sessionId}"`);

        // Stop SSE stream
        this.stopSseStream(sessionId);

        // Cancel any pending prompt
        const pending = session.pendingPrompt;
        if (pending) {
            session.pendingPrompt = undefined;
            pending.resolve({ output: "❌ Sesión eliminada.", sessionId });
        }

        // Clear queue
        session.promptQueue = [];

        // Remove from agent's session set
        const agentSessionSet = this.agentSessions.get(session.agentId);
        if (agentSessionSet) {
            agentSessionSet.delete(sessionId);
            if (agentSessionSet.size === 0) {
                this.agentSessions.delete(session.agentId);
            }
        }

        // Remove from sessions map
        this.sessions.delete(sessionId);

        // Try to delete on opencode server (best effort)
        try {
            const host = session.agent.host || "localhost";
            await fetch(`http://${host}:${session.agent.port}/session/${sessionId}`, {
                method: "DELETE",
                signal: AbortSignal.timeout(5000),
            });
        } catch {
            // Ignore errors
        }
    }

    /**
     * Get an existing session or create a new one if needed.
     */
    async ensureSession(agent: PersistentAgent, sessionId?: string): Promise<string> {
        if (sessionId) {
            const existing = this.sessions.get(sessionId);
            if (existing && existing.agentId === agent.id) {
                // Verify session is still valid on server
                try {
                    const host = agent.host || "localhost";
                    const res = await fetch(`http://${host}:${agent.port}/session/${sessionId}`, {
                        signal: AbortSignal.timeout(5000),
                    });
                    if (res.ok) {
                        return sessionId;
                    }
                } catch {
                    // Session is gone, will create new
                }
            }
        }

        // Create new session
        return await this.createSession(agent);
    }

    // ─── SSE stream per session ────────────────────────────────────────────────

    private startSseStream(session: SessionInstance): void {
        if (session.sseController) {
            console.log(`[SessionInstance.startSseStream] SSE stream already running for session "${session.sessionId}"`);
            return;
        }

        console.log(`[SessionInstance.startSseStream] Starting SSE stream for session "${session.sessionId}"`);
        const abort = new AbortController();
        session.sseController = abort;
        session.lastSseEventAt = Date.now();

        this.runSseLoop(session, abort).catch(err =>
            console.error(`[SessionInstance] SSE loop error for session ${session.sessionId}:`, err)
        );
    }

    private stopSseStream(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session || !session.sseController) return;

        session.sseController.abort();
        session.sseController = undefined;
        this.stopHeartbeat(sessionId);
        session.status = "idle";
    }

    private async runSseLoop(session: SessionInstance, abort: AbortController): Promise<void> {
        const agent = session.agent;
        const host = agent.host || "localhost";
        const baseUrl = `http://${host}:${agent.port}`;
        const workdir = resolveDir(agent.workdir);

        await this.recoverPendingQuestions(session);
        await this.recoverPendingPrompt(session);

        let reconnectDelay = 1000;
        while (!abort.signal.aborted) {
            try {
                const response = await fetch(`${baseUrl}/global/event`, {
                    signal: abort.signal,
                    headers: { Accept: "text/event-stream" },
                });
                if (!response.ok || !response.body) {
                    throw new Error(`SSE connect failed: ${response.status}`);
                }

                const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
                let buffer = "";
                const abortHandler = () => { try { reader.cancel(); } catch {} };
                abort.signal.addEventListener("abort", abortHandler);

                try {
                    while (!abort.signal.aborted) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += value;
                        const chunks = buffer.split("\n\n");
                        buffer = chunks.pop() ?? "";
                        for (const chunk of chunks) {
                            const dataLine = chunk.split("\n").find(l => l.startsWith("data:"));
                            if (!dataLine) continue;
                            let parsed: any;
                            try { parsed = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

                            // Filter by directory AND session ID
                            if (parsed.directory && parsed.directory !== workdir) continue;

                            const event = parsed.payload ?? parsed;
                            if (!event) continue;

                            if (abort.signal.aborted) break;
                            session.lastSseEventAt = Date.now();

                            const type = event.type as string;
                            const props = event.properties;

                            // Log all events for debugging
                            console.log(`[SessionInstance.SSE] Event received: type="${type}", session="${session.sessionId}"`);

                            // Filter events by session ID for this specific session
                            const eventSessionId = props?.sessionID ?? "";
                            
                            // Handle events that don't have sessionID (global events)
                            if (type === "server.connected" || type === "server.heartbeat") {
                                console.log(`[SessionInstance.SSE] Skipping ${type} event`);
                                this.recoverPendingQuestions(session).catch(() => {});
                                this.recoverPendingPrompt(session).catch(() => {});
                                continue;
                            }

                            // Check if this event belongs to this session or its children
                            const isTargetSession = !eventSessionId || eventSessionId === session.sessionId;
                            const isChildSession = session.activeChildSessions.has(eventSessionId);
                            
                            if (!isTargetSession && !isChildSession) {
                                // Event belongs to a different session, skip it
                                continue;
                            }

                            if (type === "session.status") {
                                const statusType = props?.status?.type;
                                if (statusType === "busy" || statusType === "retry" || statusType === "idle") {
                                    session.status = statusType as "busy" | "retry" | "idle";
                                    console.log(`[SessionInstance.SSE] session.status: status="${statusType}", session="${session.sessionId}"`);
                                }
                            }

                            // Question asked
                            if (type === "question.asked" && this.onQuestion) {
                                const questionId: string = props?.id ?? "";
                                console.log(`[SessionInstance] question.asked for session "${session.sessionId}": ${questionId}`);
                                if (!questionId || !this.forwardedQuestionIds.has(questionId)) {
                                    if (questionId) this.forwardedQuestionIds.add(questionId);
                                    this.onQuestion(session.sessionId, agent.id, props).catch(err =>
                                        console.error(`[SessionInstance] onQuestion callback error:`, err)
                                    );
                                }
                            }

                            // Session error
                            if (type === "session.error") {
                                let errorMessage = "Error desconocido del modelo";
                                if (props?.error) {
                                    const err = props.error;
                                    errorMessage = err.data?.message ?? err.message ?? String(err);
                                }
                                console.error(`[SessionInstance] session.error for session "${session.sessionId}": ${errorMessage}`);

                                if (isTargetSession || isChildSession) {
                                    const pending = session.pendingPrompt;
                                    if (pending && (isTargetSession || !eventSessionId || eventSessionId === session.sessionId)) {
                                        this.stopHeartbeat(session.sessionId);
                                        session.pendingPrompt = undefined;
                                        pending.resolve({
                                            output: `❌ Error del modelo: ${errorMessage}`,
                                            sessionId: session.sessionId,
                                        });
                                    }
                                }

                                if (this.onSessionError) {
                                    this.onSessionError(session.sessionId, agent.id, errorMessage).catch(err =>
                                        console.error(`[SessionInstance] onSessionError callback error:`, err)
                                    );
                                }
                            }

                            // Session created (track child sessions)
                            if (type === "session.created") {
                                const createdId: string = props?.sessionID ?? props?.info?.id ?? "";
                                const parentId: string = props?.info?.parentID ?? "";
                                if (createdId && parentId === session.sessionId) {
                                    session.activeChildSessions.add(createdId);
                                    console.log(`[SessionInstance] session.created: child "${createdId}" tracked for session "${session.sessionId}", active children: ${session.activeChildSessions.size}`);
                                }
                            }

                            // Session deleted
                            if (type === "session.deleted") {
                                const deletedId: string = props?.sessionID ?? props?.info?.id ?? "";
                                if (deletedId === session.sessionId) {
                                    console.log(`[SessionInstance] session.deleted: session "${deletedId}" was deleted`);
                                    session.status = "idle";
                                }
                                session.activeChildSessions.delete(deletedId);
                            }

                            // Session idle - resolve pending prompt
                            if (type === "session.idle") {
                                const idleSessionId: string = props?.sessionID ?? "";
                                console.log(`[SessionInstance] session.idle event: session="${idleSessionId}", target="${session.sessionId}", isTarget=${isTargetSession}, isChild=${isChildSession}`);

                                if (isTargetSession) {
                                    // Clear all tracked children
                                    session.activeChildSessions.clear();
                                    if (session.pendingPrompt) {
                                        console.log(`[SessionInstance] session.idle for main session "${session.sessionId}" — resolving prompt`);
                                        await this.resolvePromptFromIdle(session);
                                    } else {
                                        // External session (web/CLI)
                                        console.log(`[SessionInstance] session.idle: no pending prompt — external session`);
                                        this.notifyExternalSessionIdle(session).catch(err =>
                                            console.error(`[SessionInstance] notifyExternalSessionIdle error:`, err)
                                        );
                                    }
                                } else if (isChildSession) {
                                    session.activeChildSessions.delete(idleSessionId);
                                    console.log(`[SessionInstance] session.idle: child "${idleSessionId}" finished. Remaining: ${session.activeChildSessions.size}`);
                                    if (session.activeChildSessions.size === 0 && session.pendingPrompt) {
                                        await this.checkParentAndResolve(session);
                                    }
                                }
                            }
                        }
                    }
                } finally {
                    abort.signal.removeEventListener("abort", abortHandler);
                    reader.releaseLock();
                }

                if (!abort.signal.aborted) {
                    console.log(`[SessionInstance] SSE stream closed normally for session "${session.sessionId}" — reconnecting in ${reconnectDelay}ms`);
                    await new Promise(r => setTimeout(r, reconnectDelay));
                    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
                }
            } catch (err) {
                if (abort.signal.aborted) break;
                console.error(`[SessionInstance] SSE loop error for session "${session.sessionId}":`, err);
                await new Promise(r => setTimeout(r, reconnectDelay));
                reconnectDelay = Math.min(reconnectDelay * 2, 10000);
            }
        }

        console.log(`[SessionInstance] SSE loop ended for session "${session.sessionId}"`);
    }

    // ─── Prompt sending ───────────────────────────────────────────────────────

    /**
     * Send a prompt to a specific session.
     * Each session operates independently with its own SSE and heartbeat.
     */
    async sendPrompt(sessionId: string, userText: string): Promise<AgentSendResult> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { output: "❌ Session not found", sessionId };
        }

        const agent = session.agent;
        const host = agent.host || "localhost";
        const baseUrl = `http://${host}:${agent.port}`;

        // Check if session is busy
        if (session.status === "busy" || session.pendingPrompt) {
            return { output: "❌ Session is busy. Wait for current task to complete or use a different session.", sessionId };
        }

        let modelConfig: { id: string; providerID: string; modelID: string } | undefined;
        if (agent.model) {
            const parts = agent.model.split("/");
            if (parts.length === 2) {
                modelConfig = { id: agent.model, providerID: parts[0], modelID: parts[1] };
            }
        }

        const requestBody: any = {
            parts: [{ type: "text", text: userText }],
            agent: "build",
        };
        if (modelConfig) {
            requestBody.model = modelConfig;
        }

        console.log(`[SessionInstance] sendPrompt → session="${sessionId}" text="${userText.slice(0, 80)}${userText.length > 80 ? "…" : ""}"`);

        const result = await new Promise<AgentSendResult>((resolve, reject) => {
            // No timeout - the user can cancel with /cancel when they want
            session.pendingPrompt = {
                sessionId,
                resolve,
                reject,
                startedAt: Date.now(),
            };

            fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(10000),
            }).then(res => {
                if (!res.ok) {
                    session.pendingPrompt = undefined;
                    this.stopHeartbeat(sessionId);
                    console.error(`[SessionInstance] prompt_async HTTP error ${res.status} for session "${sessionId}"`);
                    resolve({ output: `❌ Failed to send prompt: HTTP ${res.status}`, sessionId });
                } else {
                    console.log(`[SessionInstance] prompt accepted for session "${sessionId}", starting heartbeat`);
                    session.status = "busy";
                    this.startHeartbeat(session);
                }
            }).catch(err => {
                session.pendingPrompt = undefined;
                this.stopHeartbeat(sessionId);
                console.error(`[SessionInstance] prompt_async fetch error for session "${sessionId}":`, err);
                resolve({ output: `❌ Failed to send prompt: ${err}`, sessionId });
            });
        });

        return result;
    }

    /**
     * Enqueue a prompt for a session (will be processed when current task completes).
     */
    enqueue(sessionId: string, item: QueuedPrompt): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.promptQueue.push(item);
    }

    /**
     * Get queue length for a session.
     */
    queueLength(sessionId: string): number {
        const session = this.sessions.get(sessionId);
        return session?.promptQueue.length ?? 0;
    }

    /**
     * Cancel the pending prompt for a session.
     */
    cancelPendingPrompt(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return Promise.resolve();

        const pending = session.pendingPrompt;
        let abortPromise: Promise<void> = Promise.resolve();

        if (pending) {
            session.pendingPrompt = undefined;
            this.stopHeartbeat(sessionId);

            const agent = session.agent;
            if (pending.sessionId) {
                const host = agent.host || "localhost";
                const url = `http://${host}:${agent.port}/session/${pending.sessionId}/abort`;
                abortPromise = fetch(url, {
                    method: "POST",
                    signal: AbortSignal.timeout(5000),
                }).catch(() => {});
            }

            pending.resolve({ output: "❌ Cancelado por el usuario.", sessionId });
        }

        session.promptQueue = [];
        session.activeChildSessions.clear();
        session.status = "idle";

        return abortPromise;
    }

    /**
     * Check if a session is busy.
     */
    isBusy(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        return session ? session.status === "busy" || !!session.pendingPrompt : false;
    }

    /**
     * Get session status.
     */
    getSessionStatus(sessionId: string): "idle" | "busy" | "retry" | undefined {
        const session = this.sessions.get(sessionId);
        return session?.status;
    }

    // ─── Session queries ─────────────────────────────────────────────────────

    /**
     * Get all sessions for an agent.
     */
    getAgentSessions(agentId: string): SessionInstance[] {
        const sessionIds = this.agentSessions.get(agentId);
        if (!sessionIds) return [];
        return Array.from(sessionIds).map(id => this.sessions.get(id)!).filter(Boolean);
    }

    /**
     * Get all active sessions.
     */
    getAllSessions(): SessionInstance[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Get a specific session.
     */
    getSession(sessionId: string): SessionInstance | undefined {
        return this.sessions.get(sessionId);
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private async resolvePromptFromIdle(session: SessionInstance): Promise<void> {
        const pending = session.pendingPrompt;
        if (!pending) return;

        console.log(`[SessionInstance.resolvePromptFromIdle] Resolving prompt for session "${session.sessionId}"`);

        this.stopHeartbeat(session.sessionId);
        session.pendingPrompt = undefined;
        session.activeChildSessions.clear();
        session.status = "idle";

        try {
            const agent = session.agent;
            const host = agent.host || "localhost";
            const msgRes = await fetch(
                `http://${host}:${agent.port}/session/${session.sessionId}/message`,
                { signal: AbortSignal.timeout(10000) }
            );

            if (!msgRes.ok) {
                pending.resolve({ output: `❌ Error al leer mensajes: HTTP ${msgRes.status}`, sessionId: session.sessionId });
                return;
            }

            const messages: any[] = await msgRes.json();
            const lastAssistant = [...messages]
                .reverse()
                .find((m: any) => m.role === "assistant" || m.info?.role === "assistant");

            if (!lastAssistant) {
                pending.resolve({ output: "⚠️ Sin respuesta del asistente", sessionId: session.sessionId });
                return;
            }

            const parts: any[] = lastAssistant.parts || [];
            const text = parts
                .filter((p: any) => p.type === "text" && p.text)
                .map((p: any) => p.text as string)
                .join("");

            const trimmed = text.trim();
            if (!trimmed) {
                const hasTools = parts.some((p: any) => p.type === "tool-invocation");
                if (hasTools) {
                    pending.resolve({ output: "✅ Completado (ejecutó herramientas pero no generó texto)", sessionId: session.sessionId });
                } else {
                    pending.resolve({ output: "⚠️ Sin salida (ejecución vacía)", sessionId: session.sessionId });
                }
            } else {
                pending.resolve({ output: trimmed, sessionId: session.sessionId });
            }
        } catch (err) {
            console.error(`[SessionInstance.resolvePromptFromIdle] Error:`, err);
            pending.resolve({ output: `❌ Error al leer respuesta: ${err}`, sessionId: session.sessionId });
        }

        // Drain queue
        this.drainQueue(session).catch(err =>
            console.error(`[SessionInstance] drainQueue error for session "${session.sessionId}":`, err)
        );
    }

    private async notifyExternalSessionIdle(session: SessionInstance): Promise<void> {
        if (!this.onExternalSessionIdle) return;

        try {
            const agent = session.agent;
            const host = agent.host || "localhost";
            const msgRes = await fetch(
                `http://${host}:${agent.port}/session/${session.sessionId}/message`,
                { signal: AbortSignal.timeout(10000) }
            );

            if (!msgRes.ok) return;

            const messages: any[] = await msgRes.json();
            const lastAssistant = [...messages]
                .reverse()
                .find((m: any) => m.role === "assistant" || m.info?.role === "assistant");

            if (!lastAssistant) return;

            const parts: any[] = lastAssistant.parts || [];
            const text = parts
                .filter((p: any) => p.type === "text" && p.text)
                .map((p: any) => p.text as string)
                .join("")
                .trim();

            if (!text) return;

            await this.onExternalSessionIdle(session.sessionId, agent.id, text);
        } catch (err) {
            console.error(`[SessionInstance.notifyExternalSessionIdle] ERROR:`, err);
        }
    }

    private async checkParentAndResolve(session: SessionInstance): Promise<void> {
        try {
            const agent = session.agent;
            const host = agent.host || "localhost";
            const res = await fetch(
                `http://${host}:${agent.port}/session/${session.sessionId}`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (!res.ok) return;

            const sess: any = await res.json();
            const status: string = sess?.status ?? sess?.info?.status ?? "";

            if (status === "idle") {
                await this.resolvePromptFromIdle(session);
            }
        } catch (err) {
            console.debug(`[SessionInstance] checkParentAndResolve error: ${err}`);
        }
    }

    private async recoverPendingQuestions(session: SessionInstance): Promise<void> {
        if (!this.onQuestion) return;

        try {
            const agent = session.agent;
            const host = agent.host || "localhost";
            const workdir = resolveDir(agent.workdir);
            const url = `http://${host}:${agent.port}/question?directory=${encodeURIComponent(workdir)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return;

            const questions: any[] = await res.json();
            if (!Array.isArray(questions) || questions.length === 0) return;

            for (const q of questions) {
                const questionId: string = q.id ?? "";
                if (questionId && this.forwardedQuestionIds.has(questionId)) continue;
                if (questionId) this.forwardedQuestionIds.add(questionId);
                this.onQuestion(session.sessionId, agent.id, q).catch(err =>
                    console.error(`[SessionInstance] recoverPendingQuestions callback error:`, err)
                );
            }
        } catch (err) {
            console.debug(`[SessionInstance] recoverPendingQuestions: ${err}`);
        }
    }

    private async recoverPendingPrompt(session: SessionInstance): Promise<void> {
        const existing = session.pendingPrompt;

        if (!existing) {
            // Check if session is busy on server (adoption scenario)
            try {
                const agent = session.agent;
                const host = agent.host || "localhost";
                const res = await fetch(
                    `http://${host}:${agent.port}/session/${session.sessionId}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (!res.ok) return;

                const sess: any = await res.json();
                const status: string = sess?.status ?? sess?.info?.status ?? "";

                if (status === "busy") {
                    await this.adoptBusySession(session);
                }
            } catch (err) {
                console.debug(`[SessionInstance] recoverPendingPrompt: ${err}`);
            }
            return;
        }

        // Check if session is already idle
        try {
            const agent = session.agent;
            const host = agent.host || "localhost";
            const res = await fetch(
                `http://${host}:${agent.port}/session/${session.sessionId}`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (!res.ok) return;

            const sess: any = await res.json();
            const status: string = sess?.status ?? sess?.info?.status ?? "";

            if (status === "idle") {
                await this.resolvePromptFromIdle(session);
            }
        } catch (err) {
            console.debug(`[SessionInstance] recoverPendingPrompt check: ${err}`);
        }
    }

    private async adoptBusySession(session: SessionInstance): Promise<void> {
        if (session.pendingPrompt) return;

        console.log(`[SessionInstance] adoptBusySession: adopting busy session "${session.sessionId}"`);

        let adoptedChatId: number | undefined;
        let adoptedMsgId: number | undefined;

        if (this.onAdoptSession) {
            try {
                const result = await this.onAdoptSession(session.sessionId, session.agent.id, session.agent.userId);
                if (result) {
                    adoptedChatId = result.chatId;
                    adoptedMsgId = result.msgId;
                }
            } catch (err) {
                console.error(`[SessionInstance] onAdoptSession callback error:`, err);
            }
        }

        const promise = new Promise<AgentSendResult>((resolve, reject) => {
            session.pendingPrompt = {
                sessionId: session.sessionId,
                resolve,
                reject,
                startedAt: Date.now(),
            };
        });

        this.startHeartbeat(session);

        promise.then(async (result) => {
            if (adoptedChatId !== undefined && adoptedMsgId !== undefined && this.onAdoptSessionResult) {
                await this.onAdoptSessionResult(session.sessionId, session.agent.id, adoptedChatId, adoptedMsgId, result).catch((err: unknown) =>
                    console.error(`[SessionInstance] onAdoptSessionResult error:`, err)
                );
            }
        }).catch((err: unknown) => {
            console.error(`[SessionInstance] adoptBusySession promise rejected:`, err);
        });
    }

    private async drainQueue(session: SessionInstance): Promise<void> {
        if (session.promptQueue.length === 0) return;

        const next = session.promptQueue.shift()!;

        await new Promise(r => setTimeout(r, 3000));

        if (next.onDequeue) {
            await next.onDequeue().catch(err =>
                console.error(`[SessionInstance] onDequeue callback error:`, err)
            );
        }

        const result = await this.sendPrompt(session.sessionId, next.prompt);
        next.onResult(result).catch(err =>
            console.error(`[SessionInstance] Queue onResult callback error:`, err)
        );
    }

    // ─── Heartbeat ────────────────────────────────────────────────────────────

    private startHeartbeat(session: SessionInstance): void {
        if (session.heartbeatTimer) return;

        const timer = setInterval(async () => {
            await this.fireHeartbeat(session);
        }, HEARTBEAT_INTERVAL_MS);

        if (timer.unref) timer.unref();
        session.heartbeatTimer = timer;
    }

    private stopHeartbeat(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session || !session.heartbeatTimer) return;

        clearInterval(session.heartbeatTimer);
        session.heartbeatTimer = undefined;
    }

    private async fireHeartbeat(session: SessionInstance): Promise<void> {
        if (!this.onHeartbeat) return;
        if (!session.pendingPrompt) {
            this.stopHeartbeat(session.sessionId);
            return;
        }

        // Watchdog: check if session is idle
        try {
            const agent = session.agent;
            const host = agent.host || "localhost";
            const statusRes = await fetch(
                `http://${host}:${agent.port}/session/${session.sessionId}`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (statusRes.ok) {
                const sess: any = await statusRes.json();
                const status = sess?.status ?? sess?.info?.status;

                if (status) {
                    session.status = status as "idle" | "busy" | "retry";
                }

                if (status === "idle" && session.activeChildSessions.size === 0) {
                    await this.resolvePromptFromIdle(session);
                    return;
                }
            }
        } catch (err) {
            console.log(`[SessionInstance] fireHeartbeat watchdog error: ${err}`);
        }

        const pending = session.pendingPrompt;
        const minutesRunning = (Date.now() - pending.startedAt) / 60000;

        let lastToolName = "";
        let lastText = "";
        let messageCount = 0;
        let filesModified = 0;
        const recentFilesSet: string[] = [];
        let lastBashCmd = "";
        const secondsSinceLastEvent = Math.max(0, Math.round((Date.now() - session.lastSseEventAt) / 1000));
        const streamConnected = secondsSinceLastEvent <= 25;

        try {
            const agent = session.agent;
            const host = agent.host || "localhost";
            const msgRes = await fetch(
                `http://${host}:${agent.port}/session/${session.sessionId}/message`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (msgRes.ok) {
                const messages: any[] = await msgRes.json();
                messageCount = messages.length;

                for (const msg of messages) {
                    for (const part of (msg.parts ?? [])) {
                        const isToolPart = part.type === "tool" || part.type === "tool-invocation";
                        if (isToolPart) {
                            const toolName: string = (part.tool ?? part.toolName ?? part.name ?? "").toLowerCase();
                            if (toolName) lastToolName = toolName;
                            if (FILE_WRITE_TOOLS.has(toolName)) {
                                filesModified++;
                                const args = part.state?.input ?? part.args ?? part.input ?? {};
                                const filePath: string = args.filePath ?? args.path ?? args.file ?? "";
                                if (filePath) {
                                    const idx = recentFilesSet.indexOf(filePath);
                                    if (idx !== -1) recentFilesSet.splice(idx, 1);
                                    recentFilesSet.push(filePath);
                                    if (recentFilesSet.length > 5) recentFilesSet.shift();
                                }
                            }
                            if (toolName === "bash") {
                                const args = part.state?.input ?? part.args ?? part.input ?? {};
                                const cmd: string = args.command ?? args.cmd ?? "";
                                if (cmd) lastBashCmd = cmd.trim().slice(0, 120);
                            }
                        }
                        if (part.type === "text" && part.text) {
                            lastText = (part.text as string).replace(/\s+/g, " ").trim().slice(0, 300);
                        }
                    }
                }
            }
        } catch { /* best-effort */ }

        try {
            await this.onHeartbeat({
                sessionId: session.sessionId,
                agentId: session.agent.id,
                minutesRunning: Math.floor(minutesRunning),
                lastToolName,
                lastText,
                messageCount,
                filesModified,
                recentFiles: recentFilesSet,
                lastBashCmd,
                streamConnected,
                secondsSinceLastEvent,
                sessionStatus: session.status,
            });
        } catch (err) {
            console.error(`[SessionInstance] heartbeat error for session "${session.sessionId}":`, err);
        }
    }

    // ─── Questions ────────────────────────────────────────────────────────────

    async replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const agent = session.agent;
        const host = agent.host || "localhost";
        const port = agent.port;

        this.forwardedQuestionIds.delete(requestId);

        await fetch(`http://${host}:${port}/question/${requestId}/reply`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answers }),
            signal: AbortSignal.timeout(10000),
        });
    }

    async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const agent = session.agent;
        const host = agent.host || "localhost";
        const port = agent.port;

        this.forwardedQuestionIds.delete(requestId);

        await fetch(`http://${host}:${port}/question/${requestId}/reject`, {
            method: "POST",
            signal: AbortSignal.timeout(10000),
        });
    }
}
