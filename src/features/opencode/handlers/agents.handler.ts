/**
 * AgentsHandler — handles /agents, park/unpark/delete callbacks.
 */

import { Context, InlineKeyboard } from "grammy";
import type { BotContext } from "./bot-context.js";
import { resolveDir } from "../../../services/persistent-agent.service.js";
import { escapeHtml } from "../event-handlers/utils.js";

export class AgentsHandler {
    constructor(private readonly ctx: BotContext) {}

    async handleAgents(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agents = this.ctx.agentDb.getByUser(userId);
        const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);
        const keyboard = new InlineKeyboard();

        for (const agent of agents) {
            const isActive = agent.id === activeId;
            const displayName = this.getAgentDisplayName(agent.name);
            const label = isActive ? `✅ ${displayName}` : `🤖 ${displayName}`;
            keyboard
                .text(label, `agent:activate:${agent.id}`)
                .text("🗑️", `agent:del:${agent.id}`)
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

    async handleAgentActivate(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("agent:activate:")) return;
        const agentId = callbackData.replace("agent:activate:", "");
        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

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
        await this.handleAgents(ctx);
    }

    async handleAgentDelete(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("agent:del:")) return;
        const agentId = callbackData.replace("agent:del:", "");
        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

        const keyboard = new InlineKeyboard()
            .text("✅ Sí, borrar", `agent:delconfirm:${agentId}`)
            .text("❌ Cancelar", "agent:delcancel");

        await ctx.editMessageText(
            `🗑️ ¿Borrar agente <b>${escapeHtml(agent.name)}</b>?\n\nSe detendrá su servidor y se eliminará la configuración.`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    async handleAgentDeleteConfirm(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("agent:delconfirm:")) return;
        const agentId = callbackData.replace("agent:delconfirm:", "");
        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

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
            `🗑️ Agente <b>${escapeHtml(agent.name)}</b> eliminado.`,
            { parse_mode: "HTML" }
        );
    }

    async handleAgentDeleteCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage().catch(() => {});
        await this.handleAgents(ctx);
    }

    private getAgentDisplayName(name: string): string {
        const parts = name.split(/[\/\\]/);
        return parts.length > 1 ? parts[parts.length - 1] : name;
    }
}