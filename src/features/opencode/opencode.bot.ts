/**
 * OpenCodeBot — Simplified unified design
 *
 * Comandos:
 *   /new       — Wizard: crea agente (Gitea / GitHub / local) + arranca servidor
 *   /agents    — Lista agentes, activa sticky, borra
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
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { ConfigService } from "../../services/config.service.js";
import { AgentDbService } from "../../services/agent-db.service.js";
import type { PersistentAgent } from "../../services/agent-db.service.js";
import { PersistentAgentService, pickPort, resolveDir, findOpencodeCmd } from "../../services/persistent-agent.service.js";
import type { AgentSendResult, HeartbeatSummary } from "../../services/persistent-agent.service.js";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { AccessControlMiddleware } from "../../middleware/access-control.middleware.js";
import { MessageUtils } from "../../utils/message.utils.js";
import { ErrorUtils } from "../../utils/error.utils.js";
import { formatAsHtml, escapeHtml } from "./event-handlers/utils.js";
import * as fs from "fs";
import * as nodePath from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { TranscriptionService } from "../../services/transcription.service.js";

// ─── Wizard state ─────────────────────────────────────────────────────────────

type WizardStep = "name" | "git" | "confirm";

interface NewAgentWizard {
    step: WizardStep;
    name?: string;
    workdir?: string;    // resolved absolute path
    gitSource?: "gitea" | "github" | "none";
    repoName?: string;
    model: string;       // always the default — user changes it with /models later
}

interface ModelSelectionState {
    agentId: string;
    modelsCache: Record<string, string[]>;
    providers: string[];
    currentProvider?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveHome(p: string): string {
    if (p.startsWith("~/") || p === "~") {
        return nodePath.join(os.homedir(), p.slice(1));
    }
    return p;
}

/** Global workspace root: WORKSPACE_DIR env or ~/proyectos */
function workspaceDir(): string {
    const raw = process.env.WORKSPACE_DIR || "~/proyectos";
    const resolved = resolveHome(raw);
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    return resolved;
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────

async function githubCreateRepo(name: string): Promise<{ cloneUrl: string; htmlUrl: string } | null> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return null;
    const res = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers: {
            Authorization: `token ${token}`,
            "Content-Type": "application/json",
            Accept: "application/vnd.github.v3+json",
        },
        body: JSON.stringify({ name, private: false, auto_init: true }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return { cloneUrl: data.clone_url, htmlUrl: data.html_url };
}

async function githubGetRepo(name: string): Promise<{ cloneUrl: string; htmlUrl: string } | null> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return null;
    // Try to get username from token
    const meRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
    });
    if (!meRes.ok) return null;
    const me: any = await meRes.json();
    const res = await fetch(`https://api.github.com/repos/${me.login}/${name}`, {
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return { cloneUrl: data.clone_url, htmlUrl: data.html_url };
}

// ─── Gitea helpers ────────────────────────────────────────────────────────────

async function giteaCreateOrGetRepo(name: string): Promise<{ cloneUrl: string; htmlUrl: string; sshUrl: string } | null> {
    const url = process.env.GITEA_URL;
    const token = process.env.GITEA_TOKEN;
    if (!url || !token) return null;

    const headers = { Authorization: `token ${token}`, "Content-Type": "application/json" };

    // Try to create (if already exists it returns 409 → try to get)
    const createRes = await fetch(`${url}/api/v1/user/repos`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, auto_init: true, private: false }),
    });

    if (createRes.ok) {
        const d: any = await createRes.json();
        return { cloneUrl: d.clone_url, htmlUrl: d.html_url, sshUrl: d.ssh_url };
    }

    // Already exists → fetch it
    const meRes = await fetch(`${url}/api/v1/user`, { headers });
    if (!meRes.ok) return null;
    const me: any = await meRes.json();
    const getRes = await fetch(`${url}/api/v1/repos/${me.login}/${name}`, { headers });
    if (!getRes.ok) return null;
    const d: any = await getRes.json();
    return { cloneUrl: d.clone_url, htmlUrl: d.html_url, sshUrl: d.ssh_url };
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class OpenCodeBot {
    private configService: ConfigService;
    private agentDb: AgentDbService;
    private persistentAgentService: PersistentAgentService;
    private transcriptionService: TranscriptionService;
    private bot?: Bot;

    /** Wizard state per user for /new multi-step flow */
    private newWizard: Map<number, NewAgentWizard> = new Map();

    /** Pending one-shot /run state: userId → { prompt, agentId? } */
    private runWizard: Map<number, { prompt: string; agentId?: string }> = new Map();

    /** Pending /rename state: userId → agentId (waiting for user to type the new session name) */
    private renameWizard: Map<number, string> = new Map();

    /** Model selection state: userId → { agentId, modelsCache, providers, currentProvider? } */
    private modelSelection: Map<number, ModelSelectionState> = new Map();

    /** Short-key → remote agent discovery data for callback buttons (avoids 64-byte limit) */
    private remoteAgentIndex: Map<string, { host: string; port: number; project: string; workdir: string; sessionId?: string; model?: string }> = new Map();
    private remoteAgentIndexCounter = 0;

    /**
     * Remote context per user (in-memory only, resets on bot restart).
     * When set, ALL commands operate on that remote node instead of localhost.
     * null / undefined = local context (default).
     */
    private remoteContext: Map<number, string> = new Map();

    /** Returns the remote host for the user, or null if local context. */
    private getContextHost(userId: number): string | null {
        return this.remoteContext.get(userId) ?? null;
    }

    /** Short-key → model full name for callback buttons */
    private modelIndex: Map<string, string> = new Map();
    private modelIndexCounter = 0;
    private static readonly MAX_CALLBACK_DATA = 64;

    private makeShortKey(prefix: string): string {
        if (this.modelIndexCounter > 999999) this.modelIndexCounter = 0;
        const key = `${prefix}${this.modelIndexCounter++}`;
        if (key.length > OpenCodeBot.MAX_CALLBACK_DATA) {
            console.warn(`[OpenCodeBot] callback_data too long: ${key}`);
        }
        return key;
    }

    /** Agent question callbacks keyed by shortKey */
    private pendingAgentQuestions: Map<string, { agentId: string; port: number; req: any }> = new Map();

    /** Heartbeat message per agent: { chatId, msgId } — edited each tick, deleted when prompt resolves */
    private heartbeatMessages: Map<string, { chatId: number; msgId: number }> = new Map();

    /**
     * Single "en cola" status message per agent.
     * There is only ONE queue-status bubble at a time; it gets deleted and recreated
     * each time the count changes (new enqueue or dequeue).
     */
    private queueStatusMessage: Map<string, { chatId: number; msgId: number }> = new Map();

    /**
     * Short-key → { agentId, sessionId } index for session keyboard buttons.
     * Telegram limits callback_data to 64 bytes; UUIDs alone exceed that limit,
     * so we store full IDs here and pass only the short key in the button data.
     */
    private sessIndex: Map<string, { agentId: string; sessionId: string }> = new Map();
    private sessIndexCounter = 0;

    constructor(configService: ConfigService) {
        this.configService = configService;
        this.agentDb = new AgentDbService();
        this.persistentAgentService = new PersistentAgentService(this.agentDb);
        this.transcriptionService = new TranscriptionService();
    }

    registerHandlers(bot: Bot): void {
        this.bot = bot;

        // Register persistent agent callbacks
        this.persistentAgentService.setOnQuestionCallback(this.handleAgentQuestion.bind(this));
        this.persistentAgentService.setOnSessionErrorCallback(this.handleAgentSessionError.bind(this));
        this.persistentAgentService.setOnHeartbeatCallback(this.handleAgentHeartbeat.bind(this));

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
        bot.command("start", AccessControlMiddleware.requireAccess, this.handleStart.bind(this));
        bot.command("help",  AccessControlMiddleware.requireAccess, this.handleStart.bind(this));
        bot.command("new",     AccessControlMiddleware.requireAccess, this.handleNew.bind(this));
        bot.command("agents",  AccessControlMiddleware.requireAccess, (ctx) => this.handleAgentsWithIp(ctx));
        bot.command("run",     AccessControlMiddleware.requireAccess, this.handleRun.bind(this));
        bot.command("models",  AccessControlMiddleware.requireAccess, this.handleModels.bind(this));
        bot.command("esc",     AccessControlMiddleware.requireAccess, this.handleEsc.bind(this));
        bot.command("undo",    AccessControlMiddleware.requireAccess, this.handleUndo.bind(this));
        bot.command("redo",    AccessControlMiddleware.requireAccess, this.handleRedo.bind(this));
        bot.command("session", AccessControlMiddleware.requireAccess, this.handleSession.bind(this));
        bot.command("rename",  AccessControlMiddleware.requireAccess, this.handleRename.bind(this));
        bot.command("delete",  AccessControlMiddleware.requireAccess, this.handleDelete.bind(this));
        bot.command("deleteall", AccessControlMiddleware.requireAccess, this.handleDeleteAll.bind(this));
        bot.command("restart", AccessControlMiddleware.requireAccess, this.handleRestart.bind(this));
        bot.command("remoto",  AccessControlMiddleware.requireAccess, this.handleRemoto.bind(this));
        bot.command("local",   AccessControlMiddleware.requireAccess, this.handleLocal.bind(this));

        // ─── Callbacks ───────────────────────────────────────────────────────
        bot.callbackQuery(/^new:source:/,   AccessControlMiddleware.requireAccess, this.handleNewSource.bind(this));
        bot.callbackQuery(/^new:confirm$/,  AccessControlMiddleware.requireAccess, this.handleNewConfirm.bind(this));
        bot.callbackQuery(/^new:cancel$/,   AccessControlMiddleware.requireAccess, this.handleNewCancel.bind(this));

        bot.callbackQuery(/^agent:activate:/, AccessControlMiddleware.requireAccess, this.handleAgentActivate.bind(this));
        bot.callbackQuery(/^agent:del:/,      AccessControlMiddleware.requireAccess, this.handleAgentDelete.bind(this));
        bot.callbackQuery(/^agent:delconfirm:/, AccessControlMiddleware.requireAccess, this.handleAgentDeleteConfirm.bind(this));
        bot.callbackQuery(/^agent:delcancel$/,  AccessControlMiddleware.requireAccess, this.handleAgentDeleteCancel.bind(this));
        bot.callbackQuery(/^agent:model:/,    AccessControlMiddleware.requireAccess, this.handleAgentModelSelect.bind(this));
        bot.callbackQuery("agent:new",        AccessControlMiddleware.requireAccess, this.handleAgentNew.bind(this));
        bot.callbackQuery(/^agent:park:/,     AccessControlMiddleware.requireAccess, this.handleAgentPark.bind(this));
        bot.callbackQuery(/^agent:unpark:/,   AccessControlMiddleware.requireAccess, this.handleAgentUnpark.bind(this));
        
        // Remote agent callbacks
        bot.callbackQuery(/^remote:select:/,  AccessControlMiddleware.requireAccess, this.handleRemoteAgentSelect.bind(this));

        bot.callbackQuery(/^run:agent:/,    AccessControlMiddleware.requireAccess, this.handleRunAgentSelected.bind(this));
        bot.callbackQuery(/^run:cancel$/,   AccessControlMiddleware.requireAccess, this.handleRunCancel.bind(this));

        bot.callbackQuery(/^mdl_/,         AccessControlMiddleware.requireAccess, this.handleModelCallback.bind(this));

        bot.callbackQuery(/^agq:/,          AccessControlMiddleware.requireAccess, this.handleAgentQuestionCallback.bind(this));

        bot.callbackQuery(/^sa:/,   AccessControlMiddleware.requireAccess, this.handleSessionActivate.bind(this));
        bot.callbackQuery(/^sn:/,   AccessControlMiddleware.requireAccess, this.handleSessionNew.bind(this));
        bot.callbackQuery(/^sd:/,   AccessControlMiddleware.requireAccess, this.handleSessionDeleteAll.bind(this));
        bot.callbackQuery(/^sx:/,   AccessControlMiddleware.requireAccess, this.handleSessionDelete.bind(this));

        // ─── ESC keyboard button ─────────────────────────────────────────────
        bot.hears("⏹️ ESC", AccessControlMiddleware.requireAccess, this.handleEsc.bind(this));

        // ─── Regular text messages ───────────────────────────────────────────
        bot.on("message:text", AccessControlMiddleware.requireAccess, async (ctx, next) => {
            if (ctx.message?.text?.startsWith("/")) return next();
            if (ctx.message?.text === "⏹️ ESC") return next();
            const userId = ctx.from?.id;
            if (!userId) return;

            // /new wizard intercept
            if (this.newWizard.has(userId)) {
                await this.handleNewWizardText(ctx);
                return;
            }
            // /run wizard intercept
            if (this.runWizard.has(userId)) {
                await this.handleRunWizardText(ctx);
                return;
            }
            // /rename wizard intercept
            if (this.renameWizard.has(userId)) {
                await this.handleRenameWizardText(ctx);
                return;
            }
            // Regular message → route to active/last agent
            await this.handleMessage(ctx);
        });

        // File uploads
        bot.on("message:document", AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:photo",    AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:video",    AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:audio",    AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
        bot.on("message:voice",    AccessControlMiddleware.requireAccess, this.handleFileUpload.bind(this));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /start — help
    // ─────────────────────────────────────────────────────────────────────────

    private async handleStart(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        const isGitea  = !!process.env.GITEA_URL && !!process.env.GITEA_TOKEN;
        const isGithub = !!process.env.GITHUB_TOKEN;
        const maxAgents = this.configService.getMaxAgents();
        const remoteHost = userId ? this.getContextHost(userId) : null;
        const contextLine = remoteHost
            ? `\n📡 <b>Contexto: remoto</b> → <code>${escapeHtml(remoteHost)}</code> (usa /local para volver)\n`
            : `\n🏠 <b>Contexto: local</b>\n`;

        await ctx.reply(
            `<b>TelegramCoder</b>${contextLine}\n` +
            `<b>Comandos:</b>\n` +
            `/new — Crear agente (${isGitea ? "Gitea ✅" : "Gitea ❌"} / ${isGithub ? "GitHub ✅" : "GitHub ❌"} / local)\n` +
            `/agents — Ver y gestionar tus agentes\n` +
            `/run — Prompt puntual a un agente\n` +
            `/session — Ver sesiones del agente activo\n` +
            `/rename — Renombrar la sesión activa\n` +
            `/delete — Borrar sesión activa y crear nueva\n` +
            `/deleteall — Borrar todas las sesiones y crear nueva\n` +
            `/models — Cambiar modelo del agente activo\n` +
            `/esc — Cancelar / desactivar agente / abortar\n` +
            `/undo — Revertir último cambio\n` +
            `/redo — Restaurar cambio revertido\n` +
            `/restart — Reiniciar bot y servidores\n` +
            `/remoto &lt;ip&gt; — Cambiar contexto a nodo remoto\n` +
            `/local — Volver a contexto local\n\n` +
            `<b>Flujo:</b>\n` +
            `1. <code>/new mi-proyecto</code> → wizard → agente listo\n` +
            `2. Escribe tus mensajes directamente\n` +
            `3. <code>/esc</code> para volver a la sesión principal\n\n` +
            `<b>Límite:</b> ${maxAgents} agentes activos (MAX_AGENTS en .env)\n` +
            `Los agentes aparcados (⏹️ en /agents) no cuentan para el límite.`,
            { parse_mode: "HTML" }
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /new — wizard unificado
    // ─────────────────────────────────────────────────────────────────────────

    private async handleNew(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const maxAgents = this.configService.getMaxAgents();
        const existing = this.agentDb.getByUser(userId);
        // Only running agents count against the limit — stopped/parked ones don't
        const runningCount = existing.filter(a => a.status === "running").length;
        if (runningCount >= maxAgents) {
            // Soft warning — do not block
            await ctx.reply(
                `⚠️ Tienes ${runningCount} agentes activos (límite recomendado: ${maxAgents}).\n\n` +
                `Puedes crear uno más, o aparcar alguno con ⏹️ en /agents para liberar espacio.`
            );
        }

        const defaultModel = process.env.OPENCODE_DEFAULT_MODEL || "github-copilot/claude-sonnet-4.6";
        const inlineName = ctx.message?.text?.replace(/^\/new\s*/i, "").trim() || "";

        if (inlineName) {
            // Name provided inline → resolve path and go straight to git step
            const wizard: NewAgentWizard = { step: "git", name: inlineName, model: defaultModel };
            wizard.workdir = this.resolveProjectPath(inlineName);
            this.newWizard.set(userId, wizard);
            await this.sendGitPicker(ctx, wizard);
        } else {
            this.newWizard.set(userId, { step: "name", model: defaultModel });
            await ctx.reply(
                `🆕 <b>Nuevo agente</b>\n\nEscribe el nombre o ruta del proyecto:\n` +
                `<i>· <code>mi-proyecto</code> → crea ${escapeHtml(workspaceDir())}/mi-proyecto\n` +
                `· <code>/ruta/absoluta</code> → usa esa ruta directamente</i>`,
                { parse_mode: "HTML" }
            );
        }
    }

    /**
     * Resolves a project name or path to an absolute directory.
     * - Absolute path → used as-is.
     * - Path starting with ~/ → resolved against home.
     * - Otherwise → placed inside workspaceDir().
     * Creates the directory if it doesn't exist.
     */
    private resolveProjectPath(nameOrPath: string): string {
        let resolved: string;
        if (nodePath.isAbsolute(nameOrPath)) {
            resolved = nameOrPath;
        } else if (nameOrPath.startsWith("~/") || nameOrPath === "~") {
            resolved = resolveHome(nameOrPath);
        } else {
            resolved = nodePath.join(workspaceDir(), nameOrPath);
        }
        if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
        return resolved;
    }

    /**
     * Shows the optional git integration picker.
     * Always shows GitHub, Gitea and "Sin repositorio" — regardless of token config.
     * Tokens are only checked at creation time.
     */
    private async sendGitPicker(ctx: Context, wizard: NewAgentWizard): Promise<void> {
        const keyboard = new InlineKeyboard();
        keyboard.text("⚫ GitHub", "new:source:github").row();
        keyboard.text("🟠 Gitea",  "new:source:gitea").row();
        keyboard.text("📁 Sin repositorio remoto", "new:source:none").row();
        keyboard.text("❌ Cancelar", "new:cancel");

        await ctx.reply(
            `🆕 <b>${escapeHtml(wizard.name!)}</b>\n\n` +
            `📁 Dir: <code>${escapeHtml(wizard.workdir!)}</code>\n\n` +
            `¿Crear repositorio remoto? (opcional)`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    /** Handles git source selection: new:source:gitea | new:source:github | new:source:none */
    private async handleNewSource(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const wizard = this.newWizard.get(userId);
        if (!wizard) { await ctx.editMessageText("❌ Sesión expirada. Usa /new."); return; }

        const source = ctx.callbackQuery!.data.replace("new:source:", "") as "gitea" | "github" | "none";
        wizard.gitSource = source;

        await ctx.deleteMessage().catch(() => {});

        if (source === "none") {
            wizard.step = "confirm";
            await this.sendNewConfirm(ctx, wizard);
        } else {
            // Use the project folder name as repo name — no need to ask
            wizard.repoName = wizard.name!;
            wizard.step = "confirm";
            await this.sendNewConfirm(ctx, wizard);
        }
    }

    private async handleNewWizardText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;
        const wizard = this.newWizard.get(userId);
        if (!wizard) return;

        const text = ctx.message?.text?.trim() || "";

        switch (wizard.step) {
            case "name": {
                if (!text) { await ctx.reply("❌ Nombre requerido."); return; }
                wizard.name = text;
                wizard.workdir = this.resolveProjectPath(text);
                wizard.step = "git";
                await this.sendGitPicker(ctx, wizard);
                break;
            }

            case "git": {
                // User typed repo name after being asked (gitSource is already set)
                const repoName = (text === "-" || !text) ? wizard.name! : text;
                wizard.repoName = repoName;
                wizard.step = "confirm";
                await this.sendNewConfirm(ctx, wizard);
                break;
            }

            default:
                break;
        }
    }

    private async sendNewConfirm(ctx: Context, wizard: NewAgentWizard): Promise<void> {
        const gitLabel =
            wizard.gitSource === "gitea"  ? `🟠 Gitea (repo: <code>${escapeHtml(wizard.repoName || wizard.name!)}</code>)` :
            wizard.gitSource === "github" ? `⚫ GitHub (repo: <code>${escapeHtml(wizard.repoName || wizard.name!)}</code>)` :
            "📁 Sin repositorio remoto";

        const keyboard = new InlineKeyboard()
            .text("✅ Crear agente", "new:confirm")
            .text("❌ Cancelar", "new:cancel");

        await ctx.reply(
            `🆕 <b>Resumen</b>\n\n` +
            `🤖 Nombre: <b>${escapeHtml(wizard.name!)}</b>\n` +
            `📁 Dir: <code>${escapeHtml(wizard.workdir!)}</code>\n` +
            `🌐 Git: ${gitLabel}\n` +
            `🧠 Modelo: <code>${escapeHtml(wizard.model)}</code>\n\n` +
            `¿Confirmar?`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    private async handleNewConfirm(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const wizard = this.newWizard.get(userId);
        if (!wizard || !wizard.name) {
            await ctx.editMessageText("❌ Sesión expirada. Usa /new.");
            return;
        }
        this.newWizard.delete(userId);

        const statusMsg = await ctx.editMessageText(`⏳ Creando agente <b>${escapeHtml(wizard.name)}</b>...`, { parse_mode: "HTML" });
        const msgId = (statusMsg as any).message_id ?? ctx.callbackQuery!.message!.message_id;
        const chatId = ctx.chat!.id;

        const edit = (text: string) =>
            ctx.api.editMessageText(chatId, msgId, text, { parse_mode: "HTML" }).catch(() => {});

        // ── Local context ────────────────────────────────────────────────────
        try {
            // 1. Resolve workdir (already resolved during wizard, but ensure it exists)
            const workdir = wizard.workdir || this.resolveProjectPath(wizard.name);
            if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive: true });

            // 2. Optional: create/clone remote repo
            if (wizard.gitSource === "gitea" || wizard.gitSource === "github") {
                const repoName = wizard.repoName || wizard.name;
                await edit(`⏳ ${wizard.gitSource === "gitea" ? "🟠 Gitea" : "⚫ GitHub"}: creando/obteniendo repo <b>${escapeHtml(repoName)}</b>...`);

                if (wizard.gitSource === "gitea") {
                    const repo = await giteaCreateOrGetRepo(repoName);
                    if (!repo) {
                        await edit("❌ No se pudo crear/obtener el repo en Gitea. Verifica GITEA_URL y GITEA_TOKEN.");
                        return;
                    }
                    // Clone only if the workdir is empty (no git repo yet)
                    const isEmptyOrNew = !fs.existsSync(nodePath.join(workdir, ".git"));
                    if (isEmptyOrNew) {
                        await edit(`⏳ Clonando <code>${escapeHtml(repoName)}</code>...`);
                        try {
                            execSync(`git clone "${repo.sshUrl}" "${workdir}"`, { stdio: "pipe" });
                        } catch {
                            try {
                                execSync(`git clone "${repo.cloneUrl}" "${workdir}"`, { stdio: "pipe" });
                            } catch {
                                await edit(
                                    `⚠️ Repo creado en Gitea pero no se pudo clonar automáticamente.\n` +
                                    `Clona manualmente: <code>git clone ${escapeHtml(repo.cloneUrl)}</code>\n\n` +
                                    `Continuando con el directorio existente...`
                                );
                                // Not fatal — continue with the existing workdir
                                await new Promise(r => setTimeout(r, 2500));
                            }
                        }
                    }
                } else {
                    // GitHub
                    let repo = await githubGetRepo(repoName);
                    if (!repo) repo = await githubCreateRepo(repoName);
                    if (!repo) {
                        await edit("❌ No se pudo crear/obtener el repo en GitHub. Verifica GITHUB_TOKEN.");
                        return;
                    }
                    const isEmptyOrNew = !fs.existsSync(nodePath.join(workdir, ".git"));
                    if (isEmptyOrNew) {
                        await edit(`⏳ Clonando <code>${escapeHtml(repoName)}</code> de GitHub...`);
                        try {
                            execSync(`git clone "${repo.cloneUrl}" "${workdir}"`, { stdio: "pipe" });
                        } catch {
                            await edit(
                                `⚠️ Repo creado en GitHub pero no se pudo clonar automáticamente.\n` +
                                `Clona manualmente: <code>git clone ${escapeHtml(repo.cloneUrl)}</code>\n\n` +
                                `Continuando con el directorio existente...`
                            );
                            await new Promise(r => setTimeout(r, 2500));
                        }
                    }
                }
            }

            // 3. Pick port
            const port = pickPort(this.agentDb.usedPorts());

            // 4. Save agent to DB
            const agent: PersistentAgent = {
                id: randomUUID(),
                userId,
                name: wizard.name,
                role: "",
                workdir,
                model: wizard.model,
                port,
                status: "running",
                createdAt: new Date().toISOString(),
            };
            this.agentDb.save(agent);

            // 5. Start the opencode server for this agent
            await edit(`⏳ Arrancando servidor OpenCode en puerto <code>${port}</code>...`);
            const startResult = await this.persistentAgentService.startAgent(agent);
            if (!startResult.success) {
                this.agentDb.delete(agent.id);
                await edit(`❌ No se pudo arrancar el servidor: ${startResult.message}`);
                return;
            }

            // 6. Inject git credentials into opencode via PUT /auth/:id (best-effort)
            await this.injectCredentials(agent.port);

            // 7. Mark as active (sticky) and save last used
            this.persistentAgentService.setActiveAgent(userId, agent.id);
            this.agentDb.setLastUsed(userId, agent.id);

            await edit(
                `✅ <b>Agente "${escapeHtml(wizard.name)}" listo</b>\n\n` +
                `📁 Dir: <code>${escapeHtml(workdir)}</code>\n` +
                `🧠 Modelo: <code>${escapeHtml(wizard.model)}</code>\n` +
                `🔌 Puerto: <code>${port}</code>\n\n` +
                `Ya puedes enviar mensajes directamente.`
            );

        } catch (error) {
            await edit(ErrorUtils.createErrorMessage("crear agente", error));
        }
    }

    /**
     * Injects Gitea / GitHub credentials into an opencode server via PUT /auth/:id.
     * Fire-and-forget — never throws.
     */
    private async injectCredentials(port: number): Promise<void> {
        const baseUrl = `http://localhost:${port}`;

        const creds: Array<{ id: string; type: string; token?: string; url?: string }> = [];

        if (process.env.GITEA_TOKEN && process.env.GITEA_URL) {
            creds.push({
                id: "gitea",
                type: "gitea",
                token: process.env.GITEA_TOKEN,
                url: process.env.GITEA_URL,
            });
        }
        if (process.env.GITHUB_TOKEN) {
            creds.push({
                id: "github",
                type: "github",
                token: process.env.GITHUB_TOKEN,
            });
        }

        for (const cred of creds) {
            try {
                await fetch(`${baseUrl}/auth/${cred.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(cred),
                    signal: AbortSignal.timeout(5000),
                });
            } catch {
                // Best-effort — don't fail agent creation if auth injection fails
            }
        }
    }

    private async handleNewCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (userId) this.newWizard.delete(userId);
        await ctx.editMessageText("❌ Cancelado.").catch(() => {});
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /agents — lista y gestión
    // ─────────────────────────────────────────────────────────────────────────

    private async handleAgents(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agents = this.agentDb.getByUser(userId);
        const runningAgents = agents.filter(a => a.status === "running");
        const activeId = this.persistentAgentService.getActiveAgentId(userId);
        const keyboard = new InlineKeyboard();

        for (const agent of agents) {
            const isStopped = agent.status === "stopped";
            const isActive = agent.id === activeId;
            const label = isStopped
                ? `⏸️ ${agent.name}`
                : isActive ? `✅ ${agent.name}` : agent.name;

            if (isStopped) {
                // Parked agent: show resume button instead of activate/prompt
                keyboard
                    .text(label, `agent:activate:${agent.id}`)
                    .text("▶️", `agent:unpark:${agent.id}`)
                    .text("🗑️", `agent:del:${agent.id}`)
                    .row();
            } else {
                keyboard
                    .text(label, `agent:activate:${agent.id}`)
                    .text("💬", `run:agent:${agent.id}`)
                    .text("⏹️", `agent:park:${agent.id}`)
                    .text("🗑️", `agent:del:${agent.id}`)
                    .row();
            }
        }

        // Always show "➕ Nuevo agente" at the bottom
        keyboard.text("➕ Nuevo agente", "agent:new");

        const activeInfo = activeId
            ? `\n\n🟢 <b>${escapeHtml(agents.find(a => a.id === activeId)?.name ?? "")}</b> activo — tus mensajes van a él.\n/esc para volver a ninguno.`
            : agents.length === 0
                ? `\n\n⚪ Aún no tienes agentes.`
                : `\n\n⚪ Ningún agente activo.`;

        const maxAgents = this.configService.getMaxAgents();
        const header = agents.length === 0
            ? `🤖 <b>Tus agentes</b>\n\nNo tienes agentes todavía.`
            : `🤖 <b>Tus agentes (${runningAgents.length}/${maxAgents} activos, ${agents.length} total)</b>\n\n` +
              `Toca el nombre para activar (sticky), 💬 prompt, ⏹️ aparcar, ▶️ reanudar, 🗑️ borrar.\n` +
              `Los agentes aparcados (⏸️) no cuentan para el límite de ${maxAgents}.`;

        await ctx.reply(
            header + activeInfo,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    /** Handle /agents command — respects remote context */
    private async handleAgentsWithIp(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
        const ipArg = args[0]?.trim();

        // Explicit IP argument always wins; otherwise use remote context if set
        const host = ipArg || (userId ? this.getContextHost(userId) : null);

        if (host) {
            await this.handleRemoteAgents(ctx, host);
        } else {
            await this.handleAgents(ctx);
        }
    }

    /** Discover and display agents from a remote host */
    private async handleRemoteAgents(ctx: Context, host: string): Promise<void> {
        try {
            // Validate IP format
            const ipRegex = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*)$/;
            if (!ipRegex.test(host)) {
                await ctx.reply(`❌ Formato de IP/host inválido: ${host}`);
                return;
            }

            const discoveryPort = parseInt(process.env.DISCOVERY_PORT || '17000', 10);
            const url = `http://${host}:${discoveryPort}/discovery`;

            // Fetch agents from remote host
            const response = await fetch(url, { 
                signal: AbortSignal.timeout(5000) 
            });

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

            // Prepare keyboard with remote agents
            const keyboard = new InlineKeyboard();
            for (const agent of agents) {
                const projectName = agent.project || 'unknown';
                const statusEmoji = agent.status === 'running' ? '🟢' : '🔴';

                // Store agent data in remoteAgentIndex and use short key in callback
                const shortKey = String(this.remoteAgentIndexCounter++);
                this.remoteAgentIndex.set(shortKey, {
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
                `${agents.length} agente${agents.length !== 1 ? 's' : ''} encontrado${agents.length !== 1 ? 's' : ''}.\n` +
                `Toca el nombre para activarlo como agente sticky.`,
                { 
                    parse_mode: "HTML", 
                    reply_markup: keyboard 
                }
            );
        } catch (error: any) {
            console.error('[OpenCodeBot] Error discovering remote agents:', error);
            await ctx.reply(`❌ Error al descubrir agentes en ${host}: ${error.message || error}`);
        }
    }

    /** Triggered by the "➕ Nuevo agente" button in /agents — starts the /new wizard inline */
    private async handleAgentNew(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
            `🆕 <b>Nuevo agente</b>\n\nEscribe el nombre o ruta del proyecto:\n` +
            `<i>· <code>mi-proyecto</code> → crea ${escapeHtml(workspaceDir())}/mi-proyecto\n` +
            `· <code>/ruta/absoluta</code> → usa esa ruta directamente</i>`,
            { parse_mode: "HTML" }
        );
        const userId = ctx.from?.id;
        if (!userId) return;
        const defaultModel = process.env.OPENCODE_DEFAULT_MODEL || "github-copilot/claude-sonnet-4.6";
        this.newWizard.set(userId, { step: "name", model: defaultModel });
    }

    private async handleAgentActivate(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const agentId = ctx.callbackQuery!.data.replace("agent:activate:", "");
        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

        const currentActive = this.persistentAgentService.getActiveAgentId(userId);
        if (currentActive === agentId) {
            this.persistentAgentService.clearActiveAgent(userId);
            await ctx.answerCallbackQuery({ text: `⚪ ${agent.name} desactivado.` });
        } else {
            this.persistentAgentService.setActiveAgent(userId, agentId);
            this.agentDb.setLastUsed(userId, agentId);
            await ctx.answerCallbackQuery({ text: `✅ ${agent.name} activado.` });
        }

        await ctx.deleteMessage().catch(() => {});
        await this.handleAgents(ctx);
    }

    private async handleAgentDelete(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const agentId = ctx.callbackQuery!.data.replace("agent:del:", "");
        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

        const keyboard = new InlineKeyboard()
            .text("✅ Sí, borrar", `agent:delconfirm:${agentId}`)
            .text("❌ Cancelar", "agent:delcancel");

        await ctx.editMessageText(
            `🗑️ ¿Borrar agente <b>${escapeHtml(agent.name)}</b>?\n\nSe detendrá su servidor y se eliminará la configuración.`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    private async handleAgentDeleteConfirm(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const agentId = ctx.callbackQuery!.data.replace("agent:delconfirm:", "");
        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

        // 1. Delete all OpenCode sessions on the server before stopping the process
        try {
            const baseUrl = `http://localhost:${agent.port}`;
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (sessRes.ok) {
                const sessions: any[] = await sessRes.json();
                await Promise.all(sessions.map(s =>
                    fetch(`${baseUrl}/session/${s.id}`, {
                        method: "DELETE",
                        signal: AbortSignal.timeout(8000),
                    }).catch(() => {})
                ));
            }
        } catch { /* best-effort — proceed with stop even if sessions can't be deleted */ }

        // 2. Stop the process
        this.persistentAgentService.stopAgent(agentId);
        this.agentDb.delete(agentId);

        if (this.persistentAgentService.getActiveAgentId(userId) === agentId) {
            this.persistentAgentService.clearActiveAgent(userId);
        }

        // If this was the last used, clear it
        const lastUsed = this.agentDb.getLastUsed(userId);
        if (lastUsed?.id === agentId) {
            this.agentDb.clearLastUsed(userId);
        }

        await ctx.editMessageText(
            `🗑️ Agente <b>${escapeHtml(agent.name)}</b> eliminado.`,
            { parse_mode: "HTML" }
        );
    }

    private async handleAgentDeleteCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage().catch(() => {});
        await this.handleAgents(ctx);
    }

    /** Park (stop) an agent without deleting it — it won't count against MAX_AGENTS */
    private async handleAgentPark(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const agentId = ctx.callbackQuery!.data.replace("agent:park:", "");
        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

        if (agent.status === "stopped") {
            await ctx.answerCallbackQuery({ text: `⏸️ ${agent.name} ya estaba aparcado.` });
            return;
        }

        // Deactivate if it was the active sticky agent
        if (this.persistentAgentService.getActiveAgentId(userId) === agentId) {
            this.persistentAgentService.clearActiveAgent(userId);
        }

        this.persistentAgentService.parkAgent(agentId);

        await ctx.answerCallbackQuery({ text: `⏸️ ${agent.name} aparcado.` });
        await ctx.deleteMessage().catch(() => {});
        await this.handleAgents(ctx);
    }

    /** Unpark (resume) a stopped agent */
    private async handleAgentUnpark(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const agentId = ctx.callbackQuery!.data.replace("agent:unpark:", "");
        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

        if (agent.status === "running") {
            await ctx.answerCallbackQuery({ text: `▶️ ${agent.name} ya estaba activo.` });
            return;
        }

        const statusMsg = await ctx.reply(`▶️ Arrancando <b>${escapeHtml(agent.name)}</b>…`, { parse_mode: "HTML" });

        const result = await this.persistentAgentService.unparkAgent(agent);

        await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => {});

        if (result.success) {
            await ctx.reply(`✅ <b>${escapeHtml(agent.name)}</b> reanudado.`, { parse_mode: "HTML" });
        } else {
            await ctx.reply(`❌ No se pudo arrancar <b>${escapeHtml(agent.name)}</b>: ${result.message}`, { parse_mode: "HTML" });
        }

        await ctx.deleteMessage().catch(() => {});
        await this.handleAgents(ctx);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /run — one-shot prompt
    // ─────────────────────────────────────────────────────────────────────────

    private async handleRun(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const allAgents = this.agentDb.getByUser(userId);
        const agents = allAgents.filter(a => a.status !== "stopped");
        if (agents.length === 0) {
            await ctx.reply("ℹ️ No tienes agentes activos. Crea uno con /new o reanuda un agente aparcado con /agents.");
            return;
        }

        const inlinePrompt = ctx.message?.text?.replace(/^\/run\s*/i, "").trim() || "";

        if (inlinePrompt) {
            if (agents.length === 1) {
                // Only one agent → send directly
                await this.executeRunPrompt(ctx, agents[0], inlinePrompt);
            } else {
                this.runWizard.set(userId, { prompt: inlinePrompt });
                await this.showRunPicker(ctx, inlinePrompt);
            }
        } else {
            this.runWizard.set(userId, { prompt: "" });
            await ctx.reply(
                `💬 <b>Prompt puntual</b>\n\nEscribe el mensaje que quieres enviar. /esc para cancelar.`,
                { parse_mode: "HTML" }
            );
        }
    }

    private async showRunPicker(ctx: Context, prompt: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;
        const allAgents = this.agentDb.getByUser(userId);
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

    private async handleRunWizardText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;
        const state = this.runWizard.get(userId);
        if (!state) return;

        const text = ctx.message?.text?.trim() || "";
        if (!text) return;

        const allAgents = this.agentDb.getByUser(userId);
        const agents = allAgents.filter(a => a.status !== "stopped");
        this.runWizard.delete(userId);

        if (agents.length === 1) {
            await this.executeRunPrompt(ctx, agents[0], text);
        } else {
            this.runWizard.set(userId, { prompt: text });
            await this.showRunPicker(ctx, text);
        }
    }

    private async handleRunAgentSelected(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const agentId = ctx.callbackQuery!.data.replace("run:agent:", "");
        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

        const state = this.runWizard.get(userId);
        const prompt = state?.prompt || "";
        this.runWizard.delete(userId);

        if (!prompt) { await ctx.editMessageText("❌ No hay prompt. Usa /run de nuevo."); return; }

        await ctx.deleteMessage().catch(() => {});
        await this.executeRunPrompt(ctx, agent, prompt);
    }

    private async handleRunCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (userId) this.runWizard.delete(userId);
        await ctx.editMessageText("❌ Cancelado.").catch(() => {});
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

        // Fire-and-forget: do NOT await so other commands are not blocked.
        this.persistentAgentService.sendPrompt(agent, prompt).then(async (result) => {
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

    // ─────────────────────────────────────────────────────────────────────────
    // Routing: mensaje normal → agente sticky o último usado
    // ─────────────────────────────────────────────────────────────────────────

    private async handleMessage(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const prompt = ctx.message?.text?.trim() || "";
        if (!prompt) return;

        // 1. Active sticky agent
        let activeId = this.persistentAgentService.getActiveAgentId(userId);

        // 2. Fallback to last used
        if (!activeId) {
            const lastUsed = this.agentDb.getLastUsed(userId);
            if (lastUsed) {
                activeId = lastUsed.id;
                // Reactivate as sticky automatically
                this.persistentAgentService.setActiveAgent(userId, activeId);
            }
        }

        if (!activeId) {
            await ctx.reply(
                `ℹ️ No hay ningún agente activo.\n\n` +
                `Crea uno con /new o activa uno existente con /agents.`
            );
            return;
        }

        const agent = this.agentDb.getById(activeId);
        if (!agent) {
            this.persistentAgentService.clearActiveAgent(userId);
            this.agentDb.clearLastUsed(userId);
            await ctx.reply("❌ El agente activo ya no existe. Usa /new o /agents.");
            return;
        }

        // Guard: parked agents can't receive prompts
        if (agent.status === "stopped") {
            await ctx.reply(
                `⏸️ El agente <b>${escapeHtml(agent.name)}</b> está aparcado.\n\n` +
                `Reanúdalo con ▶️ en /agents antes de enviarle mensajes.`,
                { parse_mode: "HTML" }
            );
            return;
        }

        await this.sendPromptToAgent(ctx, agent, prompt);
    }

    /**
     * If the active session still has the default auto-generated title (starts with "tg-"),
     * rename it using the first 50 chars of the prompt. Fire-and-forget — never throws.
     */
    private async autoRenameSessionIfNeeded(agent: PersistentAgent, prompt: string): Promise<void> {
        const sessionId = this.persistentAgentService.getSessionId(agent.id);
        if (!sessionId) return;

        try {
            const baseUrl = `http://localhost:${agent.port}`;
            const res = await fetch(`${baseUrl}/session/${sessionId}`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return;
            const sess: any = await res.json();
            if (!sess.title?.startsWith("tg-")) return; // already renamed

            const newTitle = prompt.replace(/\s+/g, " ").trim().slice(0, 50);
            if (!newTitle) return;

            await fetch(`${baseUrl}/session/${sessionId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: newTitle }),
                signal: AbortSignal.timeout(5000),
            });
        } catch { /* best-effort, never throws */ }
    }

    private async sendPromptToAgent(ctx: Context, agent: PersistentAgent, prompt: string): Promise<void> {
        // If the agent is already processing a prompt, enqueue and notify the user
        if (this.persistentAgentService.isBusy(agent.id)) {
            const chatId = ctx.chat!.id;

            // Delete the previous queue-status message (if any) and send a fresh one
            const prevQueueMsg = this.queueStatusMessage.get(agent.id);
            if (prevQueueMsg && this.bot) {
                await this.bot.api.deleteMessage(prevQueueMsg.chatId, prevQueueMsg.msgId).catch(() => {});
            }

            // Enqueue the prompt BEFORE sending the status message so queueLength is accurate
            this.persistentAgentService.enqueue(agent.id, {
                prompt,
                onDequeue: async () => {
                    if (!this.bot) return;

                    // Delete the shared queue-status bubble
                    const queueMsg = this.queueStatusMessage.get(agent.id);
                    if (queueMsg) {
                        await this.bot.api.deleteMessage(queueMsg.chatId, queueMsg.msgId).catch(() => {});
                        this.queueStatusMessage.delete(agent.id);
                    }

                    // Send a fresh "procesando" message for this item — becomes the heartbeat anchor
                    const processingMsg = await this.bot.api.sendMessage(
                        chatId,
                        `⏳ <b>${escapeHtml(agent.name)}</b> [${escapeHtml(agent.model)}] procesando…`,
                        { parse_mode: "HTML" }
                    ).catch(() => null);
                    if (processingMsg) {
                        this.heartbeatMessages.set(agent.id, { chatId, msgId: processingMsg.message_id });
                    }

                    // If there are still items waiting, show an updated queue-status bubble
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

            // Now the queue has the item — read the updated count
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

        // Send a placeholder so the user knows the agent is processing
        const statusMsg = await ctx.reply(
            `⏳ <b>${escapeHtml(agent.name)}</b> [${escapeHtml(agent.model)}] procesando…`,
            { parse_mode: "HTML" }
        );
        await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});

        // Register placeholder as the heartbeat anchor so heartbeat ticks edit it
        this.heartbeatMessages.set(agent.id, { chatId: ctx.chat!.id, msgId: statusMsg.message_id });

        // Auto-rename the session with the first prompt if it still has the default tg-* title
        this.autoRenameSessionIfNeeded(agent, prompt).catch(() => {});

        // Fire-and-forget: do NOT await — return control to grammY immediately so other
        // commands (/agents, /esc, etc.) are not blocked while the agent is processing.
        const chatId = ctx.chat!.id;
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

    /**
     * Deletes the heartbeat placeholder and sends the result as a NEW message so
     * Telegram triggers a sound/vibration notification. Editing is silent — only
     * new messages notify the user audibly.
     */
    private async editOrSendResult(
        chatId: number,
        msgId: number,
        agent: PersistentAgent,
        result: AgentSendResult,
    ): Promise<void> {
        const header = `🤖 <b>${escapeHtml(agent.name)}</b>\n\n`;
        const body = result.output || "(sin salida)";
        const MAX = 3800;

        // Always delete the placeholder first so it doesn't linger
        await this.bot!.api.deleteMessage(chatId, msgId).catch(() => {});

        if (body.length <= MAX) {
            await this.bot!.api.sendMessage(chatId, `${header}${formatAsHtml(body)}`, { parse_mode: "HTML" }).catch(() => {});
        } else {
            const buf = Buffer.from(body, "utf8");
            await this.bot!.api.sendDocument(
                chatId,
                new InputFile(buf, `${agent.name}-respuesta.md`),
                { caption: `${header}(resultado adjunto)`, parse_mode: "HTML" }
            ).catch(() => {});
        }
    }

    /**
     * Used by the queue's onResult callback — sends the result as a new message
     * (no placeholder to edit since it was queued).
     */
    private async sendAgentResult(
        chatId: number,
        agent: PersistentAgent,
        result: AgentSendResult,
    ): Promise<void> {
        const header = `🤖 <b>${escapeHtml(agent.name)}</b>\n\n`;
        const body = result.output || "(sin salida)";
        const MAX = 3800;

        if (body.length <= MAX) {
            await this.bot!.api.sendMessage(chatId, `${header}${formatAsHtml(body)}`, { parse_mode: "HTML" }).catch(() => {});
        } else {
            const buf = Buffer.from(body, "utf8");
            await this.bot!.api.sendDocument(
                chatId,
                new InputFile(buf, `${agent.name}-respuesta.md`),
                { caption: `${header}(resultado adjunto)`, parse_mode: "HTML" }
            ).catch(() => {});
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /esc
    // ─────────────────────────────────────────────────────────────────────────

    private async handleEsc(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        // Cancel any in-flight prompt for the user's active or last-used agent
        const busyAgentId = this.persistentAgentService.getActiveAgentId(userId)
            ?? this.agentDb.getLastUsed(userId)?.id;
        if (busyAgentId && this.persistentAgentService.isBusy(busyAgentId)) {
            const agent = this.agentDb.getById(busyAgentId);
            this.persistentAgentService.cancelPendingPrompt(busyAgentId);
            const hb = this.heartbeatMessages.get(busyAgentId);
            this.heartbeatMessages.delete(busyAgentId);
            if (hb) {
                await this.bot!.api.editMessageText(
                    hb.chatId, hb.msgId,
                    `❌ <b>${escapeHtml(agent?.name ?? busyAgentId)}</b> cancelado.`,
                    { parse_mode: "HTML" }
                ).catch(() => {});
            } else {
                await ctx.reply(`❌ <b>${escapeHtml(agent?.name ?? busyAgentId)}</b> cancelado.`, { parse_mode: "HTML" });
            }
            return;
        }

        // Cancel /new wizard
        if (this.newWizard.has(userId)) {
            this.newWizard.delete(userId);
            await ctx.reply("❌ Cancelado.");
            return;
        }

        // Cancel /run wizard
        if (this.runWizard.has(userId)) {
            this.runWizard.delete(userId);
            await ctx.reply("❌ Cancelado.");
            return;
        }

        // Cancel /rename wizard
        if (this.renameWizard.has(userId)) {
            this.renameWizard.delete(userId);
            await ctx.reply("❌ Cancelado.");
            return;
        }

        // Deactivate sticky agent
        const activeId = this.persistentAgentService.getActiveAgentId(userId);
        if (activeId) {
            const agent = this.agentDb.getById(activeId);
            this.persistentAgentService.clearActiveAgent(userId);
            await ctx.reply(
                `⏹️ <b>${escapeHtml(agent?.name ?? activeId)}</b> desactivado.\n` +
                `Los próximos mensajes irán al último agente usado automáticamente.`,
                { parse_mode: "HTML" }
            );
            return;
        }

        await ctx.reply("ℹ️ Nada que cancelar.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    private async getAvailableModels(): Promise<Record<string, string[]>> {
        try {
            const opencodeCmd = await findOpencodeCmd();
            const output = execSync(`"${opencodeCmd}" models 2>/dev/null`, { encoding: "utf-8" });
            const modelsByProvider: Record<string, string[]> = {};
            
            for (const line of output.trim().split("\n")) {
                const trimmed = line.trim();
                if (trimmed && trimmed.includes("/")) {
                    const [provider, ...modelParts] = trimmed.split("/");
                    const model = modelParts.join("/");
                    if (!modelsByProvider[provider]) {
                        modelsByProvider[provider] = [];
                    }
                    modelsByProvider[provider].push(`${provider}/${model}`);
                }
            }
            return modelsByProvider;
        } catch (error) {
            console.error("Error fetching models from opencode:", error);
            return {};
        }
    }

    // /models — cambiar modelo del agente activo
    // ─────────────────────────────────────────────────────────────────────────

    private async handleModels(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const activeId = this.persistentAgentService.getActiveAgentId(userId)
            ?? this.agentDb.getLastUsed(userId)?.id;

        if (!activeId) {
            await this.showAgentPickerForModels(ctx);
            return;
        }

        const agent = this.agentDb.getById(activeId);
        if (!agent) { await ctx.reply("❌ Agente no encontrado."); return; }

        await this.showProviderPicker(ctx, agent.id, agent.model);
    }

    private async showAgentPickerForModels(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agents = this.agentDb.getByUser(userId);
        if (agents.length === 0) {
            await ctx.reply("ℹ️ No tienes agentes. Crea uno con /new.");
            return;
        }

        const keyboard = new InlineKeyboard();
        for (const agent of agents) {
            const shortKey = this.makeShortKey("mdl_ag_");
            this.modelIndex.set(shortKey, agent.id);
            keyboard.text(agent.name, shortKey).row();
        }

        await ctx.reply("Selecciona un agente para cambiar su modelo:", { reply_markup: keyboard });
    }

    private async showProviderPicker(ctx: Context, agentId: string, currentModel: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const modelsCache = await this.getAvailableModels();
        const providers = Object.keys(modelsCache).sort();

        this.modelSelection.set(userId, { agentId, modelsCache, providers });

        const keyboard = new InlineKeyboard();
        for (const provider of providers) {
            const shortKey = this.makeShortKey("mdl_pr_");
            this.modelIndex.set(shortKey, provider);
            keyboard.text(provider, shortKey).row();
        }

        await ctx.reply(
            `🧠 <b>Modelo actual:</b> <code>${escapeHtml(currentModel)}</code>\n\nElige proveedor:`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    private async handleModelCallback(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data || !data.startsWith("mdl_")) return;

        await ctx.answerCallbackQuery();

        if (data.startsWith("mdl_ag_")) {
            const agentId = this.modelIndex.get(data);
            if (!agentId) { await ctx.editMessageText("❌ Sesión expirada."); return; }
            const agent = this.agentDb.getById(agentId);
            if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }
            await this.showProviderPicker(ctx, agent.id, agent.model);
            return;
        }

        if (data.startsWith("mdl_pr_")) {
            const provider = this.modelIndex.get(data);
            if (!provider) { await ctx.editMessageText("❌ Sesión expirada."); return; }
            const state = this.modelSelection.get(userId);
            if (!state) { await ctx.editMessageText("❌ Sesión expirada. Usa /models."); return; }

            const models = state.modelsCache[provider] || [];
            const keyboard = new InlineKeyboard();
            for (const model of models) {
                const modelName = model.split("/")[1];
                const shortKey = this.makeShortKey("mdl_mo_");
                this.modelIndex.set(shortKey, model);
                keyboard.text(modelName, shortKey).row();
            }
            keyboard.text("← Volver", "mdl_back");

            state.currentProvider = provider;
            await ctx.editMessageText(
                `🧠 <b>${provider}</b> — elige modelo:`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
            return;
        }

        if (data === "mdl_back") {
            const state = this.modelSelection.get(userId);
            if (!state) { await ctx.editMessageText("❌ Sesión expirada. Usa /models."); return; }

            const keyboard = new InlineKeyboard();
            for (const provider of state.providers) {
                const shortKey = this.makeShortKey("mdl_pr_");
                this.modelIndex.set(shortKey, provider);
                keyboard.text(provider, shortKey).row();
            }

            const agent = this.agentDb.getById(state.agentId);
            await ctx.editMessageText(
                `🧠 <b>Modelo actual:</b> <code>${escapeHtml(agent?.model || "desconocido")}</code>\n\nElige proveedor:`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
            return;
        }

        if (data.startsWith("mdl_mo_")) {
            const model = this.modelIndex.get(data);
            if (!model) { await ctx.editMessageText("❌ Sesión expirada."); return; }
            const state = this.modelSelection.get(userId);
            if (!state) { await ctx.editMessageText("❌ Sesión expirada. Usa /models."); return; }

            const agent = this.agentDb.getById(state.agentId);
            if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

            this.agentDb.updateModel(state.agentId, model);
            this.modelSelection.delete(userId);

            await ctx.editMessageText(
                `✅ Modelo de <b>${escapeHtml(agent.name)}</b> cambiado a <code>${escapeHtml(model)}</code>`,
                { parse_mode: "HTML" }
            );
            return;
        }
    }

    private async handleProviderSelection(ctx: Context): Promise<void> {
        await this.handleModelCallback(ctx);
    }

    private async handleBackToProviders(ctx: Context): Promise<void> {
        await this.handleModelCallback(ctx);
    }

    private async handleAgentModelSelect(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        await this.handleModels(ctx);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /session — list & manage sessions of active agent
    // ─────────────────────────────────────────────────────────────────────────

    private async sendSessionList(ctx: Context, agent: PersistentAgent, edit = false): Promise<void> {
        const baseUrl = `http://localhost:${agent.port}`;
        const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
        if (!sessRes.ok) {
            const txt = `❌ No se pudo conectar al servidor del agente <b>${escapeHtml(agent.name)}</b>.`;
            if (edit) await ctx.editMessageText(txt, { parse_mode: "HTML" }).catch(() => ctx.reply(txt, { parse_mode: "HTML" }));
            else await ctx.reply(txt, { parse_mode: "HTML" });
            return;
        }

        const sessions: any[] = await sessRes.json();
        const currentSessionId = this.persistentAgentService.getSessionId(agent.id);

        // Sort newest first
        sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));

        // Build a fresh index for this render — old entries cleared to avoid unbounded growth
        // We key by agent so multiple agents don't collide
        const prefix = `s${this.sessIndexCounter++}`;
        const newKey = `sn:${prefix}`;    // new session
        const daKey  = `sd:${prefix}`;    // delete-all
        this.sessIndex.set(newKey, { agentId: agent.id, sessionId: "" });
        this.sessIndex.set(daKey,  { agentId: agent.id, sessionId: "" });

        const keyboard = new InlineKeyboard();

        if (sessions.length === 0) {
            keyboard.text("➕ Nueva sesión", newKey);
        } else {
            for (let i = 0; i < sessions.length; i++) {
                const s = sessions[i];
                const actKey = `sa:${prefix}:${i}`;
                const delKey = `sx:${prefix}:${i}`;
                this.sessIndex.set(actKey, { agentId: agent.id, sessionId: s.id });
                this.sessIndex.set(delKey, { agentId: agent.id, sessionId: s.id });

                const isCurrent = s.id === currentSessionId;
                const title = (s.title || s.id.slice(0, 8)).slice(0, 28);
                const label = isCurrent ? `🟢 ${title}` : title;
                keyboard
                    .text(label,   actKey)
                    .text("🗑️",   delKey)
                    .row();
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

    private async handleSession(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.getActiveOrLastAgent(userId);
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

    private async handleSessionActivate(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        // sa:PREFIX:INDEX — look up agentId + sessionId from sessIndex
        const key = ctx.callbackQuery!.data;
        const entry = this.sessIndex.get(key);
        if (!entry) { await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const { agentId, sessionId: sessId } = entry;

        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {}); return; }

        const current = this.persistentAgentService.getSessionId(agentId);
        if (current === sessId) {
            await ctx.answerCallbackQuery({ text: "Ya es la sesión activa." });
            return;
        }

        // Tell the PersistentAgentService to use this session
        this.persistentAgentService.setSessionId(agentId, sessId);
        await ctx.answerCallbackQuery({ text: "✅ Sesión activada." });

        try {
            await this.sendSessionList(ctx, agent, true);
        } catch (err) {
            await ctx.editMessageText(ErrorUtils.createErrorMessage("activar sesión", err)).catch(() => {});
        }
    }

    private async handleSessionNew(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        // sn:PREFIX — look up agentId from sessIndex
        const key = ctx.callbackQuery!.data;
        const entry = this.sessIndex.get(key);
        if (!entry) { await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const { agentId } = entry;

        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {}); return; }

        try {
            const newSessId = await this.persistentAgentService.createNewSession(agent);
            this.persistentAgentService.setSessionId(agentId, newSessId);
            await ctx.answerCallbackQuery({ text: "✅ Nueva sesión creada." });
            await this.sendSessionList(ctx, agent, true);
        } catch (err) {
            await ctx.editMessageText(ErrorUtils.createErrorMessage("crear sesión", err)).catch(() => {});
        }
    }

    private async handleSessionDelete(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        // sx:PREFIX:INDEX — look up agentId + sessionId from sessIndex
        const key = ctx.callbackQuery!.data;
        const entry = this.sessIndex.get(key);
        if (!entry) { await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const { agentId, sessionId: sessId } = entry;

        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {}); return; }

        const baseUrl = `http://localhost:${agent.port}`;
        try {
            await fetch(`${baseUrl}/session/${sessId}`, {
                method: "DELETE",
                signal: AbortSignal.timeout(8000),
            });

            // If we deleted the active session, clear the cached ID so next send creates a new one
            const current = this.persistentAgentService.getSessionId(agentId);
            if (current === sessId) {
                this.persistentAgentService.setSessionId(agentId, "");
            }

            await ctx.answerCallbackQuery({ text: "🗑️ Sesión eliminada." });
            await this.sendSessionList(ctx, agent, true);
        } catch (err) {
            await ctx.editMessageText(ErrorUtils.createErrorMessage("eliminar sesión", err)).catch(() => {});
        }
    }

    private async handleSessionDeleteAll(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        // sd:PREFIX — look up agentId from sessIndex
        const key = ctx.callbackQuery!.data;
        const entry = this.sessIndex.get(key);
        if (!entry) { await ctx.editMessageText("⚠️ Botón expirado. Vuelve a ejecutar /session.").catch(() => {}); return; }
        const { agentId } = entry;

        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {}); return; }

        const baseUrl = `http://localhost:${agent.port}`;
        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (sessRes.ok) {
                const sessions: any[] = await sessRes.json();
                await Promise.all(sessions.map(s =>
                    fetch(`${baseUrl}/session/${s.id}`, { method: "DELETE", signal: AbortSignal.timeout(8000) }).catch(() => {})
                ));
            }

            // Clear cached session ID — next prompt will create a fresh one
            this.persistentAgentService.setSessionId(agentId, "");
            this.agentDb.setSessionId(agentId, "");

            await ctx.answerCallbackQuery({ text: "🗑️ Todas las sesiones eliminadas." });
            await this.sendSessionList(ctx, agent, true);
        } catch (err) {
            await ctx.editMessageText(ErrorUtils.createErrorMessage("eliminar sesiones", err)).catch(() => {});
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /undo & /redo (delegated to agent's opencode server)
    // ─────────────────────────────────────────────────────────────────────────

    private async handleUndo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo."); return; }

        const baseUrl = `http://localhost:${agent.port}`;
        try {
            // Get last session for this agent
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (!sessRes.ok) { await ctx.reply("❌ No se pudo conectar al servidor del agente."); return; }
            const sessions: any[] = await sessRes.json();
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

    private async handleRedo(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo."); return; }

        const baseUrl = `http://localhost:${agent.port}`;
        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (!sessRes.ok) { await ctx.reply("❌ No se pudo conectar al servidor del agente."); return; }
            const sessions: any[] = await sessRes.json();
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

    private getActiveOrLastAgent(userId: number): PersistentAgent | undefined {
        const activeId = this.persistentAgentService.getActiveAgentId(userId);
        if (activeId) return this.agentDb.getById(activeId);
        return this.agentDb.getLastUsed(userId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /delete — delete active session and immediately create a new one
    // ─────────────────────────────────────────────────────────────────────────

    private async handleDelete(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo. Activa uno con /agents."); return; }

        const sessionId = this.persistentAgentService.getSessionId(agent.id);
        if (!sessionId) { await ctx.reply("ℹ️ No hay sesión activa que borrar."); return; }

        const baseUrl = `http://localhost:${agent.port}`;
        try {
            await fetch(`${baseUrl}/session/${sessionId}`, {
                method: "DELETE",
                signal: AbortSignal.timeout(8000),
            });

            // Create a fresh session immediately
            const newSessId = await this.persistentAgentService.createNewSession(agent);
            this.persistentAgentService.setSessionId(agent.id, newSessId);

            await ctx.reply(
                `🗑️ Sesión eliminada.\n✅ Nueva sesión creada — lista para recibir mensajes.`
            );
        } catch (err) {
            await ctx.reply(ErrorUtils.createErrorMessage("eliminar sesión", err));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /deleteall — delete all sessions and immediately create a new one
    // ─────────────────────────────────────────────────────────────────────────

    private async handleDeleteAll(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo. Activa uno con /agents."); return; }

        const host = agent.host || 'localhost';
        const baseUrl = `http://${host}:${agent.port}`;
        try {
            const sessRes = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
            if (sessRes.ok) {
                const sessions: any[] = await sessRes.json();
                await Promise.all(sessions.map(s =>
                    fetch(`${baseUrl}/session/${s.id}`, { method: "DELETE", signal: AbortSignal.timeout(8000) }).catch(() => {})
                ));
            }

            // Clear cached ID and create a fresh session
            this.persistentAgentService.setSessionId(agent.id, "");
            const newSessId = await this.persistentAgentService.createNewSession(agent);
            this.persistentAgentService.setSessionId(agent.id, newSessId);

            await ctx.reply(
                `🗑️ Todas las sesiones eliminadas.\n✅ Nueva sesión creada — lista para recibir mensajes.`
            );
        } catch (err) {
            await ctx.reply(ErrorUtils.createErrorMessage("eliminar sesiones", err));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /rename — rename the active session of the active agent
    // ─────────────────────────────────────────────────────────────────────────

    private async handleRename(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agent = this.getActiveOrLastAgent(userId);
        if (!agent) { await ctx.reply("ℹ️ No hay agente activo. Activa uno con /agents."); return; }

        const sessionId = this.persistentAgentService.getSessionId(agent.id);
        if (!sessionId) { await ctx.reply("ℹ️ No hay sesión activa para renombrar."); return; }

        // Inline: /rename Nuevo nombre
        const inlineName = ctx.message?.text?.replace(/^\/rename\s*/i, "").trim() || "";
        if (inlineName) {
            await this.renameSession(ctx, agent, sessionId, inlineName);
        } else {
            // Enter wizard: wait for next text message
            this.renameWizard.set(userId, agent.id);
            await ctx.reply(
                `✏️ Escribe el nuevo nombre para la sesión actual de <b>${escapeHtml(agent.name)}</b>:\n<i>/esc para cancelar</i>`,
                { parse_mode: "HTML" }
            );
        }
    }

    private async handleRenameWizardText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;
        const agentId = this.renameWizard.get(userId);
        if (!agentId) return;
        this.renameWizard.delete(userId);

        const newName = ctx.message?.text?.trim() || "";
        if (!newName) { await ctx.reply("❌ Nombre vacío, operación cancelada."); return; }

        const agent = this.agentDb.getById(agentId);
        if (!agent) { await ctx.reply("❌ Agente no encontrado."); return; }

        const sessionId = this.persistentAgentService.getSessionId(agentId);
        if (!sessionId) { await ctx.reply("ℹ️ No hay sesión activa para renombrar."); return; }

        await this.renameSession(ctx, agent, sessionId, newName);
    }

    /** PATCH /session/:id with a new title */
    private async renameSession(ctx: Context, agent: PersistentAgent, sessionId: string, newName: string): Promise<void> {
        const baseUrl = `http://localhost:${agent.port}`;
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

    // ─────────────────────────────────────────────────────────────────────────
    // /restart
    // ─────────────────────────────────────────────────────────────────────────

    private async handleRestart(ctx: Context): Promise<void> {
        const msg = await ctx.reply("🔄 Reiniciando...");
        try {
            const { SessionDbService } = await import("../../services/session-db.service.js");
            const db = new SessionDbService();
            db.setState("restart_pending_chat_id", String(ctx.chat!.id));
            db.setState("restart_pending_message_id", String(msg.message_id));
        } catch { /* ignore */ }
        setTimeout(() => process.exit(0), 500);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Agent questions (heartbeat / question callbacks)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Called by PersistentAgentService when the model/opencode reports session.error.
     * The in-flight prompt has already been resolved with the error message.
     * This handler fires an extra notification only when there was NO pending prompt
     * (i.e. the error was spontaneous / background), so the user always knows.
     */
    private async handleAgentSessionError(agentId: string, errorMessage: string): Promise<void> {
        const bot = this.bot;
        if (!bot) return;

        const agent = this.agentDb.getById(agentId);
        if (!agent) return;

        // If there was a pending heartbeat message we already resolved it with the error.
        // Only send a separate notification if there is no heartbeat message registered
        // (meaning the error arrived outside of a user-initiated prompt).
        const hb = this.heartbeatMessages.get(agentId);
        if (hb) return; // already handled via sendPrompt resolution path

        try {
            await bot.api.sendMessage(
                agent.userId,
                `⚠️ <b>${escapeHtml(agent.name)}</b> — error del modelo:\n\n<code>${escapeHtml(errorMessage)}</code>`,
                { parse_mode: "HTML" }
            );
        } catch (err) {
            console.error("[OpenCodeBot] Failed to send session error notification:", err);
        }
    }

    private async handleAgentQuestion(agentId: string, req: any): Promise<void> {
        const bot = this.bot;
        if (!bot) return;

        const agent = this.agentDb.getById(agentId);
        if (!agent) return;

        const shortKey = randomUUID().slice(0, 8);
        this.pendingAgentQuestions.set(shortKey, { agentId, port: agent.port, req });

        // Build message text: show question + each option with its description
        const firstQ = req.questions?.[0];
        const questionText = firstQ?.question || "¿Qué prefieres?";

        let optionsText = "";
        const keyboard = new InlineKeyboard();

        if (firstQ?.options && Array.isArray(firstQ.options)) {
            firstQ.options.forEach((opt: any, idx: number) => {
                // opt can be a string or { label, description }
                const label = typeof opt === "string" ? opt : (opt.label ?? String(opt));
                const desc  = typeof opt === "object" && opt.description ? opt.description : "";
                // Use numeric index in callback_data to avoid byte-limit issues with long labels
                keyboard.text(label, `agq:${shortKey}:${idx}`).row();
                optionsText += `\n${idx + 1}. <b>${escapeHtml(label)}</b>`;
                if (desc) optionsText += `\n   <i>${escapeHtml(desc)}</i>`;
            });
        }

        keyboard.text("❌ Rechazar", `agq:${shortKey}:r`);

        try {
            await bot.api.sendMessage(
                agent.userId,
                `❓ <b>${escapeHtml(agent.name)}</b> tiene una pregunta:\n\n` +
                `${escapeHtml(questionText)}` +
                (optionsText ? `\n${optionsText}` : ""),
                { parse_mode: "HTML", reply_markup: keyboard }
            );
        } catch (err) {
            console.error("[OpenCodeBot] Failed to send question:", err);
        }
    }

    private async handleAgentQuestionCallback(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const data = ctx.callbackQuery!.data; // agq:SHORTKEY:IDX or agq:SHORTKEY:r
        const match = data.match(/^agq:([^:]+):(.+)$/);
        if (!match) return;
        const shortKey = match[1];
        const answerKey = match[2];

        const pending = this.pendingAgentQuestions.get(shortKey);
        if (!pending) {
            await ctx.editMessageText("⚠️ Esta pregunta ya fue respondida o expiró.").catch(() => {});
            return;
        }
        this.pendingAgentQuestions.delete(shortKey);

        if (answerKey === "r") {
            const agent = this.agentDb.getById(pending.agentId);
            if (!agent) {
                await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {});
                return;
            }
            await this.persistentAgentService.rejectQuestion(agent, pending.req.id);
            await ctx.editMessageText("❌ Rechazado.").catch(() => {});
        } else {
            // answerKey is the numeric index into options
            const idx = parseInt(answerKey, 10);
            const firstQ = pending.req.questions?.[0];
            const opt = firstQ?.options?.[idx];
            const label = typeof opt === "string" ? opt : (opt?.label ?? String(opt ?? answerKey));
            const agent = this.agentDb.getById(pending.agentId);
            if (!agent) {
                await ctx.editMessageText("❌ Agente no encontrado.").catch(() => {});
                return;
            }
            await this.persistentAgentService.replyQuestion(agent, pending.req.id, [[label]]);
            await ctx.editMessageText(`✅ Respondido: <b>${escapeHtml(label)}</b>`, { parse_mode: "HTML" }).catch(() => {});
        }
    }

    private async handleAgentHeartbeat(agentId: string, summary: HeartbeatSummary): Promise<void> {
        const bot = this.bot;
        if (!bot) return;

        const agent = this.agentDb.getById(agentId);
        if (!agent) return;

        // Build rich heartbeat text
        const toolLine = summary.lastToolName ? `\n🔧 <code>${escapeHtml(summary.lastToolName)}</code>` : "";
        const textLine = summary.lastText ? `\n💬 <i>${escapeHtml(summary.lastText.slice(0, 120))}</i>` : "";
        const filesEdited = summary.filesModified;
        const statsLine = `\n📊 ${summary.messageCount} mensajes · ${filesEdited} archivo${filesEdited !== 1 ? "s" : ""} editado${filesEdited !== 1 ? "s" : ""}`;
        const text = `⏳ <b>${escapeHtml(agent.name)}</b> — trabajando (${summary.minutesRunning} min)${toolLine}${textLine}${statsLine}`;

        const existing = this.heartbeatMessages.get(agentId);
        if (existing) {
            // Subsequent ticks: edit the same message
            await bot.api.editMessageText(existing.chatId, existing.msgId, text, { parse_mode: "HTML" }).catch(() => {});
        } else {
            // First tick: send a new message and register it as the heartbeat anchor
            const msg = await bot.api.sendMessage(agent.userId, text, { parse_mode: "HTML" }).catch(() => null);
            if (msg) {
                this.heartbeatMessages.set(agentId, { chatId: agent.userId, msgId: msg.message_id });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // File uploads
    // ─────────────────────────────────────────────────────────────────────────

    private async handleFileUpload(ctx: Context): Promise<void> {
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

            if (isAudio && this.transcriptionService.isConfigured()) {
                const userId = ctx.from?.id;
                if (!userId) return;

                const statusMsg = await ctx.reply("🎙️ Transcribiendo audio...");

                const result = await this.transcriptionService.transcribeAudio(savePath);

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

                const activeId = this.persistentAgentService.getActiveAgentId(userId)
                    ?? this.agentDb.getLastUsed(userId)?.id;

                if (activeId) {
                    const agent = this.agentDb.getById(activeId);
                    if (agent) {
                        await this.sendPromptToAgent(ctx, agent, `[Audio transcrito]\n\n${transcription}`);
                        return;
                    }
                }

                await ctx.reply("ℹ️ Transcripción lista. Usa /agents para activar un agente.");
                return;
            }

            if (isAudio && !this.transcriptionService.isConfigured()) {
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

            await MessageUtils.scheduleMessageDeletion(ctx, confirmMsg.message_id, this.configService.getMessageDeleteTimeout());
        } catch (error) {
            await ctx.reply(ErrorUtils.createErrorMessage("guardar archivo", error));
        }
    }
    
    /**
     * Handle selecting a remote agent.
     * Registers it in the local DB (with isRemote=true) and activates it as a
     * normal sticky agent — messages flow through sendPromptToAgent exactly like local.
     */
    private async handleRemoteAgentSelect(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const key = ctx.callbackQuery!.data.replace("remote:select:", "");
        const info = this.remoteAgentIndex.get(key);
        if (!info) {
            await ctx.editMessageText("❌ Datos del agente remoto no encontrados. Vuelve a hacer /agents <ip>.");
            return;
        }

        const { host, port, project, workdir, sessionId, model } = info;
        const defaultModel = model || process.env.OPENCODE_DEFAULT_MODEL || "github-copilot/claude-sonnet-4.6";

        // Reuse existing DB entry for this host:port, or create a new one
        const existingAll = this.agentDb.getAll();
        let agent = existingAll.find(a => a.host === host && a.port === port && a.isRemote);

        if (!agent) {
            agent = {
                id: randomUUID(),
                userId,
                name: `${project} (${host})`,
                role: "",
                workdir: workdir || `/remote/${host}/${project}`,
                model: defaultModel,
                port,
                sessionId,
                status: "running",
                createdAt: new Date().toISOString(),
                host,
                isRemote: true,
            };
            this.agentDb.save(agent);
        } else {
            // Update userId and sessionId in case they changed
            agent = { ...agent, userId, sessionId: sessionId ?? agent.sessionId };
            this.agentDb.save(agent);
        }

        // Connect SSE stream (startAgent detects it's already running, just opens SSE)
        await this.persistentAgentService.startAgent(agent);

        // Activate as sticky — from now on all messages go here via normal handleMessage
        this.persistentAgentService.setActiveAgent(userId, agent.id);
        this.agentDb.setLastUsed(userId, agent.id);

        await ctx.editMessageText(
            `✅ <b>${escapeHtml(agent.name)}</b> activo\n\n` +
            `📡 ${host}:${port}\n` +
            `Todos tus mensajes van a este agente. Usa /esc para desactivar.`,
            { parse_mode: "HTML" }
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // /remoto <ip> — switch user context to a remote node
    // /local       — switch back to local context
    // ─────────────────────────────────────────────────────────────────────────

    private async handleRemoto(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const ip = ctx.message?.text?.replace(/^\/remoto\s*/i, "").trim() || "";

        if (!ip) {
            const current = this.getContextHost(userId);
            if (current) {
                await ctx.reply(
                    `📡 Contexto actual: <b>remoto</b> → <code>${escapeHtml(current)}</code>\n\n` +
                    `Usa /local para volver al contexto local.`,
                    { parse_mode: "HTML" }
                );
            } else {
                await ctx.reply(
                    `ℹ️ Debes indicar la IP o host del nodo remoto:\n<code>/remoto 192.168.1.10</code>`,
                    { parse_mode: "HTML" }
                );
            }
            return;
        }

        // Basic IP/hostname validation
        const ipRegex = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*)$/;
        if (!ipRegex.test(ip)) {
            await ctx.reply(`❌ Formato de IP/host inválido: <code>${escapeHtml(ip)}</code>`, { parse_mode: "HTML" });
            return;
        }

        // Verify the remote node is reachable before switching context
        const discoveryPort = parseInt(process.env.DISCOVERY_PORT || '17000', 10);
        try {
            const res = await fetch(`http://${ip}:${discoveryPort}/discovery`, {
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                await ctx.reply(`❌ El nodo <code>${escapeHtml(ip)}</code> respondió con HTTP ${res.status}.`, { parse_mode: "HTML" });
                return;
            }
            const data = await res.json() as any;
            const agentCount = (data.agents || []).length;

            // Set context
            this.remoteContext.set(userId, ip);

            // Clear active agent — the user should pick or create one in the remote context
            this.persistentAgentService.clearActiveAgent(userId);

            await ctx.reply(
                `📡 <b>Contexto cambiado a remoto: <code>${escapeHtml(ip)}</code></b>\n\n` +
                `${agentCount} agente${agentCount !== 1 ? 's' : ''} disponible${agentCount !== 1 ? 's' : ''} en ese nodo.\n\n` +
                `Ahora todos los comandos operan en ese nodo:\n` +
                `• /agents — ver agentes remotos\n` +
                `• /new — crear agente en el nodo remoto\n` +
                `• /deleteall — borrar registros de agentes remotos\n\n` +
                `Usa /local para volver al contexto local.`,
                { parse_mode: "HTML" }
            );
        } catch (err: any) {
            await ctx.reply(
                `❌ No se pudo conectar al nodo <code>${escapeHtml(ip)}</code>:${discoveryPort}\n${escapeHtml(err.message || String(err))}`,
                { parse_mode: "HTML" }
            );
        }
    }

    private async handleLocal(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const previous = this.getContextHost(userId);
        this.remoteContext.delete(userId);
        this.persistentAgentService.clearActiveAgent(userId);

        if (previous) {
            await ctx.reply(
                `🏠 <b>Contexto cambiado a local</b>\n\nYa no estás conectado a <code>${escapeHtml(previous)}</code>.\n` +
                `Todos los comandos operan en esta máquina.`,
                { parse_mode: "HTML" }
            );
        } else {
            await ctx.reply(`🏠 Ya estás en contexto local.`);
        }
    }
}
