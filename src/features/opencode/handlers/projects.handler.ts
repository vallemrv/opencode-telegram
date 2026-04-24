/**
 * ProjectsHandler — handles /proyectos.
 *
 * Lists subdirectories of WORKSPACE_DIR. Tapping a project either activates
 * its existing OpenCode server (if running) or starts a new one (evicting
 * the LRU server when the 3-server limit is reached).
 */

import { Context, InlineKeyboard } from "grammy";
import * as fs from "fs";
import * as nodePath from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import type { PersistentAgent } from "../../../services/agent-db.service.js";
import { pickPort } from "../../../services/persistent-agent.service.js";
import { escapeHtml } from "../event-handlers/utils.js";
import type { BotContext } from "./bot-context.js";

function resolveHome(p: string): string {
    if (p.startsWith("~/") || p === "~") return nodePath.join(os.homedir(), p.slice(1));
    return p;
}

function workspaceDir(): string {
    const raw = process.env.WORKSPACE_DIR || "~/proyectos";
    const resolved = resolveHome(raw);
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    return resolved;
}

export class ProjectsHandler {
    /** Maps short callback index → absolute path */
    private readonly projectIndex = new Map<string, string>();
    private projectIndexCounter = 0;

    constructor(private readonly ctx: BotContext) {}

    private makeProjectKey(absPath: string): string {
        const key = `p${this.projectIndexCounter++}`;
        this.projectIndex.set(key, absPath);
        return key;
    }

    // ── /proyectos ────────────────────────────────────────────────────────────

    async handleProjects(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const root = workspaceDir();
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch (err) {
            await ctx.reply(`❌ No se pudo leer ${escapeHtml(root)}: ${escapeHtml(String(err))}`, { parse_mode: "HTML" });
            return;
        }

        const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith("."))
            .map(e => e.name)
            .sort((a, b) => a.localeCompare(b));

        const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);
        const allAgents = this.ctx.agentDb.getAll();

        const keyboard = new InlineKeyboard();
        for (const name of dirs) {
            const absPath = nodePath.join(root, name);
            const existing = allAgents.find(a => a.workdir === absPath);
            let prefix = "📁";
            if (existing) {
                if (existing.id === activeId) prefix = "✅";
                else if (existing.status === "running") prefix = "🟢";
            }
            const key = this.makeProjectKey(absPath);
            keyboard.text(`${prefix} ${name}`, `proj:open:${key}`).row();
        }
        keyboard.text("🆕 Nuevo proyecto (wizard)", "agent:new");

        const maxAgents = this.ctx.configService.getMaxAgents();
        const running = this.ctx.agentDb.countRunningLocal();
        const header =
            `📂 <b>Proyectos en</b> <code>${escapeHtml(root)}</code>\n` +
            `Servidores activos: ${running}/${maxAgents}\n\n` +
            (dirs.length === 0
                ? `No hay subdirectorios. Pulsa 🆕 para crear uno con el wizard.`
                : `Toca un proyecto para abrirlo. Si hay ${maxAgents} servidores corriendo, se parará el menos usado (LRU).`);

        await ctx.reply(header, { parse_mode: "HTML", reply_markup: keyboard });
    }

    // ── proj:open:<key> ───────────────────────────────────────────────────────

    async handleProjectOpen(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:open:")) return;
        const key = data.slice("proj:open:".length);
        const absPath = this.projectIndex.get(key);
        if (!absPath) {
            await ctx.reply("❌ Proyecto caducado, ejecuta /proyectos de nuevo.");
            return;
        }
        if (!fs.existsSync(absPath)) {
            await ctx.reply(`❌ Ya no existe: <code>${escapeHtml(absPath)}</code>`, { parse_mode: "HTML" });
            return;
        }

        const projectName = nodePath.basename(absPath);
        const existing = this.ctx.agentDb.findByWorkdir(absPath);

        // Existing running agent → activate
        if (existing && existing.status === "running") {
            this.ctx.persistentAgentService.setActiveAgent(userId, existing.id);
            this.ctx.agentDb.setLastUsed(userId, existing.id);
            this.ctx.persistentAgentService.touchLastUsed(existing.id);
            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(
                `✅ <b>${escapeHtml(projectName)}</b> activado.\n` +
                `Tus mensajes van a este servidor. /esc para desactivar.`,
                { parse_mode: "HTML" }
            );
            return;
        }

        // Otherwise we need to start one. Ensure slot first.
        const status = await ctx.reply(`⏳ Abriendo <b>${escapeHtml(projectName)}</b>...`, { parse_mode: "HTML" });
        const editStatus = (text: string) =>
            ctx.api.editMessageText(status.chat.id, status.message_id, text, { parse_mode: "HTML" }).catch(() => {});

        // If existing-but-stopped record, drop it so we get a fresh one
        if (existing) {
            await this.ctx.persistentAgentService.evictAgent(existing).catch(() => {});
        }

        const maxAgents = this.ctx.configService.getMaxAgents();
        const evicted = await this.ctx.persistentAgentService.ensureSlotAvailable(maxAgents);
        if (evicted) {
            await editStatus(`♻️ Liberando slot: parado <b>${escapeHtml(evicted.name)}</b> (LRU).`);
        }

        const port = pickPort(this.ctx.agentDb.usedPorts());
        const defaultModel = process.env.OPENCODE_DEFAULT_MODEL || "github-copilot/claude-sonnet-4.6";
        const agent: PersistentAgent = {
            id: randomUUID(),
            userId,
            name: projectName,
            role: "",
            workdir: absPath,
            model: defaultModel,
            port,
            status: "running",
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
        };
        this.ctx.agentDb.save(agent);

        await editStatus(`⏳ Arrancando servidor en puerto <code>${port}</code>...`);
        const result = await this.ctx.persistentAgentService.startAgent(agent);
        if (!result.success) {
            this.ctx.agentDb.delete(agent.id);
            await editStatus(`❌ No se pudo arrancar: ${escapeHtml(result.message)}`);
            return;
        }

        this.ctx.persistentAgentService.setActiveAgent(userId, agent.id);
        this.ctx.agentDb.setLastUsed(userId, agent.id);

        await editStatus(
            `✅ <b>${escapeHtml(projectName)}</b> listo.\n` +
            `Modelo: <code>${escapeHtml(defaultModel)}</code>\n` +
            `Puerto: <code>${port}</code>\n\n` +
            `Tus mensajes van a este servidor. /esc para desactivar.`
        );
    }
}
