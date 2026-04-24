/**
 * AgentsHandler — handles /agents, /web, park/unpark/delete callbacks,
 * and remote agent discovery + selection.
 */

import { Context, InlineKeyboard } from "grammy";
import type { BotContext } from "./bot-context.js";
import { resolveDir } from "../../../services/persistent-agent.service.js";
import { escapeHtml } from "../event-handlers/utils.js";

// ─── URL helpers (local to this module) ──────────────────────────────────────

function base64UrlEncode(value: string): string {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function normalizeHostForUrl(value?: string): string | undefined {
    if (!value) return undefined;
    let host = value.trim();
    if (!host) return undefined;
    host = host.replace(/^https?:\/\//i, "");
    host = host.split("/")[0] || "";
    if (host.includes("@")) host = host.split("@").pop() || "";
    if (host.startsWith("[")) {
        const end = host.indexOf("]");
        return end > 0 ? host.slice(0, end + 1) : undefined;
    }
    const [withoutPort] = host.split(":");
    return withoutPort?.trim() || undefined;
}

// ─── Handler class ────────────────────────────────────────────────────────────

export class AgentsHandler {
    constructor(private readonly ctx: BotContext) {}

    // ── /agents [ip] ─────────────────────────────────────────────────────────

    async handleAgentsWithIp(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
        const ipArg = args[0]?.trim();

        if (!ipArg) {
            this.ctx.disconnectRemoteAgent(userId);
        }

        if (ipArg) {
            await this.handleRemoteAgents(ctx, ipArg);
        } else {
            await this.handleAgents(ctx);
        }
    }

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

    // ── agent:activate:ID ─────────────────────────────────────────────────────

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

    // ── agent:del:ID ──────────────────────────────────────────────────────────

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

    // ── agent:delconfirm:ID ───────────────────────────────────────────────────

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

        // Delete all OpenCode sessions before stopping
        // Only delete sessions belonging to this agent's workdir
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

    // ── agent:delcancel ───────────────────────────────────────────────────────

    async handleAgentDeleteCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage().catch(() => {});
        await this.handleAgents(ctx);
    }

    // ── /web <host> ───────────────────────────────────────────────────────────

    async handleWeb(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
        const hostArg = args[0]?.trim();

        if (!hostArg) {
            await ctx.reply(
                `ℹ️ Para abrir OpenCode Web debes indicar la IP/host del nodo.\n\n` +
                `Usa: <code>/web &lt;ip&gt;</code>\n` +
                `Ejemplo: <code>/web 10.0.0.8</code>`,
                { parse_mode: "HTML" }
            );
            return;
        }

        await this.handleRemoteWeb(ctx, hostArg);
    }

    // ── remote:select:KEY ─────────────────────────────────────────────────────

    async handleRemoteAgentSelect(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("remote:select:")) return;
        const key = callbackData.replace("remote:select:", "");
        const info = this.ctx.remoteAgentIndex.get(key);
        if (!info) {
            await ctx.editMessageText("❌ Datos del agente remoto no encontrados. Vuelve a hacer /agents <ip>.");
            return;
        }

        const { host, port, project, workdir, sessionId, model } = info;
        const defaultModel = model || process.env.OPENCODE_DEFAULT_MODEL || "github-copilot/claude-sonnet-4.6";
        const agentId = `remote-${host}-${port}`;
        const agent: any = {
            id: agentId,
            userId,
            name: `${project} (${host})`,
            workdir: workdir || `/remote/${host}/${project}`,
            model: defaultModel,
            port,
            sessionId,
            status: "running",
            host,
            isRemote: true,
        };

        this.ctx.remoteAgentsInMemory.set(userId, { id: agentId, host, port, model: defaultModel });
        const startResult = await this.ctx.persistentAgentService.startAgent(agent);

        if (!startResult.success) {
            this.ctx.remoteAgentsInMemory.delete(userId);
            await ctx.editMessageText(
                `❌ Error al conectar con ${host}:${port}\n<i>${escapeHtml(startResult.message)}</i>`,
                { parse_mode: "HTML" }
            );
            return;
        }

        this.ctx.persistentAgentService.setActiveAgent(userId, agentId);
        await ctx.editMessageText(
            `✅ <b>${escapeHtml(agent.name)}</b> activo\n\n📡 ${host}:${port}\n\n<i>Envía tu mensaje ahora.</i>`,
            { parse_mode: "HTML" }
        );
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private getAgentDisplayName(name: string): string {
        const parts = name.split(/[\/\\]/);
        return parts.length > 1 ? parts[parts.length - 1] : name;
    }

    private isValidHost(host: string): boolean {
        const trimmed = host.trim();
        if (!trimmed || trimmed.length > 253) return false;
        const hostRegex = /^(\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;
        if (!hostRegex.test(trimmed)) return false;
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
            const octets = trimmed.split(".").map(Number);
            return octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255);
        }
        return true;
    }

    private async handleRemoteAgents(ctx: Context, host: string): Promise<void> {
        try {
            if (!this.isValidHost(host)) {
                await ctx.reply(`❌ Formato de IP/host inválido: ${host}`);
                return;
            }

            const discoveryPort = parseInt(process.env.DISCOVERY_PORT || "17000", 10);
            const url = `http://${host}:${discoveryPort}/discovery`;

            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) {
                await ctx.reply(`❌ No se pudo conectar al nodo remoto: ${host}:${discoveryPort} (HTTP ${response.status})`);
                return;
            }

            const data = await response.json() as any;
            const agents = data.agents || [];

            if (agents.length === 0) {
                await ctx.reply(`📭 Nodo ${host} no tiene agentes disponibles.`);
                return;
            }

            const keyboard = new InlineKeyboard();
            for (const agent of agents) {
                const projectName = agent.project || "unknown";
                const statusEmoji = agent.status === "running" ? "🟢" : "🔴";

                const shortKey = String(this.ctx.remoteAgentIndexCounter++);
                this.ctx.remoteAgentIndex.set(shortKey, {
                    host,
                    port: agent.port,
                    project: projectName,
                    workdir: agent.workdir,
                    sessionId: agent.sessionId,
                    model: agent.model,
                });

                keyboard
                    .text(`${statusEmoji} ${projectName}`, `remote:select:${shortKey}`)
                    .row();
            }

            await ctx.reply(
                `📍 Agentes remotos en ${host}:\n\n` +
                `${agents.length} agente${agents.length !== 1 ? "s" : ""} encontrado${agents.length !== 1 ? "s" : ""}.\n` +
                `Toca el nombre para activarlo como agente sticky.`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
        } catch (error: any) {
            await ctx.reply(`❌ Error al descubrir agentes en ${host}: ${error.message || error}`);
        }
    }

    private async handleRemoteWeb(ctx: Context, host: string): Promise<void> {
        if (!this.isValidHost(host)) {
            await ctx.reply(`❌ Host inválido: ${host}`);
            return;
        }

        const discoveryPort = parseInt(process.env.DISCOVERY_PORT || "17000", 10);
        const discoveryUrl = `http://${host}:${discoveryPort}/discovery`;

        try {
            const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) {
                await ctx.reply(`❌ No se pudo consultar ${host}:${discoveryPort} (HTTP ${response.status}).`);
                return;
            }

            const data = await response.json() as any;
            const agents = (data.agents || []) as Array<{ port: number; project: string; workdir: string; status?: string }>;
            const activeAgents = agents.filter(a => !a.status || a.status === "running");

            if (activeAgents.length === 0) {
                await ctx.reply(`📭 ${host} no reporta proyectos por discovery.`);
                return;
            }

            const keyboard = new InlineKeyboard();
            const lines: string[] = [];

            for (const agent of activeAgents) {
                const status = agent.status === "running" ? "🟢" : "⏸️";
                const projectName = agent.project || `puerto-${agent.port}`;
                const serverUrl = `http://${host}:${agent.port}`;

                keyboard.url(`${status} ${projectName}`, serverUrl).row();
                lines.push(`• <b>${escapeHtml(projectName)}</b> — <code>${host}:${agent.port}</code>`);
            }

            await ctx.reply(
                `🌐 <b>OpenCode Web (remoto)</b>\n\nHost: <code>${escapeHtml(host)}</code>\n\n${lines.join("\n")}\n\nPulsa el botón del proyecto para abrir su server web (<code>${escapeHtml(host)}:puerto</code>).`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
        } catch (error: any) {
            await ctx.reply(`❌ Error consultando ${host}: ${error?.message || error}`);
        }
    }
}
