/**
 * ServersHandler — handles /servers, park/unpark/delete callbacks.
 */

import { Context, InlineKeyboard } from "grammy";
import type { BotContext } from "./bot-context.js";
import { resolveDir } from "../../../services/persistent-agent.service.js";
import { escapeHtml } from "../event-handlers/utils.js";

export class ServersHandler {
    constructor(private readonly ctx: BotContext) {}

    async handleServers(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        let agents = this.ctx.agentDb.getByUser(userId);

        // Fallback: if getByUser returned nothing but there is an active agent in
        // memory (restored after restart), show all agents so the user is not left
        // with an empty list.  This can happen when user_id type coercion differs
        // between the SQLite driver and the Telegram userId at query time.
        if (agents.length === 0) {
            const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);
            if (activeId) {
                agents = this.ctx.agentDb.getAll().filter(a => Number(a.userId) === Number(userId));
            }
        }

        const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);
        const keyboard = new InlineKeyboard();

        for (const agent of agents) {
            const isActive = agent.id === activeId;
            const displayName = this.getAgentDisplayName(agent.name);
            const label = isActive ? `✅ ${displayName}` : `🤖 ${displayName}`;
            keyboard
                .text(label, `server:activate:${agent.id}`)
                .text("🗑️", `server:del:${agent.id}`)
                .row();
        }

        const activeAgent = agents.find(a => a.id === activeId);
        const activeInfo = activeId
            ? `\n\n🟢 <b>${escapeHtml(this.getAgentDisplayName(activeAgent?.name ?? ""))}</b> activo — tus mensajes van a él.\n/esc para volver a ninguno.`
            : agents.length === 0
                ? `\n\n⚪ Aún no hay servidores OpenCode activos.`
                : `\n\n⚪ Ningún servidor activo.`;

        const maxAgents = this.ctx.configService.getMaxAgents();
        const header = agents.length === 0
            ? `🤖 <b>Servidores OpenCode</b>\n\nNo hay ninguno arrancado.\nUsa /proyectos para abrir un proyecto.`
            : `🤖 <b>Servidores OpenCode (${agents.length}/${maxAgents})</b>\n\n` +
              `Toca el nombre para activar (sticky), 🗑️ para parar y borrar (irreversible).`;

        await ctx.reply(
            header + activeInfo,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    async handleServerActivate(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) { await ctx.answerCallbackQuery(); return; }

        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("server:activate:")) { await ctx.answerCallbackQuery(); return; }
        const agentId = callbackData.replace("server:activate:", "");
        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) {
            await ctx.answerCallbackQuery({ text: "❌ Servidor no encontrado." });
            await ctx.editMessageText("❌ Servidor no encontrado.");
            return;
        }

        const currentActive = this.ctx.persistentAgentService.getActiveAgentId(userId);
        if (currentActive === agentId) {
            this.ctx.persistentAgentService.clearActiveAgent(userId);
            await ctx.answerCallbackQuery({ text: `⚪ ${agent.name} desactivado.` });
        } else {
            this.ctx.persistentAgentService.setActiveAgent(userId, agentId);
            this.ctx.agentDb.setLastUsed(userId, agentId);
            this.ctx.persistentAgentService.touchLastUsed(agentId);
            await ctx.answerCallbackQuery({ text: `✅ ${agent.name} activado.` });
        }

        await ctx.deleteMessage().catch(() => {});
        await this.handleServers(ctx);
    }

    async handleServerDelete(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("server:del:")) return;
        const agentId = callbackData.replace("server:del:", "");
        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Servidor no encontrado."); return; }

        const keyboard = new InlineKeyboard()
            .text("✅ Sí, borrar", `server:delconfirm:${agentId}`)
            .text("❌ Cancelar", "server:delcancel");

        await ctx.editMessageText(
            `🗑️ ¿Borrar servidor <b>${escapeHtml(agent.name)}</b>?\n\nSe detendrá su servidor y se eliminará la configuración.`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    async handleServerDeleteConfirm(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("server:delconfirm:")) return;
        const agentId = callbackData.replace("server:delconfirm:", "");
        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Servidor no encontrado."); return; }

        const host = agent.host || "localhost";
        const baseUrl = `http://${host}:${agent.port}`;

        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (sessRes.ok) {
                const allSessions: any[] = await sessRes.json();
                const agentDir = resolveDir(agent.workdir);
                const sessions = allSessions.filter((s: any) => !s.directory || s.directory === agentDir);
                await Promise.all(sessions.map(s =>
                    fetch(`${baseUrl}/session/${s.id}`, {
                        method: "DELETE",
                        signal: AbortSignal.timeout(8000),
                    }).catch(() => {})
                ));
            }
        } catch { /* best-effort */ }

        this.ctx.persistentAgentService.stopAgent(agentId);
        this.ctx.agentDb.delete(agentId);

        if (this.ctx.persistentAgentService.getActiveAgentId(userId) === agentId) {
            this.ctx.persistentAgentService.clearActiveAgent(userId);
        }

        const lastUsed = this.ctx.agentDb.getLastUsed(userId);
        if (lastUsed?.id === agentId) {
            this.ctx.agentDb.clearLastUsed(userId);
        }

        await ctx.editMessageText(
            `🗑️ Servidor <b>${escapeHtml(agent.name)}</b> eliminado.`,
            { parse_mode: "HTML" }
        );
    }

    async handleServerDeleteCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage().catch(() => {});
        await this.handleServers(ctx);
    }

    private getAgentDisplayName(name: string): string {
        const parts = name.split(/[\/\\]/);
        return parts.length > 1 ? parts[parts.length - 1] : name;
    }
}