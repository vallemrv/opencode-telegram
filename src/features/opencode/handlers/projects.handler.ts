/**
 * ProjectsHandler — handles /proyectos.
 *
 * Browser-style navigation of WORKSPACE_DIR. User can navigate into
 * subdirectories and start an OpenCode server at any level.
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
    const raw = process.env.WORKSPACE_DIR || process.cwd();
    if (raw.startsWith("~/") || raw === "~") return nodePath.join(os.homedir(), raw.slice(1));
    return raw;
}

export class ProjectsHandler {
    private readonly projectIndex = new Map<string, string>();
    private projectIndexCounter = 0;

    constructor(private readonly ctx: BotContext) {}

    private makeProjectKey(absPath: string): string {
        const key = `p${this.projectIndexCounter++}`;
        this.projectIndex.set(key, absPath);
        return key;
    }

    private isRootDir(absPath: string): boolean {
        return absPath === workspaceDir();
    }

    // ── /proyectos ────────────────────────────────────────────────────────────

    async handleProjects(ctx: Context): Promise<void> {
        await this.showDirectory(ctx, workspaceDir());
    }

    // ── Show directory contents ────────────────────────────────────────────────

    private async showDirectory(ctx: Context, absPath: string, editMsgId?: number): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(absPath, { withFileTypes: true });
        } catch (err) {
            const msg = `❌ No se pudo leer ${escapeHtml(absPath)}: ${escapeHtml(String(err))}`;
            if (editMsgId && ctx.chat) {
                await ctx.api.editMessageText(ctx.chat.id, editMsgId, msg, { parse_mode: "HTML" });
            } else {
                await ctx.reply(msg, { parse_mode: "HTML" });
            }
            return;
        }

        const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith("."))
            .map(e => e.name)
            .sort((a, b) => a.localeCompare(b));

        const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);
        const allAgents = this.ctx.agentDb.getAll();

        const keyboard = new InlineKeyboard();

        // Botón para abrir servidor en el directorio actual (si no es la raíz)
        if (!this.isRootDir(absPath)) {
            const existing = allAgents.find(a => a.workdir === absPath);
            let statusIcon = "🟢";
            if (existing) {
                if (existing.id === activeId) statusIcon = "✅";
                else if (existing.status === "running") statusIcon = "🟢";
                else statusIcon = "🔴";
            }
            const currentKey = this.makeProjectKey(absPath);
            keyboard.text(`⚡ Abrir servidor aquí ${statusIcon}`, `proj:start:${currentKey}`).row();
        }

        // Subcarpetas
        for (const name of dirs) {
            const subPath = nodePath.join(absPath, name);
            const existing = allAgents.find(a => a.workdir === subPath);
            let prefix = "📁";
            if (existing) {
                if (existing.id === activeId) prefix = "✅";
                else if (existing.status === "running") prefix = "🟢";
            }
            const key = this.makeProjectKey(subPath);
            keyboard.text(`${prefix} ${name}`, `proj:nav:${key}`).row();
        }

        // Botón atrás (si no estamos en la raíz)
        if (!this.isRootDir(absPath)) {
            const parentPath = nodePath.dirname(absPath);
            const parentKey = this.makeProjectKey(parentPath);
            keyboard.text("⬅️ Atrás", `proj:nav:${parentKey}`);
        }

        // Botón para crear nuevo proyecto
        if (this.isRootDir(absPath)) {
            keyboard.text("🆕 Nuevo proyecto (wizard)", "agent:new");
        }

        const maxAgents = this.ctx.configService.getMaxAgents();
        const running = this.ctx.agentDb.countRunningLocal();
        const relPath = this.isRootDir(absPath) ? "/" : nodePath.relative(workspaceDir(), absPath) || "/";

        const header =
            `📂 <b>${escapeHtml(relPath)}</b>\n` +
            `Servidores activos: ${running}/${maxAgents}\n\n` +
            (dirs.length === 0 && this.isRootDir(absPath)
                ? `No hay subdirectorios. Pulsa 🆕 para crear uno.`
                : dirs.length === 0
                ? `Esta carpeta está vacía. Puedes abrir un servidor aquí.`
                : `Toca una carpeta para navegar. ⚡ para abrir servidor.`);

        if (editMsgId && ctx.chat) {
            await ctx.api.editMessageText(ctx.chat.id, editMsgId, header, {
                parse_mode: "HTML",
                reply_markup: keyboard,
            });
        } else {
            await ctx.reply(header, { parse_mode: "HTML", reply_markup: keyboard });
        }
    }

    // ── proj:nav:<key> — navigate into directory ───────────────────────────────

    async handleProjectNav(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:nav:")) return;
        const key = data.slice("proj:nav:".length);
        const absPath = this.projectIndex.get(key);
        if (!absPath) {
            await ctx.reply("❌ Ruta caducada, ejecuta /proyectos de nuevo.");
            return;
        }
        if (!fs.existsSync(absPath)) {
            await ctx.reply(`❌ Ya no existe: <code>${escapeHtml(absPath)}</code>`, { parse_mode: "HTML" });
            return;
        }
        const msgId = ctx.callbackQuery?.message?.message_id;
        await this.showDirectory(ctx, absPath, msgId);
    }

    // ── proj:start:<key> — start server in directory ────────────────────────────

    async handleProjectStart(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:start:")) return;
        const key = data.slice("proj:start:".length);
        const absPath = this.projectIndex.get(key);
        if (!absPath) {
            await ctx.reply("❌ Ruta caducada, ejecuta /proyectos de nuevo.");
            return;
        }
        if (!fs.existsSync(absPath)) {
            await ctx.reply(`❌ Ya no existe: <code>${escapeHtml(absPath)}</code>`, { parse_mode: "HTML" });
            return;
        }

        const projectName = nodePath.basename(absPath) || "workspace";
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

        // Delete message and start server
        await ctx.deleteMessage().catch(() => {});
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

    // ── Legacy: proj:open (delegates to start) ───────────────────────────────────

    async handleProjectOpen(ctx: Context): Promise<void> {
        await this.handleProjectStart(ctx);
    }
}