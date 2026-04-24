/**
 * MessageHandler — regular message routing, /run, /esc, /restart,
 * heartbeat + question callbacks, and file upload handling.
 */

import { Context, InputFile, InlineKeyboard } from "grammy";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as nodePath from "path";
import type { PersistentAgent } from "../../../services/agent-db.service.js";
import type { AgentSendResult, HeartbeatSummary } from "../../../services/persistent-agent.service.js";
import { ErrorUtils } from "../../../utils/error.utils.js";
import { MessageUtils } from "../../../utils/message.utils.js";
import { formatAsHtml, escapeHtml } from "../event-handlers/utils.js";
import type { BotContext } from "./bot-context.js";

function getAgentBaseUrl(agent: { host?: string; port: number }): string {
    return `http://${agent.host || "localhost"}:${agent.port}`;
}

export class MessageHandler {
    constructor(private readonly ctx: BotContext) {}

    // ── Regular text message routing ──────────────────────────────────────────

    async handleMessage(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const prompt = ctx.message?.text?.trim() || "";
        if (!prompt) return;

        // ── Custom answer to an agent question ────────────────────────────────
        const customPending = this.ctx.pendingCustomAnswer.get(userId);
        if (customPending) {
            this.ctx.pendingCustomAnswer.delete(userId);
            const pending = this.ctx.pendingAgentQuestions.get(customPending.shortKey);
            if (pending) {
                this.ctx.pendingAgentQuestions.delete(customPending.shortKey);
                const agent = this.ctx.agentDb.getById(pending.agentId);
                if (agent) {
                    await this.ctx.persistentAgentService.replyQuestion(agent, pending.req.id, [[prompt]]);
                    try {
                        const bot2 = this.ctx.bot;
                        if (bot2) {
                            await bot2.api.editMessageText(
                                customPending.chatId,
                                customPending.msgId,
                                `✅ Respondido: <b>${escapeHtml(prompt)}</b>`,
                                { parse_mode: "HTML" }
                            );
                        }
                    } catch (err) {
                        console.error("[MessageHandler] Failed to edit custom answer message:", err);
                    }
                }
            }
            return;
        }

        let activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);

        if (!activeId) {
            const lastUsed = this.ctx.agentDb.getLastUsed(userId);
            if (lastUsed) {
                activeId = lastUsed.id;
                this.ctx.persistentAgentService.setActiveAgent(userId, activeId);
            }
        }

        if (!activeId) {
            await ctx.reply(
                `ℹ️ No hay ningún agente activo.\n\n` +
                `Crea uno con /new o activa uno existente con /agents.`
            );
            return;
        }

        const agent = this.ctx.agentDb.getById(activeId);
        if (!agent) {
            this.ctx.persistentAgentService.clearActiveAgent(userId);
            this.ctx.agentDb.clearLastUsed(userId);
            await ctx.reply("❌ El agente activo ya no existe. Usa /new o /agents.");
            return;
        }

        if (agent.status === "stopped") {
            await ctx.reply(
                `⏸️ El agente <b>${escapeHtml(agent.name)}</b> está aparcado.\n\n` +
                `Reanúdalo con ▶️ en /agents antes de enviarle mensajes.`,
                { parse_mode: "HTML" }
            );
            return;
        }

        await this.ctx.sendPromptToAgent(ctx, agent, prompt);
    }

    // ── /run ──────────────────────────────────────────────────────────────────

    async handleRun(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const allAgents = this.ctx.agentDb.getByUser(userId);
        const agents = allAgents.filter(a => a.status !== "stopped");
        if (agents.length === 0) {
            await ctx.reply("ℹ️ No tienes agentes activos. Crea uno con /new o reanuda un agente aparcado con /agents.");
            return;
        }

        const inlinePrompt = ctx.message?.text?.replace(/^\/run\s*/i, "").trim() || "";

        if (inlinePrompt) {
            if (agents.length === 1) {
                await this.executeRunPrompt(ctx, agents[0], inlinePrompt);
            } else {
                this.ctx.runWizard.set(userId, { prompt: inlinePrompt });
                await this.showRunPicker(ctx, inlinePrompt);
            }
        } else {
            this.ctx.runWizard.set(userId, { prompt: "" });
            await ctx.reply(
                `💬 <b>Prompt puntual</b>\n\nEscribe el mensaje que quieres enviar. /esc para cancelar.`,
                { parse_mode: "HTML" }
            );
        }
    }

    async handleRunWizardText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;
        const state = this.ctx.runWizard.get(userId);
        if (!state) return;

        const text = ctx.message?.text?.trim() || "";
        if (!text) return;

        const allAgents = this.ctx.agentDb.getByUser(userId);
        const agents = allAgents.filter(a => a.status !== "stopped");
        this.ctx.runWizard.delete(userId);

        if (agents.length === 1) {
            await this.executeRunPrompt(ctx, agents[0], text);
        } else {
            this.ctx.runWizard.set(userId, { prompt: text });
            await this.showRunPicker(ctx, text);
        }
    }

    async handleRunAgentSelected(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("run:agent:")) return;
        const agentId = callbackData.replace("run:agent:", "");
        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

        const state = this.ctx.runWizard.get(userId);
        const prompt = state?.prompt || "";
        this.ctx.runWizard.delete(userId);

        if (!prompt) { await ctx.editMessageText("❌ No hay prompt. Usa /run de nuevo."); return; }

        await ctx.deleteMessage().catch(() => {});
        await this.executeRunPrompt(ctx, agent, prompt);
    }

    async handleRunCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (userId) this.ctx.runWizard.delete(userId);
        await ctx.editMessageText("❌ Cancelado.").catch(() => {});
    }

    // ── /esc ──────────────────────────────────────────────────────────────────

    async handleEsc(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const busyAgentId = this.ctx.persistentAgentService.getActiveAgentId(userId)
            ?? this.ctx.agentDb.getLastUsed(userId)?.id;
        if (busyAgentId && this.ctx.persistentAgentService.isBusy(busyAgentId)) {            const agent = this.ctx.agentDb.getById(busyAgentId);
            this.ctx.persistentAgentService.cancelPendingPrompt(busyAgentId);
            const hb = this.ctx.heartbeatMessages.get(busyAgentId);
            this.ctx.heartbeatMessages.delete(busyAgentId);
            if (hb) {
                await this.ctx.bot!.api.editMessageText(
                    hb.chatId, hb.msgId,
                    `❌ <b>${escapeHtml(agent?.name ?? busyAgentId)}</b> cancelado.`,
                    { parse_mode: "HTML" }
                ).catch(() => {});
            } else {
                await ctx.reply(`❌ <b>${escapeHtml(agent?.name ?? busyAgentId)}</b> cancelado.`, { parse_mode: "HTML" });
            }
            return;
        }

        if (this.ctx.newWizard.has(userId)) {
            this.ctx.newWizard.delete(userId);
            await ctx.reply("❌ Cancelado.");
            return;
        }

        if (this.ctx.pendingCustomAnswer.has(userId)) {
            const pca = this.ctx.pendingCustomAnswer.get(userId)!;
            this.ctx.pendingCustomAnswer.delete(userId);
            // Restore keyboard on question message
            const pending = this.ctx.pendingAgentQuestions.get(pca.shortKey);
            if (pending) {
                const firstQ = pending.req.questions?.[0];
                const kb = new InlineKeyboard();
                if (firstQ?.options && Array.isArray(firstQ.options)) {
                    firstQ.options.forEach((opt: any, idx: number) => {
                        const lbl = typeof opt === "string" ? opt : (opt.label ?? String(opt));
                        kb.text(lbl, `agq:${pca.shortKey}:${idx}`).row();
                    });
                }
                kb.text("❌ Rechazar", `agq:${pca.shortKey}:r`);
                kb.text("✏️ Escribir respuesta", `agq:${pca.shortKey}:custom`);
                try {
                    await this.ctx.bot!.api.editMessageReplyMarkup(pca.chatId, pca.msgId, { reply_markup: kb });
                } catch (_) { /* ignore */ }
            }
            await ctx.reply("❌ Respuesta libre cancelada.");
            return;
        }

        if (this.ctx.runWizard.has(userId)) {
            this.ctx.runWizard.delete(userId);
            await ctx.reply("❌ Cancelado.");
            return;
        }

        if (this.ctx.renameWizard.has(userId)) {
            this.ctx.renameWizard.delete(userId);
            await ctx.reply("❌ Cancelado.");
            return;
        }

        const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);
        if (activeId) {
            const agent = this.ctx.agentDb.getById(activeId);
            this.ctx.persistentAgentService.clearActiveAgent(userId);

            if (agent) {
                await ctx.reply(`⏹️ <b>${escapeHtml(agent.name)}</b> desactivado.`, { parse_mode: "HTML" });
            } else {
                await ctx.reply(`⏹️ Agente desactivado.`);
            }
            return;
        }

        await ctx.reply("ℹ️ Nada que cancelar.");
    }

    // ── /restart ──────────────────────────────────────────────────────────────

    async handleRestart(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const adminId = this.ctx.configService.getAdminUserId();
        if (!adminId || userId !== adminId) {
            await ctx.reply("⛔ Solo administradores pueden reiniciar el servicio.");
            return;
        }

        const statusMsg = await ctx.reply("🔄 <b>Reiniciando servicio...</b>\n\n1️⃣ Git pull...", { parse_mode: "HTML" });

        try {
            const { execSync } = await import("child_process");
            const cwd = process.cwd();

            // 1. Git pull
            try {
                execSync("git pull", { cwd, encoding: "utf-8" });
                await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                    "🔄 <b>Reiniciando servicio...</b>\n\n1️⃣ Git pull ✅\n2️⃣ Building...",
                    { parse_mode: "HTML" }
                );
            } catch { /* not fatal */ }

            // 2. Build
            execSync("npm run build", { cwd, encoding: "utf-8" });
            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                "🔄 <b>Reiniciando servicio...</b>\n\n1️⃣ Git pull ✅\n2️⃣ Build ✅\n3️⃣ Restarting service...",
                { parse_mode: "HTML" }
            );

            // 3. Restart via systemd or pm2
            try {
                execSync("systemctl restart opencode-telegram", { encoding: "utf-8" });
            } catch {
                try {
                    execSync("pm2 restart opencode-telegram", { encoding: "utf-8" });
                } catch { /* fall through — exit below will trigger restart */ }
            }

            // 4. Save state for post-restart notification
            const { SessionDbService } = await import("../../../services/session-db.service.js");
            const db = new SessionDbService();
            db.setState("restart_pending_chat_id", String(ctx.chat!.id));
            db.setState("restart_pending_message_id", String(statusMsg.message_id));
            db.setState("restart_initiated_by", String(userId));
            
            // 5. Save active agents state for persistence
            this.ctx.persistentAgentService.saveActiveAgentsState();

            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                "✅ <b>Servicio reiniciado correctamente</b>\n\nEl bot se está reiniciando...",
                { parse_mode: "HTML" }
            );
        } catch (err: any) {
            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                `❌ <b>Error al reiniciar</b>\n\n${escapeHtml(err.message || String(err))}`,
                { parse_mode: "HTML" }
            );
            return;
        }

        setTimeout(() => process.exit(0), 1000);
    }

    // ── Agent question callback ───────────────────────────────────────────────

    async handleAgentQuestion(agentId: string, req: any): Promise<void> {
        const bot = this.ctx.bot;
        if (!bot) return;

        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) return;

        const shortKey = randomUUID().slice(0, 8);
        this.ctx.pendingAgentQuestions.set(shortKey, { agentId, port: agent.port, req });

        const firstQ = req.questions?.[0];
        const questionText = firstQ?.question || "¿Qué prefieres?";

        let optionsText = "";
        const keyboard = new InlineKeyboard();

        if (firstQ?.options && Array.isArray(firstQ.options)) {
            firstQ.options.forEach((opt: any, idx: number) => {
                const label = typeof opt === "string" ? opt : (opt.label ?? String(opt));
                const desc  = typeof opt === "object" && opt.description ? opt.description : "";
                keyboard.text(label, `agq:${shortKey}:${idx}`).row();
                optionsText += `\n${idx + 1}. <b>${escapeHtml(label)}</b>`;
                if (desc) optionsText += `\n   <i>${escapeHtml(desc)}</i>`;
            });
        }

        keyboard.text("❌ Rechazar", `agq:${shortKey}:r`);
        keyboard.text("✏️ Escribir respuesta", `agq:${shortKey}:custom`);

        try {
            const { chatId } = this.ctx.resolveAgentChat(agent.id);
            await bot.api.sendMessage(
                chatId,
                `❓ <b>${escapeHtml(agent.name)}</b> tiene una pregunta:\n\n` +
                `${escapeHtml(questionText)}` +
                (optionsText ? `\n${optionsText}` : ""),
                { parse_mode: "HTML", reply_markup: keyboard }
            );
        } catch (err) {
            console.error("[MessageHandler] Failed to send question:", err);
        }
    }

    async handleAgentQuestionCallback(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const data = ctx.callbackQuery?.data;
        if (!data) return;
        const match = data.match(/^agq:([^:]+):(.+)$/);
        if (!match) return;
        const shortKey = match[1];
        const answerKey = match[2];

        const pending = this.ctx.pendingAgentQuestions.get(shortKey);
        if (!pending) {
            try {
                await ctx.editMessageText("⚠️ Esta pregunta ya fue respondida o expiró.");
            } catch (err) {
                console.error("[MessageHandler] Failed to edit expired question message:", err);
            }
            return;
        }
        this.ctx.pendingAgentQuestions.delete(shortKey);

        if (answerKey === "r") {
            const agent = this.ctx.agentDb.getById(pending.agentId);
            if (!agent) {
                try {
                    await ctx.editMessageText("❌ Agente no encontrado.");
                } catch (err) {
                    console.error("[MessageHandler] Failed to edit agent not found message:", err);
                }
                return;
            }
            await this.ctx.persistentAgentService.rejectQuestion(agent, pending.req.id);
            try {
                await ctx.editMessageText("❌ Rechazado.");
            } catch (err) {
                console.error("[MessageHandler] Failed to edit rejection message:", err);
            }
        } else if (answerKey === "custom") {
            // Re-insert pending question so it can still be answered
            this.ctx.pendingAgentQuestions.set(shortKey, pending);
            const userId = ctx.from?.id;
            if (userId) {
                const chatId = ctx.chat?.id ?? 0;
                const msgId = ctx.callbackQuery?.message?.message_id ?? 0;
                this.ctx.pendingCustomAnswer.set(userId, { shortKey, chatId, msgId });
            }
            try {
                await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("❌ Cancelar respuesta", `agq:${shortKey}:cancelcustom`) });
            } catch (_) { /* ignore */ }
            await ctx.answerCallbackQuery("✏️ Escribe tu respuesta como mensaje de texto");
            return; // already answered callback query above
        } else if (answerKey === "cancelcustom") {
            // Re-insert question and restore keyboard
            this.ctx.pendingAgentQuestions.set(shortKey, pending);
            const userId = ctx.from?.id;
            if (userId) this.ctx.pendingCustomAnswer.delete(userId);
            // Restore original keyboard
            const firstQ2 = pending.req.questions?.[0];
            const keyboard2 = new InlineKeyboard();
            if (firstQ2?.options && Array.isArray(firstQ2.options)) {
                firstQ2.options.forEach((opt: any, idx: number) => {
                    const label2 = typeof opt === "string" ? opt : (opt.label ?? String(opt));
                    keyboard2.text(label2, `agq:${shortKey}:${idx}`).row();
                });
            }
            keyboard2.text("❌ Rechazar", `agq:${shortKey}:r`);
            keyboard2.text("✏️ Escribir respuesta", `agq:${shortKey}:custom`);
            try {
                await ctx.editMessageReplyMarkup({ reply_markup: keyboard2 });
            } catch (_) { /* ignore */ }
        } else {
            const idx = parseInt(answerKey, 10);
            const firstQ = pending.req.questions?.[0];
            const opt = firstQ?.options?.[idx];
            const label = typeof opt === "string" ? opt : (opt?.label ?? String(opt ?? answerKey));
            const agent = this.ctx.agentDb.getById(pending.agentId);
            if (!agent) {
                try {
                    await ctx.editMessageText("❌ Agente no encontrado.");
                } catch (err) {
                    console.error("[MessageHandler] Failed to edit agent not found message:", err);
                }
                return;
            }
            await this.ctx.persistentAgentService.replyQuestion(agent, pending.req.id, [[label]]);
            try {
                await ctx.editMessageText(`✅ Respondido: <b>${escapeHtml(label)}</b>`, { parse_mode: "HTML" });
            } catch (err) {
                console.error("[MessageHandler] Failed to edit response message:", err);
            }
        }
    }

    // ── Heartbeat callback ────────────────────────────────────────────────────

    async handleAgentHeartbeat(agentId: string, summary: HeartbeatSummary): Promise<void> {
        const bot = this.ctx.bot;
        if (!bot) return;

        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) return;

        const elapsed = summary.minutesRunning === 0
            ? "< 1 min"
            : `${summary.minutesRunning} min`;

        // Header
        let text = `⏳ <b>${escapeHtml(agent.name)}</b> — trabajando (${elapsed})\n`;

        const streamLabel = summary.streamConnected ? "🟢 SSE" : "🔴 SSE";
        const age = summary.secondsSinceLastEvent;
        const ageText = typeof age === "number" ? `${age}s` : "n/d";
        const statusLabel = summary.sessionStatus ? summary.sessionStatus.toUpperCase() : "N/D";
        text += `\n📡 ${streamLabel} · ⏱️ último evento: ${ageText} · estado: <code>${escapeHtml(statusLabel)}</code>`;

        // Last tool / action
        if (summary.lastToolName) {
            text += `\n🔧 <b>Herramienta:</b> <code>${escapeHtml(summary.lastToolName)}</code>`;
            if (summary.lastBashCmd && summary.lastToolName === "bash") {
                text += `\n   <code>${escapeHtml(summary.lastBashCmd)}</code>`;
            }
        }

        // What it's thinking / saying
        if (summary.lastText) {
            const snippet = summary.lastText.length > 200
                ? summary.lastText.slice(0, 200) + "…"
                : summary.lastText;
            text += `\n\n💭 <i>${escapeHtml(snippet)}</i>`;
        }

        // Recently modified files
        if (summary.recentFiles.length > 0) {
            text += `\n\n📝 <b>Archivos modificados:</b>`;
            for (const f of summary.recentFiles) {
                // Show only the last 2 path segments to keep it short
                const parts = f.replace(/\\/g, "/").split("/");
                const short = parts.length > 2 ? "…/" + parts.slice(-2).join("/") : f;
                text += `\n  • <code>${escapeHtml(short)}</code>`;
            }
        }

        // Stats line
        const filesEdited = summary.filesModified;
        text += `\n\n📊 ${summary.messageCount} mensajes · ${filesEdited} edici${filesEdited !== 1 ? "ones" : "ón"}`;

        const existing = this.ctx.heartbeatMessages.get(agentId);
        if (existing) {
            try {
                await bot.api.editMessageText(existing.chatId, existing.msgId, text, { parse_mode: "HTML" });
            } catch (err: any) {
                // "message is not modified" (400) is benign — the text didn't change this tick.
                // Only clear the reference if the message truly no longer exists (deleted/too old).
                const desc: string = err?.description ?? "";
                const messageGone =
                    err?.error_code === 400 &&
                    (desc.includes("message to edit not found") ||
                     desc.includes("MESSAGE_ID_INVALID") ||
                     desc.includes("can't find"));
                if (messageGone) {
                    this.ctx.heartbeatMessages.delete(agentId);
                }
                // For "message is not modified" we keep the reference so the next
                // tick can still edit the same message when content changes.
            }
        } else {
            try {
                const { chatId, userId } = this.ctx.resolveAgentChat(agentId);
                const msg = await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
                if (msg) {
                    this.ctx.heartbeatMessages.set(agentId, { chatId, msgId: msg.message_id, userId });
                }
            } catch (err) {
                console.error("[MessageHandler] Failed to send heartbeat message:", err);
            }
        }
    }

    // ── Session error callback ────────────────────────────────────────────────

    async handleAgentSessionError(agentId: string, errorMessage: string): Promise<void> {
        const bot = this.ctx.bot;
        if (!bot) return;

        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) return;

        const hb = this.ctx.heartbeatMessages.get(agentId);
        if (hb) return; // already handled via sendPrompt resolution path

        try {
            const { chatId } = this.ctx.resolveAgentChat(agentId);
            await bot.api.sendMessage(
                chatId,
                `⚠️ <b>${escapeHtml(agent.name)}</b> — error del modelo:\n\n<code>${escapeHtml(errorMessage)}</code>`,
                { parse_mode: "HTML" }
            );
        } catch (err) {
            console.error("[MessageHandler] Failed to send session error notification:", err);
        }
    }

    // ── Heartbeat clear callback ──────────────────────────────────────────────

    async handleAgentHeartbeatClear(agentId: string): Promise<void> {
        const hb = this.ctx.heartbeatMessages.get(agentId);
        if (hb) {
            this.ctx.heartbeatMessages.delete(agentId);
        }
    }

    // ── File uploads ──────────────────────────────────────────────────────────

    async handleFileUpload(ctx: Context): Promise<void> {
        try {
            const message = ctx.message;
            if (!message) return;

            let fileId: string | undefined;
            let fileName: string | undefined;
            let isAudio = false;

            if (message.document) {
                fileId = message.document.file_id;
                fileName = message.document.file_name || `document_${Date.now()}`;
            } else if (message.photo?.length) {
                fileId = message.photo[message.photo.length - 1].file_id;
                fileName = `photo_${Date.now()}.jpg`;
            } else if (message.video) {
                fileId = message.video.file_id;
                fileName = message.video.file_name || `video_${Date.now()}.mp4`;
            } else if (message.audio) {
                fileId = message.audio.file_id;
                fileName = message.audio.file_name || `audio_${Date.now()}.mp3`;
                isAudio = true;
            } else if (message.voice) {
                fileId = message.voice.file_id;
                fileName = `voice_${Date.now()}.ogg`;
                isAudio = true;
            }

            if (!fileId || !fileName) { await ctx.reply("❌ Tipo de archivo no soportado."); return; }

            const file = await ctx.api.getFile(fileId);
            if (!file.file_path) { await ctx.reply("❌ No se pudo obtener el archivo."); return; }

            const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
            const response = await fetch(fileUrl);
            if (!response.ok) { await ctx.reply("❌ Error al descargar el archivo."); return; }

            const saveDir = "/tmp/telegramCoder";
            if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

            const savePath = nodePath.join(saveDir, fileName);
            const buffer = Buffer.from(await response.arrayBuffer());
            fs.writeFileSync(savePath, buffer);

            if (isAudio && this.ctx.transcriptionService.isConfigured()) {
                const userId = ctx.from?.id;
                if (!userId) return;

                const statusMsg = await ctx.reply("🎙️ Transcribiendo audio...");
                const result = await this.ctx.transcriptionService.transcribeAudio(savePath);

                if (!result.success) {
                    await ctx.api.editMessageText(
                        ctx.chat!.id, statusMsg.message_id,
                        `❌ Error de transcripción: ${escapeHtml(result.error || "desconocido")}`,
                        { parse_mode: "HTML" }
                    );
                    return;
                }

                await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

                const transcription = result.text?.trim();
                if (!transcription) {
                    await ctx.reply("ℹ️ El audio está vacío o no se pudo transcribir.");
                    return;
                }

                await ctx.reply(
                    `📝 <b>Transcripción:</b>\n\n${escapeHtml(transcription)}`,
                    { parse_mode: "HTML" }
                );

                const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId)
                    ?? this.ctx.agentDb.getLastUsed(userId)?.id;

                if (activeId) {
                    const agent = this.ctx.agentDb.getById(activeId);
                    if (agent) {
                        await this.ctx.sendPromptToAgent(ctx, agent, `[Audio transcrito]\n\n${transcription}`);
                        return;
                    }
                }

                await ctx.reply("ℹ️ Transcripción lista. Usa /agents para activar un agente.");
                return;
            }

            if (isAudio && !this.ctx.transcriptionService.isConfigured()) {
                await ctx.reply(
                    `⚠️ Audio recibido pero <code>GEMINI_API_KEY</code> no está configurado.\n` +
                    `Archivo guardado en: <code>${savePath}</code>`,
                    { parse_mode: "HTML" }
                );
                return;
            }

            const confirmMsg = await ctx.reply(
                `✅ <b>Archivo guardado</b>\n\n<code>${savePath}</code>`,
                { parse_mode: "HTML" }
            );

            await MessageUtils.scheduleMessageDeletion(ctx, confirmMsg.message_id, this.ctx.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("guardar archivo", error));
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async showRunPicker(ctx: Context, prompt: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;
        const allAgents = this.ctx.agentDb.getByUser(userId);
        const agents = allAgents.filter(a => a.status !== "stopped");
        const keyboard = new InlineKeyboard();
        for (const agent of agents) {
            keyboard.text(`🤖 ${agent.name}`, `run:agent:${agent.id}`).row();
        }
        keyboard.text("❌ Cancelar", "run:cancel");
        const preview = prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
        await ctx.reply(
            `💬 <b>¿A qué agente?</b>\n\n<i>${escapeHtml(preview)}</i>`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    private async executeRunPrompt(ctx: Context, agent: PersistentAgent, prompt: string): Promise<void> {
        const statusMsg = await ctx.reply(
            `🤖 <b>${escapeHtml(agent.name)}</b> [${escapeHtml(agent.model)}] procesando…`,
            { parse_mode: "HTML" }
        );
        await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});

        const chatId = ctx.chat!.id;
        const msgId = statusMsg.message_id;
        const header = `🤖 <b>${escapeHtml(agent.name)}</b>\n\n`;

        this.ctx.persistentAgentService.sendPrompt(agent, prompt).then(async (result) => {
            const body = result.output || "(sin salida)";
            const MAX = 3800;
            if (body.length <= MAX) {
                await ctx.api.editMessageText(
                    chatId, msgId,
                    `${header}${formatAsHtml(body)}`,
                    { parse_mode: "HTML" }
                ).catch(async () => {
                    await ctx.api.sendMessage(chatId, `${header}${formatAsHtml(body)}`, { parse_mode: "HTML" });
                });
            } else {
                await ctx.api.deleteMessage(chatId, msgId).catch(() => {});
                const buf = Buffer.from(body, "utf8");
                await ctx.api.sendDocument(
                    chatId,
                    new InputFile(buf, `${agent.name}-respuesta.md`),
                    { caption: `${header}(resultado adjunto)`, parse_mode: "HTML" }
                );
            }
        }).catch(async (err) => {
            await ctx.api.editMessageText(
                chatId, msgId,
                `❌ <b>${escapeHtml(agent.name)}</b> — error: ${escapeHtml(String(err))}`,
                { parse_mode: "HTML" }
            ).catch(() => {});
        });
    }
}
