/**
 * PersistentAgentService
 *
 * Manages long-lived `opencode serve` processes — one per persistent agent.
 * Each agent runs on its own fixed port, isolated from the main :4096 server.
 *
 * Responsibilities:
 * - Start an opencode serve process for an agent (if not already running)
 * - Stop a process (on agent deletion)
 * - Check whether a given port has a live opencode server
 * - Send a prompt to an agent's server and collect the SSE response
 * - Restart all known agents on bot startup
 * - Stream SSE events from each agent and fire onQuestion callback for tool:question
 * - Periodic heartbeat every 3 min to notify the user of agent progress
 * - Recover pending questions after SSE reconnects (via GET /question)
 */

import { spawn, ChildProcess } from "child_process";
import { access, constants } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { PersistentAgent } from "./agent-db.service.js";

export interface AgentSendResult {
    output: string;
    sessionId?: string;
}

/** Called by OpenCodeBot when the agent has a pending question for the user */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OnQuestionCallback = (agentId: string, req: any) => Promise<void>;

/** Summary sent to the bot on each heartbeat tick */
export interface HeartbeatSummary {
    /** Current agent status */
    status: "working" | "idle" | "stuck";
    /** Total message count in the latest active session */
    msgCount: number;
    /** Last 100 chars of the most recent assistant text */
    lastAction: string;
    /** Minutes elapsed since the first message of the active session */
    minutesRunning: number;
    /**
     * For idle status: last N assistant text snippets (up to 300 chars each),
     * so the bot can build a meaningful completion summary.
     */
    recentActions: string[];
}

/** Called by OpenCodeBot on each heartbeat tick */
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

/** Strip ANSI escape codes */
function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1B\[[0-9;]*[mGKHFABCDJnsu]/g, "").replace(/\x1B\([A-Z]/g, "");
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

/** Heartbeat interval in milliseconds (3 minutes) */
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;

/** Minutes of silence before an agent is considered "stuck" */
const STUCK_THRESHOLD_MIN = 10;

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

    /** Map of agentId → heartbeat timer handle */
    private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

    /**
     * Tracks message counts per agent to detect "stuck" state.
     * count: last seen message count
     * since: timestamp when count was last changed
     */
    private lastMsgCounts: Map<string, { count: number; since: number }> = new Map();

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
        });

        this.processes.set(agent.id, child);

        // Wait up to 20s for it to be ready
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (await this.isServerRunning(agent.port)) {
                this.startSseStream(agent);
                return { success: true, message: `opencode serve ready on :${agent.port}` };
            }
            await new Promise(r => setTimeout(r, 800));
        }

        return { success: false, message: `Server did not respond within 20s on port ${agent.port}` };
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

    // ─── SSE stream per agent ────────────────────────────────────────────────

    private startSseStream(agent: PersistentAgent): void {
        // Avoid duplicate streams
        if (this.sseControllers.has(agent.id)) return;

        const abort = new AbortController();
        this.sseControllers.set(agent.id, abort);

        // Run in background — no await
        this.runSseLoop(agent, abort).catch(err =>
            console.error(`[PersistentAgent] SSE loop error for agent ${agent.name}:`, err)
        );

        // Start heartbeat timer
        this.startHeartbeat(agent);
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

        // Recover any questions that were pending before this SSE connection
        await this.recoverPendingQuestions(agent);

        while (!abort.signal.aborted) {
            try {
                const events = await client.event.subscribe();
                retryDelay = 3000;

                for await (const event of events.stream) {
                    if (abort.signal.aborted) break;

                    if ((event as any).type === "question.asked" && this.onQuestion) {
                        const req = (event as any).properties;
                        console.log(`[PersistentAgent] question.asked for agent "${agent.name}": ${req.id}`);
                        this.onQuestion(agent.id, req).catch(err =>
                            console.error(`[PersistentAgent] onQuestion callback error:`, err)
                        );
                    }
                }
            } catch (err) {
                if (abort.signal.aborted) break;
                console.warn(`[PersistentAgent] SSE stream for agent "${agent.name}" disconnected, retrying in ${retryDelay}ms`);
                await new Promise(r => setTimeout(r, retryDelay));
                retryDelay = Math.min(retryDelay * 2, 30000);

                // Recover pending questions after each reconnect
                await this.recoverPendingQuestions(agent);
            }
        }
    }

    // ─── Question recovery ────────────────────────────────────────────────────

    /**
     * Queries GET /question?directory=<workdir> on the agent's server to find
     * any questions that were asked while the bot was offline (their SSE event
     * was never received).  For each unanswered question we fire onQuestion
     * exactly as if the SSE event had just arrived.
     */
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
                // Each item in the array IS the QuestionRequest (has .id, .questions[])
                this.onQuestion(agent.id, q).catch(err =>
                    console.error(`[PersistentAgent] recoverPendingQuestions callback error:`, err)
                );
            }
        } catch (err) {
            // Non-fatal — server may not have pending questions or endpoint may not exist
            console.debug(`[PersistentAgent] recoverPendingQuestions for "${agent.name}": ${err}`);
        }
    }

    // ─── Heartbeat ───────────────────────────────────────────────────────────

    private startHeartbeat(agent: PersistentAgent): void {
        if (this.heartbeatTimers.has(agent.id)) return;

        const timer = setInterval(async () => {
            await this.fireHeartbeat(agent);
        }, HEARTBEAT_INTERVAL_MS);

        // Allow the Node process to exit even if the timer is still running
        if (timer.unref) timer.unref();

        this.heartbeatTimers.set(agent.id, timer);
    }

    private stopHeartbeat(agentId: string): void {
        const timer = this.heartbeatTimers.get(agentId);
        if (timer) {
            clearInterval(timer);
            this.heartbeatTimers.delete(agentId);
        }
        this.lastMsgCounts.delete(agentId);
    }

    private async fireHeartbeat(agent: PersistentAgent): Promise<void> {
        if (!this.onHeartbeat) return;

        try {
            const summary = await this.buildHeartbeatSummary(agent);
            await this.onHeartbeat(agent.id, summary);
        } catch (err) {
            console.error(`[PersistentAgent] heartbeat error for "${agent.name}":`, err);
        }
    }

    private async buildHeartbeatSummary(agent: PersistentAgent): Promise<HeartbeatSummary> {
        const baseUrl = `http://localhost:${agent.port}`;
        const EMPTY: HeartbeatSummary = { status: "idle", msgCount: 0, lastAction: "", minutesRunning: 0, recentActions: [] };

        let msgCount = 0;
        let lastAction = "";
        let minutesRunning = 0;
        let status: HeartbeatSummary["status"] = "idle";
        const recentActions: string[] = [];

        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (!sessRes.ok) return EMPTY;

            const sessions: any[] = await sessRes.json();
            if (sessions.length === 0) return EMPTY;

            // Only consider sessions created by this bot (title starts with "tg-").
            // Ignores interactive/subagent sessions that happen to run on the same server.
            const botSessions = sessions.filter((s: any) => (s.title ?? "").startsWith("tg-"));
            if (botSessions.length === 0) return EMPTY;

            // Pick most recently updated bot session
            const session = botSessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];

            // Fetch messages for this session
            const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
                signal: AbortSignal.timeout(5000),
            });
            if (!msgRes.ok) return EMPTY;

            const messages: any[] = await msgRes.json();
            msgCount = messages.length;

            // Extract assistant text parts
            const assistantMsgs = messages.filter((m: any) => m.role === "assistant");

            // Last action: last 100 chars of the most recent assistant text
            if (assistantMsgs.length > 0) {
                const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                const parts: any[] = lastMsg.parts ?? [];
                const textPart = [...parts].reverse().find((p: any) => p.type === "text" && p.text);
                if (textPart) {
                    lastAction = (textPart.text as string).replace(/\s+/g, " ").trim().slice(0, 100);
                }
            }

            // Recent actions: last 5 unique assistant text snippets (up to 300 chars each)
            // Used to build a rich completion summary
            const seen = new Set<string>();
            for (let i = assistantMsgs.length - 1; i >= 0 && recentActions.length < 5; i--) {
                const parts: any[] = assistantMsgs[i].parts ?? [];
                const textPart = [...parts].reverse().find((p: any) => p.type === "text" && p.text);
                if (!textPart) continue;
                const snippet = (textPart.text as string).replace(/\s+/g, " ").trim().slice(0, 300);
                if (snippet && !seen.has(snippet)) {
                    seen.add(snippet);
                    recentActions.unshift(snippet);
                }
            }

            // Compute minutesRunning from first message timestamp
            if (messages.length > 0 && messages[0].time?.created) {
                minutesRunning = Math.floor((Date.now() - messages[0].time.created) / 60000);
            }

            // Check if there's a running step (no step-finish in the last assistant msg)
            const lastAsst = assistantMsgs[assistantMsgs.length - 1];
            const hasRunningStep = lastAsst &&
                !(lastAsst.parts ?? []).some((p: any) => p.type === "step-finish");

            if (hasRunningStep) {
                // Check stuck: message count hasn't changed for > STUCK_THRESHOLD_MIN
                const prev = this.lastMsgCounts.get(agent.id);
                if (prev && prev.count === msgCount) {
                    const silentMin = (Date.now() - prev.since) / 60000;
                    status = silentMin >= STUCK_THRESHOLD_MIN ? "stuck" : "working";
                } else {
                    this.lastMsgCounts.set(agent.id, { count: msgCount, since: Date.now() });
                    status = "working";
                }
            } else {
                // No running step — agent is idle
                this.lastMsgCounts.delete(agent.id);
                status = "idle";
            }
        } catch {
            // Server unreachable
            status = "idle";
        }

        return { status, msgCount, lastAction, minutesRunning, recentActions };
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
     * Uses the REST API directly (same as the main OpenCodeService).
     * Attaches the agent's role as a system-context prefix.
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

        // Build full prompt with role context
        const roleContext = agent.role
            ? `<agent_role>\n${agent.role}\n</agent_role>\n\n`
            : "";
        const fullPrompt = `${roleContext}${userText}`;

        // Create a session on this agent's server
        let sessionId: string;
        try {
            const createRes = await fetch(`${baseUrl}/session`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: `tg-${Date.now()}`,
                    permission: [
                        { permission: "command", pattern: "*", action: "allow" },
                        { permission: "file",    pattern: "*", action: "allow" },
                        { permission: "network", pattern: "*", action: "allow" },
                        { permission: "browser", pattern: "*", action: "allow" },
                    ],
                }),
                signal: AbortSignal.timeout(10000),
            });
            if (!createRes.ok) throw new Error(`Create session failed: ${createRes.status}`);
            const sess = await createRes.json() as any;
            sessionId = sess.id;
        } catch (err) {
            return { output: `❌ Failed to create session on agent server: ${err}` };
        }

        // Send prompt synchronously (blocking until done) using /session/:id/prompt
        // We use opencode run --attach so we leverage its built-in output parsing
        const cmd = await findOpencodeCmd();
        const workdir = resolveDir(agent.workdir);

        return new Promise((resolve) => {
            const args = [
                "run",
                "--attach", baseUrl,
                "--session", sessionId,
                "--dir", workdir,
                "--model", agent.model,
                fullPrompt,
            ];

            const child = spawn(cmd, args, {
                cwd: workdir,
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env },
            });

            const lines: string[] = [];
            const handleData = (buf: Buffer) => {
                const cleaned = stripAnsi(buf.toString("utf8"));
                for (const line of cleaned.split("\n")) {
                    const t = line.trim();
                    if (!t || t.startsWith(">")) continue;
                    lines.push(t);
                }
            };

            child.stdout.on("data", handleData);
            child.stderr.on("data", handleData);

            child.on("close", () => {
                resolve({ output: lines.join("\n").trim() || "(sin salida)", sessionId });
            });
            child.on("error", (err) => {
                resolve({ output: `❌ opencode run error: ${err.message}`, sessionId });
            });
        });
    }

    // ─── Active agent switching (sticky) ─────────────────────────────────────

    setActiveAgent(userId: number, agentId: string): void {
        this.activeAgentByUser.set(userId, agentId);
    }

    /** Returns null if no subagent is active (→ use main OpenCode session) */
    getActiveAgentId(userId: number): string | null {
        return this.activeAgentByUser.get(userId) ?? null;
    }

    clearActiveAgent(userId: number): void {
        this.activeAgentByUser.delete(userId);
    }

    // ─── Startup restore ──────────────────────────────────────────────────────

    /**
     * Call this on bot startup to bring all persisted agents back online.
     * Returns a list of agents that failed to start, so the caller can notify
     * the user via Telegram.
     */
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
