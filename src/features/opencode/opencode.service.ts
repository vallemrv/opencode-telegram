import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "./opencode.types.js";
import { processEvent } from "./opencode.event-handlers.js";
import { SessionPersistService } from "../../services/session-persist.service.js";

export class OpenCodeService {
    private userSessions: Map<number, UserSession> = new Map();
    private baseUrl: string;
    private eventAbortControllers: Map<number, AbortController> = new Map();
    private persistService: SessionPersistService;

    constructor(baseUrl?: string) {
        this.baseUrl = baseUrl || process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
        this.persistService = new SessionPersistService();
        // Restore sessions from disk in background (don't block startup)
        this.restoreSessionsFromDisk().catch(err =>
            console.error('[OpenCodeService] Failed to restore sessions:', err)
        );
    }

    async createSession(userId: number, title?: string, model?: string, directory?: string): Promise<UserSession> {
        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            const result = await client.session.create({
                body: {
                    title: title || `Telegram Session ${new Date().toISOString()}`,
                    permission: [
                        { permission: "command", pattern: "*", action: "allow" },
                        { permission: "file", pattern: "*", action: "allow" }
                    ]
                } as any,
                query: directory ? { directory } : undefined,
            });

            if (!result.data) {
                throw new Error("Failed to create session");
            }

            const userSession: UserSession = {
                userId,
                sessionId: result.data.id,
                session: result.data,
                createdAt: new Date(),
                currentAgent: "build",
                currentModel: model || process.env.OPENCODE_DEFAULT_MODEL || "opencode/glm-5-free",
            };

            this.userSessions.set(userId, userSession);

            // Persist to disk so session survives bot restarts
            this.persistService.saveSession({
                userId,
                sessionId: result.data.id,
                currentAgent: "build",
                currentModel: userSession.currentModel,
                createdAt: new Date().toISOString(),
            });

            return userSession;
        } catch (error) {
            if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED'))) {
                throw new Error(`Cannot connect to OpenCode server at ${this.baseUrl}. Please ensure:\n1. OpenCode server is running\n2. OPENCODE_SERVER_URL is configured correctly in .env file`);
            }
            throw error;
        }
    }

    getUserSession(userId: number): UserSession | undefined {
        return this.userSessions.get(userId);
    }

    updateSessionContext(userId: number, chatId: number, messageId: number): void {
        const session = this.userSessions.get(userId);
        if (session) {
            session.chatId = chatId;
            session.lastMessageId = messageId;
            // Keep disk in sync
            this.persistService.updateSession(userId, { chatId, lastMessageId: messageId });
        }
    }

    // ─── Event Stream ────────────────────────────────────────────────────────

    async startEventStream(userId: number, ctx: Context): Promise<void> {
        const userSession = this.getUserSession(userId);
        if (!userSession || !userSession.chatId) {
            console.warn(`[EventStream] Cannot start for user ${userId}: no session or chatId`);
            return;
        }

        // Stop any existing event stream for this user
        this.stopEventStream(userId);

        const abortController = new AbortController();
        this.eventAbortControllers.set(userId, abortController);

        const client = createOpencodeClient({ baseUrl: this.baseUrl });
        let retryDelay = 2000;
        const maxRetryDelay = 30000;

        console.log(`[EventStream] Starting for user ${userId}`);

        while (!abortController.signal.aborted) {
            try {
                const events = await client.event.subscribe();
                retryDelay = 2000; // Reset on success

                for await (const event of events.stream) {
                    if (abortController.signal.aborted) break;
                    // Refresh session reference in case it was updated
                    const currentSession = this.getUserSession(userId);
                    if (!currentSession) break;
                    await processEvent(event, ctx, currentSession);
                }
            } catch (error) {
                if (abortController.signal.aborted) break;
                console.error(`[EventStream] Error for user ${userId}, retrying in ${retryDelay}ms:`, error);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
            }
        }

        this.eventAbortControllers.delete(userId);
        console.log(`[EventStream] Stopped for user ${userId}`);
    }

    stopEventStream(userId: number): void {
        const controller = this.eventAbortControllers.get(userId);
        if (controller) {
            controller.abort();
            this.eventAbortControllers.delete(userId);
        }
    }

    /** Returns true if the SSE event stream is currently active for this user */
    hasEventStream(userId: number): boolean {
        return this.eventAbortControllers.has(userId);
    }

    /**
     * Ensures the event stream is running for a user.
     * Call this before sending any prompt to guarantee responses will be received.
     */
    ensureEventStream(userId: number, ctx: Context): void {
        if (this.hasEventStream(userId)) return;
        const session = this.getUserSession(userId);
        if (!session) return;

        // If chatId not set yet, use it from the incoming context
        if (!session.chatId && ctx.chat?.id) {
            session.chatId = ctx.chat.id;
            this.persistService.updateSession(userId, { chatId: ctx.chat.id });
        }

        console.log(`[EventStream] Reconnecting for user ${userId} (was not running)`);
        this.startEventStream(userId, ctx).catch(err =>
            console.error(`[EventStream] Failed to reconnect for user ${userId}:`, err)
        );
    }

    // ─── Prompt ──────────────────────────────────────────────────────────────

    async sendPrompt(userId: number, text: string, fileContext?: string): Promise<void> {
        const userSession = this.getUserSession(userId);

        if (!userSession) {
            throw new Error("No active session. Please use /opencode to start a session first.");
        }

        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            const fullPrompt = fileContext ? `${fileContext}\n\n${text}` : text;

            // 🔑 USE promptAsync: returns immediately, AI response comes through SSE stream
            // Do NOT use session.prompt() — it blocks until GLM-5 finishes, causing timeouts
            const result = await (client.session as any).promptAsync({
                path: { id: userSession.sessionId },
                body: {
                    parts: [{ type: "text", text: fullPrompt }],
                    agent: userSession.currentAgent,
                },
            });

            if (result.error) {
                throw new Error(`OpenCode rejected prompt: ${JSON.stringify(result.error)}`);
            }

            console.log(`[OpenCode] Prompt queued for session ${userSession.sessionId}`);
            // Response will arrive via SSE → session.idle handler sends it to Telegram

        } catch (error) {
            if (error instanceof Error && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED'))) {
                throw new Error(`Cannot connect to OpenCode server at ${this.baseUrl}. Please ensure the OpenCode server is running.`);
            }
            throw error;
        }
    }

    // ─── Session Management ──────────────────────────────────────────────────

    async deleteSession(userId: number): Promise<boolean> {
        const userSession = this.getUserSession(userId);

        if (!userSession) {
            return false;
        }

        this.stopEventStream(userId);

        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            await client.session.delete({
                path: { id: userSession.sessionId },
            });
            this.userSessions.delete(userId);
            this.persistService.deleteSession(userId);
            return true;
        } catch (error) {
            console.error(`Failed to delete session for user ${userId}:`, error);
            return false;
        }
    }

    hasActiveSession(userId: number): boolean {
        return this.userSessions.has(userId);
    }

    async abortSession(userId: number): Promise<boolean> {
        const userSession = this.getUserSession(userId);

        if (!userSession) {
            return false;
        }

        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            await client.session.abort({
                path: { id: userSession.sessionId },
            });
            return true;
        } catch (error) {
            console.error(`Failed to abort session for user ${userId}:`, error);
            return false;
        }
    }

    // ─── Agents ──────────────────────────────────────────────────────────────

    async getAvailableAgents(): Promise<Array<{ name: string; mode?: string; description?: string }>> {
        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            const result = await client.app.agents();

            if (!result.data) {
                return [];
            }

            const internalAgents = ['compaction', 'title', 'summary'];

            const filtered = result.data
                .filter((agent: any) => {
                    if (agent.hidden === true) return false;
                    if (agent.mode === "subagent") return false;
                    if (internalAgents.includes(agent.name)) return false;
                    return agent.mode === "primary" || agent.mode === "all";
                })
                .map((agent: any) => ({
                    name: agent.name || "unknown",
                    mode: agent.mode,
                    description: agent.description
                }));

            console.log("Filtered agents:", filtered.map((a: any) => a.name));
            return filtered;
        } catch (error) {
            console.error("Failed to get available agents:", error);
            return [];
        }
    }

    async cycleToNextAgent(userId: number): Promise<{ success: boolean; currentAgent?: string }> {
        const userSession = this.getUserSession(userId);

        if (!userSession) {
            return { success: false };
        }

        try {
            const agents = await this.getAvailableAgents();

            if (agents.length === 0) {
                return { success: false };
            }

            const currentAgent = userSession.currentAgent || agents[0].name;
            const currentIndex = agents.findIndex(a => a.name === currentAgent);
            const nextIndex = (currentIndex + 1) % agents.length;
            const nextAgent = agents[nextIndex].name;

            userSession.currentAgent = nextAgent;

            console.log(`✓ Cycled agent for user ${userId}: ${currentAgent} → ${nextAgent}`);
            return { success: true, currentAgent: nextAgent };
        } catch (error) {
            console.error(`Failed to cycle agent for user ${userId}:`, error);
            return { success: false };
        }
    }

    // ─── Session Title ────────────────────────────────────────────────────────

    async updateSessionTitle(userId: number, title: string): Promise<{ success: boolean; message?: string }> {
        const userSession = this.getUserSession(userId);

        if (!userSession) {
            return { success: false, message: "No active session found" };
        }

        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            await client.session.update({
                path: { id: userSession.sessionId },
                body: { title }
            });

            console.log(`✓ Updated session title for user ${userId}: "${title}"`);
            return { success: true };
        } catch (error) {
            console.error(`Failed to update session title for user ${userId}:`, error);
            return { success: false, message: "Failed to update session title" };
        }
    }

    // ─── Projects & Sessions List ─────────────────────────────────────────────

    async getProjects(): Promise<Array<{ id: string; worktree: string }>> {
        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            const result = await client.project.list();

            if (!result.data) {
                return [];
            }

            return result.data.map((project: any) => ({
                id: project.id,
                worktree: project.worktree
            }));
        } catch (error) {
            console.error("Failed to get projects:", error);
            return [];
        }
    }

    async getSessions(limit: number = 5, directory?: string): Promise<Array<{ id: string; title: string; created: number; updated: number; worktree?: string }>> {
        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            const result = await client.session.list(
                directory ? { query: { directory } } : undefined
            );

            if (!result.data) {
                return [];
            }

            return result.data
                .sort((a: any, b: any) => b.time.updated - a.time.updated)
                .slice(0, limit)
                .map((session: any) => ({
                    id: session.id,
                    title: session.title,
                    created: session.time.created,
                    updated: session.time.updated,
                    worktree: session.worktree
                }));
        } catch (error) {
            console.error("Failed to get sessions:", error);
            return [];
        }
    }

    // ─── Undo / Redo ─────────────────────────────────────────────────────────

    async undoLastMessage(userId: number): Promise<{ success: boolean; message?: string }> {
        const userSession = this.getUserSession(userId);

        if (!userSession) {
            return { success: false, message: "No active session found" };
        }

        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            if (typeof client.session.revert !== 'function') {
                return { success: false, message: "Undo is not available in this SDK version" };
            }

            await client.session.revert({
                path: { id: userSession.sessionId }
            });

            console.log(`✓ Undid last message for user ${userId}`);
            return { success: true };
        } catch (error) {
            console.error(`Failed to undo message for user ${userId}:`, error);
            return { success: false, message: "Failed to undo last message" };
        }
    }

    async redoLastMessage(userId: number): Promise<{ success: boolean; message?: string }> {
        const userSession = this.getUserSession(userId);

        if (!userSession) {
            return { success: false, message: "No active session found" };
        }

        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            if (typeof client.session.unrevert !== 'function') {
                return { success: false, message: "Redo is not available in this SDK version" };
            }

            await client.session.unrevert({
                path: { id: userSession.sessionId }
            });

            console.log(`✓ Redid last message for user ${userId}`);
            return { success: true };
        } catch (error) {
            console.error(`Failed to redo message for user ${userId}:`, error);
            return { success: false, message: "Failed to redo last message" };
        }
    }

    // ─── Session Restore ──────────────────────────────────────────────────────

    /**
     * Restore sessions persisted on disk after a bot restart.
     * For each persisted session, verify it still exists on the OpenCode server.
     */
    private async restoreSessionsFromDisk(): Promise<void> {
        const persisted = this.persistService.loadSessions();
        if (persisted.size === 0) return;

        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        let serverSessions: any[] = [];
        try {
            const result = await client.session.list() as any;
            serverSessions = (result.data as any[]) || [];
        } catch (err) {
            console.warn('[OpenCodeService] Could not reach OpenCode server during restore, skipping session restore');
            return;
        }

        const serverSessionIds = new Set(serverSessions.map((s: any) => s.id));
        let restored = 0;

        for (const [userId, p] of persisted.entries()) {
            if (!serverSessionIds.has(p.sessionId)) {
                console.log(`[OpenCodeService] Session ${p.sessionId} for user ${userId} no longer exists on server, removing from disk`);
                this.persistService.deleteSession(userId);
                continue;
            }

            const serverSession = serverSessions.find((s: any) => s.id === p.sessionId);
            const userSession: UserSession = {
                userId,
                sessionId: p.sessionId,
                session: serverSession,
                createdAt: new Date(p.createdAt),
                chatId: p.chatId,
                lastMessageId: p.lastMessageId,
                currentAgent: p.currentAgent || 'build',
                currentModel: p.currentModel || process.env.OPENCODE_DEFAULT_MODEL || 'opencode/glm-5-free',
            };

            this.userSessions.set(userId, userSession);
            restored++;
            console.log(`[OpenCodeService] ✅ Restored session for user ${userId}: ${p.sessionId} (chatId: ${p.chatId})`);
        }

        if (restored > 0) {
            console.log(`[OpenCodeService] Restored ${restored} session(s) from disk — event stream will reconnect on next message`);
        }
    }
}
