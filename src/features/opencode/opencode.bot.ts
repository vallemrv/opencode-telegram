/**
 * OpenCodeBot — Simplified unified design
 *
 * Comandos:
 *   /new       — Wizard: crea agente (Gitea / GitHub / local) + arranca servidor
 *   /agents    — Lista agentes, activa sticky, borra
 *   /web       — Abre OpenCode Web remoto por IP/host
 *   /run       — One-shot: prompt puntual a un agente
 *   /models    — Cambia el modelo del agente activo
 *   /esc       — Cancela wizard, desactiva sticky, o aborta operación en curso
 *   /undo      — Revertir último mensaje (solo agentes OpenCode)
 *   /redo      — Restaurar cambio revertido
 *   /restart   — Reinicia el bot
 *   /start     — Ayuda
 *
 * Flujo de mensajes:
 *   1. Si hay agente sticky → va a él
 *   2. Si no → va al último agente usado (persistido en DB)
 *   3. Si no hay ninguno → pide crear uno con /new
 *
 * Architecture:
 *   All handler logic lives in src/features/opencode/handlers/*.handler.ts
 *   This class is the orchestrator: it holds shared state and wires grammY routes.
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { ConfigService } from "../../services/config.service.js";
import { AgentDbService } from "../../services/agent-db.service.js";
import type { PersistentAgent } from "../../services/agent-db.service.js";
import { PersistentAgentService } from "../../services/persistent-agent.service.js";
import type { AgentSendResult } from "../../services/persistent-agent.service.js";
import type { OnAdoptSessionCallback, OnAdoptSessionResultCallback } from "../../services/persistent-agent.service.js";
import { AccessControlMiddleware } from "../../middleware/access-control.middleware.js";
import { formatAsHtml, escapeHtml } from "./event-handlers/utils.js";
import { TranscriptionService } from "../../services/transcription.service.js";

// ─── Handler classes ──────────────────────────────────────────────────────────
import { NewWizardHandler } from "./handlers/new-wizard.handler.js";
import { AgentsHandler }    from "./handlers/agents.handler.js";
import { ModelsHandler }    from "./handlers/models.handler.js";
import { SessionHandler }   from "./handlers/session.handler.js";
import { MessageHandler }   from "./handlers/message.handler.js";
import type { BotContext, NewAgentWizard, ModelSelectionState, RemoteAgentInfo } from "./handlers/bot-context.js";

// ─────────────────────────────────────────────────────────────────────────────

export class OpenCodeBot implements BotContext {

    // ── Core services ─────────────────────────────────────────────────────────
    readonly configService: ConfigService;
    readonly agentDb: AgentDbService;
    readonly persistentAgentService: PersistentAgentService;
    readonly transcriptionService: TranscriptionService;
    bot: Bot | undefined;

    // ── Wizard state maps ─────────────────────────────────────────────────────
    readonly newWizard:       Map<number, NewAgentWizard>                    = new Map();
    readonly runWizard:       Map<number, { prompt: string; agentId?: string }> = new Map();
    readonly renameWizard:    Map<number, string>                            = new Map();
    readonly modelSelection:  Map<number, ModelSelectionState>               = new Map();

    // ── Index / lookup maps ───────────────────────────────────────────────────
    readonly remoteAgentIndex:     Map<string, RemoteAgentInfo>                            = new Map();
    readonly remoteAgentsInMemory: Map<number, { id: string; host: string; port: number; model: string }> = new Map();
    readonly modelIndex:           Map<string, string>                                     = new Map();
    readonly pendingAgentQuestions: Map<string, { agentId: string; port: number; req: any }> = new Map();
    readonly heartbeatMessages:    Map<string, { chatId: number; msgId: number }>          = new Map();
    readonly queueStatusMessage:   Map<string, { chatId: number; msgId: number }>          = new Map();
    readonly sessIndex:            Map<string, { agentId: string; sessionId: string }>     = new Map();

    // ── Counters ──────────────────────────────────────────────────────────────
    remoteAgentIndexCounter = 0;
    modelIndexCounter       = 0;
    sessIndexCounter        = 0;
    private static readonly MAX_CALLBACK_DATA = 64;

    // ── Handler instances ─────────────────────────────────────────────────────
    private newWizardHandler: NewWizardHandler;
    private agentsHandler:    AgentsHandler;
    private modelsHandler:    ModelsHandler;
    private sessionHandler:   SessionHandler;
    private messageHandler:   MessageHandler;

    constructor(configService: ConfigService) {
        this.configService         = configService;
        this.agentDb               = new AgentDbService();
        this.persistentAgentService = new PersistentAgentService(this.agentDb);
        this.transcriptionService  = new TranscriptionService();

        this.newWizardHandler = new NewWizardHandler(this);
        this.agentsHandler    = new AgentsHandler(this);
        this.modelsHandler    = new ModelsHandler(this);
        this.sessionHandler   = new SessionHandler(this);
        this.messageHandler   = new MessageHandler(this);
    }

    // ── Shared helper: make a short callback key ──────────────────────────────
    makeShortKey(prefix: string): string {
        if (this.modelIndexCounter > 999999) this.modelIndexCounter = 0;
        const key = `${prefix}${this.modelIndexCounter++}`;
        if (key.length > OpenCodeBot.MAX_CALLBACK_DATA) {
            console.warn(`[OpenCodeBot] callback_data too long: ${key}`);
        }
        return key;
    }

    // ── Shared helper: disconnect remote agent ────────────────────────────────
    disconnectRemoteAgent(userId: number): void {
        const remoteAgent = this.remoteAgentsInMemory.get(userId);
        if (remoteAgent) {
            console.log(`[disconnectRemoteAgent] Disconnecting remote agent ${remoteAgent.host}:${remoteAgent.port}`);
            this.remoteAgentsInMemory.delete(userId);
            this.persistentAgentService.cancelPendingPrompt(remoteAgent.id);
            const abortCtrl = (this.persistentAgentService as any).sseControllers?.get(remoteAgent.id);
            if (abortCtrl) {
                abortCtrl.abort();
                (this.persistentAgentService as any).sseControllers.delete(remoteAgent.id);
            }
        }
    }

    // ── Shared helper: resolve active or last-used agent ─────────────────────
    getActiveOrLastAgent(userId: number): PersistentAgent | undefined {
        const activeId = this.persistentAgentService.getActiveAgentId(userId);
        if (activeId) {
            const fromDb = this.agentDb.getById(activeId);
            if (fromDb) return fromDb;

            const remoteAgent = this.remoteAgentsInMemory.get(userId);
            if (remoteAgent && remoteAgent.id === activeId) {
                return this.buildRemoteAgentRecord(userId, remoteAgent);
            }
        }

        const remoteAgent = this.remoteAgentsInMemory.get(userId);
        if (remoteAgent) {
            return this.buildRemoteAgentRecord(userId, remoteAgent);
        }

        return this.agentDb.getLastUsed(userId) ?? undefined;
    }

    private buildRemoteAgentRecord(
        userId: number,
        r: { id: string; host: string; port: number; model: string },
    ): PersistentAgent {
        return {
            id:       r.id,
            userId,
            name:     `Remote (${r.host})`,
            role:     "",
            workdir:  `/remote/${r.host}/`,
            model:    r.model,
            port:     r.port,
            status:   "running",
            host:     r.host,
            isRemote: true,
        } as PersistentAgent;
    }

    // ── Shared helper: edit placeholder then send new result message ──────────
    async editOrSendResult(
        chatId: number,
        msgId: number,
        agent: PersistentAgent,
        result: AgentSendResult,
    ): Promise<void> {
        const header = `🤖 <b>${escapeHtml(agent.name)}</b>\n\n`;
        const body   = result.output || "(sin salida)";
        const MAX    = 3800;

        try {
            await this.bot!.api.deleteMessage(chatId, msgId);
        } catch (err) {
            // Message may have been already deleted or edited
        }

        if (body.length <= MAX) {
            try {
                await this.bot!.api.sendMessage(chatId, `${header}${formatAsHtml(body)}`, { parse_mode: "HTML" });
            } catch (err) {
                console.error("[OpenCodeBot] Failed to send result message:", err);
            }
        } else {
            try {
                const buf = Buffer.from(body, "utf8");
                await this.bot!.api.sendDocument(
                    chatId,
                    new InputFile(buf, `${agent.name}-respuesta.md`),
                    { caption: `${header}(resultado adjunto)`, parse_mode: "HTML" }
                );
            } catch (err) {
                console.error("[OpenCodeBot] Failed to send result document:", err);
            }
        }
    }

    // ── Shared helper: send result as a new message (no placeholder) ──────────
    async sendAgentResult(
        chatId: number,
        agent: PersistentAgent,
        result: AgentSendResult,
    ): Promise<void> {
        const header = `🤖 <b>${escapeHtml(agent.name)}</b>\n\n`;
        const body   = result.output || "(sin salida)";
        const MAX    = 3800;

        if (body.length <= MAX) {
            try {
                await this.bot!.api.sendMessage(chatId, `${header}${formatAsHtml(body)}`, { parse_mode: "HTML" });
            } catch (err) {
                console.error("[OpenCodeBot] Failed to send result message:", err);
            }
        } else {
            try {
                const buf = Buffer.from(body, "utf8");
                await this.bot!.api.sendDocument(
                    chatId,
                    new InputFile(buf, `${agent.name}-respuesta.md`),
                    { caption: `${header}(resultado adjunto)`, parse_mode: "HTML" }
                );
            } catch (err) {
                console.error("[OpenCodeBot] Failed to send result document:", err);
            }
        }
    }

    // ── Shared helper: send prompt to agent (with queue support) ─────────────
    async sendPromptToAgent(ctx: Context, agent: PersistentAgent, prompt: string): Promise<void> {
        if (this.persistentAgentService.isBusy(agent.id)) {
            const chatId = ctx.chat!.id;

            const prevQueueMsg = this.queueStatusMessage.get(agent.id);
            if (prevQueueMsg && this.bot) {
                await this.bot.api.deleteMessage(prevQueueMsg.chatId, prevQueueMsg.msgId).catch(() => {});
            }

            this.persistentAgentService.enqueue(agent.id, {
                prompt,
                onDequeue: async () => {
                    if (!this.bot) return;

                    const queueMsg = this.queueStatusMessage.get(agent.id);
                    if (queueMsg) {
                        await this.bot.api.deleteMessage(queueMsg.chatId, queueMsg.msgId).catch(() => {});
                        this.queueStatusMessage.delete(agent.id);
                    }

                    const processingMsg = await this.bot.api.sendMessage(
                        chatId,
                        `⏳ <b>${escapeHtml(agent.name)}</b> [${escapeHtml(agent.model)}] procesando…`,
                        { parse_mode: "HTML" }
                    ).catch(() => null);
                    if (processingMsg) {
                        this.heartbeatMessages.set(agent.id, { chatId, msgId: processingMsg.message_id });
                    }

                    const remaining = this.persistentAgentService.queueLength(agent.id);
                    if (remaining > 0) {
                        const newQueueMsg = await this.bot.api.sendMessage(
                            chatId,
                            `📥 <b>${escapeHtml(agent.name)}</b> — ${remaining} mensaje${remaining !== 1 ? "s" : ""} en cola`,
                            { parse_mode: "HTML" }
                        ).catch(() => null);
                        if (newQueueMsg) {
                            this.queueStatusMessage.set(agent.id, { chatId, msgId: newQueueMsg.message_id });
                        }
                    }

                    await this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
                },
                onResult: async (result) => {
                    const hb = this.heartbeatMessages.get(agent.id);
                    this.heartbeatMessages.delete(agent.id);
                    if (hb) {
                        await this.editOrSendResult(hb.chatId, hb.msgId, agent, result);
                    } else {
                        await this.sendAgentResult(chatId, agent, result);
                    }
                },
            });

            const qLen = this.persistentAgentService.queueLength(agent.id);
            const statusMsg = await ctx.reply(
                `📥 <b>${escapeHtml(agent.name)}</b> — ${qLen} mensaje${qLen !== 1 ? "s" : ""} en cola`,
                { parse_mode: "HTML" }
            ).catch(() => null);
            if (statusMsg) {
                this.queueStatusMessage.set(agent.id, { chatId, msgId: statusMsg.message_id });
            }
            return;
        }

        const statusMsg = await ctx.reply(
            `⏳ <b>${escapeHtml(agent.name)}</b> [${escapeHtml(agent.model)}] procesando…`,
            { parse_mode: "HTML" }
        );
        await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});

        this.heartbeatMessages.set(agent.id, { chatId: ctx.chat!.id, msgId: statusMsg.message_id });
        this.autoRenameSessionIfNeeded(agent, prompt).catch(() => {});

        const chatId           = ctx.chat!.id;
        const placeholderMsgId = statusMsg.message_id;
        this.persistentAgentService.sendPrompt(agent, prompt).then(async (result) => {
            const hb = this.heartbeatMessages.get(agent.id);
            this.heartbeatMessages.delete(agent.id);
            await this.editOrSendResult(chatId, hb?.msgId ?? placeholderMsgId, agent, result);
        }).catch(async (err) => {
            this.heartbeatMessages.delete(agent.id);
            await this.bot!.api.deleteMessage(chatId, placeholderMsgId).catch(() => {});
            await this.bot!.api.sendMessage(
                chatId,
                `❌ <b>${escapeHtml(agent.name)}</b> — error inesperado: ${escapeHtml(String(err))}`,
                { parse_mode: "HTML" }
            ).catch(() => {});
        });
    }

    // ─── Register all bot handlers ────────────────────────────────────────────

    registerHandlers(bot: Bot): void {
        this.bot = bot;

        // Wire persistent agent callbacks to MessageHandler methods
        this.persistentAgentService.setOnQuestionCallback(
            this.messageHandler.handleAgentQuestion.bind(this.messageHandler)
        );
        this.persistentAgentService.setOnSessionErrorCallback(
            this.messageHandler.handleAgentSessionError.bind(this.messageHandler)
        );
        this.persistentAgentService.setOnHeartbeatCallback(
            this.messageHandler.handleAgentHeartbeat.bind(this.messageHandler)
        );
        this.persistentAgentService.setOnHeartbeatClearCallback(
            this.messageHandler.handleAgentHeartbeatClear.bind(this.messageHandler)
        );

        // ── Adopt-session callbacks (post-restart recovery) ───────────────────
        const adoptSessionCallback: OnAdoptSessionCallback = async (agentId, userId) => {
            if (!this.bot) return null;
            const agent = this.agentDb.getById(agentId);
            const agentName = agent?.name ?? agentId;
            try {
                const msg = await this.bot.api.sendMessage(
                    userId,
                    `🔄 <b>${escapeHtml(agentName)}</b> — bot reiniciado, recuperando trabajo en curso…`,
                    { parse_mode: "HTML" }
                );
                // Register as heartbeat message so ticks update this placeholder
                this.heartbeatMessages.set(agentId, { chatId: userId, msgId: msg.message_id });
                return { chatId: userId, msgId: msg.message_id };
            } catch (err) {
                console.error("[OpenCodeBot] adoptSession notification failed:", err);
                return null;
            }
        };
        this.persistentAgentService.setOnAdoptSessionCallback(adoptSessionCallback);

        const adoptSessionResultCallback: OnAdoptSessionResultCallback = async (agentId, chatId, msgId, result) => {
            const agent = this.agentDb.getById(agentId);
            if (!agent) {
                console.warn(`[OpenCodeBot] adoptSessionResult: agent ${agentId} not found in DB`);
                return;
            }
            // Clear heartbeatMessages before editOrSendResult (same pattern as sendPromptToAgent)
            this.heartbeatMessages.delete(agentId);
            await this.editOrSendResult(chatId, msgId, agent, result);
        };
        this.persistentAgentService.setOnAdoptSessionResultCallback(adoptSessionResultCallback);

        // Restore all agents on startup
        this.persistentAgentService.restoreAll(this.agentDb.getAll())
            .then(async (failed) => {
                for (const agent of failed) {
                    try {
                        await bot.api.sendMessage(
                            agent.userId,
                            `⚠️ <b>Agente "${escapeHtml(agent.name)}" no pudo restaurarse</b>\n\nPuerto: <code>${agent.port}</code>. Arrancará de nuevo al enviarle un mensaje.`,
                            { parse_mode: "HTML" }
                        );
                    } catch { /* ignore */ }
                }
            })
            .catch(err => console.error("[OpenCodeBot] Failed to restore agents:", err));

        // ─── Commands ────────────────────────────────────────────────────────
        bot.command("start",   AccessControlMiddleware.requireAccess, this.handleStart.bind(this));
        bot.command("help",    AccessControlMiddleware.requireAccess, this.handleStart.bind(this));
        bot.command("new",     AccessControlMiddleware.requireAccess, this.newWizardHandler.handleNew.bind(this.newWizardHandler));
        bot.command("agents",  AccessControlMiddleware.requireAccess, (ctx) => this.agentsHandler.handleAgentsWithIp(ctx));
        bot.command("web",     AccessControlMiddleware.requireAccess, this.agentsHandler.handleWeb.bind(this.agentsHandler));
        bot.command("run",     AccessControlMiddleware.requireAccess, this.messageHandler.handleRun.bind(this.messageHandler));
        bot.command("models",  AccessControlMiddleware.requireAccess, this.modelsHandler.handleModels.bind(this.modelsHandler));
        bot.command("esc",     AccessControlMiddleware.requireAccess, this.messageHandler.handleEsc.bind(this.messageHandler));
        bot.command("undo",    AccessControlMiddleware.requireAccess, this.sessionHandler.handleUndo.bind(this.sessionHandler));
        bot.command("redo",    AccessControlMiddleware.requireAccess, this.sessionHandler.handleRedo.bind(this.sessionHandler));
        bot.command("session", AccessControlMiddleware.requireAccess, this.sessionHandler.handleSession.bind(this.sessionHandler));
        bot.command("rename",  AccessControlMiddleware.requireAccess, this.sessionHandler.handleRename.bind(this.sessionHandler));
        bot.command("delete",  AccessControlMiddleware.requireAccess, this.sessionHandler.handleDelete.bind(this.sessionHandler));
        bot.command("deleteall", AccessControlMiddleware.requireAccess, this.sessionHandler.handleDeleteAll.bind(this.sessionHandler));
        bot.command("restart", AccessControlMiddleware.requireAccess, this.messageHandler.handleRestart.bind(this.messageHandler));

        // ─── Callbacks ───────────────────────────────────────────────────────
        bot.callbackQuery(/^new:source:/,       AccessControlMiddleware.requireAccess, this.newWizardHandler.handleNewSource.bind(this.newWizardHandler));
        bot.callbackQuery(/^new:confirm$/,      AccessControlMiddleware.requireAccess, this.newWizardHandler.handleNewConfirm.bind(this.newWizardHandler));
        bot.callbackQuery(/^new:cancel$/,       AccessControlMiddleware.requireAccess, this.newWizardHandler.handleNewCancel.bind(this.newWizardHandler));

        bot.callbackQuery(/^agent:activate:/,   AccessControlMiddleware.requireAccess, this.agentsHandler.handleAgentActivate.bind(this.agentsHandler));
        bot.callbackQuery(/^agent:del:/,        AccessControlMiddleware.requireAccess, this.agentsHandler.handleAgentDelete.bind(this.agentsHandler));
        bot.callbackQuery(/^agent:delconfirm:/, AccessControlMiddleware.requireAccess, this.agentsHandler.handleAgentDeleteConfirm.bind(this.agentsHandler));
        bot.callbackQuery(/^agent:delcancel$/,  AccessControlMiddleware.requireAccess, this.agentsHandler.handleAgentDeleteCancel.bind(this.agentsHandler));
        bot.callbackQuery(/^agent:model:/,      AccessControlMiddleware.requireAccess, this.modelsHandler.handleAgentModelSelect.bind(this.modelsHandler));
        bot.callbackQuery("agent:new",          AccessControlMiddleware.requireAccess, this.newWizardHandler.handleAgentNew.bind(this.newWizardHandler));
        bot.callbackQuery(/^agent:park:/,       AccessControlMiddleware.requireAccess, this.agentsHandler.handleAgentPark.bind(this.agentsHandler));
        bot.callbackQuery(/^agent:unpark:/,     AccessControlMiddleware.requireAccess, this.agentsHandler.handleAgentUnpark.bind(this.agentsHandler));

        bot.callbackQuery(/^remote:select:/,    AccessControlMiddleware.requireAccess, this.agentsHandler.handleRemoteAgentSelect.bind(this.agentsHandler));

        bot.callbackQuery(/^run:agent:/,        AccessControlMiddleware.requireAccess, this.messageHandler.handleRunAgentSelected.bind(this.messageHandler));
        bot.callbackQuery(/^run:cancel$/,       AccessControlMiddleware.requireAccess, this.messageHandler.handleRunCancel.bind(this.messageHandler));

        bot.callbackQuery(/^mdl_/,              AccessControlMiddleware.requireAccess, this.modelsHandler.handleModelCallback.bind(this.modelsHandler));

        bot.callbackQuery(/^agq:/,              AccessControlMiddleware.requireAccess, this.messageHandler.handleAgentQuestionCallback.bind(this.messageHandler));

        bot.callbackQuery(/^sa:/,               AccessControlMiddleware.requireAccess, this.sessionHandler.handleSessionActivate.bind(this.sessionHandler));
        bot.callbackQuery(/^sn:/,               AccessControlMiddleware.requireAccess, this.sessionHandler.handleSessionNew.bind(this.sessionHandler));
        bot.callbackQuery(/^sd:/,               AccessControlMiddleware.requireAccess, this.sessionHandler.handleSessionDeleteAll.bind(this.sessionHandler));
        bot.callbackQuery(/^sx:/,               AccessControlMiddleware.requireAccess, this.sessionHandler.handleSessionDelete.bind(this.sessionHandler));

        // ─── ESC keyboard button ─────────────────────────────────────────────
        bot.hears("⏹️ ESC", AccessControlMiddleware.requireAccess, this.messageHandler.handleEsc.bind(this.messageHandler));

        // ─── Regular text messages ───────────────────────────────────────────
        bot.on("message:text", AccessControlMiddleware.requireAccess, async (ctx, next) => {
            if (ctx.message?.text?.startsWith("/")) return next();
            if (ctx.message?.text === "⏹️ ESC") return next();
            const userId = ctx.from?.id;
            if (!userId) return;

            if (this.newWizard.has(userId)) {
                await this.newWizardHandler.handleNewWizardText(ctx);
                return;
            }
            if (this.runWizard.has(userId)) {
                await this.messageHandler.handleRunWizardText(ctx);
                return;
            }
            if (this.renameWizard.has(userId)) {
                await this.sessionHandler.handleRenameWizardText(ctx);
                return;
            }
            await this.messageHandler.handleMessage(ctx);
        });

        // ─── File uploads ────────────────────────────────────────────────────
        bot.on("message:document", AccessControlMiddleware.requireAccess, this.messageHandler.handleFileUpload.bind(this.messageHandler));
        bot.on("message:photo",    AccessControlMiddleware.requireAccess, this.messageHandler.handleFileUpload.bind(this.messageHandler));
        bot.on("message:video",    AccessControlMiddleware.requireAccess, this.messageHandler.handleFileUpload.bind(this.messageHandler));
        bot.on("message:audio",    AccessControlMiddleware.requireAccess, this.messageHandler.handleFileUpload.bind(this.messageHandler));
        bot.on("message:voice",    AccessControlMiddleware.requireAccess, this.messageHandler.handleFileUpload.bind(this.messageHandler));
    }

    // ─── /start — help ────────────────────────────────────────────────────────

    private async handleStart(ctx: Context): Promise<void> {
        const isGitea  = !!process.env.GITEA_URL && !!process.env.GITEA_TOKEN;
        const isGithub = !!process.env.GITHUB_TOKEN;
        const maxAgents = this.configService.getMaxAgents();

        await ctx.reply(
            `<b>TelegramCoder</b>\n\n` +
            `<b>Comandos:</b>\n` +
            `/new — Crear agente (${isGitea ? "Gitea ✅" : "Gitea ❌"} / ${isGithub ? "GitHub ✅" : "GitHub ❌"} / local)\n` +
            `/agents [&lt;ip&gt;] — Ver agentes (usa &lt;ip&gt; para nodos remotos)\n` +
            `/web &lt;ip&gt; — Abrir OpenCode Web por proyecto (remoto)\n` +
            `/run — Prompt puntual a un agente\n` +
            `/session — Ver sesiones del agente activo\n` +
            `/rename — Renombrar la sesión activa\n` +
            `/delete — Borrar sesión activa y crear nueva\n` +
            `/deleteall — Borrar todas las sesiones y crear nueva\n` +
            `/models — Cambiar modelo del agente activo\n` +
            `/esc — Cancelar / desactivar agente / abortar\n` +
            `/undo — Revertir último cambio\n` +
            `/redo — Restaurar cambio revertido\n` +
            `/restart — Reiniciar (git pull + build + restart)\n\n` +
            `<b>Flujo:</b>\n` +
            `1. <code>/new mi-proyecto</code> → wizard → agente listo\n` +
            `2. Escribe tus mensajes directamente\n` +
            `3. <code>/esc</code> para desactivar agente\n\n` +
            `<b>Remoto:</b> <code>/agents 10.0.0.8</code> → pulsa agente → úsalo una vez\n\n` +
            `<b>Web:</b> <code>/web 10.0.0.8</code>\n\n` +
            `<b>Límite:</b> ${maxAgents} agentes activos (MAX_AGENTS en .env)\n` +
            `Los agentes aparcados (⏹️ en /agents) no cuentan para el límite.`,
            { parse_mode: "HTML" }
        );
    }

    // ─── Auto-rename session on first prompt ──────────────────────────────────

    private async autoRenameSessionIfNeeded(agent: PersistentAgent, prompt: string): Promise<void> {
        const sessionId = this.persistentAgentService.getSessionId(agent.id);
        if (!sessionId) return;

        try {
            const baseUrl = `http://${agent.host || "localhost"}:${agent.port}`;
            const res = await fetch(`${baseUrl}/session/${sessionId}`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return;
            const sess: any = await res.json();
            if (!sess.title?.startsWith("tg-")) return;

            const newTitle = prompt.replace(/\s+/g, " ").trim().slice(0, 50);
            if (!newTitle) return;

            await fetch(`${baseUrl}/session/${sessionId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: newTitle }),
                signal: AbortSignal.timeout(5000),
            });
        } catch { /* best-effort */ }
    }
}
