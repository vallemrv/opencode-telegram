import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "./opencode.types.js";
import { processEvent } from "./opencode.event-handlers.js";
import { SessionDbService } from "../../services/session-db.service.js";
import * as os from "os";
import * as nodePath from "path";

/** Builds a Gitea context block to prepend to prompts when Gitea is configured */
function buildGiteaContext(): string | null {
    const url = process.env.GITEA_URL?.trim();
    const token = process.env.GITEA_TOKEN?.trim();
    const rawWorkdir = process.env.GITEA_DEFAULT_WORKDIR?.trim() || '~/proyectos/gitea-projects';

    if (!url || !token) return null;

    const workdir = rawWorkdir.startsWith('~')
        ? nodePath.join(os.homedir(), rawWorkdir.slice(1))
        : rawWorkdir;

    return `<gitea_context>
You have access to a Gitea instance with the following configuration:
- Gitea URL: ${url}
- API base: ${url}/api/v1
- Authentication: use header "Authorization: token ${token}" for all API requests
- Local projects directory: ${workdir}

When the user asks you to create a repository, delete a repository, list repositories, or perform any Gitea operation, use this configuration to make the appropriate API calls directly. Do not ask the user for the URL or token — they are already provided above.
</gitea_context>

`;
}

export class OpenCodeService {
    private userSessions: Map<number, UserSession> = new Map();
    private baseUrl: string;
    private eventAbortControllers: Map<number, AbortController> = new Map();
    public dbService: SessionDbService;

    constructor(baseUrl?: string) {
        this.baseUrl = baseUrl || process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
        this.dbService = new SessionDbService();
        // Restore sessions from DB in background (don't block startup)
        this.restoreSessionsFromDisk().catch(err =>
            console.error('[OpenCodeService] Failed to restore sessions:', err)
        );
    }

    async createSession(userId: number, title?: string, model?: string, directory?: string): Promise<UserSession> {
        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        try {
            const actualModel = model || process.env.OPENCODE_DEFAULT_MODEL || "opencode/glm-5-free";
            const sessionTitle = title ? `${title} [${actualModel}]` : `Session [${actualModel}] ${new Date().toISOString()}`;

            const result = await client.session.create({
                body: {
                    title: sessionTitle,
                    permission: [
                        { permission: "command", pattern: "*", action: "allow" },
                        { permission: "file", pattern: "*", action: "allow" }
                    ]
                } as any,
                query: directory ? { cwd: directory } : undefined,
            } as any);

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

            // Persist to SQLite DB so session survives bot restarts
            this.dbService.saveSession({
                id: result.data.id,
                userId,
                projectId: title || "global",
                title: sessionTitle,
                model: userSession.currentModel,
                chatId: null,
                lastMessageId: null,
                currentAgent: "build",
                createdAt: new Date().toISOString(),
                isActive: true
            });
            this.dbService.setActiveSession(userId, result.data.id);

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
            // Keep DB in sync
            this.dbService.updateSession(session.sessionId, { chatId, lastMessageId: messageId });
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
                    // If session is not in memory, skip event but keep stream alive
                    if (!currentSession) continue;
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
            this.dbService.updateSession(session.sessionId, { chatId: ctx.chat.id });
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
            const giteaContext = buildGiteaContext();
            const basePrompt = fileContext ? `${fileContext}\n\n${text}` : text;
            const fullPrompt = giteaContext ? `${giteaContext}${basePrompt}` : basePrompt;

            let modelConfig = undefined;
            if (userSession.currentModel) {
                const parts = userSession.currentModel.split('/');
                if (parts.length === 2) {
                    modelConfig = { providerID: parts[0], modelID: parts[1] };
                }
            }

            // 🔑 USE promptAsync: returns immediately, AI response comes through SSE stream
            // Do NOT use session.prompt() — it blocks until GLM-5 finishes, causing timeouts
            const result = await (client.session as any).promptAsync({
                path: { id: userSession.sessionId },
                body: {
                    parts: [{ type: "text", text: fullPrompt }],
                    agent: userSession.currentAgent,
                    model: modelConfig, // Ahora es un objeto { providerID, modelID }
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
                sessionID: userSession.sessionId,
            } as any);
            this.userSessions.delete(userId);
            this.dbService.deleteSession(userSession.sessionId);
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

    async updateSessionTitle(userId: number, title: string): Promise<{ success: boolean; message?: string; title?: string }> {
        const userSession = this.getUserSession(userId);

        if (!userSession) {
            return { success: false, message: "No active session found" };
        }

        const client = createOpencodeClient({ baseUrl: this.baseUrl });

        // Ensure title contains the model bracket
        const currentModel = userSession.currentModel || process.env.OPENCODE_DEFAULT_MODEL || "opencode/glm-5-free";
        let finalTitle = title;

        // Remove existing model bracket if any to avoid duplicates
        finalTitle = finalTitle.replace(/\s*\[.*?\]$/, "");
        finalTitle = `${finalTitle} [${currentModel}]`;

        try {
            await client.session.update({
                path: { id: userSession.sessionId },
                body: { title: finalTitle }
            });

            // Keep local state in sync
            userSession.session.title = finalTitle;

            // Sync with local DB
            this.dbService.updateSession(userSession.sessionId, {
                title: finalTitle,
                model: currentModel
            });

            console.log(`✓ Updated session title for user ${userId}: "${finalTitle}"`);
            return { success: true, title: finalTitle };
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

    async getSessions(limit: number = 5, directory?: string): Promise<Array<{ id: string; title: string; created: number; updated: number; directory?: string }>> {
        try {
            // Use fetch directly — the SDK wrapper drops the directory query param
            const url = new URL(`${this.baseUrl}/session`);
            if (directory) url.searchParams.set("directory", directory);

            const response = await fetch(url.toString());
            if (!response.ok) return [];

            const data: any[] = await response.json();

            return data
                .sort((a: any, b: any) => b.time.updated - a.time.updated)
                .slice(0, limit)
                .map((session: any) => ({
                    id: session.id,
                    title: session.title,
                    created: session.time.created,
                    updated: session.time.updated,
                    directory: session.directory
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
     * Try to restore the most recently updated session from OpenCode for this user.
     * Used when the user sends a message but the bot has no session in memory
     * (e.g. after a restart). Picks the most recently updated session in OpenCode.
     */
    async tryRestoreLatestSession(userId: number, ctx: any): Promise<void> {
        try {
            const resp = await fetch(`${this.baseUrl}/session`);
            if (!resp.ok) return;
            const all: any[] = await resp.json();
            if (all.length === 0) return;

            // Pick the most recently updated session
            const latest = all.sort((a, b) => b.time.updated - a.time.updated)[0];

            const currentModel =
                latest.title?.match(/\[(.*?)\]/)?.[1] ||
                process.env.OPENCODE_DEFAULT_MODEL ||
                'github-copilot/claude-sonnet-4.6';

            const userSession: UserSession = {
                userId,
                sessionId: latest.id,
                session: latest,
                createdAt: new Date(latest.time.created),
                chatId: ctx.chat?.id,
                currentAgent: 'build',
                currentModel,
            };

            this.userSessions.set(userId, userSession);

            // Persist to DB so it survives next restart too
            this.dbService.saveSession({
                id: latest.id,
                userId,
                projectId: latest.title?.split(' [')[0] || 'global',
                title: latest.title || latest.id,
                model: currentModel,
                chatId: ctx.chat?.id || null,
                lastMessageId: null,
                currentAgent: 'build',
                createdAt: new Date(latest.time.created).toISOString(),
                isActive: true,
            });
            this.dbService.setActiveSession(userId, latest.id);

            console.log(`[OpenCodeService] ✅ Auto-restored session for user ${userId}: ${latest.id} (${latest.title})`);
        } catch (err) {
            console.error('[OpenCodeService] tryRestoreLatestSession failed:', err);
        }
    }

    /**
     * Restore sessions persisted on disk after a bot restart.
     * For each persisted session, verify it still exists on the OpenCode server.
     */
    private async restoreSessionsFromDisk(): Promise<void> {
        const persisted = this.dbService.getAllActiveSessions();
        if (persisted.length === 0) return;

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

        for (const p of persisted) {
            const userId = p.userId;

            if (!serverSessionIds.has(p.id)) {
                console.log(`[OpenCodeService] Session ${p.id} for user ${userId} no longer exists on server, removing from DB`);
                this.dbService.deleteSession(p.id);
                continue;
            }

            const serverSession = serverSessions.find((s: any) => s.id === p.id);
            const userSession: UserSession = {
                userId,
                sessionId: p.id,
                session: serverSession,
                createdAt: new Date(p.createdAt),
                chatId: p.chatId || undefined,
                lastMessageId: p.lastMessageId || undefined,
                currentAgent: p.currentAgent || 'build',
                currentModel: p.model || process.env.OPENCODE_DEFAULT_MODEL || 'opencode/glm-5-free',
            };

            this.userSessions.set(userId, userSession);
            restored++;
            console.log(`[OpenCodeService] ✅ Restored active session for user ${userId}: ${p.id} (chatId: ${p.chatId})`);

            // Check if there's a pending response that was never delivered (bot died mid-stream)
            if (p.chatId) {
                this.deliverMissedResponse(userSession, client).catch(err =>
                    console.error('[OpenCodeService] deliverMissedResponse failed:', err)
                );
            }
        }

        if (restored > 0) {
            console.log(`[OpenCodeService] Restored ${restored} active session(s) from DB — event stream will reconnect on next message`);
        }
    }

    /**
     * After a bot restart, check if the last assistant message was never sent to Telegram.
     * If so, send it now.
     */
    private async deliverMissedResponse(userSession: UserSession, client: any): Promise<void> {
        try {
            const result = await client.session.message.list({
                path: { id: userSession.sessionId },
                query: { limit: 20 },
            }) as any;

            const messages: any[] = result.data || [];
            if (messages.length === 0) return;

            // Find the last assistant message
            const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === 'assistant');
            if (!lastAssistant) return;

            // Extract text from parts
            const parts: any[] = lastAssistant.parts || [];
            const text = parts
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text || '')
                .join('');

            if (!text.trim()) return;

            // Only deliver if the session status is idle (not still processing)
            const statusResp = await fetch(`${this.baseUrl}/session/status`);
            if (statusResp.ok) {
                const statuses: any = await statusResp.json();
                const sessionStatus = statuses[userSession.sessionId];
                if (sessionStatus && sessionStatus.type !== 'idle') return; // still busy
            }

            console.log(`[OpenCodeService] Delivering missed response for user ${userSession.userId}`);

            // Import the idle handler logic inline to avoid circular deps
            const { formatAsHtml } = await import('./event-handlers/utils.js');
            const Bot = (await import('grammy')).Bot;
            const token = process.env.TELEGRAM_BOT_TOKENS?.split(',')[0]?.trim();
            if (!token || !userSession.chatId) return;

            const bot = new Bot(token);
            const html = formatAsHtml(text);
            const MAX = 4000;
            if (html.length <= MAX) {
                await bot.api.sendMessage(userSession.chatId, `🔄 <b>Respuesta recuperada tras reinicio:</b>\n\n${html}`, { parse_mode: 'HTML' });
            } else {
                const { InputFile } = await import('grammy');
                const buf = Buffer.from(text, 'utf8');
                await bot.api.sendDocument(userSession.chatId, new InputFile(buf, 'respuesta.md'), {
                    caption: '🔄 Respuesta recuperada tras reinicio (archivo adjunto)',
                });
            }
        } catch (err) {
            console.error('[OpenCodeService] Error in deliverMissedResponse:', err);
        }
    }
}
