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
import { realpathSync, existsSync, writeFileSync } from "fs";
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
    /** Last snippet of assistant text (up to 300 chars) — best-effort */
    lastText: string;
    /** Total number of messages in the session so far */
    messageCount: number;
    /** Number of file-modifying tool calls (edit / write / patch) seen so far */
    filesModified: number;
    /** True if approaching hard timeout (80% of TIMEOUT_MS) */
    isNearTimeout?: boolean;
    /** List of recently modified file paths (up to 5) */
    recentFiles: string[];
    /** Last bash command executed, if any */
    lastBashCmd: string;
    /** True when stream received events recently */
    streamConnected?: boolean;
    /** Seconds since the last SSE event seen for this agent */
    secondsSinceLastEvent?: number;
    /** Last known session status from session.status events */
    sessionStatus?: "busy" | "retry" | "idle";
}

/** Called by OpenCodeBot on each heartbeat tick (only while a prompt is in-flight) */
export type OnHeartbeatCallback = (agentId: string, summary: HeartbeatSummary) => Promise<void>;

/** Called by OpenCodeBot to clear the heartbeat message when a prompt completes (success or error) */
export type OnHeartbeatClearCallback = (agentId: string) => Promise<void>;

/**
 * Called when the bot reconnects after a restart and finds a busy session
 * already in progress on the opencode server.
 * The bot should:
 *   1. Send a notification message to the user ("recovered in-progress job")
 *   2. Store the returned msgId as the heartbeat placeholder (so the result
 *      replaces that message when the session finishes)
 * Returns { chatId, msgId } of the placeholder message, or null if it could
 * not be sent (e.g. bot not yet ready).
 */
export type OnAdoptSessionCallback = (
    agentId: string,
    userId: number,
) => Promise<{ chatId: number; msgId: number } | null>;

/**
 * Called when an adopted (recovered) session finally resolves.
 * The bot receives the chatId/msgId of the placeholder sent by OnAdoptSessionCallback
 * and the final result, so it can edit/replace the placeholder with the actual response.
 */
export type OnAdoptSessionResultCallback = (
    agentId: string,
    chatId: number,
    msgId: number,
    result: AgentSendResult,
) => Promise<void>;

/**
 * Called at startup when a persisted heartbeat placeholder exists for an agent
 * but the underlying opencode session is no longer busy and cannot be adopted
 * (server restarted too, session 404'd, etc.). The bot should edit the
 * placeholder message to let the user know their work was lost and then
 * drop the heartbeat entry.
 */
export type OnLostPromptCallback = (
    agentId: string,
    chatId: number,
    msgId: number,
) => Promise<void>;

/**
 * Lookup for persisted heartbeat placeholders. The service does not own the
 * SQLite connection; the bot injects this lookup so we keep the service
 * layer unaware of the DB schema.
 */
export type HeartbeatLookup = (
    agentId: string,
) => { chatId: number; msgId: number } | undefined;

/** Resolve ~ in paths */
export function resolveDir(p: string): string {
    let resolved = p;
    if (resolved.startsWith("~/") || resolved === "~") {
        resolved = path.join(os.homedir(), resolved.slice(1));
    }
    try {
        resolved = realpathSync(resolved);
    } catch {
        // path may not exist yet; return the expanded path as-is
    }
    return resolved;
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
    // Allow explicit override via env var (useful when systemd PATH lacks nvm)
    if (process.env.OPENCODE_CMD) {
        try { await access(process.env.OPENCODE_CMD, constants.X_OK); return process.env.OPENCODE_CMD; } catch { /* invalid, fall through */ }
    }

    // Force use /usr/bin/opencode explicitly
    const forcedPath = "/usr/bin/opencode";
    try {
        await access(forcedPath, constants.X_OK);
        return forcedPath;
    } catch { /* fall through to other candidates */ }

    // Prefer the opencode found in PATH (e.g. nvm-installed) over the local
    // node_modules copy which may be an older version with a different model list.
    try {
        const { execSync } = await import("child_process");
        const found = execSync("which opencode 2>/dev/null").toString().trim();
        if (found) return found;
    } catch { /* not in PATH, try static candidates */ }

    const candidates = [
        "/usr/local/bin/opencode",
        path.join(process.env.HOME || "", ".opencode", "bin", "opencode"),
        path.join(process.cwd(), "node_modules", ".bin", "opencode"),
    ];
    for (const p of candidates) {
        try { await access(p, constants.X_OK); return p; } catch { /* next */ }
    }
    throw new Error("opencode binary not found");
}

/** Heartbeat interval while a prompt is in-flight */
const HEARTBEAT_INTERVAL_MS = 20 * 1000;

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

    /** Callback registered by OpenCodeBot to clear heartbeat message when prompt completes */
    private onHeartbeatClear?: OnHeartbeatClearCallback;

    /** Callback registered by OpenCodeBot to handle adopted (recovered) sessions after restart */
    private onAdoptSession?: OnAdoptSessionCallback;

    /** Called when an adopted (recovered) session finally resolves. */
    private onAdoptSessionResult?: OnAdoptSessionResultCallback;

    /** Called when a persisted heartbeat exists but no session can be recovered. */
    private onLostPrompt?: OnLostPromptCallback;

    /** Lookup for persisted heartbeat placeholder (chatId + msgId) by agentId. */
    private heartbeatLookup?: HeartbeatLookup;

    /** Map of agentId → heartbeat timer handle (only active while prompt is in-flight) */
    private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

    /** Map of agentId → timestamp (ms) of last SSE event received */
    private lastSseEventAt: Map<string, number> = new Map();

    /** Map of agentId → last known session.status.type */
    private lastSessionStatus: Map<string, "busy" | "retry" | "idle"> = new Map();

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

    /**
     * Set of question IDs already forwarded to the bot.
     * Prevents duplicate question messages when the SSE stream reconnects.
     */
    private forwardedQuestionIds: Set<string> = new Set();

    /**
     * Per-agent set of child session IDs that are currently active (not yet idle).
     * Populated from session.created events (when info.parentID matches our session)
     * and cleared when session.idle arrives for each child.
     * Used to avoid resolving the parent prompt prematurely when the parent session
     * briefly goes idle between sub-agent invocations.
     *
     * Key: agentId. Value: Set of active child sessionIDs.
     */
    private activeChildSessions: Map<string, Set<string>> = new Map();

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

    /** Register the heartbeat clear callback (called once at startup by OpenCodeBot) */
    setOnHeartbeatClearCallback(cb: OnHeartbeatClearCallback): void {
        this.onHeartbeatClear = cb;
    }

    /** Register the adopt-session callback (called once at startup by OpenCodeBot) */
    setOnAdoptSessionCallback(cb: OnAdoptSessionCallback): void {
        this.onAdoptSession = cb;
    }

    /** Register the adopt-session result callback (called once at startup by OpenCodeBot) */
    setOnAdoptSessionResultCallback(cb: OnAdoptSessionResultCallback): void {
        this.onAdoptSessionResult = cb;
    }

    /** Callback invoked when a persisted heartbeat cannot be recovered after restart. */
    setOnLostPromptCallback(cb: OnLostPromptCallback): void {
        this.onLostPrompt = cb;
    }

    /** Inject a lookup that returns persisted heartbeat placeholders by agentId. */
    setHeartbeatLookup(lookup: HeartbeatLookup): void {
        this.heartbeatLookup = lookup;
    }

    // ─── Server lifecycle ─────────────────────────────────────────────────────

    async startAgent(agent: PersistentAgent): Promise<{ success: boolean; message: string }> {
        console.log(`[PersistentAgent.startAgent] Starting agent "${agent.name}" (ID: ${agent.id}, isRemote: ${agent.isRemote}, host: ${agent.host || 'N/A'}, port: ${agent.port})`);
        
        if (this.processes.has(agent.id)) {
            console.log(`[PersistentAgent.startAgent] Agent already has a local process, returning success`);
            return { success: true, message: "already running" };
        }

        if (await this.isServerRunning(agent)) {
            console.log(`[PersistentAgent.startAgent] Server is already running at ${agent.host || 'localhost'}:${agent.port}, ensuring session and starting SSE`);
            await this.ensureSession(agent);
            this.startSseStream(agent);
            return { success: true, message: "already running (external)" };
        }

        // Remote agents run on another machine — we never spawn a local process for them
        if (agent.isRemote) {
            console.log(`[PersistentAgent.startAgent] Agent is remote (${agent.host}:${agent.port}), checking if reachable...`);
            
            // Try to connect to the remote server
            const remoteUrl = `http://${agent.host}:${agent.port}`;
            try {
                console.log(`[PersistentAgent.startAgent] Testing connection to ${remoteUrl}`);
                const testRes = await fetch(remoteUrl, {
                    method: 'HEAD',
                    signal: AbortSignal.timeout(5000),
                });
                console.log(`[PersistentAgent.startAgent] Remote server responded with status: ${testRes.status}`);
                
                if (testRes.ok || testRes.status < 500) {
                    console.log(`[PersistentAgent.startAgent] Remote server is reachable, ensuring session and starting SSE`);
                    await this.ensureSession(agent);
                    this.startSseStream(agent);
                    return { success: true, message: `remote agent ${agent.host}:${agent.port} is reachable` };
                } else {
                    console.error(`[PersistentAgent.startAgent] Remote server returned unexpected status: ${testRes.status}`);
                    return { success: false, message: `Remote agent ${agent.host}:${agent.port} returned HTTP ${testRes.status}` };
                }
            } catch (err: any) {
                console.error(`[PersistentAgent.startAgent] Failed to connect to remote agent at ${remoteUrl}:`, err.message);
                return { success: false, message: `Remote agent ${agent.host}:${agent.port} is not reachable: ${err.message || err}` };
            }
        }

        console.log(`[PersistentAgent.startAgent] Agent is local, finding opencode binary...`);
        let cmd: string;
        try {
            cmd = await findOpencodeCmd();
            console.log(`[PersistentAgent.startAgent] Found opencode binary at: ${cmd}`);
        } catch (e) {
            console.error(`[PersistentAgent.startAgent] opencode binary not found:`, e);
            return { success: false, message: "opencode binary not found" };
        }
        
        const workdir = resolveDir(agent.workdir);
        console.log(`[PersistentAgent.startAgent] Workdir: ${workdir}`);

        // Ensure opencode.json exists in workdir to anchor the workspace root here,
        // preventing opencode from walking up the directory tree to a parent folder.
        const opencodeJsonPath = path.join(workdir, "opencode.json");
        if (!existsSync(opencodeJsonPath)) {
            try {
                writeFileSync(opencodeJsonPath, "{}\n", { encoding: "utf-8" });
                console.log(`[PersistentAgent.startAgent] Created opencode.json in ${workdir} to anchor workspace`);
            } catch (e: any) {
                console.warn(`[PersistentAgent.startAgent] Could not create opencode.json in ${workdir}: ${e.message}`);
            }
        }

        const hostname = process.env.OPENCODE_BIND_HOST || "0.0.0.0";
        console.log(`[PersistentAgent.startAgent] Spawning opencode serve on ${hostname}:${agent.port}`);
        const shellCmd = `cd ${workdir} && ${cmd} serve --port ${agent.port} --hostname ${hostname}`;
        console.log(`[PersistentAgent.startAgent] Shell command: ${shellCmd}`);
        const child = spawn("sh", ["-c", shellCmd], {
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
        const expectedDir = resolveDir(agent.workdir);

        console.log(`[PersistentAgent.ensureSession] Agent "${agent.name}" (${agent.id}), host: ${host}, port: ${agent.port}, cachedSessionId: ${cachedId || 'N/A'}`);

        if (cachedId) {
            try {
                console.log(`[PersistentAgent.ensureSession] Checking if existing session ${cachedId} is still valid`);
                const res = await fetch(`${baseUrl}/session/${cachedId}`, {
                    signal: AbortSignal.timeout(5000),
                });
                if (res.ok) {
                    const sess: any = await res.json();
                    // Validate that the session belongs to this agent's workdir.
                    // Normalize both paths to avoid false mismatches (e.g. symlinks, trailing slash).
                    const actualDir = typeof sess.directory === "string" ? resolveDir(sess.directory) : "";
                    if (actualDir && actualDir !== expectedDir) {
                        console.log(`[PersistentAgent.ensureSession] Session ${cachedId} belongs to a different directory (${actualDir} vs ${expectedDir}), creating new session`);
                    } else {
                        this.sessionIds.set(agent.id, cachedId);
                        console.log(`[PersistentAgent.ensureSession] Existing session ${cachedId} is valid`);
                        return cachedId;
                    }
                } else {
                    console.log(`[PersistentAgent.ensureSession] Existing session ${cachedId} returned status ${res.status}, creating new session`);
                }
            } catch (err: any) {
                console.log(`[PersistentAgent.ensureSession] Error checking session ${cachedId}: ${err.message || err}`);
            }
            console.log(`[PersistentAgent.ensureSession] Session ${cachedId} for agent "${agent.name}" is gone or mismatched, creating a new one`);
        }

        const sessionId = await this.createSession(agent);
        this.sessionIds.set(agent.id, sessionId);
        this.agentDb.setSessionId(agent.id, sessionId);
        console.log(`[PersistentAgent.ensureSession] Created new session ${sessionId} for agent "${agent.name}"`);
        return sessionId;
    }

    /** Create a new OpenCode session on the agent's server. Returns the new session ID. */
    private async createSession(agent: PersistentAgent): Promise<string> {
        const host = agent.host || 'localhost';
        const baseUrl = `http://${host}:${agent.port}`;
        const workdir = resolveDir(agent.workdir);
        console.log(`[PersistentAgent.createSession] Creating session for agent "${agent.name}" at ${baseUrl}`);

        let modelConfig: { providerID: string; modelID: string } | undefined;
        if (agent.model) {
            const parts = agent.model.split("/");
            if (parts.length === 2) {
                modelConfig = { providerID: parts[0], modelID: parts[1] };
                console.log(`[PersistentAgent.createSession] Using model: ${modelConfig.providerID}/${modelConfig.modelID}`);
            }
        }

        const createRes = await fetch(`${baseUrl}/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: `tg-${agent.name}`,
                // Force exact workspace directory for the session.
                directory: workdir,
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

        console.log(`[PersistentAgent.createSession] Session creation response status: ${createRes.status}`);

        if (!createRes.ok) {
            const errorText = await createRes.text().catch(() => 'N/A');
            console.error(`[PersistentAgent.createSession] Session creation failed: ${createRes.status} - ${errorText}`);
            throw new Error(`Create session failed: ${createRes.status} ${errorText}`);
        }

        const sess = await createRes.json() as any;
        console.log(`[PersistentAgent.createSession] Session created with ID: ${sess.id}`);
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
        
        const url = `http://${host}:${port}`;
        try {
            console.log(`[PersistentAgent.isServerRunning] Checking server at ${url}`);
            const res = await fetch(`http://${host}:${port}`, {
                method: "HEAD",
                signal: AbortSignal.timeout(3000),
            });
            const result = res.ok || res.status < 500;
            console.log(`[PersistentAgent.isServerRunning] Server at ${url} responded: ${result ? 'RUNNING' : 'NOT RUNNING'} (status: ${res.status})`);
            return result;
        } catch (err: any) {
            console.log(`[PersistentAgent.isServerRunning] Server at ${url} NOT reachable: ${err.message || err}`);
            return false;
        }
    }

    isProcessManaged(agentId: string): boolean {
        return this.processes.has(agentId);
    }

    // ─── SSE stream per agent ─────────────────────────────────────────────────

    private startSseStream(agent: PersistentAgent): void {
        if (this.sseControllers.has(agent.id)) {
            console.log(`[PersistentAgent.startSseStream] SSE stream already running for agent "${agent.name}"`);
            return;
        }

        console.log(`[PersistentAgent.startSseStream] Starting SSE stream for agent "${agent.name}" at ${agent.host || 'localhost'}:${agent.port}`);
        const abort = new AbortController();
        this.sseControllers.set(agent.id, abort);
        this.lastSseEventAt.set(agent.id, Date.now());

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
        this.lastSessionStatus.delete(agentId);
    }

    private async runSseLoop(agent: PersistentAgent, abort: AbortController): Promise<void> {
        const host = agent.host || 'localhost';
        const baseUrl = `http://${host}:${agent.port}`;
        const client = createOpencodeClient({ baseUrl });
        let retryDelay = 3000;
        // Maximum time to keep a single SSE connection alive before forcing a reconnect.
        // This prevents the stream from hanging silently when the TCP connection goes stale.
        const SSE_RECONNECT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

        await this.recoverPendingQuestions(agent);
        await this.recoverPendingPrompt(agent);

        while (!abort.signal.aborted) {
            // Per-connection abort: forces reconnect every SSE_RECONNECT_INTERVAL_MS
            const connAbort = new AbortController();
            const connTimeout = setTimeout(() => {
                if (!abort.signal.aborted) {
                    console.log(`[PersistentAgent] SSE connection for agent "${agent.name}" exceeded ${SSE_RECONNECT_INTERVAL_MS / 1000}s — forcing reconnect`);
                    connAbort.abort();
                }
            }, SSE_RECONNECT_INTERVAL_MS);
            abort.signal.addEventListener("abort", () => connAbort.abort(), { once: true });

            try {
                const events = await client.event.subscribe();
                retryDelay = 3000;

                for await (const event of events.stream) {
                    if (abort.signal.aborted || connAbort.signal.aborted) break;

                    this.lastSseEventAt.set(agent.id, Date.now());

                    const type = (event as any).type;
                    const props = (event as any).properties;

                    if (type === "server.connected" || type === "server.heartbeat") {
                        continue;
                    }

                    if (type === "session.status") {
                        const statusType = props?.status?.type;
                        const sessionStatus =
                            statusType === "busy" || statusType === "retry" || statusType === "idle"
                                ? (statusType as "busy" | "retry" | "idle")
                                : undefined;
                        if (sessionStatus) {
                            this.lastSessionStatus.set(agent.id, sessionStatus);
                        }
                    }

                    // ── question.asked → forward to bot ───────────────────
                    if (type === "question.asked" && this.onQuestion) {
                        const questionId: string = props.id ?? "";
                        console.log(`[PersistentAgent] question.asked for agent "${agent.name}": ${questionId}`);
                        // Deduplicate: skip if already forwarded (can happen on SSE reconnect)
                        if (!questionId || !this.forwardedQuestionIds.has(questionId)) {
                            if (questionId) this.forwardedQuestionIds.add(questionId);
                            this.onQuestion(agent.id, props).catch(err =>
                                console.error(`[PersistentAgent] onQuestion callback error:`, err)
                            );
                        } else {
                            console.log(`[PersistentAgent] question.asked for agent "${agent.name}" already forwarded, skipping duplicate`);
                        }
                    }

                    // ── session.error → notify bot and resolve pending ─────
                    if (type === "session.error") {
                        const errorSessionId: string = props?.sessionID ?? props?.id ?? "";
                        const mySessionId = this.sessionIds.get(agent.id);
                        let errorMessage: string =
                            props?.error?.message ?? props?.message ??
                            (typeof props?.error === "string" ? props.error : null) ??
                            "Error desconocido del modelo";
                        
                        // Extraer mensaje real de errores anidados (ej: APIError con data.message)
                        if ((errorMessage === "Error desconocido del modelo" || errorMessage?.includes("Unauthorized")) && props?.error?.data) {
                            const nestedMessage = props.error.data?.message || props.error.data?.error?.message;
                            if (nestedMessage) {
                                errorMessage = nestedMessage;
                            }
                        }

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
                                // NOTE: Do NOT call onHeartbeatClear here — same race
                                // condition as in resolvePromptFromIdle. OpenCodeBot's
                                // .then() handler will clear heartbeatMessages after
                                // sending/editing the result message.
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

                    // ── session.created → track child sessions ────────────
                    if (type === "session.created") {
                        const createdInfo: any = props?.info ?? props;
                        const createdId: string = createdInfo?.id ?? "";
                        const parentId: string = createdInfo?.parentID ?? "";
                        const mySessionId = this.sessionIds.get(agent.id);

                        if (createdId && parentId && mySessionId && parentId === mySessionId) {
                            // This is a child session spawned by our parent session.
                            // Track it so we know the parent is still working.
                            const children = this.activeChildSessions.get(agent.id) ?? new Set<string>();
                            children.add(createdId);
                            this.activeChildSessions.set(agent.id, children);
                            console.log(`[PersistentAgent] session.created: child "${createdId}" tracked for agent "${agent.name}" (parent "${mySessionId}"), active children: ${children.size}`);
                        }
                    }

                    // ── session.idle → resolve in-flight prompt ───────────
                    if (type === "session.idle") {
                        const idleSessionId: string = props?.sessionID ?? props?.id ?? "";
                        const mySessionId = this.sessionIds.get(agent.id);
                        const pendingPrompt = this.pendingPrompts.get(agent.id);

                        console.log(`[PersistentAgent] session.idle event: agent="${agent.name}", idleSessionId="${idleSessionId}", mySessionId="${mySessionId || 'N/A'}", hasPendingPrompt=${!!pendingPrompt}`);

                        // Case 1: event is for our parent session → resolve directly
                        const isParentSession =
                            !idleSessionId ||
                            !mySessionId ||
                            idleSessionId === mySessionId;

                        if (isParentSession) {
                            // Before resolving, clear all tracked children (parent is done)
                            this.activeChildSessions.delete(agent.id);
                            if (pendingPrompt) {
                                const resolveId = idleSessionId || mySessionId || "";
                                console.log(`[PersistentAgent] session.idle for PARENT session "${resolveId}" — resolving prompt for agent "${agent.name}"`);
                                await this.resolvePromptFromIdle(agent, resolveId);
                            } else {
                                console.log(`[PersistentAgent] session.idle: NO pending prompt to resolve for agent "${agent.name}"`);
                            }
                        } else if (pendingPrompt) {
                            // Case 2: event is for a different session — likely a child/sub-agent.
                            // Mark the child as idle in our tracking set.
                            const children = this.activeChildSessions.get(agent.id);
                            if (children?.has(idleSessionId)) {
                                children.delete(idleSessionId);
                                console.log(`[PersistentAgent] session.idle: child "${idleSessionId}" finished. Remaining active children: ${children.size}`);

                                if (children.size === 0) {
                                    // All tracked children are done. Check if parent is also idle
                                    // (its own session.idle may not arrive if it delegated everything).
                                    console.log(`[PersistentAgent] All children idle — checking parent "${mySessionId}" status`);
                                    await this.handleChildSessionIdle(agent, idleSessionId, mySessionId ?? "");
                                }
                                // If children.size > 0, more sub-agents are still running — wait.
                            } else {
                                // Unknown session (not tracked as our child) — could be a child
                                // created before we started tracking or from a previous run.
                                // Check the parent's status to be safe.
                                console.log(`[PersistentAgent] session.idle for untracked session "${idleSessionId}" — checking parent "${mySessionId}" status`);
                                await this.handleChildSessionIdle(agent, idleSessionId, mySessionId ?? "");
                            }
                        }
                    }
                }
            } catch (err) {
                clearTimeout(connTimeout);
                if (abort.signal.aborted) break;
                // If it was a forced reconnect (connAbort), retry immediately without backoff
                if (connAbort.signal.aborted && !abort.signal.aborted) {
                    console.log(`[PersistentAgent] SSE reconnect triggered for agent "${agent.name}" — reconnecting immediately`);
                    await this.recoverPendingQuestions(agent);
                    await this.recoverPendingPrompt(agent);
                    continue;
                }
                console.warn(`[PersistentAgent] SSE stream for agent "${agent.name}" disconnected, retrying in ${retryDelay}ms`);
                await new Promise(r => setTimeout(r, retryDelay));
                retryDelay = Math.min(retryDelay * 2, 15000);
                await this.recoverPendingQuestions(agent);
                await this.recoverPendingPrompt(agent);
            } finally {
                clearTimeout(connTimeout);
            }
        }
    }

    /**
     * Called when session.idle arrives via SSE.
     * Fetches the last assistant message and resolves the pending Promise.
     */
    private async resolvePromptFromIdle(agent: PersistentAgent, sessionId: string): Promise<void> {
        console.log(`[PersistentAgent.resolvePromptFromIdle] ENTER: agent="${agent.name}", sessionId="${sessionId}"`);
        
        const pending = this.pendingPrompts.get(agent.id);
        // Accept the event if there is a pending prompt AND either:
        //   (a) sessionId matches exactly, or
        //   (b) sessionId is empty (opencode omitted it) — assume it's ours
        if (!pending) {
            console.log(`[PersistentAgent.resolvePromptFromIdle] NO pending prompt found for agent "${agent.id}"`);
            return;
        }
        if (sessionId && pending.sessionId && sessionId !== pending.sessionId) {
            console.log(`[PersistentAgent.resolvePromptFromIdle] SessionId mismatch: event="${sessionId}", pending="${pending.sessionId}"`);
            return;
        }

        console.log(`[PersistentAgent.resolvePromptFromIdle] Resolving prompt for agent "${agent.name}"`);

        // Stop heartbeat — response arrived
        this.stopHeartbeat(agent.id);
        this.pendingPrompts.delete(agent.id);
        // Clear child session tracking — the whole task is done
        this.activeChildSessions.delete(agent.id);

        // NOTE: Do NOT call onHeartbeatClear here. The heartbeatMessages reference
        // must remain intact so that OpenCodeBot.sendPromptToAgent can read it in
        // its .then() handler to edit/delete the correct placeholder message.
        // OpenCodeBot is responsible for clearing heartbeatMessages after use.

        try {
            const host = agent.host || 'localhost';
            const resolveSessionId = pending.sessionId || sessionId;
            console.log(`[PersistentAgent.resolvePromptFromIdle] Fetching messages from http://${host}:${agent.port}/session/${resolveSessionId}/message`);
            
            const msgRes = await fetch(
                `http://${host}:${agent.port}/session/${resolveSessionId}/message`,
                { signal: AbortSignal.timeout(10000) }
            );
            console.log(`[PersistentAgent.resolvePromptFromIdle] Fetch response status: ${msgRes.status}`);
            
            if (!msgRes.ok) {
                console.log(`[PersistentAgent.resolvePromptFromIdle] HTTP error: ${msgRes.status}`);
                pending.resolve({ output: `❌ Error al leer mensajes: HTTP ${msgRes.status}`, sessionId: resolveSessionId });
                return;
            }

            const messages: any[] = await msgRes.json();
            console.log(`[PersistentAgent.resolvePromptFromIdle] Received ${messages.length} messages`);
            
            const lastAssistant = [...messages]
                .reverse()
                .find((m: any) => m.role === "assistant" || m.info?.role === "assistant");

            if (!lastAssistant) {
                console.log(`[PersistentAgent.resolvePromptFromIdle] No assistant message found`);
                pending.resolve({ output: "⚠️ Sin respuesta del asistente", sessionId: resolveSessionId });
                return;
            }

            console.log(`[PersistentAgent.resolvePromptFromIdle] Found assistant message with ${lastAssistant.parts?.length || 0} parts`);

            const parts: any[] = lastAssistant.parts || [];
            const text = parts
                .filter((p: any) => p.type === "text" && p.text)
                .map((p: any) => p.text as string)
                .join("");

            // Diferenciar entre:
            // - Respuesta vacía genuina (se ejecutó todo pero no escribió nada)
            // - Error de lectura
            const trimmed = text.trim();
            console.log(`[PersistentAgent.resolvePromptFromIdle] Extracted text length: ${trimmed.length} chars`);
            
            if (!trimmed) {
                // Verificar si hubo llamadas a herramientas (indica que trabajó)
                const hasTools = parts.some((p: any) => p.type === "tool-invocation");
                console.log(`[PersistentAgent.resolvePromptFromIdle] Empty text, hasTools=${hasTools}`);
                if (hasTools) {
                    pending.resolve({ output: "✅ Completado (ejecutó herramientas pero no generó texto)", sessionId: resolveSessionId });
                } else {
                    pending.resolve({ output: "⚠️ Sin salida (ejecución vacía)", sessionId: resolveSessionId });
                }
            } else {
                console.log(`[PersistentAgent.resolvePromptFromIdle] Resolving with text (${trimmed.length} chars)`);
                pending.resolve({ output: trimmed, sessionId: resolveSessionId });
            }
        } catch (err) {
            console.error(`[PersistentAgent.resolvePromptFromIdle] Error:`, err);
            pending.resolve({ output: `❌ Error al leer respuesta: ${err}`, sessionId: sessionId });
        }

        console.log(`[PersistentAgent.resolvePromptFromIdle] EXIT: About to drain queue for agent "${agent.name}"`);

        // Once the current prompt is resolved, drain the next item from the queue (if any)
        this.drainQueue(agent).catch(err =>
            console.error(`[PersistentAgent] drainQueue error for "${agent.name}":`, err)
        );
        
        console.log(`[PersistentAgent.resolvePromptFromIdle] COMPLETE: agent="${agent.name}"`);
    }

    // ─── Sub-agent (child session) handling ───────────────────────────────────

    /**
     * Called when session.idle arrives for a session that does NOT match our
     * registered parent sessionId, and either all tracked children are idle or
     * the session was not tracked (e.g. created before we started the SSE stream).
     *
     * We query the parent session status via HTTP. If the parent is also idle,
     * it means opencode finished everything but we either missed the parent's
     * session.idle event, or opencode didn't emit one. Resolve now.
     * If the parent is still busy, do nothing — wait for its own session.idle.
     */
    private async handleChildSessionIdle(
        agent: PersistentAgent,
        childSessionId: string,
        parentSessionId: string,
    ): Promise<void> {
        if (!parentSessionId) return;

        try {
            const host = agent.host || "localhost";
            const res = await fetch(
                `http://${host}:${agent.port}/session/${parentSessionId}`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (!res.ok) return;

            const session: any = await res.json();
            // Session object does not carry a live status field — we infer it
            // from the session.status SSE events. The only reliable indicator
            // from the REST API is whether the session has an active model run.
            // The safest heuristic: if the session.idle event arrived for the child
            // AND we have no more tracked children, check via the dedicated
            // /session/{id} endpoint which in newer opencode versions includes
            // a transient "status" field injected at serve time (not in the type).
            const status: string = session?.status ?? session?.info?.status ?? "";

            console.log(`[PersistentAgent] handleChildSessionIdle: parent "${parentSessionId}" REST status="${status || "(none)"}" after child "${childSessionId}" went idle`);

            if (status === "idle") {
                console.log(`[PersistentAgent] Parent session "${parentSessionId}" confirmed idle — resolving prompt for agent "${agent.name}"`);
                await this.resolvePromptFromIdle(agent, parentSessionId);
            } else if (!status) {
                // The REST endpoint does not expose status (common in older opencode).
                // Do NOT resolve here — the parent session may still be generating its
                // text response after finishing tool-calls (finish="tool-calls").
                // Wait for the parent's own session.idle SSE event.
                // The heartbeat watchdog will resolve if session.idle never arrives.
                console.log(`[PersistentAgent] Parent "${parentSessionId}" status unknown — waiting for parent session.idle SSE event (watchdog will catch if missed)`);
            }
            // status === "busy": parent is still working — wait for its session.idle
        } catch (err) {
            console.debug(`[PersistentAgent] handleChildSessionIdle error for agent "${agent.name}": ${err}`);
        }
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
                const questionId: string = q.id ?? "";
                // Deduplicate: skip questions already forwarded in this session
                if (questionId && this.forwardedQuestionIds.has(questionId)) {
                    console.log(`[PersistentAgent] recoverPendingQuestions: question ${questionId} already forwarded, skipping`);
                    continue;
                }
                if (questionId) this.forwardedQuestionIds.add(questionId);
                this.onQuestion(agent.id, q).catch(err =>
                    console.error(`[PersistentAgent] recoverPendingQuestions callback error:`, err)
                );
            }
        } catch (err) {
            console.debug(`[PersistentAgent] recoverPendingQuestions for "${agent.name}": ${err}`);
        }
    }

    /**
     * Called on SSE connect/reconnect.
     *
     * Case 1 — SSE reconnect mid-session (pendingPrompt already exists):
     *   If the session is already idle in opencode (session.idle was missed while
     *   we were disconnected), resolve the pending promise immediately.
     *
     * Case 2 — Bot restart while session was busy (pendingPrompt is gone):
     *   If the session is busy on the server but we have no pending promise,
     *   "adopt" the session: create a synthetic pendingPrompt, start the
     *   heartbeat, and notify the user so they know the result will arrive.
     *   When session.idle eventually fires the result is delivered normally.
     */
    private async recoverPendingPrompt(agent: PersistentAgent): Promise<void> {
        const existing = this.pendingPrompts.get(agent.id);

        const sessionId = existing?.sessionId ?? this.sessionIds.get(agent.id) ?? agent.sessionId;
        // If there is no session at all and we have a persisted heartbeat, the
        // previous work is unrecoverable (e.g. the opencode server itself was
        // also restarted and sessionId was never learned). Notify the user.
        if (!sessionId) {
            await this.notifyLostPromptIfAny(agent);
            return;
        }

        try {
            const host = agent.host || 'localhost';
            const res = await fetch(
                `http://${host}:${agent.port}/session/${sessionId}`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (!res.ok) {
                // Session does not exist on the server anymore — opencode restarted,
                // user deleted it, etc. If we had a heartbeat waiting, tell the user.
                if (!existing) {
                    await this.notifyLostPromptIfAny(agent);
                }
                return;
            }

            const session: any = await res.json();
            const status: string = session?.status ?? session?.info?.status ?? "";

            if (existing) {
                // Case 1: already have a pending prompt — resolve if idle
                if (status === "idle" || session?.info?.status === "idle") {
                    console.log(`[PersistentAgent] recoverPendingPrompt: session ${sessionId} is already idle for agent "${agent.name}" — resolving now`);
                    await this.resolvePromptFromIdle(agent, sessionId);
                }
            } else if (status === "busy") {
                // Case 2: bot restarted while session was busy — adopt it
                await this.adoptBusySession(agent, sessionId);
            } else {
                // Case 3: session exists but is idle and we have no pending prompt.
                // If there's a persisted heartbeat, the result was produced while the
                // bot was down and can no longer be correlated — treat as lost.
                await this.notifyLostPromptIfAny(agent);
            }
        } catch (err) {
            console.debug(`[PersistentAgent] recoverPendingPrompt for "${agent.name}": ${err}`);
        }
    }

    /**
     * If a heartbeat placeholder was persisted for this agent but we could not
     * recover the prompt (no session / session gone / session idle with no
     * pending), notify the user that their in-progress work is lost and clear
     * the heartbeat entry.
     */
    private async notifyLostPromptIfAny(agent: PersistentAgent): Promise<void> {
        if (!this.heartbeatLookup || !this.onLostPrompt) return;
        const hb = this.heartbeatLookup(agent.id);
        if (!hb) return;

        try {
            await this.onLostPrompt(agent.id, hb.chatId, hb.msgId);
            console.log(`[PersistentAgent] notifyLostPromptIfAny: notified lost prompt for agent "${agent.name}" in chat ${hb.chatId}`);
        } catch (err) {
            console.error(`[PersistentAgent] onLostPrompt callback error for "${agent.name}":`, err);
        }
    }

    /**
     * Adopt a session that is busy on the opencode server but has no
     * corresponding pendingPrompt in memory (typically after a bot restart).
     *
     * Creates a synthetic PendingPrompt so the SSE loop can resolve it when
     * session.idle eventually fires, and starts the heartbeat timer.
     * Optionally notifies the user via the onAdoptSession callback.
     */
    private async adoptBusySession(agent: PersistentAgent, sessionId: string): Promise<void> {
        if (this.pendingPrompts.has(agent.id)) return; // race guard

        console.log(`[PersistentAgent] adoptBusySession: adopting busy session "${sessionId}" for agent "${agent.name}" after restart`);

        // Notify the user and get a placeholder message to use as heartbeat anchor
        let adoptedChatId: number | undefined;
        let adoptedMsgId: number | undefined;

        if (this.onAdoptSession) {
            try {
                const result = await this.onAdoptSession(agent.id, agent.userId);
                if (result) {
                    adoptedChatId = result.chatId;
                    adoptedMsgId  = result.msgId;
                }
            } catch (err) {
                console.error(`[PersistentAgent] onAdoptSession callback error for "${agent.name}":`, err);
            }
        }

        // Create the synthetic pending promise.
        // When it resolves, deliver the result to the user.
        const promise = new Promise<AgentSendResult>((resolve, reject) => {
            this.pendingPrompts.set(agent.id, {
                sessionId,
                resolve,
                reject,
                startedAt: Date.now(),
            });
        });

        // Start heartbeat
        this.startHeartbeat(agent);

        // Handle the result asynchronously — this mirrors what sendPromptToAgent does
        promise.then(async (result) => {
            // If we got a placeholder message, use it; otherwise just send fresh
            if (adoptedChatId !== undefined && adoptedMsgId !== undefined && this.onAdoptSessionResult) {
                await this.onAdoptSessionResult(agent.id, adoptedChatId, adoptedMsgId, result).catch((err: unknown) =>
                    console.error(`[PersistentAgent] onAdoptSessionResult error for "${agent.name}":`, err)
                );
            } else {
                console.log(`[PersistentAgent] adoptBusySession: no result callback registered for "${agent.name}" — result dropped`);
            }
        }).catch((err: unknown) => {
            console.error(`[PersistentAgent] adoptBusySession promise rejected for "${agent.name}":`, err);
        });
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

        // Watchdog: if session.idle was missed, resolve once the server reports idle.
        // Guard against premature resolution when the parent is temporarily idle
        // between sub-agent invocations: use the in-memory tracking set.
        try {
            const host = agent.host || 'localhost';
            const statusRes = await fetch(
                `http://${host}:${agent.port}/session/${pending.sessionId}`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (statusRes.ok) {
                const session: any = await statusRes.json();
                const status = session?.status ?? session?.info?.status;
                if (status === "idle") {
                    const children = this.activeChildSessions.get(agent.id);
                    const hasActiveChildren = children && children.size > 0;
                    if (!hasActiveChildren) {
                        console.log(`[PersistentAgent] fireHeartbeat watchdog: parent session "${pending.sessionId}" is idle with no active children tracked — resolving`);
                        await this.resolvePromptFromIdle(agent, pending.sessionId);
                        return;
                    } else {
                        console.log(`[PersistentAgent] fireHeartbeat watchdog: parent session "${pending.sessionId}" is idle but ${children!.size} child session(s) still active — waiting`);
                    }
                }
                // If status is missing or not 'idle', do NOT resolve — trust the SSE loop.
            }
        } catch {
            // best-effort watchdog only
        }

        const minutesRunning = (Date.now() - pending.startedAt) / 60000;

        // Best-effort: fetch messages and extract rich info
        let lastToolName = "";
        let lastText = "";
        let messageCount = 0;
        let filesModified = 0;
        const recentFilesSet: string[] = [];
        let lastBashCmd = "";
        const lastEventAt = this.lastSseEventAt.get(agent.id);
        const secondsSinceLastEvent = lastEventAt
            ? Math.max(0, Math.round((Date.now() - lastEventAt) / 1000))
            : undefined;
        const streamConnected = secondsSinceLastEvent === undefined ? false : secondsSinceLastEvent <= 25;
        const sessionStatus = this.lastSessionStatus.get(agent.id);

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
                        // opencode v2 API uses type "tool" with part.tool (name) and part.state.input
                        // Kept "tool-invocation" fallback for legacy compatibility
                        const isToolPart = part.type === "tool" || part.type === "tool-invocation";
                        if (isToolPart) {
                            const toolName: string = (part.tool ?? part.toolName ?? part.name ?? "").toLowerCase();
                            if (toolName) lastToolName = toolName;
                            if (FILE_WRITE_TOOLS.has(toolName)) {
                                filesModified++;
                                // v2: args live in part.state.input; legacy: part.args or part.input
                                const args = part.state?.input ?? part.args ?? part.input ?? {};
                                const filePath: string = args.filePath ?? args.path ?? args.file ?? "";
                                if (filePath) {
                                    // Keep only the last 5 unique files, most recent last
                                    const idx = recentFilesSet.indexOf(filePath);
                                    if (idx !== -1) recentFilesSet.splice(idx, 1);
                                    recentFilesSet.push(filePath);
                                    if (recentFilesSet.length > 5) recentFilesSet.shift();
                                }
                            }
                            // Capture last bash command
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
            await this.onHeartbeat(agent.id, {
                minutesRunning: Math.floor(minutesRunning),
                lastToolName,
                lastText,
                messageCount,
                filesModified,
                recentFiles: recentFilesSet,
                lastBashCmd,
                streamConnected,
                secondsSinceLastEvent,
                sessionStatus,
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
        
        // Remove from dedup set — question is now answered
        this.forwardedQuestionIds.delete(requestId);

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
        
        // Remove from dedup set — question is now rejected
        this.forwardedQuestionIds.delete(requestId);

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
        } else if (!this.sseControllers.has(agent.id)) {
            // If the server is up but SSE is detached, attach now to avoid hanging prompts.
            this.startSseStream(agent);
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
                console.log(`[PersistentAgent] Using model from agent: ${modelConfig.providerID}/${modelConfig.modelID}`);
            } else {
                console.warn(`[PersistentAgent] Invalid model format: ${agent.model}`);
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
     *
     * 1. Best-effort: POST /session/{id}/abort so opencode actually stops the
     *    model call on its side instead of quietly finishing in the background.
     * 2. Resolve the pending promise locally with a "cancelled" message so the
     *    Telegram placeholder is edited immediately.
     * 3. Stop the heartbeat and clear the queue / child-session tracking.
     *
     * Returns the Promise of the abort HTTP call so callers that care can
     * await it; most call-sites (e.g. /esc) fire-and-forget.
     */
    cancelPendingPrompt(agentId: string): Promise<void> {
        const pending = this.pendingPrompts.get(agentId);
        let abortPromise: Promise<void> = Promise.resolve();

        if (pending) {
            this.pendingPrompts.delete(agentId);
            this.stopHeartbeat(agentId);

            // Fire the abort request to opencode. We do NOT await it before resolving
            // the pending promise — the user already decided to cancel, so resolving
            // locally ensures the Telegram UI updates immediately even if opencode
            // is unreachable. If abort fails, we log but don't propagate the error.
            const agent = this.agentDb.getById(agentId);
            if (agent && pending.sessionId) {
                const host = agent.host || "localhost";
                const url = `http://${host}:${agent.port}/session/${pending.sessionId}/abort`;
                abortPromise = fetch(url, {
                    method: "POST",
                    signal: AbortSignal.timeout(5000),
                }).then(res => {
                    if (!res.ok) {
                        console.warn(`[PersistentAgent.cancelPendingPrompt] abort returned HTTP ${res.status} for agent "${agent.name}" session "${pending.sessionId}"`);
                    } else {
                        console.log(`[PersistentAgent.cancelPendingPrompt] abort OK for agent "${agent.name}" session "${pending.sessionId}"`);
                    }
                }).catch((err: unknown) => {
                    console.warn(`[PersistentAgent.cancelPendingPrompt] abort failed for agent "${agent.name}" session "${pending.sessionId}":`, err);
                });
            }

            pending.resolve({ output: "❌ Cancelado por el usuario.", sessionId: pending.sessionId });
        }
        // Also clear the queue and child session tracking so nothing drains after cancellation
        this.promptQueues.delete(agentId);
        this.activeChildSessions.delete(agentId);

        return abortPromise;
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
     * Save active agents state to DB for persistence across restarts
     */
    saveActiveAgentsState(): void {
        const { SessionDbService } = require('./session-db.service.js');
        const db = new SessionDbService();
        
        // Save each user's active agent with their session info
        for (const [userId, agentId] of this.activeAgentByUser.entries()) {
            db.setState(`active_agent_user_${userId}`, agentId);
            
            // Also save the session ID for this agent if it exists
            const sessionId = this.sessionIds.get(agentId);
            if (sessionId) {
                db.setState(`sticky_session_${agentId}`, sessionId);
            }
        }
        
        // Save all session IDs cache
        for (const [agentId, sessionId] of this.sessionIds.entries()) {
            db.setState(`session_${agentId}`, sessionId);
        }
        
        console.log(`[PersistentAgent] Saved ${this.activeAgentByUser.size} active agent(s) and ${this.sessionIds.size} session(s) to DB`);
    }

    /**
     * Restore active agents state from DB after restart
     * @returns Map of userId → agentId that were restored
     */
    restoreActiveAgentsState(): Map<number, string> {
        const { SessionDbService } = require('./session-db.service.js');
        const db = new SessionDbService();
        const restored = new Map<number, string>();
        
        // Get all keys from bot_state that start with "active_agent_user_"
        const activeRows = db.getStateByPattern('active_agent_user_%');
        
        for (const row of activeRows) {
            const userId = parseInt(row.key.replace('active_agent_user_', ''), 10);
            const agentId = row.value;
            if (!isNaN(userId)) {
                this.activeAgentByUser.set(userId, agentId);
                restored.set(userId, agentId);
                
                // Restore sticky session for this agent
                const stickySession = db.getState(`sticky_session_${agentId}`);
                if (stickySession) {
                    this.sessionIds.set(agentId, stickySession);
                    console.log(`[PersistentAgent] Restored sticky session ${stickySession} for agent ${agentId} (user ${userId})`);
                }
            }
        }
        
        // Restore all session IDs cache (includes sticky sessions)
        const sessionEntries = db.getStateByPattern('session_%');
        
        for (const entry of sessionEntries) {
            const agentId = entry.key.replace('session_', '');
            // Don't overwrite sticky sessions
            if (!this.sessionIds.has(agentId)) {
                this.sessionIds.set(agentId, entry.value);
            }
        }
        
        console.log(`[PersistentAgent] Restored ${restored.size} active agent(s) and ${this.sessionIds.size} session(s) from DB`);
        return restored;
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
            
            // Remote agents are on another machine — skip restore, they'll connect on-demand
            if (agent.isRemote) {
                console.log(`[PersistentAgent] Skipping remote agent "${agent.name}" at ${agent.host}:${agent.port} — will connect on first use`);
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

    // ─── LRU slot management ─────────────────────────────────────────────────

    /** Touch the lastUsedAt timestamp of an agent (selection / prompt). */
    touchLastUsed(agentId: string): void {
        try { this.agentDb.touchLastUsed(agentId); } catch { /* ignore */ }
    }

    /**
     * Ensure there is at least one free slot among the global MAX_OPENCODE_SERVERS
     * for a brand-new local agent. If the limit is reached, the least-recently-used
     * running local agent is stopped and deleted (no resumption — irreversible).
     *
     * @param maxServers  Hard limit (default 3)
     * @param protectId   Optional agent.id to never evict (e.g. the one we are about to activate)
     * @returns The agent that was evicted, or null if nothing needed to be done.
     */
    async ensureSlotAvailable(maxServers: number, protectId?: string): Promise<PersistentAgent | null> {
        const running = this.agentDb.getRunningOrderedByLRU();
        if (running.length < maxServers) return null;

        const candidate = running.find(a => a.id !== protectId);
        if (!candidate) return null;

        await this.evictAgent(candidate);
        return candidate;
    }

    /** Stop and permanently delete an agent (process + DB row + sticky/last-used cleanup). */
    async evictAgent(agent: PersistentAgent): Promise<void> {
        // Best-effort: delete OpenCode sessions that belong to this workdir.
        try {
            const baseUrl = `http://${agent.host || "localhost"}:${agent.port}`;
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(3000) });
            if (sessRes.ok) {
                const allSessions: any[] = await sessRes.json();
                const agentDir = resolveDir(agent.workdir);
                const sessions = allSessions.filter((s: any) => !s.directory || s.directory === agentDir);
                await Promise.all(sessions.map(s =>
                    fetch(`${baseUrl}/session/${s.id}`, {
                        method: "DELETE",
                        signal: AbortSignal.timeout(5000),
                    }).catch(() => {})
                ));
            }
        } catch { /* best-effort */ }

        this.stopAgent(agent.id);
        this.agentDb.delete(agent.id);

        // Clean any sticky/last-used pointers across users
        for (const [userId, activeId] of this.activeAgentByUser.entries()) {
            if (activeId === agent.id) this.activeAgentByUser.delete(userId);
        }
        try {
            // Best-effort: clear last-used pointers for users that had this one
            const lastUsed = this.agentDb.getLastUsed(agent.userId);
            if (lastUsed?.id === agent.id) this.agentDb.clearLastUsed(agent.userId);
        } catch { /* ignore */ }
    }
}
