/**
 * PersistentAgentService
 *
 * Manages long-lived `opencode serve` processes — one per persistent agent.
 *
 * Notification flow (correct):
 *   1. User sends a prompt → sendPrompt() fires it async and returns a Promise
 *      that is stored in pendingPromises keyed by agentId.
 *   2. The SSE loop receives session.idle for that sessionId → resolves the
 *      Promise with the last assistant message text.
 *   3. OpenCodeBot receives the resolved text and sends it to Telegram.
 *
 * Heartbeat:
 *   - Fires every HEARTBEAT_INTERVAL_MS while an agent has an in-flight prompt.
 *   - Edits the same Telegram message each tick with live progress info.
 *   - Stops when session.idle arrives or the user sends /esc.
 *   - There is NO hard timeout — the user cancels explicitly with /esc.
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { access, constants } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { PersistentAgent } from "./agent-db.service.js";
import type { AgentDbService } from "./agent-db.service.js";

export interface AgentSendResult {
    output: string;
    sessionId?: string;
}

/** A queued prompt waiting to be sent once the agent becomes idle */
export interface QueuedPrompt {
    prompt: string;
    /** Called with the result when the queued prompt finishes executing */
    onResult: (result: AgentSendResult) => Promise<void>;
    /** Called when the queued prompt starts executing (before sendPrompt) */
    onDequeue?: () => Promise<void>;
}

/** Called by OpenCodeBot when the agent has a pending question for the user */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OnQuestionCallback = (agentId: string, req: any) => Promise<void>;

/** Called by OpenCodeBot when the model/session reports an error */
export type OnSessionErrorCallback = (agentId: string, errorMessage: string) => Promise<void>;

/** Summary sent to the bot on each heartbeat tick */
export interface HeartbeatSummary {
    /** Minutes elapsed since the prompt was sent */
    minutesRunning: number;
    /** Name of the last tool called (e.g. "edit", "bash", "read") — best-effort */
    lastToolName: string;
    /** Last snippet of assistant text (up to 120 chars) — best-effort */
    lastText: string;
    /** Total number of messages in the session so far */
    messageCount: number;
    /** Number of file-modifying tool calls (edit / write / patch) seen so far */
    filesModified: number;
    /** True if approaching hard timeout (80% of TIMEOUT_MS) */
    isNearTimeout?: boolean;
}

/** Called by OpenCodeBot on each heartbeat tick (only while a prompt is in-flight) */
export type OnHeartbeatCallback = (agentId: string, summary: HeartbeatSummary) => Promise<void>;

/** Resolve ~ in paths */
export function resolveDir(p: string): string {
    if (p.startsWith("~/") || p === "~") {
        return path.join(os.homedir(), p.slice(1));
    }
    return p;
}

/** Pick an available port in range 15000-16000, avoiding already-used ones */
export function pickPort(usedPorts: number[]): number {
    const used = new Set(usedPorts);
    for (let p = 15000; p < 16000; p++) {
        if (!used.has(p)) return p;
    }
    throw new Error("No available ports in range 15000-16000");
}

export async function findOpencodeCmd(): Promise<string> {
    const candidates = [
        "/usr/bin/opencode",
        "/usr/local/bin/opencode",
        path.join(process.env.HOME || "", ".opencode", "bin", "opencode"),
        path.join(process.cwd(), "node_modules", ".bin", "opencode"),
    ];
    for (const p of candidates) {
        try { await access(p, constants.X_OK); return p; } catch { /* next */ }
    }
    try {
        const { execSync } = await import("child_process");
        const found = execSync("which opencode").toString().trim();
        if (found) return found;
    } catch { /* not found */ }
    throw new Error("opencode binary not found");
}

/** Heartbeat interval while a prompt is in-flight */
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;

/** File-modifying tool names recognised for the filesModified counter */
const FILE_WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

interface PendingPrompt {
    sessionId: string;
    resolve: (result: AgentSendResult) => void;
    reject: (err: Error) => void;
    startedAt: number;
}

export class PersistentAgentService {
    /** Map of agentId → child process */
    private processes: Map<string, ChildProcess> = new Map();

    /** Map of agentId → SSE abort controller */
    private sseControllers: Map<string, AbortController> = new Map();

    /** Map of userId → active agentId (sticky switch) */
    private activeAgentByUser: Map<number, string> = new Map();

    /** Callback registered by OpenCodeBot to handle pending questions */
    private onQuestion?: OnQuestionCallback;

    /** Callback registered by OpenCodeBot to handle session errors from the model */
    private onSessionError?: OnSessionErrorCallback;

    /** Callback registered by OpenCodeBot to handle heartbeat ticks */
    private onHeartbeat?: OnHeartbeatCallback;

    /** Map of agentId → heartbeat timer handle (only active while prompt is in-flight) */
    private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

    /**
     * In-flight prompt promises, keyed by agentId.
     * Resolved by the SSE loop when session.idle arrives for that agent's sessionId.
     */
    private pendingPrompts: Map<string, PendingPrompt> = new Map();

    /**
     * Per-agent FIFO queue of prompts waiting to be sent once the agent becomes idle.
     * Each entry carries the raw text and a callback to notify the user with the result.
     */
    private promptQueues: Map<string, QueuedPrompt[]> = new Map();

    /**
     * In-memory cache of agentId → OpenCode sessionId.
     * Source of truth is SQLite (agent.sessionId); this cache avoids extra DB reads.
     */
    private sessionIds: Map<string, string> = new Map();

    constructor(private readonly agentDb: AgentDbService) {}

    /** Register the question callback (called once at startup by OpenCodeBot) */
    setOnQuestionCallback(cb: OnQuestionCallback): void {
        this.onQuestion = cb;
    }

    /** Register the session error callback (called once at startup by OpenCodeBot) */
    setOnSessionErrorCallback(cb: OnSessionErrorCallback): void {
        this.onSessionError = cb;
    }

    /** Register the heartbeat callback (called once at startup by OpenCodeBot) */
    setOnHeartbeatCallback(cb: OnHeartbeatCallback): void {
        this.onHeartbeat = cb;
    }

    // ─── Server lifecycle ─────────────────────────────────────────────────────

    async startAgent(agent: PersistentAgent): Promise<{ success: boolean; message: string }> {
        if (this.processes.has(agent.id)) {
            return { success: true, message: "already running" };
        }

        if (await this.isServerRunning(agent)) {
            await this.ensureSession(agent);
            this.startSseStream(agent);
            return { success: true, message: "already running (external)" };
        }

        // Remote agents run on another machine — we never spawn a local process for them
        if (agent.isRemote) {
            return { success: false, message: `Remote agent ${agent.host}:${agent.port} is not reachable` };
        }

        const cmd = await findOpencodeCmd();
        const workdir = resolveDir(agent.workdir);

        const hostname = process.env.OPENCODE_BIND_HOST || "0.0.0.0";
        const child = spawn(cmd, [
            "serve",
            "--port", String(agent.port),
            "--hostname", hostname,
        ], {
            cwd: workdir,
            detached: false,
            stdio: "ignore",
            env: { ...process.env },
        });

        child.on("error", (err) => {
            console.error(`[PersistentAgent] Failed to spawn opencode for "${agent.name}":`, err.message);
            this.processes.delete(agent.id);
            this.stopSseStream(agent.id);
            const pending = this.pendingPrompts.get(agent.id);
            if (pending) {
                this.pendingPrompts.delete(agent.id);
                pending.reject(err);
            }
        });

        child.on("exit", (code) => {
            console.log(`[PersistentAgent] Agent "${agent.name}" (port ${agent.port}) exited with code ${code}`);
            this.processes.delete(agent.id);
            this.stopSseStream(agent.id);
            // Reject any in-flight prompt
            const pending = this.pendingPrompts.get(agent.id);
            if (pending) {
                this.pendingPrompts.delete(agent.id);
                pending.reject(new Error(`Agent server exited with code ${code}`));
            }
        });

        this.processes.set(agent.id, child);

        // Wait up to 20s for it to be ready
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
        if (await this.isServerRunning(agent)) {
                await this.ensureSession(agent);
                this.startSseStream(agent);
                return { success: true, message: `opencode serve ready on :${agent.port}` };
            }
            await new Promise(r => setTimeout(r, 800));
        }

        return { success: false, message: `Server did not respond within 20s on port ${agent.port}` };
    }

    /**
     * Ensures the agent has a live long-lived OpenCode session.
     */
    private async ensureSession(agent: PersistentAgent): Promise<string> {
        const host = agent.host || 'localhost';
        const baseUrl = `http://${host}:${agent.port}`;
        const cachedId = this.sessionIds.get(agent.id) ?? agent.sessionId;

        if (cachedId) {
            try {
                const res = await fetch(`${baseUrl}/session/${cachedId}`, {
                    signal: AbortSignal.timeout(5000),
                });
                if (res.ok) {
                    this.sessionIds.set(agent.id, cachedId);
                    return cachedId;
                }
            } catch { /* fall through */ }
            console.log(`[PersistentAgent] Session ${cachedId} for agent "${agent.name}" is gone, creating a new one`);
        }

        const sessionId = await this.createSession(agent);
        this.sessionIds.set(agent.id, sessionId);
        this.agentDb.setSessionId(agent.id, sessionId);
        console.log(`[PersistentAgent] Created session ${sessionId} for agent "${agent.name}"`);
        return sessionId;
    }

    /** Create a new OpenCode session on the agent's server. Returns the new session ID. */
    private async createSession(agent: PersistentAgent): Promise<string> {
        const host = agent.host || 'localhost';
        const baseUrl = `http://${host}:${agent.port}`;

        let modelConfig: { providerID: string; modelID: string } | undefined;
        if (agent.model) {
            const parts = agent.model.split("/");
            if (parts.length === 2) {
                modelConfig = { providerID: parts[0], modelID: parts[1] };
            }
        }

        const createRes = await fetch(`${baseUrl}/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: `tg-${agent.name}`,
                system: agent.role || undefined,
                model: modelConfig,
                permission: [
                    { permission: "command", pattern: "*", action: "allow" },
                    { permission: "file",    pattern: "*", action: "allow" },
                    { permission: "network", pattern: "*", action: "allow" },
                    { permission: "browser", pattern: "*", action: "allow" },
                ],
            }),
            signal: AbortSignal.timeout(10000),
        });

        if (!createRes.ok) {
            throw new Error(`Create session failed: ${createRes.status} ${await createRes.text()}`);
        }

        const sess = await createRes.json() as any;
        return sess.id as string;
    }

    stopAgent(agentId: string): void {
        this.stopSseStream(agentId);
        const child = this.processes.get(agentId);
        if (child && !child.killed) {
            child.kill("SIGTERM");
        }
        this.processes.delete(agentId);
    }

    /**
     * Park an agent: stop its process (like stopAgent) but mark it as 'stopped'
     * in the DB so it is not counted against MAX_AGENTS and won't be restarted.
     * Any in-flight prompt is cancelled first.
     */
    parkAgent(agentId: string): void {
        // Cancel any in-flight prompt
        const pending = this.pendingPrompts.get(agentId);
        if (pending) {
            this.pendingPrompts.delete(agentId);
            this.stopHeartbeat(agentId);
            pending.resolve({ output: "⏸️ Agente aparcado por el usuario.", sessionId: pending.sessionId });
        }
        // Clear the prompt queue
        this.promptQueues.delete(agentId);
        // Stop the process
        this.stopAgent(agentId);
        // Mark in DB
        this.agentDb.setStatus(agentId, "stopped");
    }

    /**
     * Unpark a previously stopped agent: start its process and mark it 'running'.
     */
    async unparkAgent(agent: PersistentAgent): Promise<{ success: boolean; message: string }> {
        const result = await this.startAgent(agent);
        if (result.success) {
            this.agentDb.setStatus(agent.id, "running");
        }
        return result;
    }

    async isServerRunning(agentOrPort: PersistentAgent | number): Promise<boolean> {
        let host: string, port: number;
        
        if (typeof agentOrPort === 'number') {
            // Legacy call with just port
            host = 'localhost';
            port = agentOrPort;
        } else {
            // New call with agent object
            const agent = agentOrPort;
            host = agent.host || 'localhost';
            port = agent.port;
        }
        
        try {
            const res = await fetch(`http://${host}:${port}`, {
                method: "HEAD",
                signal: AbortSignal.timeout(3000),
            });
            return res.ok || res.status < 500;
        } catch {
            return false;
        }
    }

    isProcessManaged(agentId: string): boolean {
        return this.processes.has(agentId);
    }

    // ─── SSE stream per agent ─────────────────────────────────────────────────

    private startSseStream(agent: PersistentAgent): void {
        if (this.sseControllers.has(agent.id)) return;

        const abort = new AbortController();
        this.sseControllers.set(agent.id, abort);

        this.runSseLoop(agent, abort).catch(err =>
            console.error(`[PersistentAgent] SSE loop error for agent ${agent.name}:`, err)
        );
    }

    private stopSseStream(agentId: string): void {
        const ctrl = this.sseControllers.get(agentId);
        if (ctrl) {
            ctrl.abort();
            this.sseControllers.delete(agentId);
        }
        this.stopHeartbeat(agentId);
    }

    private async runSseLoop(agent: PersistentAgent, abort: AbortController): Promise<void> {
        const host = agent.host || 'localhost';
        const baseUrl = `http://${host}:${agent.port}`;
        const client = createOpencodeClient({ baseUrl });
        let retryDelay = 3000;

        await this.recoverPendingQuestions(agent);
        await this.recoverPendingPrompt(agent);

        while (!abort.signal.aborted) {
            try {
                const events = await client.event.subscribe();
                retryDelay = 3000;

                for await (const event of events.stream) {
                    if (abort.signal.aborted) break;

                    const type = (event as any).type;
                    const props = (event as any).properties;

                    // ── question.asked → forward to bot ───────────────────
                    if (type === "question.asked" && this.onQuestion) {
                        console.log(`[PersistentAgent] question.asked for agent "${agent.name}": ${props.id}`);
                        this.onQuestion(agent.id, props).catch(err =>
                            console.error(`[PersistentAgent] onQuestion callback error:`, err)
                        );
                    }

                    // ── session.error → notify bot and resolve pending ─────
                    if (type === "session.error") {
                        const errorSessionId: string = props?.sessionID ?? props?.id ?? "";
                        const mySessionId = this.sessionIds.get(agent.id);
                        const errorMessage: string =
                            props?.error?.message ?? props?.message ??
                            (typeof props?.error === "string" ? props.error : null) ??
                            "Error desconocido del modelo";

                        // Log the full raw event so we can see what opencode is actually sending
                        console.error(`[PersistentAgent] session.error for agent "${agent.name}": ${errorMessage} | raw: ${JSON.stringify(props)}`);
                        console.error(`[PersistentAgent] session.error sessionId match: event="${errorSessionId}" mine="${mySessionId}"`);

                        // Resolve pending prompt if the session matches — OR if there is no
                        // session info in the error event (some opencode versions omit it)
                        const sessionMatches =
                            !errorSessionId ||                           // no session in event → assume ours
                            !mySessionId ||
                            errorSessionId === mySessionId;

                        if (sessionMatches) {
                            // Stop heartbeat and resolve in-flight prompt with the error
                            const pending = this.pendingPrompts.get(agent.id);
                            if (pending) {
                                this.stopHeartbeat(agent.id);
                                this.pendingPrompts.delete(agent.id);
                                pending.resolve({
                                    output: `❌ Error del modelo: ${errorMessage}`,
                                    sessionId: errorSessionId || mySessionId || "",
                                });
                                // Drain queue after error so queued prompts are not lost
                                this.drainQueue(agent).catch(err =>
                                    console.error(`[PersistentAgent] drainQueue error after session.error for "${agent.name}":`, err)
                                );
                            }
                        }

                        // Always notify the bot so the user knows even if there was no pending prompt
                        if (this.onSessionError) {
                            this.onSessionError(agent.id, errorMessage).catch(err =>
                                console.error(`[PersistentAgent] onSessionError callback error:`, err)
                            );
                        }
                    }

                    // ── session.idle → resolve in-flight prompt ───────────
                    if (type === "session.idle") {
                        const idleSessionId: string = props?.sessionID ?? props?.id ?? "";
                        const mySessionId = this.sessionIds.get(agent.id);

                        // Use the same liberal matching as session.error:
                        // if opencode omits sessionID (some versions do), assume it's ours.
                        const sessionMatches =
                            !idleSessionId ||
                            !mySessionId ||
                            idleSessionId === mySessionId;

                        if (sessionMatches) {
                            const resolveId = idleSessionId || mySessionId || "";
                            console.log(`[PersistentAgent] session.idle for agent "${agent.name}" session "${resolveId}"`);
                            await this.resolvePromptFromIdle(agent, resolveId);
                        }
                    }
                }
            } catch (err) {
                if (abort.signal.aborted) break;
                console.warn(`[PersistentAgent] SSE stream for agent "${agent.name}" disconnected, retrying in ${retryDelay}ms`);
                await new Promise(r => setTimeout(r, retryDelay));
                retryDelay = Math.min(retryDelay * 2, 30000);
                await this.recoverPendingQuestions(agent);
                await this.recoverPendingPrompt(agent);
            }
        }
    }

    /**
     * Called when session.idle arrives via SSE.
     * Fetches the last assistant message and resolves the pending Promise.
     */
    private async resolvePromptFromIdle(agent: PersistentAgent, sessionId: string): Promise<void> {
        const pending = this.pendingPrompts.get(agent.id);
        // Accept the event if there is a pending prompt AND either:
        //   (a) sessionId matches exactly, or
        //   (b) sessionId is empty (opencode omitted it) — assume it's ours
        if (!pending) return;
        if (sessionId && pending.sessionId && sessionId !== pending.sessionId) return;

        // Use the pending session's own ID for fetching messages
        const resolveSessionId = pending.sessionId || sessionId;

        // Stop heartbeat — response arrived
        this.stopHeartbeat(agent.id);
        this.pendingPrompts.delete(agent.id);

        try {
            const host = agent.host || 'localhost';
            const msgRes = await fetch(
                `http://${host}:${agent.port}/session/${resolveSessionId}/message`,
                { signal: AbortSignal.timeout(10000) }
            );
            if (!msgRes.ok) {
                pending.resolve({ output: `❌ Error al leer mensajes: HTTP ${msgRes.status}`, sessionId: resolveSessionId });
                return;
            }

            const messages: any[] = await msgRes.json();
            const lastAssistant = [...messages]
                .reverse()
                .find((m: any) => m.role === "assistant" || m.info?.role === "assistant");

            if (!lastAssistant) {
                pending.resolve({ output: "⚠️ Sin respuesta del asistente", sessionId: resolveSessionId });
                return;
            }

            const parts: any[] = lastAssistant.parts || [];
            const text = parts
                .filter((p: any) => p.type === "text" && p.text)
                .map((p: any) => p.text as string)
                .join("");

            // Diferenciar entre:
            // - Respuesta vacía genuina (se ejecutó todo pero no escribió nada)
            // - Error de lectura
            const trimmed = text.trim();
            if (!trimmed) {
                // Verificar si hubo llamadas a herramientas (indica que trabajó)
                const hasTools = parts.some((p: any) => p.type === "tool-invocation");
                if (hasTools) {
                    pending.resolve({ output: "✅ Completado (ejecutó herramientas pero no generó texto)", sessionId: resolveSessionId });
                } else {
                    pending.resolve({ output: "⚠️ Sin salida (ejecución vacía)", sessionId: resolveSessionId });
                }
            } else {
                pending.resolve({ output: trimmed, sessionId: resolveSessionId });
            }
        } catch (err) {
            pending.resolve({ output: `❌ Error al leer respuesta: ${err}`, sessionId: resolveSessionId });
        }

        // Once the current prompt is resolved, drain the next item from the queue (if any)
        this.drainQueue(agent).catch(err =>
            console.error(`[PersistentAgent] drainQueue error for "${agent.name}":`, err)
        );
    }

    // ─── Question recovery ────────────────────────────────────────────────────

    private async recoverPendingQuestions(agent: PersistentAgent): Promise<void> {
        if (!this.onQuestion) return;

        try {
            const host = agent.host || 'localhost';
            const workdir = resolveDir(agent.workdir);
            const url = `http://${host}:${agent.port}/question?directory=${encodeURIComponent(workdir)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return;

            const questions: any[] = await res.json();
            if (!Array.isArray(questions) || questions.length === 0) return;

            console.log(`[PersistentAgent] Recovering ${questions.length} pending question(s) for agent "${agent.name}"`);
            for (const q of questions) {
                this.onQuestion(agent.id, q).catch(err =>
                    console.error(`[PersistentAgent] recoverPendingQuestions callback error:`, err)
                );
            }
        } catch (err) {
            console.debug(`[PersistentAgent] recoverPendingQuestions for "${agent.name}": ${err}`);
        }
    }

    /**
     * Called on SSE connect/reconnect. If there is a pending in-flight prompt
     * for this agent and the session is already idle in opencode (i.e. the
     * session.idle event was missed while we were disconnected), resolve it
     * immediately instead of waiting forever.
     */
    private async recoverPendingPrompt(agent: PersistentAgent): Promise<void> {
        const pending = this.pendingPrompts.get(agent.id);
        if (!pending) return; // nothing in flight

        const sessionId = pending.sessionId;
        if (!sessionId) return;

        try {
            const host = agent.host || 'localhost';
            const res = await fetch(
                `http://${host}:${agent.port}/session/${sessionId}`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (!res.ok) return;

            const session: any = await res.json();
            // opencode reports the session as idle when it is not actively running a prompt
            if (session?.status === "idle" || session?.info?.status === "idle") {
                console.log(`[PersistentAgent] recoverPendingPrompt: session ${sessionId} is already idle for agent "${agent.name}" — resolving now`);
                await this.resolvePromptFromIdle(agent, sessionId);
            }
        } catch (err) {
            console.debug(`[PersistentAgent] recoverPendingPrompt for "${agent.name}": ${err}`);
        }
    }

    // ─── Heartbeat (safeguard only) ───────────────────────────────────────────

    private startHeartbeat(agent: PersistentAgent): void {
        if (this.heartbeatTimers.has(agent.id)) return;

        const timer = setInterval(async () => {
            await this.fireHeartbeat(agent);
        }, HEARTBEAT_INTERVAL_MS);

        if (timer.unref) timer.unref();
        this.heartbeatTimers.set(agent.id, timer);
    }

    private stopHeartbeat(agentId: string): void {
        const timer = this.heartbeatTimers.get(agentId);
        if (timer) {
            clearInterval(timer);
            this.heartbeatTimers.delete(agentId);
        }
    }

    private async fireHeartbeat(agent: PersistentAgent): Promise<void> {
        if (!this.onHeartbeat) return;

        const pending = this.pendingPrompts.get(agent.id);
        if (!pending) {
            this.stopHeartbeat(agent.id);
            return;
        }

        const minutesRunning = (Date.now() - pending.startedAt) / 60000;

        // Best-effort: fetch messages and extract rich info
        let lastToolName = "";
        let lastText = "";
        let messageCount = 0;
        let filesModified = 0;

        try {
        const host = agent.host || 'localhost';
        const baseUrl = `http://${host}:${agent.port}`;
            const msgRes = await fetch(`${baseUrl}/session/${pending.sessionId}/message`, {
                signal: AbortSignal.timeout(5000),
            });
            if (msgRes.ok) {
                const messages: any[] = await msgRes.json();
                messageCount = messages.length;

                for (const msg of messages) {
                    for (const part of (msg.parts ?? [])) {
                        if (part.type === "tool-invocation") {
                            const toolName: string = (part.toolName ?? part.name ?? "").toLowerCase();
                            if (toolName) lastToolName = toolName;
                            if (FILE_WRITE_TOOLS.has(toolName)) filesModified++;
                        }
                        if (part.type === "text" && part.text) {
                            lastText = (part.text as string).replace(/\s+/g, " ").trim().slice(0, 120);
                        }
                    }
                }
            }
        } catch { /* best-effort */ }

        try {
            await this.onHeartbeat(agent.id, {
                minutesRunning: Math.floor(minutesRunning),
                lastToolName,
                lastText,
                messageCount,
                filesModified,
            });
        } catch (err) {
            console.error(`[PersistentAgent] heartbeat error for "${agent.name}":`, err);
        }
    }

    // ─── Reply to a question ──────────────────────────────────────────────────

    async replyQuestion(agentOrPort: PersistentAgent | number, requestId: string, answers: string[][]): Promise<void> {
        let host: string, port: number;
        
        if (typeof agentOrPort === 'number') {
            // Legacy call with just port
            host = 'localhost';
            port = agentOrPort;
        } else {
            // New call with agent object
            const agent = agentOrPort;
            host = agent.host || 'localhost';
            port = agent.port;
        }
        
        await fetch(`http://${host}:${port}/question/${requestId}/reply`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answers }),
            signal: AbortSignal.timeout(10000),
        });
    }

    async rejectQuestion(agentOrPort: PersistentAgent | number, requestId: string): Promise<void> {
        let host: string, port: number;
        
        if (typeof agentOrPort === 'number') {
            // Legacy call with just port
            host = 'localhost';
            port = agentOrPort;
        } else {
            // New call with agent object
            const agent = agentOrPort;
            host = agent.host || 'localhost';
            port = agent.port;
        }
        
        await fetch(`http://${host}:${port}/question/${requestId}/reject`, {
            method: "POST",
            signal: AbortSignal.timeout(10000),
        });
    }

    // ─── Prompt ───────────────────────────────────────────────────────────────

    /**
     * Send a prompt to a persistent agent's opencode server.
     *
     * Fire-and-forget: the prompt is sent via /prompt_async and this method
     * returns a Promise that is resolved by the SSE loop when session.idle
     * arrives for this agent's session. The heartbeat timer is started as a
     * safeguard in case session.idle never arrives.
     */
    async sendPrompt(agent: PersistentAgent, userText: string): Promise<AgentSendResult> {
        const host = agent.host || 'localhost';
        const baseUrl = `http://${host}:${agent.port}`;

        // Ensure the server is running
        const running = await this.isServerRunning(agent);
        if (!running) {
            const started = await this.startAgent(agent);
            if (!started.success) {
                return { output: `❌ Could not start agent server: ${started.message}` };
            }
        }

        // Get or create the long-lived session for this agent
        let sessionId: string;
        try {
            sessionId = await this.ensureSession(agent);
        } catch (err) {
            return { output: `❌ Failed to get/create session for agent: ${err}` };
        }

        // Build model config
        let modelConfig: { providerID: string; modelID: string } | undefined;
        if (agent.model) {
            const parts = agent.model.split("/");
            if (parts.length === 2) {
                modelConfig = { providerID: parts[0], modelID: parts[1] };
            }
        }

        // Register the pending promise BEFORE sending the prompt so the SSE
        // loop cannot race and resolve before we're listening.
        // There is NO hard timeout — the user cancels explicitly with /esc.
        console.log(`[PersistentAgent] sendPrompt → agent="${agent.name}" session="${sessionId}" text="${userText.slice(0, 80)}${userText.length > 80 ? "…" : ""}"`);

        // Build request body — omit 'model' field entirely if not configured
        // (Copilot API rejects null/undefined model)
        const requestBody: any = {
            parts: [{ type: "text", text: userText }],
            agent: "build",
        };
        if (modelConfig) {
            requestBody.model = modelConfig;
        }

        const result = await new Promise<AgentSendResult>((resolve, reject) => {
            this.pendingPrompts.set(agent.id, {
                sessionId,
                resolve,
                reject,
                startedAt: Date.now(),
            });

            // Send prompt async (fire and forget) — response comes via SSE session.idle
            fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(10000),
            }).then(res => {
                if (!res.ok) {
                    this.pendingPrompts.delete(agent.id);
                    this.stopHeartbeat(agent.id);
                    console.error(`[PersistentAgent] prompt_async HTTP error ${res.status} for agent "${agent.name}"`);
                    resolve({ output: `❌ Failed to send prompt: HTTP ${res.status}`, sessionId });
                } else {
                    // Prompt accepted — start the heartbeat
                    console.log(`[PersistentAgent] prompt accepted by opencode for agent "${agent.name}", starting heartbeat`);
                    this.startHeartbeat(agent);
                }
            }).catch(err => {
                this.pendingPrompts.delete(agent.id);
                this.stopHeartbeat(agent.id);
                console.error(`[PersistentAgent] prompt_async fetch error for agent "${agent.name}":`, err);
                resolve({ output: `❌ Failed to send prompt to agent: ${err}`, sessionId });
            });
        });

        return result;
    }

    // ─── Prompt queue (per agent) ─────────────────────────────────────────────

    /** Returns true if the agent currently has an in-flight prompt */
    isBusy(agentId: string): boolean {
        return this.pendingPrompts.has(agentId);
    }

    /**
     * Cancel the in-flight prompt for an agent (called by /esc).
     * Resolves the pending promise with a cancellation message and stops the heartbeat.
     * Queued prompts are also cleared.
     */
    cancelPendingPrompt(agentId: string): void {
        const pending = this.pendingPrompts.get(agentId);
        if (pending) {
            this.pendingPrompts.delete(agentId);
            this.stopHeartbeat(agentId);
            pending.resolve({ output: "❌ Cancelado por el usuario.", sessionId: pending.sessionId });
        }
        // Also clear the queue so nothing drains after cancellation
        this.promptQueues.delete(agentId);
    }

    /** How many prompts are waiting in the queue for this agent (not counting the in-flight one) */
    queueLength(agentId: string): number {
        return this.promptQueues.get(agentId)?.length ?? 0;
    }

    /**
     * Add a prompt to the agent's queue.
     * `onResult` will be called with the AgentSendResult once the prompt executes.
     */
    enqueue(agentId: string, item: QueuedPrompt): void {
        const q = this.promptQueues.get(agentId) ?? [];
        q.push(item);
        this.promptQueues.set(agentId, q);
    }

    /**
     * Dequeue and execute the next queued prompt for the given agent (if any).
     * Called automatically after session.idle resolves the current in-flight prompt.
     */
    private async drainQueue(agent: PersistentAgent): Promise<void> {
        const q = this.promptQueues.get(agent.id);
        if (!q || q.length === 0) return;

        const next = q.shift()!;
        this.promptQueues.set(agent.id, q);

        // Notify that this queued prompt is now being processed
        if (next.onDequeue) {
            await next.onDequeue().catch(err =>
                console.error(`[PersistentAgent] onDequeue callback error for "${agent.name}":`, err)
            );
        }

        // Execute it as a normal sendPrompt, then fire the callback
        const result = await this.sendPrompt(agent, next.prompt);
        next.onResult(result).catch(err =>
            console.error(`[PersistentAgent] Queue onResult callback error for "${agent.name}":`, err)
        );
    }

    // ─── Active agent switching (sticky) ─────────────────────────────────────

    setActiveAgent(userId: number, agentId: string): void {
        this.activeAgentByUser.set(userId, agentId);
    }

    getActiveAgentId(userId: number): string | null {
        return this.activeAgentByUser.get(userId) ?? null;
    }

    clearActiveAgent(userId: number): void {
        this.activeAgentByUser.delete(userId);
    }

    /** Returns the current OpenCode sessionId for an agent (from in-memory cache) */
    getSessionId(agentId: string): string | undefined {
        return this.sessionIds.get(agentId);
    }

    /**
     * Override the active session ID for an agent (in-memory + DB).
     * Pass an empty string to clear it (next prompt will create a fresh session).
     */
    setSessionId(agentId: string, sessionId: string): void {
        if (sessionId) {
            this.sessionIds.set(agentId, sessionId);
            this.agentDb.setSessionId(agentId, sessionId);
        } else {
            this.sessionIds.delete(agentId);
            this.agentDb.setSessionId(agentId, "");
        }
    }

    /**
     * Create a new OpenCode session for the given agent and return its ID.
     * Does NOT set it as active — caller decides.
     */
    async createNewSession(agent: PersistentAgent): Promise<string> {
        const running = await this.isServerRunning(agent);
        if (!running) {
            const started = await this.startAgent(agent);
            if (!started.success) throw new Error(`Agent server not running: ${started.message}`);
        }
        return this.createSession(agent);
    }

    // ─── Startup restore ──────────────────────────────────────────────────────

    async restoreAll(agents: PersistentAgent[]): Promise<PersistentAgent[]> {
        const failed: PersistentAgent[] = [];
        for (const agent of agents) {
            // Parked agents are intentionally stopped — skip them
            if (agent.status === "stopped") {
                console.log(`[PersistentAgent] Skipping parked agent "${agent.name}" (status=stopped)`);
                continue;
            }
            console.log(`[PersistentAgent] Restoring agent "${agent.name}" on port ${agent.port}…`);
            const result = await this.startAgent(agent);
            console.log(`[PersistentAgent] → ${result.message}`);
            if (!result.success) {
                failed.push(agent);
            }
        }
        return failed;
    }
}
