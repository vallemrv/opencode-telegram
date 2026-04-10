/**
 * SessionHandler — handles /session, /delete, /deleteall, /rename, /undo, /redo.
 */

import { Context, InlineKeyboard } from "grammy";
import type { PersistentAgent } from "../../../services/agent-db.service.js";
import { resolveDir } from "../../../services/persistent-agent.service.js";
import { ErrorUtils } from "../../../utils/error.utils.js";
import { escapeHtml } from "../event-handlers/utils.js";
import type { BotContext } from "./bot-context.js";

function getAgentBaseUrl(agent: { host?: string; port: number }): string {
    return `http://${agent.host || "localhost"}:${agent.port}`;
}

/** Filter a list of OpenCode sessions to only those matching the agent's workdir. */
function filterSessionsByWorkdir(sessions: any[], workdir: string): any[] {
    const resolved = resolveDir(workdir);
    return sessions.filter((s: any) => !s.directory || s.directory === resolved);
}

export class SessionHandler {
    constructor(private readonly ctx: BotContext) {}

    // ── /session ──────────────────────────────────────────────────────────────

    async handleSession(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.ctx.getActiveOrLastAgent(userId);
        if (!agent) {
            await ctx.reply("ℹ️ No hay agente activo. Activa uno con /agents.");
            return;
        }

        try {
            await this.sendSessionList(ctx, agent, false);
        } catch (err) {
            await ctx.reply(ErrorUtils.createErrorMessage("listar sesiones", err));
        }
    }

    // ── sa:PREFIX:INDEX — activate session ────────────────────────────────────

    async handleSessionActivate(ctx: Context): Promise<void> {
        const key = ctx.callbackQuery?.data;
        if (!key) { await ctx.answerCallbackQuery(); await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const entry = this.ctx.sessIndex.get(key);
        if (!entry) { await ctx.answerCallbackQuery(); await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const { agentId, sessionId: sessId } = entry;

        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.answerCallbackQuery(); await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {}); return; }

        const current = this.ctx.persistentAgentService.getSessionId(agentId);
        if (current === sessId) {
            await ctx.answerCallbackQuery({ text: "Ya es la sesión activa." });
            return;
        }

        this.ctx.persistentAgentService.setSessionId(agentId, sessId);
        await ctx.answerCallbackQuery({ text: "✅ Sesión activada." });

        try {
            await this.sendSessionList(ctx, agent, true);
        } catch (err) {
            await ctx.editMessageText(ErrorUtils.createErrorMessage("activar sesión", err)).catch(() => {});
        }
    }

    // ── sn:PREFIX — new session ───────────────────────────────────────────────

    async handleSessionNew(ctx: Context): Promise<void> {
        const key = ctx.callbackQuery?.data;
        if (!key) { await ctx.answerCallbackQuery(); await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const entry = this.ctx.sessIndex.get(key);
        if (!entry) { await ctx.answerCallbackQuery(); await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const { agentId } = entry;

        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.answerCallbackQuery(); await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {}); return; }

        try {
            const newSessId = await this.ctx.persistentAgentService.createNewSession(agent);
            this.ctx.persistentAgentService.setSessionId(agentId, newSessId);
            await ctx.answerCallbackQuery({ text: "✅ Nueva sesión creada." });
            await this.sendSessionList(ctx, agent, true);
        } catch (err) {
            await ctx.answerCallbackQuery({ text: "❌ Error al crear sesión." }).catch(() => {});
            await ctx.editMessageText(ErrorUtils.createErrorMessage("crear sesión", err)).catch(() => {});
        }
    }

    // ── sx:PREFIX:INDEX — delete single session ───────────────────────────────

    async handleSessionDelete(ctx: Context): Promise<void> {
        const key = ctx.callbackQuery?.data;
        if (!key) { await ctx.answerCallbackQuery(); await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const entry = this.ctx.sessIndex.get(key);
        if (!entry) { await ctx.answerCallbackQuery(); await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const { agentId, sessionId: sessId } = entry;

        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.answerCallbackQuery(); await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {}); return; }

        const baseUrl = getAgentBaseUrl(agent);
        try {
            await fetch(`${baseUrl}/session/${sessId}`, {
                method: "DELETE",
                signal: AbortSignal.timeout(8000),
            });

            const current = this.ctx.persistentAgentService.getSessionId(agentId);
            if (current === sessId) {
                this.ctx.persistentAgentService.setSessionId(agentId, "");
            }

            await ctx.answerCallbackQuery({ text: "🗑️ Sesión eliminada." });
            await this.sendSessionList(ctx, agent, true);
        } catch (err) {
            await ctx.answerCallbackQuery({ text: "❌ Error al eliminar." }).catch(() => {});
            await ctx.editMessageText(ErrorUtils.createErrorMessage("eliminar sesión", err)).catch(() => {});
        }
    }

    // ── sd:PREFIX — delete all sessions ──────────────────────────────────────

    async handleSessionDeleteAll(ctx: Context): Promise<void> {
        const key = ctx.callbackQuery?.data;
        if (!key) { await ctx.answerCallbackQuery(); await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const entry = this.ctx.sessIndex.get(key);
        if (!entry) { await ctx.answerCallbackQuery(); await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const { agentId } = entry;

        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.answerCallbackQuery(); await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {}); return; }

        const baseUrl = getAgentBaseUrl(agent);
        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (sessRes.ok) {
                const allSessions: any[] = await sessRes.json();
                const sessions = filterSessionsByWorkdir(allSessions, agent.workdir);
                await Promise.all(sessions.map(s =>
                    fetch(`${baseUrl}/session/${s.id}`, { method: "DELETE", signal: AbortSignal.timeout(8000) }).catch(() => {})
                ));
            }

            this.ctx.persistentAgentService.setSessionId(agentId, "");
            this.ctx.agentDb.setSessionId(agentId, "");

            await ctx.answerCallbackQuery({ text: "🗑️ Todas las sesiones eliminadas." });
            await this.sendSessionList(ctx, agent, true);
        } catch (err) {
            await ctx.answerCallbackQuery({ text: "❌ Error al eliminar." }).catch(() => {});
            await ctx.editMessageText(ErrorUtils.createErrorMessage("eliminar sesiones", err)).catch(() => {});
        }
    }

    // ── /delete ───────────────────────────────────────────────────────────────

    async handleDelete(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.ctx.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo. Activa uno con /agents."); return; }

        const sessionId = this.ctx.persistentAgentService.getSessionId(agent.id);
        if (!sessionId) { await ctx.reply("ℹ️ No hay sesión activa que borrar."); return; }

        const baseUrl = getAgentBaseUrl(agent);
        try {
            await fetch(`${baseUrl}/session/${sessionId}`, {
                method: "DELETE",
                signal: AbortSignal.timeout(8000),
            });

            const newSessId = await this.ctx.persistentAgentService.createNewSession(agent);
            this.ctx.persistentAgentService.setSessionId(agent.id, newSessId);

            await ctx.reply(`🗑️ Sesión eliminada.\n✅ Nueva sesión creada — lista para recibir mensajes.`);
        } catch (err) {
            await ctx.reply(ErrorUtils.createErrorMessage("eliminar sesión", err));
        }
    }

    // ── /deleteall ────────────────────────────────────────────────────────────

    async handleDeleteAll(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.ctx.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo. Activa uno con /agents."); return; }

        const baseUrl = getAgentBaseUrl(agent);
        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (sessRes.ok) {
                const allSessions: any[] = await sessRes.json();
                const sessions = filterSessionsByWorkdir(allSessions, agent.workdir);
                await Promise.all(sessions.map(s =>
                    fetch(`${baseUrl}/session/${s.id}`, { method: "DELETE", signal: AbortSignal.timeout(8000) }).catch(() => {})
                ));
            }

            this.ctx.persistentAgentService.setSessionId(agent.id, "");
            const newSessId = await this.ctx.persistentAgentService.createNewSession(agent);
            this.ctx.persistentAgentService.setSessionId(agent.id, newSessId);

            await ctx.reply(`🗑️ Todas las sesiones eliminadas.\n✅ Nueva sesión creada — lista para recibir mensajes.`);
        } catch (err) {
            await ctx.reply(ErrorUtils.createErrorMessage("eliminar sesiones", err));
        }
    }

    // ── /rename ───────────────────────────────────────────────────────────────

    async handleRename(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.ctx.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo. Activa uno con /agents."); return; }

        const sessionId = this.ctx.persistentAgentService.getSessionId(agent.id);
        if (!sessionId) { await ctx.reply("ℹ️ No hay sesión activa para renombrar."); return; }

        const inlineName = ctx.message?.text?.replace(/^\/rename\s*/i, "").trim() || "";
        if (inlineName) {
            await this.renameSession(ctx, agent, sessionId, inlineName);
        } else {
            this.ctx.renameWizard.set(userId, agent.id);
            await ctx.reply(
                `✏️ Escribe el nuevo nombre para la sesión actual de <b>${escapeHtml(agent.name)}</b>:\n<i>/esc para cancelar</i>`,
                { parse_mode: "HTML" }
            );
        }
    }

    async handleRenameWizardText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;
        const agentId = this.ctx.renameWizard.get(userId);
        if (!agentId) return;
        this.ctx.renameWizard.delete(userId);

        const newName = ctx.message?.text?.trim() || "";
        if (!newName) { await ctx.reply("❌ Nombre vacío, operación cancelada."); return; }

        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.reply("❌ Agente no encontrado."); return; }

        const sessionId = this.ctx.persistentAgentService.getSessionId(agentId);
        if (!sessionId) { await ctx.reply("ℹ️ No hay sesión activa para renombrar."); return; }

        await this.renameSession(ctx, agent, sessionId, newName);
    }

    // ── /undo ─────────────────────────────────────────────────────────────────

    async handleUndo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.ctx.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo."); return; }

        const baseUrl = getAgentBaseUrl(agent);
        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (!sessRes.ok) { await ctx.reply("❌ No se pudo conectar al servidor del agente."); return; }
            const allSessions: any[] = await sessRes.json();
            const sessions = filterSessionsByWorkdir(allSessions, agent.workdir);
            if (sessions.length === 0) { await ctx.reply("ℹ️ No hay sesiones."); return; }
            const session = sessions.sort((a, b) => b.time.updated - a.time.updated)[0];

            const res = await fetch(`${baseUrl}/session/${session.id}/revert`, {
                method: "POST", signal: AbortSignal.timeout(10000)
            });
            if (res.ok) {
                await ctx.reply(`↩️ <b>Revertido</b>`, { parse_mode: "HTML" });
            } else {
                await ctx.reply("⚠️ No se pudo revertir.");
            }
        } catch (err) {
            await ctx.reply(ErrorUtils.createErrorMessage("undo", err));
        }
    }

    // ── /redo ─────────────────────────────────────────────────────────────────

    async handleRedo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.ctx.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo."); return; }

        const baseUrl = getAgentBaseUrl(agent);
        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (!sessRes.ok) { await ctx.reply("❌ No se pudo conectar al servidor del agente."); return; }
            const allSessions: any[] = await sessRes.json();
            const sessions = filterSessionsByWorkdir(allSessions, agent.workdir);
            if (sessions.length === 0) { await ctx.reply("ℹ️ No hay sesiones."); return; }
            const session = sessions.sort((a, b) => b.time.updated - a.time.updated)[0];

            const res = await fetch(`${baseUrl}/session/${session.id}/unrevert`, {
                method: "POST", signal: AbortSignal.timeout(10000)
            });
            if (res.ok) {
                await ctx.reply(`↪️ <b>Restaurado</b>`, { parse_mode: "HTML" });
            } else {
                await ctx.reply("⚠️ No se pudo restaurar.");
            }
        } catch (err) {
            await ctx.reply(ErrorUtils.createErrorMessage("redo", err));
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    async sendSessionList(ctx: Context, agent: PersistentAgent, edit = false): Promise<void> {
        const baseUrl = getAgentBaseUrl(agent);
        const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
        if (!sessRes.ok) {
            const txt = `❌ No se pudo conectar al servidor del agente <b>${escapeHtml(agent.name)}</b>.`;
            if (edit) await ctx.editMessageText(txt, { parse_mode: "HTML" }).catch(() => ctx.reply(txt, { parse_mode: "HTML" }));
            else await ctx.reply(txt, { parse_mode: "HTML" });
            return;
        }

        const allSessions: any[] = await sessRes.json();
        const sessions = filterSessionsByWorkdir(allSessions, agent.workdir);
        const currentSessionId = this.ctx.persistentAgentService.getSessionId(agent.id);

        sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));

        const prefix = `s${this.ctx.sessIndexCounter++}`;
        const newKey = `sn:${prefix}`;
        const daKey  = `sd:${prefix}`;
        this.ctx.sessIndex.set(newKey, { agentId: agent.id, sessionId: "" });
        this.ctx.sessIndex.set(daKey,  { agentId: agent.id, sessionId: "" });

        const keyboard = new InlineKeyboard();

        if (sessions.length === 0) {
            keyboard.text("➕ Nueva sesión", newKey);
        } else {
            for (let i = 0; i < sessions.length; i++) {
                const s = sessions[i];
                const actKey = `sa:${prefix}:${i}`;
                const delKey = `sx:${prefix}:${i}`;
                this.ctx.sessIndex.set(actKey, { agentId: agent.id, sessionId: s.id });
                this.ctx.sessIndex.set(delKey, { agentId: agent.id, sessionId: s.id });

                const isCurrent = s.id === currentSessionId;
                const title = (s.title || s.id.slice(0, 8)).slice(0, 28);
                const label = isCurrent ? `🟢 ${title}` : title;
                keyboard.text(label, actKey).text("🗑️", delKey).row();
            }
            keyboard
                .text("➕ Nueva sesión",  newKey).row()
                .text("🗑️ Borrar todas", daKey);
        }

        const header =
            `📋 <b>Sesiones de ${escapeHtml(agent.name)}</b> (${sessions.length})\n` +
            `🟢 = sesión activa del bot — toca el nombre para cambiar`;

        if (edit) {
            await ctx.editMessageText(header, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
        } else {
            await ctx.reply(header, { parse_mode: "HTML", reply_markup: keyboard });
        }
    }

    private async renameSession(ctx: Context, agent: PersistentAgent, sessionId: string, newName: string): Promise<void> {
        const baseUrl = getAgentBaseUrl(agent);
        try {
            const res = await fetch(`${baseUrl}/session/${sessionId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: newName }),
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) {
                await ctx.reply(`❌ Error al renombrar: HTTP ${res.status}`);
                return;
            }
            await ctx.reply(`✅ Sesión renombrada a <b>${escapeHtml(newName)}</b>`, { parse_mode: "HTML" });
        } catch (err) {
            await ctx.reply(ErrorUtils.createErrorMessage("renombrar sesión", err));
        }
    }
}
