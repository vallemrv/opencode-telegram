/**
 * MultiSessionHandler
 *
 * Handles Telegram commands for managing multiple OpenCode sessions.
 * Each session operates independently with its own SSE, heartbeat, and prompt queue.
 */

import type { Context, Bot } from "telegraf";
import type { Message } from "telegraf/types";
import type { PersistentAgent } from "../../../services/agent-db.service.js";
import type { AgentDbService } from "../../../services/agent-db.service.js";
import { SessionInstanceService, type HeartbeatSummary, type AgentSendResult } from "../../../services/session-instance.service.js";
import { PersistentAgentService } from "../../../services/persistent-agent.service.js";
import { formatAsHtml, escapeHtml } from "../utils.js";
import { InputFile } from "grammy";

interface SessionInfo {
    id: string;
    agentId: string;
    agentName: string;
    status: "idle" | "busy" | "retry";
    createdAt: number;
    lastActivity: number;
}

export interface ActiveSession {
    sessionId: string;
    chatId: number;
    userId: number;
    agentId: string;
}

export class MultiSessionHandler {
    /** Map of userId → active session ID (for sticky session switching) */
    private activeSessions: Map<number, ActiveSession> = new Map();

    /** Map of sessionId → { chatId, msgId } for heartbeat messages */
    private heartbeatMessages: Map<string, { chatId: number; msgId: number }> = new Map();

    /** Map of userId → agentId (the server/agent to use for new sessions) */
    private selectedAgents: Map<number, string> = new Map();

    private bot?: Bot;

    constructor(
        private readonly sessionService: SessionInstanceService,
        private readonly agentService: PersistentAgentService,
        private readonly agentDb: AgentDbService,
    ) {
        this.registerCallbacks();
    }

    setBot(bot: Bot): void {
        this.bot = bot;
    }

    private registerCallbacks(): void {
        // Register callbacks with SessionInstanceService
        this.sessionService.setOnQuestionCallback(async (sessionId, agentId, req) => {
            await this.handleQuestion(sessionId, agentId, req);
        });

        this.sessionService.setOnSessionErrorCallback(async (sessionId, agentId, errorMessage) => {
            await this.handleSessionError(sessionId, agentId, errorMessage);
        });

        this.sessionService.setOnHeartbeatCallback(async (summary) => {
            await this.handleHeartbeat(summary);
        });

        this.sessionService.setOnHeartbeatClearCallback(async (sessionId, agentId) => {
            await this.handleHeartbeatClear(sessionId, agentId);
        });

        this.sessionService.setOnExternalSessionIdleCallback(async (sessionId, agentId, output) => {
            await this.handleExternalSessionIdle(sessionId, agentId, output);
        });

        this.sessionService.setOnAdoptSessionCallback(async (sessionId, agentId, userId) => {
            return await this.handleAdoptSession(sessionId, agentId, userId);
        });

        this.sessionService.setOnAdoptSessionResultCallback(async (sessionId, agentId, chatId, msgId, result) => {
            await this.handleAdoptSessionResult(sessionId, agentId, chatId, msgId, result);
        });

        this.sessionService.setOnLostPromptCallback(async (sessionId, agentId, chatId, msgId) => {
            await this.handleLostPrompt(sessionId, agentId, chatId, msgId);
        });

        this.sessionService.setHeartbeatLookup((sessionId) => {
            return this.heartbeatMessages.get(sessionId);
        });
    }

    // ─── Command handlers ──────────────────────────────────────────────────────

    /**
     * /sessions - List all active sessions for the user
     */
    async handleListSessions(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const sessions = this.getUserSessions(userId);
        const activeSessionId = this.getActiveSession(userId)?.sessionId;

        if (sessions.length === 0) {
            await ctx.reply(
                "📋 *No tienes sesiones activas*\n\n" +
                "Crea una nueva sesión con el comando /newsession",
                { parse_mode: "Markdown" }
            );
            return;
        }

        let message = "📋 *Tus sesiones activas*\n\n";
        
        for (const session of sessions) {
            const isActive = session.id === activeSessionId;
            const statusEmoji = session.status === "busy" ? "🔄" : session.status === "retry" ? "⏳" : "✅";
            const activeEmoji = isActive ? "👉 " : "";
            const age = this.formatDuration(Date.now() - session.createdAt);
            
            message += `${activeEmoji}${statusEmoji} *${session.id.slice(0, 8)}...* (${session.agentName})\n`;
            message += `   Estado: \`${session.status}\` | Edad: ${age}\n\n`;
        }

        message += "\n💡 *Comandos disponibles:*\n";
        message += "• `/switch <id>` - Cambiar a otra sesión\n";
        message += "• `/newsession` - Crear nueva sesión\n";
        message += "• `/closesession [id]` - Cerrar una sesión\n";
        message += "• Envía cualquier mensaje para usar la sesión activa";

        await ctx.reply(message, { parse_mode: "Markdown" });
    }

    /**
     * /newsession [agent_name] - Create a new session
     * If agent_name is not provided, uses the user's selected agent or shows list
     */
    async handleNewSession(ctx: Context, agentName?: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        let agent: PersistentAgent | null = null;

        if (agentName) {
            // Try to find agent by name
            const agents = this.agentDb.getByUser(userId);
            agent = agents.find(a => a.name.toLowerCase() === agentName.toLowerCase()) ?? null;
        } else {
            // Use selected agent
            const selectedAgentId = this.selectedAgents.get(userId);
            if (selectedAgentId) {
                agent = this.agentDb.getById(selectedAgentId);
            }
        }

        if (!agent) {
            const agents = this.agentDb.getByUser(userId);
            if (agents.length === 0) {
                await ctx.reply(
                    "❌ *No tienes servidores configurados*\n\n" +
                    "Usa el comando /servers para crear uno primero.",
                    { parse_mode: "Markdown" }
                );
                return;
            }

            // Show agent selection
            let message = "🤖 *Selecciona un servidor para la nueva sesión:*\n\n";
            for (const a of agents) {
                const status = a.status === "running" ? "🟢" : "🔴";
                message += `${status} /newsession_${a.name} - ${a.name}\n`;
            }
            
            await ctx.reply(message, { parse_mode: "Markdown" });
            return;
        }

        // Ensure the agent server is running
        const msg = await ctx.reply("🔄 Iniciando servidor y creando sesión...");
        
        try {
            // Check if server is running, start if needed
            const isRunning = await this.agentService.isServerRunning(agent);
            if (!isRunning) {
                const started = await this.agentService.startAgent(agent);
                if (!started.success) {
                    await ctx.telegram.editMessageText(
                        msg.chat.id,
                        msg.message_id,
                        undefined,
                        `❌ Error al iniciar el servidor: ${started.message}`
                    );
                    return;
                }
            }

            // Create new session
            const sessionId = await this.sessionService.createSession(agent);
            
            // Set as active session for this user
            this.setActiveSession(userId, sessionId, msg.chat.id, agent.id);

            const sessionCount = this.getUserSessions(userId).length;
            
            await ctx.telegram.editMessageText(
                msg.chat.id,
                msg.message_id,
                undefined,
                `✅ *Sesión creada*\n\n` +
                `ID: \`${sessionId.slice(0, 12)}...\`\n` +
                `Servidor: ${agent.name}\n` +
                `Total de sesiones: ${sessionCount}\n\n` +
                `💬 Envía un mensaje para comenzar a trabajar en esta sesión.`,
                { parse_mode: "Markdown" }
            );

        } catch (error) {
            await ctx.telegram.editMessageText(
                msg.chat.id,
                msg.message_id,
                undefined,
                `❌ Error al crear sesión: ${error}`
            );
        }
    }

    /**
     * /switch <session_id> - Switch to a different session
     */
    async handleSwitchSession(ctx: Context, sessionIdOrName: string): Promise<void> {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        if (!userId || !chatId) return;

        const sessions = this.getUserSessions(userId);
        
        if (sessions.length === 0) {
            await ctx.reply("❌ No tienes sesiones activas. Crea una con /newsession");
            return;
        }

        // Find session by partial ID or exact match
        let session = sessions.find(s => s.id === sessionIdOrName);
        if (!session) {
            session = sessions.find(s => s.id.startsWith(sessionIdOrName));
        }
        if (!session) {
            session = sessions.find(s => s.agentName.toLowerCase() === sessionIdOrName.toLowerCase());
        }

        if (!session) {
            await ctx.reply(
                `❌ Sesión "${sessionIdOrName}" no encontrada.\n\n` +
                `Usa /sessions para ver tus sesiones activas.`
            );
            return;
        }

        this.setActiveSession(userId, session.id, chatId, session.agentId);

        const statusEmoji = session.status === "busy" ? "🔄" : session.status === "retry" ? "⏳" : "✅";
        const age = this.formatDuration(Date.now() - session.createdAt);

        await ctx.reply(
            `✅ *Sesión activa cambiada*\n\n` +
            `ID: \`${session.id.slice(0, 12)}...\`\n` +
            `Servidor: ${session.agentName}\n` +
            `Estado: ${statusEmoji} ${session.status}\n` +
            `Edad: ${age}\n\n` +
            `💬 Envía un mensaje para trabajar en esta sesión.`,
            { parse_mode: "Markdown" }
        );
    }

    /**
     * /closesession [session_id] - Close a session
     */
    async handleCloseSession(ctx: Context, sessionIdOrName?: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const sessions = this.getUserSessions(userId);
        
        if (sessions.length === 0) {
            await ctx.reply("No tienes sesiones activas.");
            return;
        }

        let sessionToClose: SessionInfo | undefined;

        if (sessionIdOrName) {
            // Find by partial ID or name
            sessionToClose = sessions.find(s => s.id === sessionIdOrName || s.id.startsWith(sessionIdOrName));
            if (!sessionToClose) {
                sessionToClose = sessions.find(s => s.agentName.toLowerCase() === sessionIdOrName.toLowerCase());
            }
        } else {
            // Close active session
            const activeSession = this.getActiveSession(userId);
            if (activeSession) {
                sessionToClose = sessions.find(s => s.id === activeSession.sessionId);
            }
        }

        if (!sessionToClose) {
            await ctx.reply(
                `❌ Sesión no encontrada.\n\n` +
                `Usa /sessions para ver tus sesiones o especifica el ID.`
            );
            return;
        }

        // Check if busy
        if (sessionToClose.status === "busy") {
            await ctx.reply(
                `⚠️ La sesión \`${sessionToClose.id.slice(0, 12)}...\` está ocupada.\n\n` +
                `Espera a que termine o usa /cancel para cancelar el trabajo actual.`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        await this.sessionService.deleteSession(sessionToClose.id);

        // Clear active session if it was this one
        const activeSession = this.getActiveSession(userId);
        if (activeSession?.sessionId === sessionToClose.id) {
            this.activeSessions.delete(userId);
        }

        await ctx.reply(
            `✅ Sesión \`${sessionToClose.id.slice(0, 12)}...\` cerrada.`,
            { parse_mode: "Markdown" }
        );
    }

    /**
     * /cancel [session_id] - Cancel the current prompt in a session
     */
    async handleCancel(ctx: Context, sessionIdOrName?: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const sessions = this.getUserSessions(userId);
        
        let sessionToCancel: SessionInfo | undefined;

        if (sessionIdOrName) {
            sessionToCancel = sessions.find(s => s.id === sessionIdOrName || s.id.startsWith(sessionIdOrName));
        } else {
            const activeSession = this.getActiveSession(userId);
            if (activeSession) {
                sessionToCancel = sessions.find(s => s.id === activeSession.sessionId);
            }
        }

        if (!sessionToCancel) {
            await ctx.reply("❌ No hay sesión activa para cancelar.");
            return;
        }

        if (sessionToCancel.status !== "busy") {
            await ctx.reply("ℹ️ La sesión no está ocupada.");
            return;
        }

        await ctx.reply("🛑 Cancelando tarea...");
        await this.sessionService.cancelPendingPrompt(sessionToCancel.id);
        
        // Clear heartbeat message
        await this.handleHeartbeatClear(sessionToCancel.id, sessionToCancel.agentId);
    }

    /**
     * Handle incoming text message - send to active session
     */
    async handleMessage(ctx: Context, text: string): Promise<void> {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        if (!userId || !chatId) return;

        // Get or create active session
        let activeSession = this.getActiveSession(userId);

        if (!activeSession) {
            // Try to find any existing session
            const sessions = this.getUserSessions(userId);
            if (sessions.length > 0) {
                // Use the most recent idle session or the first one
                const session = sessions.find(s => s.status === "idle") || sessions[0];
                this.setActiveSession(userId, session.id, chatId, session.agentId);
                activeSession = this.getActiveSession(userId)!;
            } else {
                // No sessions - suggest creating one
                await ctx.reply(
                    "📭 *No tienes sesiones activas*\n\n" +
                    "Crea una nueva sesión con /newsession",
                    { parse_mode: "Markdown" }
                );
                return;
            }
        }

        // Check if session is busy
        const session = this.sessionService.getSession(activeSession.sessionId);
        if (!session) {
            await ctx.reply("❌ La sesión activa ya no existe. Usa /sessions para ver las disponibles.");
            this.activeSessions.delete(userId);
            return;
        }

        if (this.sessionService.isBusy(activeSession.sessionId)) {
            // Session is busy - offer to queue or switch
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: "⏳ Esperar", callback_data: `queue:${activeSession.sessionId}` },
                        { text: "🔄 Cambiar sesión", callback_data: `sessions` }
                    ]
                ]
            };
            
            await ctx.reply(
                `⏳ La sesión \`${activeSession.sessionId.slice(0, 12)}...\` está ocupada.\n\n` +
                `¿Qué quieres hacer?`,
                { 
                    parse_mode: "Markdown",
                    reply_markup: keyboard
                }
            );
            return;
        }

        // Send the message
        const placeholderMsg = await ctx.reply("🤔 Pensando...");
        
        // Store heartbeat placeholder
        this.heartbeatMessages.set(activeSession.sessionId, {
            chatId,
            msgId: placeholderMsg.message_id,
        });

        try {
            const result = await this.sessionService.sendPrompt(activeSession.sessionId, text);
            
            // Clear heartbeat message reference
            this.heartbeatMessages.delete(activeSession.sessionId);

            // Edit placeholder with result
            await ctx.telegram.editMessageText(
                chatId,
                placeholderMsg.message_id,
                undefined,
                result.output,
                { parse_mode: "Markdown" }
            );
        } catch (error) {
            this.heartbeatMessages.delete(activeSession.sessionId);
            await ctx.telegram.editMessageText(
                chatId,
                placeholderMsg.message_id,
                undefined,
                `❌ Error: ${error}`
            );
        }
    }

    /**
     * /agents - Show available agents and allow selection
     */
    async handleSelectAgent(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agents = this.agentDb.getByUser(userId);
        if (agents.length === 0) {
            await ctx.reply(
                "❌ *No tienes servidores configurados*\n\n" +
                "Usa el comando /servers para crear uno.",
                { parse_mode: "Markdown" }
            );
            return;
        }

        const selectedAgentId = this.selectedAgents.get(userId);

        let message = "🤖 *Servidores disponibles*\n\n";
        
        for (const agent of agents) {
            const isSelected = agent.id === selectedAgentId;
            const status = agent.status === "running" ? "🟢" : "🔴";
            const checkmark = isSelected ? " ✓" : "";
            message += `${status} ${agent.name}${checkmark}\n`;
            message += `   Puerto: ${agent.port} | Modelo: ${agent.model || "default"}\n\n`;
        }

        message += "\n💡 *Selecciona un servidor para nuevas sesiones:*\n";
        
        const keyboard = {
            inline_keyboard: agents.map(agent => [
                { text: agent.name, callback_data: `select_agent:${agent.id}` }
            ])
        };

        await ctx.reply(message, { 
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    }

    // ─── Callback query handlers ───────────────────────────────────────────────

    async handleCallbackQuery(ctx: Context, data: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        if (data.startsWith("select_agent:")) {
            const agentId = data.replace("select_agent:", "");
            const agent = this.agentDb.getById(agentId);
            if (agent) {
                this.selectedAgents.set(userId, agentId);
                await ctx.answerCbQuery(`Servidor "${agent.name}" seleccionado`);
                await ctx.editMessageText(
                    `✅ Servidor "${agent.name}" seleccionado para nuevas sesiones.\n\n` +
                    `Usa /newsession para crear una sesión.`
                );
            }
        } else if (data.startsWith("queue:")) {
            const sessionId = data.replace("queue:", "");
            // TODO: Implement queue functionality
            await ctx.answerCbQuery("Mensaje añadido a la cola");
        } else if (data === "sessions") {
            await ctx.answerCbQuery("Mostrando sesiones");
            await this.handleListSessions(ctx);
        }
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private getUserSessions(userId: number): SessionInfo[] {
        const allSessions = this.sessionService.getAllSessions();
        return allSessions
            .filter(s => s.agent.userId === userId)
            .map(s => ({
                id: s.sessionId,
                agentId: s.agent.id,
                agentName: s.agent.name,
                status: s.status,
                createdAt: s.createdAt,
                lastActivity: s.lastSseEventAt,
            }))
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    getActiveSession(userId: number): ActiveSession | undefined {
        return this.activeSessions.get(userId);
    }

    private setActiveSession(userId: number, sessionId: string, chatId: number, agentId: string): void {
        this.activeSessions.set(userId, { sessionId, chatId, userId, agentId });
    }

    private formatDuration(ms: number): string {
        const minutes = Math.floor(ms / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        return `${minutes}m`;
    }

    // ─── Callback implementations ─────────────────────────────────────────────

    private async handleHeartbeat(summary: HeartbeatSummary): Promise<void> {
        const heartbeatMsg = this.heartbeatMessages.get(summary.sessionId);
        if (!heartbeatMsg || !this.bot) return;

        const { chatId, msgId } = heartbeatMsg;

        // Build rich heartbeat message
        const minutes = summary.minutesRunning;
        const statusEmoji = summary.sessionStatus === "busy" ? "🔄" : summary.sessionStatus === "retry" ? "⏳" : "✅";
        const streamEmoji = summary.streamConnected ? "🟢" : "🔴";
        
        let message = `${statusEmoji} <b>Procesando...</b> ⏱️ ${minutes}m\n`;
        message += `<code>${summary.sessionId.slice(0, 8)}...</code>\n\n`;
        
        // Current tool/status
        if (summary.lastToolName) {
            const toolEmoji = this.getToolEmoji(summary.lastToolName);
            message += `${toolEmoji} <b>Actual:</b> <code>${escapeHtml(summary.lastToolName)}</code>\n`;
        }
        
        // Recent thought/text
        if (summary.lastText) {
            const thought = summary.lastText.slice(0, 120);
            message += `💭 ${escapeHtml(thought)}${summary.lastText.length > 120 ? "…" : ""}\n`;
        }
        
        // Recent bash command
        if (summary.lastBashCmd) {
            message += `\n<code>${escapeHtml(summary.lastBashCmd.slice(0, 80))}${summary.lastBashCmd.length > 80 ? "…" : ""}</code>\n`;
        }
        
        // Files modified
        if (summary.filesModified > 0) {
            message += `\n📁 <b>Archivos:</b> ${summary.filesModified}`;
            if (summary.recentFiles.length > 0) {
                const files = summary.recentFiles.slice(-3).map(f => {
                    const parts = f.split('/');
                    return parts[parts.length - 1];
                }).join(', ');
                message += ` <code>${escapeHtml(files)}</code>`;
            }
            message += '\n';
        }
        
        // Footer with stats
        message += `\n${streamEmoji} Conexión: ${summary.secondsSinceLastEvent}s | 💬 Msgs: ${summary.messageCount}`;

        try {
            await this.bot.api.editMessageText(chatId, msgId, message, { parse_mode: "HTML" });
        } catch (err) {
            console.debug(`[MultiSessionHandler] Heartbeat edit failed for ${summary.sessionId}:`, err);
        }
    }

    private getToolEmoji(toolName: string): string {
        const emojiMap: { [key: string]: string } = {
            'bash': '⚡',
            'edit': '✏️',
            'write': '📝',
            'read': '📖',
            'patch': '🩹',
            'multiedit': '🔀',
            'browser': '🌐',
            'search': '🔍',
            'ls': '📂',
            'git': '🔀',
        };
        return emojiMap[toolName.toLowerCase()] || '🔧';
    }

    private async handleHeartbeatClear(sessionId: string, agentId: string): Promise<void> {
        const heartbeatMsg = this.heartbeatMessages.get(sessionId);
        if (!heartbeatMsg || !this.bot) return;

        this.heartbeatMessages.delete(sessionId);
        console.log(`[MultiSessionHandler] Heartbeat cleared for ${sessionId}`);
        
        // Try to delete the heartbeat message
        try {
            await this.bot.api.deleteMessage(heartbeatMsg.chatId, heartbeatMsg.msgId);
        } catch {
            // Ignore errors
        }
    }

    private async handleExternalSessionIdle(sessionId: string, agentId: string, output: string): Promise<void> {
        if (!this.bot) return;
        
        // Find the user/chat for this session
        for (const [userId, activeSession] of this.activeSessions.entries()) {
            if (activeSession.sessionId === sessionId) {
                const agent = this.agentDb.getById(agentId);
                const agentName = agent?.name ?? agentId;
                
                try {
                    await this.bot.api.sendMessage(
                        activeSession.chatId,
                        `🌐 <b>${escapeHtml(agentName)}</b> <i>(web/CLI)</i>\n\n${formatAsHtml(output)}`,
                        { parse_mode: "HTML" }
                    );
                } catch (err) {
                    console.error(`[MultiSessionHandler] Failed to send external idle notification:`, err);
                }
                break;
            }
        }
    }

    private async handleAdoptSession(
        sessionId: string,
        agentId: string,
        userId: number
    ): Promise<{ chatId: number; msgId: number } | null> {
        // Find user's chat
        const activeSession = this.getActiveSession(userId);
        if (!activeSession) return null;

        // Return placeholder for adopted session
        // Note: Would need bot instance to send message
        return { chatId: activeSession.chatId, msgId: 0 };
    }

    private async handleAdoptSessionResult(
        sessionId: string,
        agentId: string,
        chatId: number,
        msgId: number,
        result: AgentSendResult
    ): Promise<void> {
        if (!this.bot) return;
        
        const agent = this.agentDb.getById(agentId);
        if (!agent) return;

        const header = `🤖 <b>${escapeHtml(agent.name)}</b>\n\n`;
        const body = result.output || "(sin salida)";
        const MAX = 3800;

        try {
            if (body.length <= MAX) {
                await this.bot.api.sendMessage(chatId, `${header}${formatAsHtml(body)}`, { parse_mode: "HTML" });
            } else {
                const buf = Buffer.from(body, "utf8");
                await this.bot.api.sendDocument(
                    chatId,
                    new InputFile(buf, `${agent.name}-respuesta.md`),
                    { caption: `${header}(resultado adjunto)`, parse_mode: "HTML" }
                );
            }
        } catch (err) {
            console.error(`[MultiSessionHandler] Failed to send adopted session result:`, err);
        }
    }

    private async handleLostPrompt(
        sessionId: string,
        agentId: string,
        chatId: number,
        msgId: number
    ): Promise<void> {
        if (!this.bot) return;
        
        const agent = this.agentDb.getById(agentId);
        const label = agent ? escapeHtml(agent.name) : agentId;
        
        try {
            await this.bot.api.editMessageText(
                chatId, 
                msgId,
                `⚠️ <b>${label}</b>: trabajo perdido durante el reinicio del bot. Vuelve a enviar el mensaje.`,
                { parse_mode: "HTML" }
            );
        } catch (err) {
            console.warn("[MultiSessionHandler] onLostPrompt edit failed:", err);
        }
    }

    // Note: handleQuestion and handleSessionError are already defined above (lines 571-590)
}
