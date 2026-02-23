import { Bot, Context, InputFile, Keyboard, InlineKeyboard } from "grammy";
import { OpenCodeService } from "./opencode.service.js";
import { ConfigService } from "../../services/config.service.js";
import { OpenCodeServerService } from "../../services/opencode-server.service.js";
import { GiteaService } from "../../services/gitea.service.js";
import { AccessControlMiddleware } from "../../middleware/access-control.middleware.js";
import { MessageUtils } from "../../utils/message.utils.js";
import { ErrorUtils } from "../../utils/error.utils.js";
import { formatAsHtml, escapeHtml } from "./event-handlers/utils.js";
import { FileMentionService, FileMentionUI } from "../file-mentions/index.js";
import * as fs from "fs";
import * as nodePath from "path";

export class OpenCodeBot {
    private opencodeService: OpenCodeService;
    private configService: ConfigService;
    private serverService: OpenCodeServerService;
    private giteaService: GiteaService;
    private fileMentionService: FileMentionService;
    private fileMentionUI: FileMentionUI;

    constructor(
        opencodeService: OpenCodeService,
        configService: ConfigService
    ) {
        this.opencodeService = opencodeService;
        this.configService = configService;
        this.serverService = new OpenCodeServerService();
        this.giteaService = new GiteaService();
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

        // Handle keyboard button presses
        bot.hears("⏹️ ESC", AccessControlMiddleware.requireAccess, this.handleEsc.bind(this));
        bot.hears("⇥ TAB", AccessControlMiddleware.requireAccess, this.handleTab.bind(this));

        // Handle inline button callbacks
        bot.callbackQuery("esc", AccessControlMiddleware.requireAccess, this.handleEscButton.bind(this));
        bot.callbackQuery("tab", AccessControlMiddleware.requireAccess, this.handleTabButton.bind(this));
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
            // Treat as prompt
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
                    userSession = await this.opencodeService.createSession(userId, title, currentModel);
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
                        userSession = await this.opencodeService.createSession(userId, title, currentModel);
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

            // Check if user has an active session
            if (!this.opencodeService.hasActiveSession(userId)) {
                await ctx.reply("❌ No active OpenCode session. Use /opencode to start a session first.");
                return;
            }

            // 🔑 KEY FIX: Ensure SSE event stream is running before sending prompt.
            // After a bot restart, sessions are restored from disk but the stream
            // is not connected yet. This reconnects it automatically.
            this.opencodeService.ensureEventStream(userId, ctx);

            // 🚦 BUSY GUARD: Si OpenCode aún está procesando el anterior prompt, avisar y esperar
            const userSession = this.opencodeService.getUserSession(userId);
            if (userSession?.isProcessing) {
                await ctx.reply("⏳ Espera — OpenCode aún está procesando tu última pregunta. Responderá enseguida.");
                return;
            }

            const promptText = ctx.message?.text?.trim() || "";

            if (!promptText) {
                return;
            }

            // Marcar como ocupado antes de enviar
            if (userSession) {
                userSession.isProcessing = true;
            }

            // Check for file mentions
            const mentions = this.fileMentionService.parseMentions(promptText);

            if (mentions.length > 0 && this.fileMentionService.isEnabled()) {
                await this.handlePromptWithMentions(ctx, userId, promptText, mentions);
            } else {
                await this.sendPromptToOpenCode(ctx, userId, promptText);
            }
        } catch (error) {
            // Clear processing flag on error too
            const userId = ctx.from?.id;
            if (userId) {
                const s = this.opencodeService.getUserSession(userId);
                if (s) s.isProcessing = false;
            }
            await ctx.reply(ErrorUtils.createErrorMessage("send prompt to OpenCode", error));
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

    private isMarkdownContent(text: string): boolean {
        // If first character is a hash, it's markdown
        return text.trimStart().startsWith('#');
    }



    private splitIntoChunks(text: string, maxLength: number): string[] {
        const chunks: string[] = [];
        let currentChunk = "";

        const lines = text.split("\n");
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 > maxLength) {
                if (currentChunk) {
                    chunks.push(currentChunk);
                }
                currentChunk = line;
            } else {
                if (currentChunk) {
                    currentChunk += "\n" + line;
                } else {
                    currentChunk = line;
                }
            }
        }

        if (currentChunk) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    private async handleEndSession(ctx: Context): Promise<void> {
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

            const success = await this.opencodeService.deleteSession(userId);

            if (success) {
                const sentMessage = await ctx.reply("✅ OpenCode session ended successfully.");
                const deleteTimeout = this.configService.getMessageDeleteTimeout();
                if (deleteTimeout > 0 && sentMessage) {
                    await MessageUtils.scheduleMessageDeletion(
                        ctx,
                        sentMessage.message_id,
                        deleteTimeout
                    );
                }
            } else {
                await ctx.reply("⚠️ Failed to end session. It may have already been closed.");
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("end OpenCode session", error));
        }
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
            if (!existingSession) {
                const msg = await ctx.reply("❌ No hay una sesión activa. Usa /projects para elegir un proyecto primero.");
                await MessageUtils.scheduleMessageDeletion(ctx, msg.message_id, 10000);
                return;
            }

            // Get current project directory
            const projectPath = existingSession.session.directory || process.env.GITEA_DEFAULT_WORKDIR || "/home/valle/Documentos/proyectos/gitea-projects";
            const nodePath = await import("path");
            const projectName = nodePath.basename(projectPath);

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

            const hasActive = this.opencodeService.hasActiveSession(userId);
            if (!hasActive) {
                await ctx.reply("❌ No hay una sesión activa que borrar. Usa /sessions para ver tus sesiones guardadas, entra a una y bórrala.");
                return;
            }

            const success = await this.opencodeService.deleteSession(userId);
            if (success) {
                await ctx.reply("🗑️ Sesión actual borrada con éxito de OpenCode y de la bot-DB local.\n\nUsa /opencode o /sessions para continuar.");
            } else {
                await ctx.reply("❌ Falló el intento de borrar la sesión.");
            }
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("delete session", error));
        }
    }

    private async handleDeleteAllSessions(ctx: Context): Promise<void> {
        try {
            const userId = ctx.from?.id;
            if (!userId) return;

            const sessions = this.opencodeService.dbService.getUserSessions(userId, 100);
            if (sessions.length === 0) {
                await ctx.reply("❌ No se encontraron sesiones para borrar.");
                return;
            }

            // Avisamos por adelantado porque puede tardar
            const msg = await ctx.reply("⏳ Borrando todas las sesiones de este usuario en OpenCode y DB...");

            // Delete one by one through OpenCodeService
            for (const s of sessions) {
                try {
                    // Activate sequentially to delete through the unified method
                    this.opencodeService.dbService.setActiveSession(userId, s.id);
                    // Mock UserSession in memory so deleteSession can work on it
                    const mockSession = { sessionId: s.id } as any;
                    (this.opencodeService as any).userSessions.set(userId, mockSession);
                    await this.opencodeService.deleteSession(userId);
                } catch (err) {
                    console.error("Failed to delete", err);
                }
            }

            // Clean up left-overs in DB
            this.opencodeService.dbService.deleteAllUserSessions(userId);

            // Clear memory
            if (this.opencodeService.hasActiveSession(userId)) {
                this.opencodeService.stopEventStream(userId);
                (this.opencodeService as any).userSessions.delete(userId);
            }

            await ctx.api.editMessageText(msg.chat.id, msg.message_id, `🗑️ Se han borrado exitosamente las ${sessions.length} sesiones.`);
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("delete all sessions", error));
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

    private async handleProjectSelection(ctx: Context): Promise<void> {
        try {
            await ctx.answerCallbackQuery();

            const callbackData = ctx.callbackQuery?.data || "";
            const projectName = callbackData.replace("project:", "");

            if (!projectName) {
                await ctx.reply("❌ Invalid project selection");
                return;
            }

            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.reply("❌ Unable to identify user");
                return;
            }

            // Determine project path to filter sessions
            const workDir = process.env.GITEA_DEFAULT_WORKDIR || "/home/valle/Documentos/proyectos/gitea-projects";
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

                await ctx.reply(
                    `📂 <b>${projectName}</b>\n\nTienes sesiones previas en este proyecto. ¿Qué quieres hacer?`,
                    { parse_mode: "HTML", reply_markup: keyboard }
                );
            } else {
                // Si OpenCode no tiene ninguna sesión para este proyecto, empezamos una de cero directo
                await this.startSessionForProject(ctx, userId, projectName);
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

            await ctx.editMessageText(`🔄 Iniciando nueva sesión para "${projectName}"...`);
            await this.startSessionForProject(ctx, userId, projectName);

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

            // Find the session data from the list (SDK has no retrieve by ID)
            const workDir = process.env.GITEA_DEFAULT_WORKDIR || "/home/valle/Documentos/proyectos/gitea-projects";
            const projectPath = (await import("path")).join(workDir, projectName);
            const client = (await import("@opencode-ai/sdk")).createOpencodeClient({ baseUrl: process.env.OPENCODE_SERVER_URL || "http://localhost:4096" });
            const listResult = await client.session.list() as any;

            const sessionData = (listResult.data as any[])?.find((s: any) => s.id === sessionId);
            if (!sessionData) {
                await ctx.editMessageText("❌ No se pudo recuperar la sesión. Es posible que haya sido eliminada de OpenCode.");
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

    /** Shared logic: ensure project is local, start server, create session */
    private async startSessionForProject(ctx: Context, userId: number, projectName: string): Promise<void> {
        const workDir = process.env.GITEA_DEFAULT_WORKDIR || "/home/valle/Documentos/proyectos/gitea-projects";
        const projectPath = nodePath.join(workDir, projectName);

        // Clone project if not present locally
        if (!fs.existsSync(projectPath)) {
            const project = await this.giteaService.getProject(projectName);
            if (project) {
                await ctx.editMessageText(`📦 Clonando "${projectName}" desde Gitea...`);
                await ctx.api.sendChatAction(ctx.chat!.id, "typing");
                const { execSync } = await import("child_process");
                try {
                    execSync(`git clone ${project.ssh_url} "${projectPath}"`, {
                        cwd: workDir,
                        stdio: "pipe",
                    });
                } catch (cloneError) {
                    console.error("Git clone error:", cloneError);
                    await ctx.editMessageText(`❌ No se pudo clonar "${projectName}". Revisa la configuración de Git.`);
                    return;
                }
            } else {
                await ctx.editMessageText(`❌ Proyecto "${projectName}" no encontrado en Gitea.`);
                return;
            }
        }

        // Start OpenCode server
        await ctx.api.sendChatAction(ctx.chat!.id, "typing");
        const startResult = await this.serverService.startServer();
        if (!startResult.success && !startResult.message.includes("already running")) {
            await ctx.editMessageText(`❌ Failed to start OpenCode server: ${startResult.message}`);
            return;
        }

        // Create new session
        try {
            const existingSession = this.opencodeService.getUserSession(userId);
            const currentModel = existingSession?.currentModel;
            const userSession = await this.opencodeService.createSession(userId, projectName, currentModel, projectPath);

            const modelInfo = userSession.currentModel ? `\n🤖 Model: <code>${userSession.currentModel}</code>` : "";

            await ctx.deleteMessage();
            const finalMessage = await ctx.reply(
                `✅ Session started for "<b>${projectName}</b>"${modelInfo}\n📂 <code>${projectPath}</code>`,
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
            await ctx.editMessageText(ErrorUtils.createErrorMessage("iniciar sesión", error));
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

            await ctx.reply(
                `🤖 <b>Select AI Model Provider</b>\n\n` +
                `Current model: <code>${currentModel}</code>\n\n` +
                `Choose a provider to see available models:`,
                {
                    parse_mode: "HTML",
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("show models", error));
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

    private async handleBackToProviders(ctx: Context): Promise<void> {
        try {
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
}
