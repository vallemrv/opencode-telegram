import { Bot, Context, InputFile, Keyboard, InlineKeyboard } from "grammy";
import { OpenCodeService } from "./opencode.service.js";
import { ConfigService } from "../../services/config.service.js";
import { OpenCodeServerService } from "../../services/opencode-server.service.js";
import { GiteaService } from "../../services/gitea.service.js";
import { BackgroundAgentService, resolveDir } from "../../services/background-agent.service.js";
import { AgentDbService } from "../../services/agent-db.service.js";
import { PersistentAgentService, pickPort } from "../../services/persistent-agent.service.js";
import { SessionDbService } from "../../services/session-db.service.js";
import { AccessControlMiddleware } from "../../middleware/access-control.middleware.js";
import { MessageUtils } from "../../utils/message.utils.js";
import { ErrorUtils } from "../../utils/error.utils.js";
import { formatAsHtml, escapeHtml } from "./event-handlers/utils.js";
import { FileMentionService, FileMentionUI } from "../file-mentions/index.js";
import * as fs from "fs";
import * as nodePath from "path";
import * as os from "os";
import { randomUUID } from "crypto";

// ─── /createagent wizard state ────────────────────────────────────────────────
interface CreateAgentWizardState {
    step: "name" | "role" | "workdir" | "model";
    name?: string;
    role?: string;
    workdir?: string;
}

// ─── /run wizard state ────────────────────────────────────────────────────────
interface RunWizardState {
    prompt: string;              // prompt waiting for agent selection
    preselectedAgentId?: string; // set when agent is already chosen (from /agents tap)
}


/** Resuelve ~ en rutas y expande variables de entorno básicas */
function resolveWorkDir(p: string): string {
    if (p.startsWith("~/") || p === "~") {
        return nodePath.join(os.homedir(), p.slice(1));
    }
    return p;
}

/** Devuelve el directorio base de proyectos, creándolo si no existe */
function getProjectsBaseDir(): string {
    const raw = process.env.GITEA_DEFAULT_WORKDIR || "~/proyectos/gitea-projects";
    const resolved = resolveWorkDir(raw);
    if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
    }
    return resolved;
}

export class OpenCodeBot {
    private opencodeService: OpenCodeService;
    private configService: ConfigService;
    private serverService: OpenCodeServerService;
    private giteaService: GiteaService;
    private backgroundAgentService: BackgroundAgentService;
    private agentDb: AgentDbService;
    private persistentAgentService: PersistentAgentService;
    private sessionDb: SessionDbService;
    private fileMentionService: FileMentionService;
    private fileMentionUI: FileMentionUI;
    private bot?: Bot;

    /** Wizard state per user for /createagent multi-step flow */
    private createAgentWizardState: Map<number, CreateAgentWizardState> = new Map();

    /** Pending prompt per user waiting for agent selection via /run */
    private runWizardState: Map<number, RunWizardState> = new Map();

    /** Pending agent questions keyed by shortKey (8 random chars), so callback data stays short */
    private pendingAgentQuestions: Map<string, { agentId: string; port: number; req: any }> = new Map();

    constructor(
        opencodeService: OpenCodeService,
        configService: ConfigService
    ) {
        this.opencodeService = opencodeService;
        this.configService = configService;
        this.serverService = new OpenCodeServerService();
        this.giteaService = new GiteaService();
        this.backgroundAgentService = new BackgroundAgentService();
        this.agentDb = new AgentDbService();
        this.persistentAgentService = new PersistentAgentService();
        this.sessionDb = new SessionDbService();
        this.fileMentionService = new FileMentionService();
        this.fileMentionUI = new FileMentionUI();
    }

    private createControlKeyboard(): Keyboard {
        return new Keyboard()
            .text("⏹️ ESC")
            .text("⇥ TAB")
            .resized()
            .persistent();
    }

    registerHandlers(bot: Bot): void {
        this.bot = bot;

        // Register question callback for persistent agents
        this.persistentAgentService.setOnQuestionCallback(
            this.handleAgentQuestion.bind(this)
        );
        // If a /restart was in progress, confirm readiness to the user who triggered it
        const restartChatId = this.sessionDb.getState("restart_pending_chat_id");
        const restartMsgId  = this.sessionDb.getState("restart_pending_message_id");
        if (restartChatId && restartMsgId) {
            this.sessionDb.deleteState("restart_pending_chat_id");
            this.sessionDb.deleteState("restart_pending_message_id");
            // Small delay to let the bot's long-polling session establish before editing
            setTimeout(() => {
                bot.api.editMessageText(
                    Number(restartChatId),
                    Number(restartMsgId),
                    "✅ <b>Bot listo</b>\n\n" +
                    "✅ Build completado\n" +
                    "✅ Servicio reiniciado y escuchando",
                    { parse_mode: "HTML" }
                ).catch(err => console.error("[OpenCodeBot] Could not edit restart message:", err));
            }, 2000);
        }

        // Restore persistent agents in background; notify owners of failures
        this.persistentAgentService.restoreAll(this.agentDb.getAll())
            .then(async (failed) => {
                for (const agent of failed) {
                    try {
                        await bot.api.sendMessage(
                            agent.userId,
                            `⚠️ <b>Agente "${agent.name}" no pudo restaurarse</b>\n\n` +
                            `Puerto: <code>${agent.port}</code> — el servidor <code>opencode serve</code> no respondió en 20s.\n\n` +
                            `El agente sigue en la base de datos. Cuando le envíes un prompt, intentará arrancar de nuevo automáticamente.`,
                            { parse_mode: "HTML" }
                        );
                    } catch (err) {
                        console.error(`[OpenCodeBot] Could not notify user ${agent.userId} of failed restore:`, err);
                    }
                }
            })
            .catch(err => console.error("[OpenCodeBot] Failed to restore persistent agents:", err));

        bot.command("start", AccessControlMiddleware.requireAccess, this.handleStart.bind(this));
        bot.command("help", AccessControlMiddleware.requireAccess, this.handleStart.bind(this));
        bot.command("opencode", AccessControlMiddleware.requireAccess, this.handleOpenCode.bind(this));
        bot.command("esc", AccessControlMiddleware.requireAccess, this.handleEsc.bind(this));
        bot.command("endsession", AccessControlMiddleware.requireAccess, this.handleEndSession.bind(this));
        bot.command("rename", AccessControlMiddleware.requireAccess, this.handleRename.bind(this));
        bot.command("new", AccessControlMiddleware.requireAccess, this.handleNewProject.bind(this));
        bot.command("projects", AccessControlMiddleware.requireAccess, this.handleProjects.bind(this));
        bot.command("models", AccessControlMiddleware.requireAccess, this.handleModels.bind(this));
        bot.command("sessions", AccessControlMiddleware.requireAccess, this.handleSessions.bind(this));
        bot.command("undo", AccessControlMiddleware.requireAccess, this.handleUndo.bind(this));
        bot.command("redo", AccessControlMiddleware.requireAccess, this.handleRedo.bind(this));
        bot.command("delete", AccessControlMiddleware.requireAccess, this.handleDeleteSession.bind(this));
        bot.command("deleteall", AccessControlMiddleware.requireAccess, this.handleDeleteAllSessions.bind(this));
        bot.command("restart", AccessControlMiddleware.requireAccess, this.handleRestart.bind(this));
        bot.command("run", AccessControlMiddleware.requireAccess, this.handleRun.bind(this));
        bot.command("createagent", AccessControlMiddleware.requireAccess, this.handleCreateAgent.bind(this));
        bot.command("agents", AccessControlMiddleware.requireAccess, this.handleAgents.bind(this));

        // Inline callbacks for persistent agents
        bot.callbackQuery(/^pagent:run:/, AccessControlMiddleware.requireAccess, this.handleRunAgentSelected.bind(this));
        bot.callbackQuery(/^pagent:runpick:/, AccessControlMiddleware.requireAccess, this.handleRunPickAgent.bind(this));
        bot.callbackQuery(/^pagent:del:/, AccessControlMiddleware.requireAccess, this.handleAgentDelete.bind(this));
        bot.callbackQuery(/^pagent:delconfirm:/, AccessControlMiddleware.requireAccess, this.handleAgentDeleteConfirm.bind(this));
        bot.callbackQuery(/^pagent:delcancel$/, AccessControlMiddleware.requireAccess, this.handleAgentDeleteCancel.bind(this));
        bot.callbackQuery(/^pagent:model:/, AccessControlMiddleware.requireAccess, this.handleAgentModelSelection.bind(this));

        // Agent question reply callbacks
        bot.callbackQuery(/^agq:/, AccessControlMiddleware.requireAccess, this.handleAgentQuestionCallback.bind(this));

        // Handle keyboard button presses
        bot.hears("⏹️ ESC", AccessControlMiddleware.requireAccess, this.handleEsc.bind(this));
        bot.hears("⇥ TAB", AccessControlMiddleware.requireAccess, this.handleTab.bind(this));

        // Handle inline button callbacks
        bot.callbackQuery("esc", AccessControlMiddleware.requireAccess, this.handleEscButton.bind(this));
        bot.callbackQuery("tab", AccessControlMiddleware.requireAccess, this.handleTabButton.bind(this));
        bot.callbackQuery(/^perm:/, AccessControlMiddleware.requireAccess, this.handlePermissionResponse.bind(this));
        bot.callbackQuery(/^del:/, AccessControlMiddleware.requireAccess, this.handleDeleteSessionCallback.bind(this));
        bot.callbackQuery(/^postdel:/, AccessControlMiddleware.requireAccess, this.handlePostDeleteChoice.bind(this));
        bot.callbackQuery(/^project:new:/, AccessControlMiddleware.requireAccess, this.handleProjectNew.bind(this));

        bot.callbackQuery(/^project:/, AccessControlMiddleware.requireAccess, this.handleProjectSelection.bind(this));
        bot.callbackQuery(/^session:resume:/, AccessControlMiddleware.requireAccess, this.handleSessionResume.bind(this));
        bot.callbackQuery(/^provider:/, AccessControlMiddleware.requireAccess, this.handleProviderSelection.bind(this));
        bot.callbackQuery(/^model:/, AccessControlMiddleware.requireAccess, this.handleModelSelection.bind(this));
        bot.callbackQuery("back:providers", AccessControlMiddleware.requireAccess, this.handleBackToProviders.bind(this));

        // Handle file uploads (documents, photos, videos, audio, etc.)
        bot.on("message:document", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:photo", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:video", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:audio", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:voice", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:video_note", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));

        // Handle regular messages (non-commands) as prompts
        bot.on("message:text", AccessControlMiddleware.requireAccess, async (ctx, next) => {
            // Skip if it's a command
            if (ctx.message?.text?.startsWith("/")) {
                return next();
            }
            // Skip if it's a keyboard button
            if (ctx.message?.text === "⏹️ ESC" || ctx.message?.text === "⇥ TAB") {
                return next();
            }
            const userId = ctx.from?.id;
            // Intercept /createagent wizard replies
            if (userId && this.createAgentWizardState.has(userId)) {
                await this.handleCreateAgentWizardReply(ctx);
                return;
            }
            // Intercept /run wizard: user typed the prompt, now show agent picker (or send directly if preselected)
            if (userId && this.runWizardState.has(userId)) {
                const prompt = ctx.message?.text?.trim() || "";
                if (prompt) {
                    const state = this.runWizardState.get(userId)!;
                    if (state.preselectedAgentId) {
                        // Agent was pre-selected from /agents — send directly
                        this.runWizardState.delete(userId);
                        const agent = this.agentDb.getById(state.preselectedAgentId);
                        if (agent) {
                            await this.sendPromptToPersistentAgent(ctx, agent, prompt);
                        } else {
                            await ctx.reply("❌ Agente no encontrado.");
                        }
                    } else {
                        this.runWizardState.set(userId, { prompt });
                        await this.showRunAgentPicker(ctx, prompt);
                    }
                }
                return;
            }
            // Regular message → always goes to main OpenCode session
            await this.handleMessageAsPrompt(ctx);
        });
    }

    private async handleStart(ctx: Context): Promise<void> {
        try {
            const helpMessage = [
                '👋 <b>Welcome to TelegramCoder!</b>',
                '',
                '🎯 <b>Session Commands:</b>',
                '/opencode [title] - Start a new OpenCode AI session',
                '   Example: /opencode Fix login bug',
                '/rename &lt;title&gt; - Rename your current session',
                '   Example: /rename Updated task name',
                '/endsession - End and close your current session',
                '/sessions - View your recent sessions (last 5)',
                '',
                '🤖 <b>AI Model Selection:</b>',
                '/models - Select AI model provider and model',
                '   Choose: opencode, github-copilot, google, zai',
                '   Default: opencode/glm-5-free',
                '',
                '📁 <b>Project Management (Gitea):</b>',
                '/new &lt;name&gt; - Create a new project in Gitea',
                '   Example: /new my-project',
                '/projects - List all your Gitea projects',
                '   Click any project to start coding!',
                '',
                '⚡️ <b>Control Commands:</b>',
                '/esc - Abort the current AI operation',
                '/undo - Revert the last message/change',
                '/redo - Restore a previously undone change',
                '/run - Switch active persistent agent',
                '/createagent - Create a new persistent subagent',
                '/agents - List / delete persistent agents',
                '/restart - Restart OpenCode server and bot',
                '⇥ TAB button - Cycle between agents (build ↔ plan)',
                '⏹️ ESC button - Same as /esc command',
                '',
                '📋 <b>Information Commands:</b>',
                '/start - Show this help message',
                '/help - Show this help message',
                '/sessions - View recent sessions with IDs',
                '',
                '💬 <b>How to Use:</b>',
                '1. Select Model: /models (choose your AI)',
                '2. Create Project: /new my-awesome-project',
                '3. View Projects: /projects (click to start)',
                '4. Chat: Just send messages directly (no /prompt needed)',
                '5. Upload: Send any file - it saves to /tmp/telegramCoder',
                '6. Control: Use ESC/TAB buttons on session message',
                '7. Undo/Redo: /undo or /redo to manage changes',
                '8. End: /endsession when done',
                '',
                '🤖 <b>Agents Available:</b>',
                '• <b>build</b> - Implements code and makes changes',
                '• <b>plan</b> - Plans and analyzes without editing',
                '• Use TAB button to switch between agents',
                '',
                '💡 <b>Tips:</b>',
                '• This help message stays - reference it anytime!',
                '• Projects are stored in /home/valle/Documentos/proyectos/gitea-projects',
                '• Gitea server: http://10.0.0.1:3000',
                '• Send files - they\'re saved to /tmp/telegramCoder',
                '• Tap the file path to copy it to clipboard',
                '• Use /models anytime to change AI model',
                '• Tab between build/plan agents as needed',
                '• Use /undo if AI makes unwanted changes',
                '• Streaming responses limited to last 50 lines',
                '',
                '🚀 <b>Get started:</b> /models then /projects'
            ].join('\n');

            await ctx.reply(helpMessage, { parse_mode: "HTML" });

            // Help message should not auto-delete - users may want to reference it
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage('show help message', error));
        }
    }

    private async handleOpenCode(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Check if user already has an active session
            if (this.opencodeService.hasActiveSession(userId)) {
                const message = await ctx.reply("✅ Session already started", {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "⏹️ ESC", callback_data: "esc" },
                                { text: "⇥ TAB", callback_data: "tab" }
                            ]
                        ]
                    }
                });

                // Schedule auto-deletion
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
                return;
            }

            // Extract title from command text (everything after /opencode)
            const text = ctx.message?.text || "";
            const title = text.replace("/opencode", "").trim() || undefined;

            // Use projects base dir as working directory for standalone /opencode
            const workDir = getProjectsBaseDir();

            // Send initial status message WITHOUT notification (silently)
            const statusMessage = await ctx.reply("🔄 Starting OpenCode session...", {
                disable_notification: true
            });

            try {
                // Show typing action while working (no notification)
                await ctx.api.sendChatAction(ctx.chat!.id, "typing");

                // Try to create session with optional title and current model
                let userSession;
                const existingSession = this.opencodeService.getUserSession(userId);
                const currentModel = existingSession?.currentModel;

                try {
                    userSession = await this.opencodeService.createSession(userId, title, currentModel, workDir);
                } catch (error) {
                    // Check if it's a connection error
                    if (error instanceof Error && (error.message.includes('Cannot connect to OpenCode server'))) {
                        // Update status silently
                        await ctx.api.editMessageText(
                            ctx.chat!.id,
                            statusMessage.message_id,
                            "🔄 OpenCode server not running. Starting server...\n\nThis may take up to 30 seconds."
                        );

                        await ctx.api.sendChatAction(ctx.chat!.id, "typing");
                        const startResult = await this.serverService.startServer();

                        if (!startResult.success) {
                            await ctx.api.editMessageText(
                                ctx.chat!.id,
                                statusMessage.message_id,
                                `❌ Failed to start OpenCode server.\n\n${startResult.message}\n\nPlease start the server manually using:\n<code>opencode serve</code>`,
                                { parse_mode: "HTML" }
                            );
                            return;
                        }

                        // Update status silently
                        await ctx.api.editMessageText(
                            ctx.chat!.id,
                            statusMessage.message_id,
                            "✅ OpenCode server started!\n\n🔄 Creating session..."
                        );
                        await ctx.api.sendChatAction(ctx.chat!.id, "typing");

                        // Retry session creation with title and model
                        userSession = await this.opencodeService.createSession(userId, title, currentModel, workDir);
                    } else {
                        throw error;
                    }
                }

                // Delete the status message and send final message WITH notification
                await ctx.api.deleteMessage(ctx.chat!.id, statusMessage.message_id);

                const modelInfo = userSession.currentModel ? `\n🤖 Model: <code>${userSession.currentModel}</code>` : "";
                const finalMessage = await ctx.reply(
                    `✅ Session started${modelInfo}`,
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "⏹️ ESC", callback_data: "esc" },
                                    { text: "⇥ TAB", callback_data: "tab" }
                                ]
                            ]
                        }
                    }
                );

                // Store chat context and start event streaming
                this.opencodeService.updateSessionContext(userId, ctx.chat!.id, finalMessage.message_id);

                // Start event streaming in background
                this.opencodeService.startEventStream(userId, ctx).catch(error => {
                    console.error("Event stream error:", error);
                });
            } catch (error) {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMessage.message_id,
                    ErrorUtils.createErrorMessage("start OpenCode session", error)
                );
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("start OpenCode session", error));
        }
    }

    private async handleMessageAsPrompt(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            const promptText = ctx.message?.text?.trim() || "";
            if (!promptText) return;

            // ── Always route to main OpenCode session ─────────────────────
            if (!this.opencodeService.hasActiveSession(userId)) {
                await this.opencodeService.tryRestoreLatestSession(userId, ctx);
            }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("❌ No hay sesión activa. Usa /projects para elegir un proyecto.");
                return;
            }

            this.opencodeService.ensureEventStream(userId, ctx);

            const userSession = this.opencodeService.getUserSession(userId);
            if (userSession?.isProcessing) {
                await ctx.reply("⏳ Espera — OpenCode aún está procesando. Responderá enseguida.");
                return;
            }

            if (userSession) userSession.isProcessing = true;

            const mentions = this.fileMentionService.parseMentions(promptText);
            if (mentions.length > 0 && this.fileMentionService.isEnabled()) {
                await this.handlePromptWithMentions(ctx, userId, promptText, mentions);
            } else {
                await this.sendPromptToOpenCode(ctx, userId, promptText);
            }
        } catch (error) {
            const userId = ctx.from?.id;
            if (userId) {
                const s = this.opencodeService.getUserSession(userId);
                if (s) s.isProcessing = false;
            }
            await ctx.reply(ErrorUtils.createErrorMessage("send prompt to OpenCode", error));
        }
    }

    /** Send a prompt to a persistent agent and deliver the response */
    private async sendPromptToPersistentAgent(ctx: Context, agent: any, promptText: string): Promise<void> {
        const statusMsg = await ctx.reply(
            `🤖 <b>${escapeHtml(agent.name)}</b> procesando…`,
            { parse_mode: "HTML" }
        );
        await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => { });

        const result = await this.persistentAgentService.sendPrompt(agent, promptText);

        const header = `🤖 <b>${escapeHtml(agent.name)}</b>\n\n`;
        const body = result.output || "(sin salida)";
        const MAX = 3800;

        if (body.length <= MAX) {
            await ctx.api.editMessageText(
                statusMsg.chat.id,
                statusMsg.message_id,
                `${header}${formatAsHtml(body)}`,
                { parse_mode: "HTML" }
            ).catch(async () => {
                await ctx.reply(`${header}${formatAsHtml(body)}`, { parse_mode: "HTML" });
            });
        } else {
            await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => { });
            const buf = Buffer.from(body, "utf8");
            await ctx.replyWithDocument(new InputFile(buf, `${agent.name}-respuesta.md`), {
                caption: `${header}(resultado adjunto por longitud)`,
                parse_mode: "HTML",
            });
        }
    }

    private async handlePromptWithMentions(
        ctx: Context,
        userId: number,
        promptText: string,
        mentions: any[]
    ): Promise<void> {
        try {
            // Show searching indicator
            const searchMessage = await this.fileMentionUI.showSearching(ctx, mentions.length);

            // Search for files
            const matches = await this.fileMentionService.searchMentions(mentions);

            // Delete searching message
            await ctx.api.deleteMessage(searchMessage.chat.id, searchMessage.message_id).catch(() => { });

            // Get user confirmation for file selections
            const selectedFiles = await this.fileMentionUI.confirmAllMatches(ctx, matches);

            if (!selectedFiles) {
                await ctx.reply("❌ File selection cancelled");
                return;
            }

            // Resolve files and get content
            const resolved = await this.fileMentionService.resolveMentions(
                mentions,
                selectedFiles,
                true
            );

            // Format file context
            const fileContext = this.fileMentionService.formatForPrompt(resolved);

            // Send prompt with file context
            await this.sendPromptToOpenCode(ctx, userId, promptText, fileContext);

        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("process file mentions", error));
        }
    }

    private async sendPromptToOpenCode(ctx: Context, userId: number, promptText: string, fileContext?: string): Promise<void> {
        try {
            // Send typing indicator so the user knows working has started
            await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => { });

            // 🔥 KEY FIX: We DO NOT await sendPrompt here. 
            // If we await it, the HTTP request blocks the Telegram handler.
            // If GLM-5 takes longer than 60s, Telegram or Node drops the connection,
            // which cancels the generation in OpenCode!
            this.opencodeService.sendPrompt(userId, promptText, fileContext).catch(async (error) => {
                console.error("[OpenCode] Error sending prompt:", error);
                // Only reply if there was a hard crash initiating the prompt
                if (error instanceof Error && error.message.includes('No active session')) {
                    await ctx.reply("❌ Error: No session active.");
                } else {
                    await ctx.reply(`❌ Connection to OpenCode lost: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            });

            // The SSE Stream handler (`session.idle`) will take care of collecting 
            // all the `message.part.updated` chunks and sending the final answer
            // back to the user cleanly.

        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("send prompt to OpenCode", error));
        }
    }


    private async handleEndSession(ctx: Context): Promise<void> {
        // Same behaviour as /delete
        return this.handleDeleteSession(ctx);
    }

    private async handleEsc(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("ℹ️ You don't have an active OpenCode session. Use /opencode to start one.");
                return;
            }

            const success = await this.opencodeService.abortSession(userId);

            if (success) {
                await ctx.reply("⏹️ Current operation aborted successfully.");
            } else {
                await ctx.reply("⚠️ Failed to abort operation. Please try again.");
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("abort OpenCode operation", error));
        }
    }

    private async handleTab(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("ℹ️ You don't have an active OpenCode session. Use /opencode to start one.");
                return;
            }

            try {
                // Cycle to next agent
                const result = await this.opencodeService.cycleToNextAgent(userId);

                if (result.success && result.currentAgent) {
                    // Show simple agent name message
                    const message = await ctx.reply(`⇥ <b>${result.currentAgent}</b>`, { parse_mode: "HTML" });

                    // Schedule auto-deletion
                    await MessageUtils.scheduleMessageDeletion(
                        ctx,
                        message.message_id,
                        this.configService.getMessageDeleteTimeout()
                    );
                } else {
                    const errorMsg = await ctx.reply("⚠️ Failed to cycle agent. Please try again.");
                    await MessageUtils.scheduleMessageDeletion(
                        ctx,
                        errorMsg.message_id,
                        this.configService.getMessageDeleteTimeout()
                    );
                }
            } catch (error) {
                const errorMsg = await ctx.reply(ErrorUtils.createErrorMessage("cycle agent", error));
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    errorMsg.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("handle TAB", error));
        }
    }

    private async handleEscButton(ctx: Context): Promise<void> {
        try {
            // Answer the callback query to remove loading state
            await ctx.answerCallbackQuery();

            // Call the same handler as the ESC command/keyboard
            await this.handleEsc(ctx);
        } catch (error) {
            await ctx.answerCallbackQuery("Error handling ESC");
            console.error("Error in handleEscButton:", error);
        }
    }

    private async handleTabButton(ctx: Context): Promise<void> {
        try {
            // Answer the callback query to remove loading state
            await ctx.answerCallbackQuery();

            // Call the same handler as the TAB keyboard
            await this.handleTab(ctx);
        } catch (error) {
            await ctx.answerCallbackQuery("Error handling TAB");
            console.error("Error in handleTabButton:", error);
        }
    }

    private async handleRename(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Check if user has an active session
            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("❌ No active session. Use /opencode to start one first.");
                return;
            }

            // Extract new title from command text
            const text = ctx.message?.text || "";
            const newTitle = text.replace("/rename", "").trim();

            if (!newTitle) {
                await ctx.reply("❌ Please provide a new title.\n\nUsage: /rename <new title>");
                return;
            }

            // Update the session title
            const result = await this.opencodeService.updateSessionTitle(userId, newTitle);

            if (result.success) {
                const message = await ctx.reply(`✅ Session renamed to: <b>${result.title || newTitle}</b>`, { parse_mode: "HTML" });

                // Schedule auto-deletion
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            } else {
                await ctx.reply(`❌ ${result.message || "Failed to rename session"}`);
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("rename session", error));
        }
    }

    private async handleProjects(ctx: Context): Promise<void> {
        try {
            // Get projects from Gitea
            const giteaProjects = await this.giteaService.listProjects();

            if (giteaProjects.length === 0) {
                await ctx.reply(
                    "📂 No projects found in Gitea.\n\n" +
                    "Create your first project with:\n" +
                    "/new <project-name>"
                );
                return;
            }

            // Create inline keyboard with project buttons
            const keyboard = new InlineKeyboard();

            giteaProjects.forEach((project) => {
                keyboard.text(
                    `📁 ${project.name}`,
                    `project:${project.name}`
                ).row();
            });

            await ctx.reply(
                `📂 <b>Your Gitea Projects (${giteaProjects.length}):</b>\n\n` +
                `Click a project to start coding with /opencode`,
                {
                    parse_mode: "HTML",
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("list projects", error));
        }
    }

    private async handleSessions(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) return;

            const existingSession = this.opencodeService.getUserSession(userId);

            // Determine project name: from active session or from DB active session
            let projectName: string | undefined;

            if (existingSession) {
                const projectPath = (existingSession.session as any).directory || getProjectsBaseDir();
                projectName = nodePath.basename(projectPath);
            } else {
                // Try to get it from the DB active session
                const dbActive = this.opencodeService.dbService.getUserSessions(userId, 1).find(s => s.isActive);
                if (dbActive) {
                    projectName = dbActive.projectId !== "global" ? dbActive.projectId : undefined;
                }
            }

            if (!projectName) {
                // No context: show all sessions grouped, or redirect to /projects
                const allSessions = this.opencodeService.dbService.getUserSessions(userId, 20);
                if (allSessions.length === 0) {
                    const msg = await ctx.reply("📂 No tienes sesiones guardadas. Usa /projects para elegir un proyecto.");
                    await MessageUtils.scheduleMessageDeletion(ctx, msg.message_id, 10000);
                    return;
                }
                const keyboard = new InlineKeyboard();
                for (const session of allSessions) {
                    const shortId = session.id.substring(0, 8);
                    const label = `${session.isActive ? "✅" : "🔁"} [${session.projectId}] ${session.title || "Untitled"} (${shortId})`;
                    keyboard.text(label, `session:resume:${session.id}:${session.projectId}`).row();
                }
                await ctx.reply(
                    `📂 <b>Todas tus sesiones</b>\n\nElige una para reanudarla:`,
                    { parse_mode: "HTML", reply_markup: keyboard }
                );
                return;
            }

            const recentSessions = this.opencodeService.dbService.getUserSessions(userId, 10)
                .filter(s => s.projectId === projectName);

            const keyboard = new InlineKeyboard();

            if (recentSessions.length > 0) {
                for (const session of recentSessions) {
                    const shortId = session.id.substring(0, 8);
                    const title = session.title || "Untitled";
                    const activeMarker = session.isActive ? "✅" : "🔁";
                    const label = `${activeMarker} ${title} (${shortId})`;
                    keyboard.text(label, `session:resume:${session.id}:${projectName}`).row();
                }
            }

            keyboard.text("🆕 Nueva sesión", `project:new:${projectName}`);

            await ctx.reply(
                `📂 <b>${projectName}</b>\n\nAquí están las sesiones de este proyecto. ¿Qué quieres hacer?`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );

        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("list sessions", error));
        }
    }

    private async handleDeleteSession(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) return;

            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";

            // Determine which session to delete
            let sessionId: string | undefined;
            let sessionTitle: string | undefined;

            const memSession = this.opencodeService.getUserSession(userId);
            if (memSession) {
                sessionId = memSession.sessionId;
                sessionTitle = memSession.session?.title;
            } else {
                // Try OpenCode directly
                const resp = await fetch(`${baseUrl}/session`);
                if (resp.ok) {
                    const all: any[] = await resp.json();
                    if (all.length > 0) {
                        const latest = all.sort((a, b) => b.time.updated - a.time.updated)[0];
                        sessionId = latest.id;
                        sessionTitle = latest.title;
                    }
                }
            }

            if (!sessionId) {
                // Nothing to delete — go straight to the "what next?" menu
                await this.showPostDeleteMenu(ctx);
                return;
            }

            // Delete from OpenCode
            const delResp = await fetch(`${baseUrl}/session/${sessionId}`, { method: "DELETE" });
            this.opencodeService.dbService.deleteSession(sessionId);

            // Clear memory
            this.opencodeService.stopEventStream(userId);
            (this.opencodeService as any).userSessions.delete(userId);

            if (!delResp.ok) {
                await ctx.reply("❌ Falló el borrado en OpenCode.");
                return;
            }

            // Show "what next?" menu
            await this.showPostDeleteMenu(ctx, sessionTitle);

        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("delete session", error));
        }
    }

    private async showPostDeleteMenu(ctx: Context, deletedTitle?: string): Promise<void> {
        const header = deletedTitle
            ? `🗑️ Sesión "<b>${deletedTitle}</b>" borrada.`
            : `🗑️ Sesión borrada.`;

        const keyboard = new InlineKeyboard()
            .text("🆕 Nueva sesión", "postdel:new")
            .text("📂 Mis proyectos", "postdel:projects");

        await ctx.reply(
            `${header}\n\n¿Qué quieres hacer ahora?`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    private async handlePostDeleteChoice(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const choice = (ctx.callbackQuery?.data || "").replace("postdel:", "");
            const userId = ctx.from?.id;
            if (!userId) return;

            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

            if (choice === "projects") {
                await this.handleProjects(ctx);
            } else if (choice === "new") {
                // No project context — show projects to pick from
                await ctx.reply("📂 Elige un proyecto para empezar la nueva sesión:");
                await this.handleProjects(ctx);
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("postdel choice", error));
        }
    }

    private async handleDeleteAllSessions(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) return;

            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";

            // Get sessions directly from OpenCode (source of truth)
            const resp = await fetch(`${baseUrl}/session`);
            if (!resp.ok) {
                await ctx.reply("❌ No se pudo conectar con OpenCode.");
                return;
            }
            const allSessions: any[] = await resp.json();

            if (allSessions.length === 0) {
                await ctx.reply("✅ No hay sesiones que borrar.");
                return;
            }

            const msg = await ctx.reply(`⏳ Borrando ${allSessions.length} sesión(es)...`);

            // Stop event stream and clear memory
            this.opencodeService.stopEventStream(userId);
            (this.opencodeService as any).userSessions.delete(userId);

            let deleted = 0;
            for (const s of allSessions) {
                try {
                    const delResp = await fetch(`${baseUrl}/session/${s.id}`, { method: "DELETE" });
                    if (delResp.ok) deleted++;
                    this.opencodeService.dbService.deleteSession(s.id);
                } catch (err) {
                    console.error("Failed to delete session", s.id, err);
                }
            }

            // Also clean DB for this user
            this.opencodeService.dbService.deleteAllUserSessions(userId);

            await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                `🗑️ ${deleted}/${allSessions.length} sesiones borradas.\n\nUsa /projects para empezar de nuevo.`
            );
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("delete all sessions", error));
        }
    }

    /** Callback when user picks a specific session to delete from the inline list */
    private async handleDeleteSessionCallback(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            const sessionId = (ctx.callbackQuery?.data || "").replace(/^del:/, "");
            if (!sessionId) return;

            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
            const delResp = await fetch(`${baseUrl}/session/${sessionId}`, { method: "DELETE" });
            this.opencodeService.dbService.deleteSession(sessionId);

            // If this was the active in-memory session, clear it
            const mem = this.opencodeService.getUserSession(userId);
            if (mem?.sessionId === sessionId) {
                this.opencodeService.stopEventStream(userId);
                (this.opencodeService as any).userSessions.delete(userId);
            }

            if (delResp.ok) {
                await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
                await this.showPostDeleteMenu(ctx);
            } else {
                await ctx.editMessageText("❌ Falló el borrado en OpenCode.");
            }
        } catch (error) {
            console.error("Error in handleDeleteSessionCallback:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("delete session", error));
        }
    }

    private async handleUndo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const result = await this.opencodeService.undoLastMessage(userId);

            if (result.success) {
                const message = await ctx.reply("↩️ <b>Undone</b> - Last message reverted", { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            } else {
                const errorMsg = result.message || "Failed to undo last message";
                const message = await ctx.reply(`❌ ${errorMsg}`);
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("undo", error));
        }
    }

    private async handleRedo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        try {
            const result = await this.opencodeService.redoLastMessage(userId);

            if (result.success) {
                const message = await ctx.reply("↪️ <b>Redone</b> - Change restored", { parse_mode: "HTML" });
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            } else {
                const errorMsg = result.message || "Failed to redo last message";
                const message = await ctx.reply(`❌ ${errorMsg}`);
                await MessageUtils.scheduleMessageDeletion(
                    ctx,
                    message.message_id,
                    this.configService.getMessageDeleteTimeout()
                );
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("redo", error));
        }
    }

    private async handleFileUpload(ctx: Context): Promise<void> {
        try {
            const message = ctx.message;
            if (!message) return;

            let fileId: string | undefined;
            let fileName: string | undefined;
            let fileType: string = "file";

            // Extract file info based on message type
            if (message.document) {
                fileId = message.document.file_id;
                fileName = message.document.file_name || `document_${Date.now()}`;
                fileType = "document";
            } else if (message.photo && message.photo.length > 0) {
                // Get the largest photo
                const photo = message.photo[message.photo.length - 1];
                fileId = photo.file_id;
                fileName = `photo_${Date.now()}.jpg`;
                fileType = "photo";
            } else if (message.video) {
                fileId = message.video.file_id;
                fileName = message.video.file_name || `video_${Date.now()}.mp4`;
                fileType = "video";
            } else if (message.audio) {
                fileId = message.audio.file_id;
                fileName = message.audio.file_name || `audio_${Date.now()}.mp3`;
                fileType = "audio";
            } else if (message.voice) {
                fileId = message.voice.file_id;
                fileName = `voice_${Date.now()}.ogg`;
                fileType = "voice";
            } else if (message.video_note) {
                fileId = message.video_note.file_id;
                fileName = `video_note_${Date.now()}.mp4`;
                fileType = "video_note";
            }

            if (!fileId || !fileName) {
                await ctx.reply("❌ Unable to process this file type");
                return;
            }

            // Get file from Telegram
            const file = await ctx.api.getFile(fileId);
            if (!file.file_path) {
                await ctx.reply("❌ Unable to get file path from Telegram");
                return;
            }

            // Download file
            const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
            const response = await fetch(fileUrl);

            if (!response.ok) {
                await ctx.reply("❌ Failed to download file from Telegram");
                return;
            }

            // Ensure directory exists (create if needed)
            const saveDir = "/tmp/telegramCoder";
            if (!fs.existsSync(saveDir)) {
                console.log(`Creating directory: ${saveDir}`);
                fs.mkdirSync(saveDir, { recursive: true });
                console.log(`✓ Directory created: ${saveDir}`);
            }

            // Save file
            const savePath = nodePath.join(saveDir, fileName);
            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(savePath, buffer);

            // Send confirmation with clickable filename
            const confirmMessage = await ctx.reply(
                `✅ <b>File saved!</b>\n\nPath: <code>${savePath}</code>\n\nTap the path to copy it.`,
                { parse_mode: "HTML" }
            );

            // Auto-delete after configured timeout
            await MessageUtils.scheduleMessageDeletion(
                ctx,
                confirmMessage.message_id,
                this.configService.getMessageDeleteTimeout()
            );

            console.log(`✓ File saved: ${savePath} (${fileType}, ${buffer.length} bytes)`);

        } catch (error) {
            console.error("Error handling file upload:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("save file", error));
        }
    }

    private async handleNewProject(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Extract project name and description from command
            const text = ctx.message?.text || "";
            const args = text.replace("/new", "").trim().split("\n");
            const projectName = args[0]?.trim();
            const description = args[1]?.trim() || "";

            if (!projectName) {
                await ctx.reply(
                    "❌ Please provide a project name.\n\n" +
                    "Usage:\n" +
                    "/new <project-name>\n" +
                    "<description> (optional)\n\n" +
                    "Example:\n" +
                    "/new my-awesome-app\n" +
                    "A cool application for managing tasks"
                );
                return;
            }

            const statusMessage = await ctx.reply(`🔄 Creating project "${projectName}" in Gitea...`);

            // Create project in Gitea
            const project = await this.giteaService.createProject({
                name: projectName,
                description: description,
                private: false,
            });

            if (!project) {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMessage.message_id,
                    `❌ Failed to create project "${projectName}" in Gitea.\n\nPlease check:\n• Gitea server is running (10.0.0.1:3000)\n• Token is valid\n• Project name is unique`
                );
                return;
            }

            // Clone the repository to local workspace
            const workDir = process.env.GITEA_DEFAULT_WORKDIR || "/home/valle/Documentos/proyectos/gitea-projects";
            const projectPath = nodePath.join(workDir, projectName);

            await ctx.api.editMessageText(
                ctx.chat!.id,
                statusMessage.message_id,
                `✅ Project "${projectName}" created in Gitea!\n\n🔄 Cloning to local workspace...`
            );

            // Clone the repository
            const { execSync } = await import("child_process");
            try {
                execSync(`git clone ${project.ssh_url} "${projectPath}"`, {
                    cwd: workDir,
                    stdio: "pipe",
                });
            } catch (cloneError) {
                console.error("Git clone error:", cloneError);
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMessage.message_id,
                    `✅ Project "${projectName}" created in Gitea!\n⚠️ Could not clone automatically.\n\nYou can clone it manually:\n<code>git clone ${project.ssh_url}</code>`,
                    { parse_mode: "HTML" }
                );
                return;
            }

            await ctx.api.editMessageText(
                ctx.chat!.id,
                statusMessage.message_id,
                `✅ Project "${projectName}" ready!\n\n📂 Location: <code>${projectPath}</code>\n🔗 Gitea: ${project.html_url}\n\nUse /projects to see all projects or /opencode ${projectName} to start coding!`,
                { parse_mode: "HTML" }
            );

        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("create new project", error));
        }
    }

    /** Handles approve/reject responses to OpenCode permission requests */
    private async handlePermissionResponse(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            const callbackData = ctx.callbackQuery?.data || "";
            // format: perm:RESPONSE:PERMISSION_ID  (response = once | always | reject)
            const parts = callbackData.replace(/^perm:/, "").split(":");
            const response = parts[0] as "once" | "always" | "reject";
            const permissionId = parts.slice(1).join(":");

            const userId = ctx.from?.id;
            if (!userId || !permissionId || !response) return;

            const userSession = this.opencodeService.getUserSession(userId);
            if (!userSession) {
                await ctx.editMessageText("❌ No hay sesión activa para responder este permiso.");
                return;
            }

            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";

            // Reply via the session-scoped endpoint
            const resp = await fetch(
                `${baseUrl}/session/${userSession.sessionId}/permissions/${permissionId}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ response }),
                }
            );

            const responseLabel: Record<string, string> = {
                once: "✅ Permitido (una vez)",
                always: "♾️ Permitido (siempre)",
                reject: "❌ Rechazado",
            };
            const label = responseLabel[response] ?? response;

            if (resp.ok) {
                // Edit the permission message to show the decision
                await ctx.editMessageText(
                    `${label}\n\n<i>Permiso respondido. OpenCode continúa...</i>`,
                    { parse_mode: "HTML" }
                );
            } else {
                const errText = await resp.text().catch(() => resp.status.toString());
                await ctx.editMessageText(
                    `⚠️ No se pudo enviar la respuesta al permiso (${errText}).\n\nIntenta de nuevo o usa /esc para abortar.`
                );
            }

            // Clear pending permission state
            userSession.pendingPermissionId = undefined;
            userSession.pendingPermissionMsgId = undefined;

        } catch (error) {
            console.error("Error handling permission response:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("responder permiso", error));
        }
    }

    private async handleProjectSelection(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            const callbackData = ctx.callbackQuery?.data || "";
            // format: project:NAME  (never project:new:NAME — that's handled separately)
            const projectName = callbackData.replace(/^project:/, "");

            if (!projectName || projectName.startsWith("new:")) {
                await ctx.reply("❌ Invalid project selection");
                return;
            }

            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Determine project path to filter sessions
            const workDir = getProjectsBaseDir();
            const projectPath = nodePath.join(workDir, projectName);

            // Siempre buscamos en OpenCode si ya hay sesiones para este proyecto
            const recentSessions = await this.opencodeService.getSessions(5, projectPath);

            if (recentSessions.length > 0) {
                const keyboard = new InlineKeyboard();

                for (const session of recentSessions) {
                    const shortId = session.id.substring(0, 8);
                    const title = session.title || "Untitled";
                    const label = `🔁 ${title} (${shortId})`;
                    keyboard.text(label, `session:resume:${session.id}:${projectName}`).row();
                }

                keyboard.text("🆕 Nueva sesión", `project:new:${projectName}`);

                await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
                await ctx.reply(
                    `📂 <b>${projectName}</b>\n\nTienes sesiones previas en este proyecto. ¿Qué quieres hacer?`,
                    { parse_mode: "HTML", reply_markup: keyboard }
                );
            } else {
                // No hay sesiones — entrar directo con sesión nueva
                await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
                const statusMsg = await ctx.reply(
                    `🔄 Iniciando sesión para "<b>${projectName}</b>"...`,
                    { parse_mode: "HTML", disable_notification: true }
                );
                await this.startSessionForProject(ctx, userId, projectName, statusMsg.message_id);
            }

        } catch (error) {
            console.error("Error in handleProjectSelection:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("select project", error));
        }
    }

    /** Called when user picks "🆕 Nueva sesión" from the project options menu */
    private async handleProjectNew(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            const callbackData = ctx.callbackQuery?.data || "";
            const projectName = callbackData.replace("project:new:", "");

            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // End existing session first
            if (this.opencodeService.hasActiveSession(userId)) {
                await this.opencodeService.deleteSession(userId);
            }

            const statusMsg = await ctx.editMessageText(`🔄 Iniciando nueva sesión para "<b>${projectName}</b>"...`, { parse_mode: "HTML" });
            const statusMsgId = (statusMsg as any).message_id ?? ctx.callbackQuery?.message?.message_id;
            await this.startSessionForProject(ctx, userId, projectName, statusMsgId);

        } catch (error) {
            console.error("Error in handleProjectNew:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("nueva sesión", error));
        }
    }

    /** Called when user picks an existing session to resume */
    private async handleSessionResume(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            const callbackData = ctx.callbackQuery?.data || "";
            // format: session:resume:SESSION_ID:PROJECT_NAME
            const parts = callbackData.replace("session:resume:", "").split(":");
            const sessionId = parts[0];
            const projectName = parts.slice(1).join(":");

            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            await ctx.editMessageText(`🔄 Reanudando sesión para "${projectName}"...`);
            await ctx.api.sendChatAction(ctx.chat!.id, "typing");

            // End current active session if any
            if (this.opencodeService.hasActiveSession(userId)) {
                await this.opencodeService.deleteSession(userId);
            }

            // Ensure server is running
            const startResult = await this.serverService.startServer();
            if (!startResult.success && !startResult.message.includes("already running")) {
                await ctx.editMessageText(`❌ Failed to start OpenCode server: ${startResult.message}`);
                return;
            }

            // Re-attach to the existing session by ID
            const existingUserSession = this.opencodeService.getUserSession(userId);

            // Fetch session directly from OpenCode by ID using REST (SDK list() drops query params)
            const baseUrl = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
            let sessionData: any = null;
            try {
                const resp = await fetch(`${baseUrl}/session/${sessionId}`);
                if (resp.ok) {
                    sessionData = await resp.json();
                }
            } catch (_) { /* will be caught below */ }

            if (!sessionData) {
                // Fallback: scan full list
                try {
                    const resp = await fetch(`${baseUrl}/session`);
                    if (resp.ok) {
                        const all: any[] = await resp.json();
                        sessionData = all.find((s: any) => s.id === sessionId);
                    }
                } catch (_) { /* ignore */ }
            }

            if (!sessionData) {
                // Session is gone from OpenCode — remove from DB and inform user
                this.opencodeService.dbService.deleteSession(sessionId);
                await ctx.editMessageText("❌ Esa sesión ya no existe en OpenCode. Se ha eliminado del historial local.\n\nUsa /projects para empezar una sesión nueva.");
                return;
            }

            // Extract model from session title if present: "My Project [opencode/glm-5]"
            let currentModel = existingUserSession?.currentModel || process.env.OPENCODE_DEFAULT_MODEL || "opencode/glm-5-free";
            const sessionTitleDisplay = sessionData.title || projectName;
            const titleMatch = sessionTitleDisplay.match(/\[(.*?)\]/);
            if (titleMatch && titleMatch[1]) {
                currentModel = titleMatch[1];
            }

            // Register the session in memory
            (this.opencodeService as any).userSessions.set(userId, {
                userId,
                sessionId,
                session: sessionData,
                createdAt: new Date(),
                currentAgent: "build",
                currentModel,
            });

            // Set session active in local DB
            this.opencodeService.dbService.setActiveSession(userId, sessionId);
            // Re-attach context
            this.opencodeService.updateSessionContext(userId, ctx.chat?.id || 0, ctx.message?.message_id || 0);

            await ctx.deleteMessage();
            const modelInfo = currentModel ? `\n🤖 Model: <code>${currentModel}</code>` : "";
            const finalMessage = await ctx.reply(
                `✅ Sesión reanudada: <b>${sessionData.title || projectName}</b>${modelInfo}`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "⏹️ ESC", callback_data: "esc" },
                            { text: "⇥ TAB", callback_data: "tab" }
                        ]]
                    }
                }
            );

            this.opencodeService.updateSessionContext(userId, ctx.chat!.id, finalMessage.message_id);
            this.opencodeService.startEventStream(userId, ctx).catch(error => {
                console.error("Event stream error:", error);
            });

        } catch (error) {
            console.error("Error in handleSessionResume:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("reanudar sesión", error));
        }
    }

    /** Shared logic: ensure project is local, start server, create session.
     *  statusMsgId: ID of an existing bot message to edit with status updates.
     *  If not provided, a new message is sent.
     */
    private async startSessionForProject(ctx: Context, userId: number, projectName: string, statusMsgId?: number): Promise<void> {
        const chatId = ctx.chat!.id;
        const workDir = getProjectsBaseDir();
        const projectPath = nodePath.join(workDir, projectName);

        const editStatus = async (text: string) => {
            if (statusMsgId) {
                await ctx.api.editMessageText(chatId, statusMsgId, text, { parse_mode: "HTML" }).catch(() => {});
            }
            // Always send typing action
            await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
        };

        const sendStatus = async (text: string): Promise<number> => {
            const msg = await ctx.api.sendMessage(chatId, text, { parse_mode: "HTML", disable_notification: true });
            statusMsgId = msg.message_id;
            return msg.message_id;
        };

        if (!statusMsgId) {
            await sendStatus(`🔄 Iniciando sesión para "<b>${projectName}</b>"...`);
        }

        // Clone project if not present locally
        if (!fs.existsSync(projectPath)) {
            const project = await this.giteaService.getProject(projectName);
            if (project) {
                await editStatus(`📦 Clonando "<b>${projectName}</b>" desde Gitea...`);
                const { execSync } = await import("child_process");
                try {
                    execSync(`git clone ${project.ssh_url} "${projectPath}"`, {
                        cwd: workDir,
                        stdio: "pipe",
                    });
                } catch (cloneError) {
                    console.error("Git clone error:", cloneError);
                    await editStatus(`❌ No se pudo clonar "<b>${projectName}</b>". Revisa la configuración de Git/SSH.`);
                    return;
                }
            } else {
                await editStatus(`❌ Proyecto "<b>${projectName}</b>" no encontrado en Gitea.`);
                return;
            }
        }

        // Start OpenCode server
        await editStatus(`🔄 Arrancando sesión para "<b>${projectName}</b>"...`);
        const startResult = await this.serverService.startServer();
        if (!startResult.success && !startResult.message.includes("already running")) {
            await editStatus(`❌ OpenCode server no disponible: ${startResult.message}`);
            return;
        }

        // Create new session
        try {
            const existingSession = this.opencodeService.getUserSession(userId);
            const currentModel = existingSession?.currentModel;
            const userSession = await this.opencodeService.createSession(userId, projectName, currentModel, projectPath);

            const modelInfo = userSession.currentModel ? `\n🤖 Model: <code>${userSession.currentModel}</code>` : "";

            // Delete the status message and send final confirmation
            if (statusMsgId) {
                await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
            }
            const finalMessage = await ctx.api.sendMessage(
                chatId,
                `✅ Sesión iniciada: <b>${projectName}</b>${modelInfo}\n📂 <code>${projectPath}</code>`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "⏹️ ESC", callback_data: "esc" },
                            { text: "⇥ TAB", callback_data: "tab" }
                        ]]
                    }
                }
            );

            this.opencodeService.updateSessionContext(userId, chatId, finalMessage.message_id);
            this.opencodeService.startEventStream(userId, ctx).catch(error => {
                console.error("Event stream error:", error);
            });
        } catch (error) {
            await editStatus(ErrorUtils.createErrorMessage("iniciar sesión", error));
        }
    }

    // Available models grouped by provider
    private getAvailableModels(): Map<string, string[]> {
        const models = new Map<string, string[]>();

        // OpenCode models
        models.set("opencode", [
            "big-pickle",
            "claude-3-5-haiku",
            "claude-haiku-4-5",
            "claude-opus-4-1",
            "claude-opus-4-5",
            "claude-opus-4-6",
            "claude-sonnet-4",
            "claude-sonnet-4-5",
            "claude-sonnet-4-6",
            "gemini-3-flash",
            "gemini-3-pro",
            "gemini-3.1-pro",
            "glm-4.6",
            "glm-4.7",
            "glm-5",
            "glm-5-free",
            "gpt-5",
            "gpt-5-codex",
            "gpt-5-nano",
            "gpt-5.1",
            "gpt-5.1-codex",
            "gpt-5.1-codex-max",
            "gpt-5.1-codex-mini",
            "gpt-5.2",
            "gpt-5.2-codex",
            "kimi-k2",
            "kimi-k2-thinking",
            "kimi-k2.5",
            "minimax-m2.1",
            "minimax-m2.5",
            "minimax-m2.5-free",
            "trinity-large-preview-free"
        ]);

        // GitHub Copilot models
        models.set("github-copilot", [
            "claude-haiku-4.5",
            "claude-opus-4.5",
            "claude-opus-4.6",
            "claude-opus-41",
            "claude-sonnet-4",
            "claude-sonnet-4.5",
            "claude-sonnet-4.6",
            "gemini-2.5-pro",
            "gemini-3-flash-preview",
            "gemini-3-pro-preview",
            "gemini-3.1-pro-preview",
            "gpt-4.1",
            "gpt-4o",
            "gpt-5",
            "gpt-5-mini",
            "gpt-5.1",
            "gpt-5.1-codex",
            "gpt-5.1-codex-max"
        ]);

        // Google/Gemini models
        models.set("google", [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-3-flash-preview",
            "gemini-3-pro-preview",
            "gemini-3.1-pro-preview",
            "gemini-3.1-pro-preview-customtools"
        ]);

        // ZAI models
        models.set("zai", [
            "glm-4.5",
            "glm-4.5-air",
            "glm-4.5-flash",
            "glm-4.5v",
            "glm-4.6",
            "glm-4.6v",
            "glm-4.7",
            "glm-4.7-flash",
            "glm-5"
        ]);

        return models;
    }

    private async handleModels(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Always show the main session model picker
            const userSession = this.opencodeService.getUserSession(userId);
            const currentModel = userSession?.currentModel || process.env.OPENCODE_DEFAULT_MODEL || "opencode/glm-5-free";
            await this.replyWithProviders(ctx, currentModel, "main");
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("show models", error));
        }
    }

    /** Shared helper: sends the provider picker message */
    private async replyWithProviders(ctx: Context, currentModel: string, target: "main" | string, edit = false): Promise<void> {
        const models = this.getAvailableModels();
        const providers = Array.from(models.keys());
        const keyboard = new InlineKeyboard();

        const prefix = target === "main" ? "provider:" : `pagent:model:${target.slice(0, 8)}:provider:`;

        providers.forEach((provider) => {
            keyboard.text(`🔹 ${provider}`, `${prefix}${provider}`).row();
        });

        const targetLabel = target === "main"
            ? "sesión principal"
            : `agente <b>${escapeHtml(this.agentDb.getById(target)?.name ?? target)}</b>`;

        const text =
            `🤖 <b>Selecciona proveedor</b>\n\n` +
            `Cambiando modelo de: ${targetLabel}\n` +
            `Modelo actual: <code>${currentModel}</code>`;

        if (edit) {
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        } else {
            await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
        }
    }

    private async handleProviderSelection(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            const callbackData = ctx.callbackQuery?.data || "";
            const provider = callbackData.replace("provider:", "");

            if (!provider) {
                await ctx.reply("❌ Invalid provider selection");
                return;
            }

            // "__main__" means user chose to change the main session model
            if (provider === "__main__") {
                const userId = ctx.from?.id;
                const userSession = userId ? this.opencodeService.getUserSession(userId) : undefined;
                const currentModel = userSession?.currentModel || process.env.OPENCODE_DEFAULT_MODEL || "opencode/glm-5-free";
                await this.replyWithProviders(ctx, currentModel, "main", true);
                return;
            }

            // Get models for this provider
            const models = this.getAvailableModels();
            const providerModels = models.get(provider) || [];

            if (providerModels.length === 0) {
                await ctx.editMessageText(`❌ No models found for provider: ${provider}`);
                return;
            }

            // Create keyboard with models for this provider
            const keyboard = new InlineKeyboard();

            providerModels.forEach((model) => {
                keyboard.text(
                    `⚡ ${model}`,
                    `model:${provider}/${model}`
                ).row();
            });

            // Add back button
            keyboard.text("◀️ Back to Providers", "back:providers");

            await ctx.editMessageText(
                `🤖 <b>${provider}</b> Models\n\n` +
                `Select a model:`,
                {
                    parse_mode: "HTML",
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            console.error("Error in handleProviderSelection:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("select provider", error));
        }
    }

    private async handleModelSelection(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            const callbackData = ctx.callbackQuery?.data || "";
            const fullModelId = callbackData.replace("model:", "");

            if (!fullModelId) {
                await ctx.reply("❌ Invalid model selection");
                return;
            }

            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Update the model in the user session
            const userSession = this.opencodeService.getUserSession(userId);
            if (userSession) {
                userSession.currentModel = fullModelId;

                // Update the session title in OpenCode so the [model] tag changes
                const currentTitle = userSession.session.title || "Telegram Session";
                await this.opencodeService.updateSessionTitle(userId, currentTitle);

                // Save explicitly to persist the model change in DB
                this.opencodeService.dbService.updateSession(userSession.sessionId, {
                    model: fullModelId,
                    chatId: ctx.chat?.id || userSession.chatId,
                });

                // Show success with model change confirmation
                const keyboard = new InlineKeyboard();
                keyboard.text("◀️ Back to Providers", "back:providers");

                await ctx.editMessageText(
                    `✅ <b>Model Changed!</b>\n\n` +
                    `Current model: <code>${fullModelId}</code>\n\n` +
                    `This model will be used for your current session.`,
                    {
                        parse_mode: "HTML",
                        reply_markup: keyboard
                    }
                );
            } else {
                // No active session, just show the selection
                const keyboard = new InlineKeyboard();
                keyboard.text("◀️ Back to Providers", "back:providers");

                await ctx.editMessageText(
                    `✅ <b>Model Selected:</b> <code>${fullModelId}</code>\n\n` +
                    `⚠️ No active session. Use /opencode to start a session with this model.`,
                    {
                        parse_mode: "HTML",
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.error("Error in handleModelSelection:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("select model", error));
        }
    }

    private async handleRestart(ctx: Context): Promise<void> {
        const { execSync, spawn } = await import("child_process");

        const statusMsg = await ctx.reply(
            "🔄 <b>Reiniciando servicios...</b>\n\n" +
            "⏳ Ejecutando <code>npm run build</code>...",
            { parse_mode: "HTML" }
        );

        const editStatus = async (text: string) => {
            await ctx.api.editMessageText(
                statusMsg.chat.id,
                statusMsg.message_id,
                text,
                { parse_mode: "HTML" }
            ).catch(() => { });
        };

        try {
            // 1. Build (synchronous — we need the result before proceeding)
            execSync("npm run build", {
                cwd: "/home/valle/Documentos/proyectos/opencode-telegram",
                stdio: "pipe",
            });

            // 2. Update status before triggering restart
            await editStatus(
                "🔄 <b>Reiniciando servicios...</b>\n\n" +
                "✅ Build completado\n" +
                "⏳ Reiniciando servicio — el bot volverá en unos segundos..."
            );

            // 3. Persist the message location so the new process can confirm readiness
            this.sessionDb.setState("restart_pending_chat_id", String(statusMsg.chat.id));
            this.sessionDb.setState("restart_pending_message_id", String(statusMsg.message_id));

            // 4. Fire-and-forget: detached spawn so the child outlives this process.
            //    systemd will SIGTERM us and bring a fresh instance back up.
            const child = spawn("sudo", ["systemctl", "restart", "opencode-telegram.service"], {
                detached: true,
                stdio: "ignore",
            });
            child.unref();

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await editStatus(
                "❌ <b>Error durante el reinicio</b>\n\n" +
                `<pre>${msg.slice(0, 800)}</pre>`
            ).catch(() => { });
        }
    }

    // ─── /run — fire-and-forget prompt to a subagent ─────────────────────────

    /**
     * /run [prompt] — if prompt provided inline, show agent picker immediately.
     * If no prompt, ask user to type it first (wizard step).
     */
    private async handleRun(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agents = this.agentDb.getByUser(userId);
        if (agents.length === 0) {
            await ctx.reply(
                "ℹ️ No tienes agentes persistentes todavía.\n\n" +
                "Usa /createagent para crear tu primer agente."
            );
            return;
        }

        // Prompt can be provided inline: /run haz un resumen de los cambios
        const inlinePrompt = ctx.message?.text?.replace(/^\/run\s*/i, "").trim() || "";
        if (inlinePrompt) {
            this.runWizardState.set(userId, { prompt: inlinePrompt });
            await this.showRunAgentPicker(ctx, inlinePrompt);
        } else {
            // Ask user to type the prompt
            this.runWizardState.set(userId, { prompt: "" });
            await ctx.reply(
                "🤖 <b>Enviar prompt a un subagente</b>\n\n" +
                "Escribe el mensaje que quieres enviar al agente:",
                { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
            );
        }
    }

    /** Sends the agent picker keyboard for a confirmed prompt */
    private async showRunAgentPicker(ctx: Context, prompt: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agents = this.agentDb.getByUser(userId);
        const keyboard = new InlineKeyboard();
        for (const agent of agents) {
            keyboard.text(`🤖 ${agent.name} [${agent.model}]`, `pagent:run:${agent.id}`).row();
        }

        const preview = prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
        await ctx.reply(
            `🤖 <b>¿A qué agente envías esto?</b>\n\n` +
            `<i>${escapeHtml(preview)}</i>\n\n` +
            `Selecciona el agente:`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    /** Callback: user tapped an agent name in /agents → ask for prompt for that specific agent */
    private async handleRunPickAgent(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            const agentId = (ctx.callbackQuery?.data || "").replace("pagent:runpick:", "");
            const agent = this.agentDb.getById(agentId);
            if (!agent) {
                await ctx.editMessageText("❌ Agente no encontrado.");
                return;
            }

            // Store which agent is pre-selected so the wizard reply goes directly to it
            this.runWizardState.set(userId, { prompt: "", preselectedAgentId: agentId });

            await ctx.reply(
                `🤖 <b>${escapeHtml(agent.name)}</b>\n\n` +
                `Escribe el prompt que quieres enviar a este agente:`,
                { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
            );
        } catch (error) {
            console.error("handleRunPickAgent error:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("pick agent", error));
        }
    }

    /** Callback: user selected an agent from the /run picker */
    private async handleRunAgentSelected(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            const agentId = (ctx.callbackQuery?.data || "").replace("pagent:run:", "");
            const agent = this.agentDb.getById(agentId);
            if (!agent) {
                await ctx.editMessageText("❌ Agente no encontrado.");
                return;
            }

            const wizardState = this.runWizardState.get(userId);
            const prompt = wizardState?.prompt || "";
            this.runWizardState.delete(userId);

            if (!prompt) {
                await ctx.editMessageText("❌ No hay prompt pendiente. Usa /run de nuevo.");
                return;
            }

            await ctx.editMessageText(
                `🤖 <b>${escapeHtml(agent.name)}</b> procesando…`,
                { parse_mode: "HTML" }
            );
            await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => { });

            const result = await this.persistentAgentService.sendPrompt(agent, prompt);

            const header = `🤖 <b>${escapeHtml(agent.name)}</b>\n\n`;
            const body = result.output || "(sin salida)";
            const MAX = 3800;

            if (body.length <= MAX) {
                await ctx.api.editMessageText(
                    ctx.callbackQuery!.message!.chat.id,
                    ctx.callbackQuery!.message!.message_id,
                    `${header}${formatAsHtml(body)}`,
                    { parse_mode: "HTML" }
                ).catch(async () => {
                    await ctx.reply(`${header}${formatAsHtml(body)}`, { parse_mode: "HTML" });
                });
            } else {
                await ctx.api.deleteMessage(
                    ctx.callbackQuery!.message!.chat.id,
                    ctx.callbackQuery!.message!.message_id
                ).catch(() => { });
                const buf = Buffer.from(body, "utf8");
                await ctx.replyWithDocument(new InputFile(buf, `${agent.name}-respuesta.md`), {
                    caption: `${header}(resultado adjunto por longitud)`,
                    parse_mode: "HTML",
                });
            }
        } catch (error) {
            console.error("handleRunAgentSelected error:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("run agent", error));
        }
    }

    // ─── /createagent wizard ──────────────────────────────────────────────────

    /** Step 1: /createagent — ask for agent name */
    private async handleCreateAgent(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        this.createAgentWizardState.set(userId, { step: "name" });

        await ctx.reply(
            `🤖 <b>Crear agente persistente</b>\n\n` +
            `Paso 1/4 — <b>Nombre</b>\n\n` +
            `Escribe un nombre corto para el agente (ej: <code>backend-helper</code>):`,
            {
                parse_mode: "HTML",
                reply_markup: { force_reply: true, selective: true },
            }
        );
    }

    /** Handles each wizard reply for /createagent */
    private async handleCreateAgentWizardReply(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const state = this.createAgentWizardState.get(userId);
        if (!state) return;

        const text = ctx.message?.text?.trim() || "";
        if (!text) {
            await ctx.reply("❌ No puede estar vacío. Inténtalo de nuevo:",
                { reply_markup: { force_reply: true, selective: true } });
            return;
        }

        if (state.step === "name") {
            state.name = text;
            state.step = "role";

            await ctx.reply(
                `✅ Nombre: <b>${escapeHtml(text)}</b>\n\n` +
                `Paso 2/4 — <b>Rol (system prompt)</b>\n\n` +
                `Describe el rol y comportamiento del agente. Este texto se inyectará al inicio de cada prompt.\n` +
                `Escribe <code>.</code> para omitir (sin rol específico):`,
                {
                    parse_mode: "HTML",
                    reply_markup: { force_reply: true, selective: true },
                }
            );
            return;
        }

        if (state.step === "role") {
            state.role = text === "." ? "" : text;
            state.step = "workdir";

            const defaultWorkdir = this.configService.getBackgroundWorkdir();
            const hint = defaultWorkdir
                ? `Deja vacío o escribe <code>.</code> para usar:\n<code>${defaultWorkdir}</code>`
                : `Ej: <code>~/proyectos/mi-proyecto</code>`;

            await ctx.reply(
                `✅ Rol guardado.\n\n` +
                `Paso 3/4 — <b>Directorio de trabajo</b>\n\n` +
                `Ruta del proyecto donde operará el agente.\n${hint}`,
                {
                    parse_mode: "HTML",
                    reply_markup: { force_reply: true, selective: true },
                }
            );
            return;
        }

        if (state.step === "workdir") {
            const defaultWorkdir = this.configService.getBackgroundWorkdir();
            const rawDir = (text === "" || text === ".") ? defaultWorkdir : text;

            if (!rawDir) {
                await ctx.reply("❌ No hay directorio configurado. Escribe una ruta válida:",
                    { reply_markup: { force_reply: true, selective: true } });
                return;
            }

            const resolved = resolveDir(rawDir);
            const fs = await import("fs");
            if (!fs.existsSync(resolved)) {
                await ctx.reply(
                    `❌ El directorio no existe:\n<code>${resolved}</code>\n\nEscribe otra ruta:`,
                    {
                        parse_mode: "HTML",
                        reply_markup: { force_reply: true, selective: true },
                    }
                );
                return;
            }

            state.workdir = resolved;
            state.step = "model";

            const defaultModel = this.configService.getBackgroundModel();
            await ctx.reply(
                `✅ Directorio: <code>${resolved}</code>\n\n` +
                `Paso 4/4 — <b>Modelo</b>\n\n` +
                `Modelo a usar en formato <code>provider/model</code>.\n` +
                `Escribe <code>.</code> para usar el predeterminado:\n<code>${defaultModel}</code>`,
                {
                    parse_mode: "HTML",
                    reply_markup: { force_reply: true, selective: true },
                }
            );
            return;
        }

        if (state.step === "model") {
            const defaultModel = this.configService.getBackgroundModel();
            const model = (text === "" || text === ".") ? defaultModel : text;

            this.createAgentWizardState.delete(userId);

            const id = randomUUID();
            const port = pickPort(this.agentDb.usedPorts());

            const agent = {
                id,
                userId,
                name: state.name!,
                role: state.role ?? "",
                workdir: state.workdir!,
                model,
                port,
                createdAt: new Date().toISOString(),
            };

            this.agentDb.save(agent);

            const statusMsg = await ctx.reply(
                `✅ <b>Agente creado</b>\n\n` +
                `Nombre: <b>${escapeHtml(agent.name)}</b>\n` +
                `Modelo: <code>${model}</code>\n` +
                `Puerto: <code>${port}</code>\n` +
                `Dir: <code>${agent.workdir}</code>\n\n` +
                `⏳ Arrancando servidor...`,
                { parse_mode: "HTML" }
            );

            this.persistentAgentService.startAgent(agent)
                .then(async (result) => {
                    const icon = result.success ? "✅" : "⚠️";
                    await ctx.api.editMessageText(
                        statusMsg.chat.id,
                        statusMsg.message_id,
                        `${icon} <b>Agente "${escapeHtml(agent.name)}"</b> listo en <code>:${port}</code>\n\n` +
                        `Modelo: <code>${model}</code>\n` +
                        `Dir: <code>${agent.workdir}</code>\n\n` +
                        `Usa <b>/run</b> para seleccionarlo como agente activo.`,
                        { parse_mode: "HTML" }
                    ).catch(() => {});
                })
                .catch(async (err) => {
                    await ctx.api.editMessageText(
                        statusMsg.chat.id,
                        statusMsg.message_id,
                        `⚠️ Agente creado pero el servidor no arrancó:\n<pre>${escapeHtml(String(err))}</pre>`,
                        { parse_mode: "HTML" }
                    ).catch(() => {});
                });
        }
    }

    // ─── /agents — list and delete ────────────────────────────────────────────

    private async handleAgents(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agents = this.agentDb.getByUser(userId);

        if (agents.length === 0) {
            await ctx.reply(
                "📋 No tienes agentes persistentes.\n\nUsa /createagent para crear uno."
            );
            return;
        }

        const keyboard = new InlineKeyboard();
        for (const agent of agents) {
            keyboard.text(`${agent.name} [${agent.model}]`, `pagent:runpick:${agent.id}`).text("🗑️", `pagent:del:${agent.id}`).row();
        }

        await ctx.reply(
            `🤖 <b>Tus agentes persistentes</b>\n\n` +
            `Toca el nombre del agente para enviarle un prompt, o 🗑️ para borrar:`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    // ─── Callbacks: delete ────────────────────────────────────────────────────

    private async handleAgentDelete(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            const agentId = (ctx.callbackQuery?.data || "").replace("pagent:del:", "");
            const agent = this.agentDb.getById(agentId);
            if (!agent) {
                await ctx.editMessageText("❌ Agente no encontrado.");
                return;
            }

            const keyboard = new InlineKeyboard()
                .text("✅ Sí, borrar", `pagent:delconfirm:${agentId}`)
                .text("❌ Cancelar", "pagent:delcancel");

            await ctx.editMessageText(
                `🗑️ ¿Borrar agente <b>${escapeHtml(agent.name)}</b>?\n\n` +
                `Esto detendrá su servidor y eliminará toda la configuración.`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
        } catch (error) {
            console.error("handleAgentDelete error:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("delete agent prompt", error));
        }
    }

    private async handleAgentDeleteConfirm(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            const agentId = (ctx.callbackQuery?.data || "").replace("pagent:delconfirm:", "");
            const agent = this.agentDb.getById(agentId);
            if (!agent) {
                await ctx.editMessageText("❌ Agente no encontrado.");
                return;
            }

            // Stop process and delete from DB
            this.persistentAgentService.stopAgent(agentId);
            this.agentDb.delete(agentId);

            await ctx.editMessageText(
                `🗑️ Agente <b>${escapeHtml(agent.name)}</b> eliminado.\n\n` +
                `Usa /createagent para crear uno nuevo o /agents para ver la lista.`,
                { parse_mode: "HTML" }
            );
        } catch (error) {
            console.error("handleAgentDeleteConfirm error:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("delete agent confirm", error));
        }
    }

    /** Callback: pagent:delcancel — cancel delete confirmation, re-render /agents list */
    private async handleAgentDeleteCancel(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            await ctx.deleteMessage().catch(() => {});
            await this.handleAgents(ctx);
        } catch (error) {
            console.error("handleAgentDeleteCancel error:", error);
        }
    }

    /**
     * Callback: pagent:model:<agentId>:__choose_provider  → show provider list for agent
     * Callback: pagent:model:<agentId>:provider:<prov>    → show model list for agent+provider
     * Callback: pagent:model:<agentId>:<provider>/<model> → save new model for agent
     */
    private async handleAgentModelSelection(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const userId = ctx.from?.id;
            if (!userId) return;

            // Format: pagent:model:<shortId(8 chars)>:<rest>
            const data = (ctx.callbackQuery?.data || "").replace(/^pagent:model:/, "");
            const colonIdx = data.indexOf(":");
            const shortId = colonIdx === -1 ? data : data.slice(0, colonIdx);
            const rest = colonIdx === -1 ? "" : data.slice(colonIdx + 1);

            // Resolve short ID (8 char prefix) to full agent record
            const agent = this.agentDb.getByPrefix(shortId);
            if (!agent) {
                await ctx.editMessageText("❌ Agente no encontrado.");
                return;
            }
            const sid = AgentDbService.shortId(agent); // always use short form for callbacks

            // Show provider list
            if (rest === "__choose_provider" || rest === "") {
                await this.replyWithAgentProviders(ctx, agent, true);
                return;
            }

            // Show model list for a provider
            if (rest.startsWith("provider:")) {
                const provider = rest.replace("provider:", "");
                const models = this.getAvailableModels();
                const providerModels = models.get(provider) || [];

                if (providerModels.length === 0) {
                    await ctx.editMessageText(`❌ No models found for provider: ${provider}`);
                    return;
                }

                const keyboard = new InlineKeyboard();
                providerModels.forEach((model) => {
                    keyboard.text(`⚡ ${model}`, `pagent:model:${sid}:${provider}/${model}`).row();
                });
                keyboard.text("◀️ Volver a proveedores", `pagent:model:${sid}:__choose_provider`);

                await ctx.editMessageText(
                    `🤖 <b>${provider}</b> — Agente <b>${escapeHtml(agent.name)}</b>\n\nSelecciona modelo:`,
                    { parse_mode: "HTML", reply_markup: keyboard }
                );
                return;
            }

            // rest is "provider/model" — save
            const newModel = rest;
            this.agentDb.updateModel(agent.id, newModel);

            // Restart the agent process so it picks up the new model on next sendPrompt
            this.persistentAgentService.stopAgent(agent.id);
            const updatedAgent = this.agentDb.getById(agent.id)!;
            this.persistentAgentService.startAgent(updatedAgent).catch(err =>
                console.error(`[OpenCodeBot] Failed to restart agent ${agent.id} after model change:`, err)
            );

            await ctx.editMessageText(
                `✅ Modelo actualizado para <b>${escapeHtml(agent.name)}</b>\n\n` +
                `Antes: <code>${agent.model}</code>\n` +
                `Ahora: <code>${newModel}</code>\n\n` +
                `El servidor del agente se ha reiniciado.`,
                { parse_mode: "HTML" }
            );
        } catch (error) {
            console.error("handleAgentModelSelection error:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("change agent model", error));
        }
    }

    /** Shows the provider picker for changing an agent's model */
    private async replyWithAgentProviders(ctx: Context, agent: any, edit: boolean): Promise<void> {
        const models = this.getAvailableModels();
        const keyboard = new InlineKeyboard();
        const sid = AgentDbService.shortId(agent);
        for (const provider of models.keys()) {
            keyboard.text(`🔹 ${provider}`, `pagent:model:${sid}:provider:${provider}`).row();
        }
        const text =
            `🤖 <b>Cambiar modelo de agente</b>\n\n` +
            `Agente: <b>${escapeHtml(agent.name)}</b>\n` +
            `Modelo actual: <code>${agent.model}</code>\n\n` +
            `Selecciona proveedor:`;
        if (edit) {
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        } else {
            await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
        }
    }

    private async handleBackToProviders(ctx: Context): Promise<void> {        try {
            await ctx.answerCallbackQuery();

            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Get current session to show current model
            const userSession = this.opencodeService.getUserSession(userId);
            const currentModel = userSession?.currentModel || process.env.OPENCODE_DEFAULT_MODEL || "opencode/glm-5-free";

            // Get providers
            const models = this.getAvailableModels();
            const providers = Array.from(models.keys());

            // Create keyboard with providers
            const keyboard = new InlineKeyboard();

            providers.forEach((provider) => {
                keyboard.text(
                    `🔹 ${provider}`,
                    `provider:${provider}`
                ).row();
            });

            await ctx.editMessageText(
                `🤖 <b>Select AI Model Provider</b>\n\n` +
                `Current model: <code>${currentModel}</code>\n\n` +
                `Choose a provider to see available models:`,
                {
                    parse_mode: "HTML",
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            console.error("Error in handleBackToProviders:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("go back to providers", error));
        }
    }

    // ─── Agent question handling ──────────────────────────────────────────────

    /**
     * Called by PersistentAgentService when a persistent agent asks a question.
     * Looks up the agent's owner and sends an inline-keyboard message to Telegram.
     */
    private async handleAgentQuestion(agentId: string, req: any): Promise<void> {
        const agent = this.agentDb.getById(agentId);
        if (!agent || !this.bot) {
            console.warn(`[OpenCodeBot] handleAgentQuestion: agent ${agentId} not found or bot not initialised`);
            return;
        }

        const requestId: string = req.id;
        const questions: any[] = req.questions ?? [];

        // Generate a short random key so callback data stays under 64 bytes
        const shortKey = randomUUID().replace(/-/g, "").slice(0, 8);
        this.pendingAgentQuestions.set(shortKey, { agentId, port: agent.port, req });

        // Auto-expire after 10 minutes to avoid memory leaks
        setTimeout(() => this.pendingAgentQuestions.delete(shortKey), 10 * 60 * 1000);

        for (let qIdx = 0; qIdx < questions.length; qIdx++) {
            const q = questions[qIdx];
            const keyboard = new InlineKeyboard();

            const options: any[] = q.options ?? [];
            for (let optIdx = 0; optIdx < options.length; optIdx++) {
                const opt = options[optIdx];
                // agq:<shortKey>:<qIdx>:<optIdx>  — always ≤ 64 bytes
                keyboard.text(opt.label, `agq:${shortKey}:${qIdx}:${optIdx}`).row();
            }
            keyboard.text("❌ Cancelar", `agq:cancel:${shortKey}`);

            await this.bot.api.sendMessage(
                agent.userId,
                `🤖 <b>${escapeHtml(agent.name)}</b> necesita una respuesta:\n\n` +
                `<b>${escapeHtml(q.header ?? "Pregunta")}</b>\n${escapeHtml(q.question ?? "")}`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
        }
    }

    /**
     * Callback handler for agq: buttons.
     * Format: agq:<shortKey>:<qIdx>:<optIdx>  or  agq:cancel:<shortKey>
     */
    private async handleAgentQuestionCallback(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();
            const data = ctx.callbackQuery?.data ?? "";

            // Cancel
            if (data.startsWith("agq:cancel:")) {
                const shortKey = data.replace("agq:cancel:", "");
                const pending = this.pendingAgentQuestions.get(shortKey);
                if (pending) {
                    this.pendingAgentQuestions.delete(shortKey);
                    await this.persistentAgentService.rejectQuestion(pending.port, pending.req.id);
                }
                await ctx.editMessageText("❌ Pregunta cancelada.").catch(() => {});
                return;
            }

            // Reply: agq:<shortKey>:<qIdx>:<optIdx>
            const parts = data.replace("agq:", "").split(":");
            if (parts.length < 3) return;
            const [shortKey, qIdxStr, optIdxStr] = parts;
            const qIdx = parseInt(qIdxStr, 10);
            const optIdx = parseInt(optIdxStr, 10);

            const pending = this.pendingAgentQuestions.get(shortKey);
            if (!pending) {
                await ctx.editMessageText("⚠️ Esta pregunta ya fue respondida o expiró.").catch(() => {});
                return;
            }

            const questions: any[] = pending.req.questions ?? [];
            const q = questions[qIdx];
            if (!q) return;
            const opt = (q.options ?? [])[optIdx];
            if (!opt) return;

            // Build answers: one array per question (only this one answered)
            const answers: string[][] = questions.map((qq: any, i: number) =>
                i === qIdx ? [opt.label] : []
            );

            this.pendingAgentQuestions.delete(shortKey);
            await this.persistentAgentService.replyQuestion(pending.port, pending.req.id, answers);

            await ctx.editMessageText(
                `✅ Respondido: <b>${escapeHtml(opt.label)}</b>`,
                { parse_mode: "HTML" }
            ).catch(() => {});
        } catch (error) {
            console.error("handleAgentQuestionCallback error:", error);
            await ctx.reply(ErrorUtils.createErrorMessage("responder pregunta de agente", error));
        }
    }
}
