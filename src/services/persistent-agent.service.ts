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
 * Heartbeat (safeguard only):
 *   - Fires every HEARTBEAT_INTERVAL_MS while an agent has an in-flight prompt.
 *   - If session.idle has NOT been received within STUCK_THRESHOLD_MIN minutes
 *     since the prompt was sent, it notifies the user that the agent may be stuck.
 *   - Resets when session.idle arrives (pendingPromises entry is cleared).
 */

import { spawn, ChildProcess } from "child_process";
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

/** Called by OpenCodeBot when the agent has a pending question for the user */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OnQuestionCallback = (agentId: string, req: any) => Promise<void>;

/** Summary sent to the bot on each heartbeat tick */
export interface HeartbeatSummary {
    /** "working" → still running; "stuck" → no idle received in STUCK_THRESHOLD_MIN */
    status: "working" | "stuck";
    /** Minutes elapsed since the prompt was sent */
    minutesRunning: number;
    /** Last 100 chars of the most recent assistant text (best-effort snapshot) */
    lastAction: string;
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

async function findOpencodeCmd(): Promise<string> {
    const candidates = [
        path.join(process.cwd(), "node_modules", ".bin", "opencode"),
        path.join(process.env.HOME || "", ".opencode", "bin", "opencode"),
        "/usr/bin/opencode",
        "/usr/local/bin/opencode",
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

/** Minutes without session.idle before considering an agent stuck */
const STUCK_THRESHOLD_MIN = 10;

/** Max time sendPrompt will wait for session.idle before timing out */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface PendingPrompt {
    sessionId: string;
    resolve: (result: AgentSendResult) => void;
    reject: (err: Error) => void;
    startedAt: number;
    timeoutHandle: NodeJS.Timeout;
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
     * In-memory cache of agentId → OpenCode sessionId.
     * Source of truth is SQLite (agent.sessionId); this cache avoids extra DB reads.
     */
    private sessionIds: Map<string, string> = new Map();

    constructor(private readonly agentDb: AgentDbService) {}

    /** Register the question callback (called once at startup by OpenCodeBot) */
    setOnQuestionCallback(cb: OnQuestionCallback): void {
        this.onQuestion = cb;
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

        if (await this.isServerRunning(agent.port)) {
            await this.ensureSession(agent);
            this.startSseStream(agent);
            return { success: true, message: "already running (external)" };
        }

        const cmd = await findOpencodeCmd();
        const workdir = resolveDir(agent.workdir);

        const child = spawn(cmd, [
            "serve",
            "--port", String(agent.port),
            "--hostname", "localhost",
        ], {
            cwd: workdir,
            detached: false,
            stdio: "ignore",
            env: { ...process.env },
        });

        child.on("exit", (code) => {
            console.log(`[PersistentAgent] Agent "${agent.name}" (port ${agent.port}) exited with code ${code}`);
            this.processes.delete(agent.id);
            this.stopSseStream(agent.id);
            // Reject any in-flight prompt
            const pending = this.pendingPrompts.get(agent.id);
            if (pending) {
                clearTimeout(pending.timeoutHandle);
                this.pendingPrompts.delete(agent.id);
                pending.reject(new Error(`Agent server exited with code ${code}`));
            }
        });

        this.processes.set(agent.id, child);

        // Wait up to 20s for it to be ready
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (await this.isServerRunning(agent.port)) {
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
        const baseUrl = `http://localhost:${agent.port}`;
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
        const baseUrl = `http://localhost:${agent.port}`;

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

    async isServerRunning(port: number): Promise<boolean> {
        try {
            const res = await fetch(`http://localhost:${port}`, {
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
        const baseUrl = `http://localhost:${agent.port}`;
        const client = createOpencodeClient({ baseUrl });
        let retryDelay = 3000;

        await this.recoverPendingQuestions(agent);

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

                    // ── session.idle → resolve in-flight prompt ───────────
                    if (type === "session.idle") {
                        const idleSessionId: string = props?.sessionID ?? props?.id ?? "";
                        const mySessionId = this.sessionIds.get(agent.id);

                        if (idleSessionId && mySessionId && idleSessionId === mySessionId) {
                            console.log(`[PersistentAgent] session.idle for agent "${agent.name}" session ${idleSessionId}`);
                            await this.resolvePromptFromIdle(agent, idleSessionId);
                        }
                    }
                }
            } catch (err) {
                if (abort.signal.aborted) break;
                console.warn(`[PersistentAgent] SSE stream for agent "${agent.name}" disconnected, retrying in ${retryDelay}ms`);
                await new Promise(r => setTimeout(r, retryDelay));
                retryDelay = Math.min(retryDelay * 2, 30000);
                await this.recoverPendingQuestions(agent);
            }
        }
    }

    /**
     * Called when session.idle arrives via SSE.
     * Fetches the last assistant message and resolves the pending Promise.
     */
    private async resolvePromptFromIdle(agent: PersistentAgent, sessionId: string): Promise<void> {
        const pending = this.pendingPrompts.get(agent.id);
        if (!pending || pending.sessionId !== sessionId) return;

        // Stop heartbeat — response arrived
        this.stopHeartbeat(agent.id);
        clearTimeout(pending.timeoutHandle);
        this.pendingPrompts.delete(agent.id);

        try {
            const msgRes = await fetch(
                `http://localhost:${agent.port}/session/${sessionId}/message`,
                { signal: AbortSignal.timeout(10000) }
            );
            if (!msgRes.ok) {
                pending.resolve({ output: `❌ Failed to fetch messages: ${msgRes.status}`, sessionId });
                return;
            }

            const messages: any[] = await msgRes.json();
            const lastAssistant = [...messages]
                .reverse()
                .find((m: any) => m.role === "assistant" || m.info?.role === "assistant");

            if (!lastAssistant) {
                pending.resolve({ output: "(sin respuesta del agente)", sessionId });
                return;
            }

            const parts: any[] = lastAssistant.parts || [];
            const text = parts
                .filter((p: any) => p.type === "text" && p.text)
                .map((p: any) => p.text as string)
                .join("");

            pending.resolve({ output: text.trim() || "(sin salida)", sessionId });
        } catch (err) {
            pending.resolve({ output: `❌ Failed to read agent response: ${err}`, sessionId });
        }
    }

    // ─── Question recovery ────────────────────────────────────────────────────

    private async recoverPendingQuestions(agent: PersistentAgent): Promise<void> {
        if (!this.onQuestion) return;

        try {
            const workdir = resolveDir(agent.workdir);
            const url = `http://localhost:${agent.port}/question?directory=${encodeURIComponent(workdir)}`;
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
            // No in-flight prompt — nothing to report, stop the timer
            this.stopHeartbeat(agent.id);
            return;
        }

        const minutesRunning = (Date.now() - pending.startedAt) / 60000;
        const status: HeartbeatSummary["status"] =
            minutesRunning >= STUCK_THRESHOLD_MIN ? "stuck" : "working";

        // Best-effort: grab the last assistant snippet for context
        let lastAction = "";
        try {
            const baseUrl = `http://localhost:${agent.port}`;
            const msgRes = await fetch(`${baseUrl}/session/${pending.sessionId}/message`, {
                signal: AbortSignal.timeout(5000),
            });
            if (msgRes.ok) {
                const messages: any[] = await msgRes.json();
                const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
                if (assistantMsgs.length > 0) {
                    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                    const parts: any[] = lastMsg.parts ?? [];
                    const textPart = [...parts].reverse().find((p: any) => p.type === "text" && p.text);
                    if (textPart) {
                        lastAction = (textPart.text as string).replace(/\s+/g, " ").trim().slice(0, 100);
                    }
                }
            }
        } catch { /* best-effort */ }

        try {
            await this.onHeartbeat(agent.id, {
                status,
                minutesRunning: Math.floor(minutesRunning),
                lastAction,
            });
        } catch (err) {
            console.error(`[PersistentAgent] heartbeat error for "${agent.name}":`, err);
        }
    }

    // ─── Reply to a question ──────────────────────────────────────────────────

    async replyQuestion(port: number, requestId: string, answers: string[][]): Promise<void> {
        await fetch(`http://localhost:${port}/question/${requestId}/reply`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answers }),
            signal: AbortSignal.timeout(10000),
        });
    }

    async rejectQuestion(port: number, requestId: string): Promise<void> {
        await fetch(`http://localhost:${port}/question/${requestId}/reject`, {
            method: "POST",
            signal: AbortSignal.timeout(10000),
        });
    }

    // ─── Prompt ───────────────────────────────────────────────────────────────

    /**
     * Send a prompt to a persistent agent's opencode server.
     *
     * Fire-and-forget: the prompt is sent via /prompt/async and this method
     * returns a Promise that is resolved by the SSE loop when session.idle
     * arrives for this agent's session. The heartbeat timer is started as a
     * safeguard in case session.idle never arrives.
     */
    async sendPrompt(agent: PersistentAgent, userText: string): Promise<AgentSendResult> {
        const baseUrl = `http://localhost:${agent.port}`;

        // Ensure the server is running
        const running = await this.isServerRunning(agent.port);
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
        const result = await new Promise<AgentSendResult>((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                if (this.pendingPrompts.get(agent.id)?.sessionId === sessionId) {
                    this.pendingPrompts.delete(agent.id);
                    this.stopHeartbeat(agent.id);
                    resolve({ output: "⏱️ Timeout: el agente no respondió en 10 minutos.", sessionId });
                }
            }, PROMPT_TIMEOUT_MS);

            if (timeoutHandle.unref) timeoutHandle.unref();

            this.pendingPrompts.set(agent.id, {
                sessionId,
                resolve,
                reject,
                startedAt: Date.now(),
                timeoutHandle,
            });

            // Send prompt async (fire and forget) — response comes via SSE session.idle
            fetch(`${baseUrl}/session/${sessionId}/prompt/async`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    parts: [{ type: "text", text: userText }],
                    agent: "build",
                    model: modelConfig,
                }),
                signal: AbortSignal.timeout(10000),
            }).then(res => {
                if (!res.ok) {
                    clearTimeout(timeoutHandle);
                    this.pendingPrompts.delete(agent.id);
                    this.stopHeartbeat(agent.id);
                    resolve({ output: `❌ Failed to send prompt: HTTP ${res.status}`, sessionId });
                } else {
                    // Prompt accepted — start the heartbeat safeguard
                    this.startHeartbeat(agent);
                }
            }).catch(err => {
                clearTimeout(timeoutHandle);
                this.pendingPrompts.delete(agent.id);
                this.stopHeartbeat(agent.id);
                resolve({ output: `❌ Failed to send prompt to agent: ${err}`, sessionId });
            });
        });

        return result;
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
        const running = await this.isServerRunning(agent.port);
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
