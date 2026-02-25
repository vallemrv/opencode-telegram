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

export class PersistentAgentService {
    /** Map of agentId → child process */
    private processes: Map<string, ChildProcess> = new Map();

    /** Map of agentId → SSE abort controller */
    private sseControllers: Map<string, AbortController> = new Map();

    /** Map of userId → active agentId (sticky switch) */
    private activeAgentByUser: Map<number, string> = new Map();

    /** Callback registered by OpenCodeBot to handle pending questions */
    private onQuestion?: OnQuestionCallback;

    /** Register the question callback (called once at startup by OpenCodeBot) */
    setOnQuestionCallback(cb: OnQuestionCallback): void {
        this.onQuestion = cb;
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
    }

    private stopSseStream(agentId: string): void {
        const ctrl = this.sseControllers.get(agentId);
        if (ctrl) {
            ctrl.abort();
            this.sseControllers.delete(agentId);
        }
    }

    private async runSseLoop(agent: PersistentAgent, abort: AbortController): Promise<void> {
        const baseUrl = `http://localhost:${agent.port}`;
        const client = createOpencodeClient({ baseUrl });
        let retryDelay = 3000;

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
            }
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
