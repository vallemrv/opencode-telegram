/**
 * ProjectsHandler — Unified project explorer + wizard.
 *
 * Explorer: Navigate directories, create folders, open/create servers
 * Wizard: Name → Git → Model → Create server (integrates /new functionality)
 */

import { Context, InlineKeyboard } from "grammy";
import { execSync } from "child_process";
import * as fs from "fs";
import * as nodePath from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import type { PersistentAgent } from "../../../services/agent-db.service.js";
import { pickPort, resolveDir, findOpencodeCmd } from "../../../services/persistent-agent.service.js";
import { escapeHtml } from "../event-handlers/utils.js";
import type { BotContext } from "./bot-context.js";

// ─── Path helpers ─────────────────────────────────────────────────────────────

function resolveHome(p: string): string {
    if (p.startsWith("~/") || p === "~") return nodePath.join(os.homedir(), p.slice(1));
    return p;
}

function workspaceDir(): string {
    const raw = process.env.ROOT_PATH_INIT || process.env.WORKSPACE_DIR || "~/proyectos";
    if (raw.startsWith("~/") || raw === "~") return nodePath.join(os.homedir(), raw.slice(1));
    return raw;
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

    const createRes = await fetch(`${url}/api/v1/user/repos`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, auto_init: true, private: false }),
    });

    if (createRes.ok) {
        const d: any = await createRes.json();
        return { cloneUrl: d.clone_url, htmlUrl: d.html_url, sshUrl: d.ssh_url };
    }

    const meRes = await fetch(`${url}/api/v1/user`, { headers });
    if (!meRes.ok) return null;
    const me: any = await meRes.json();
    const getRes = await fetch(`${url}/api/v1/repos/${me.login}/${name}`, { headers });
    if (!getRes.ok) return null;
    const d: any = await getRes.json();
    return { cloneUrl: d.clone_url, htmlUrl: d.html_url, sshUrl: d.ssh_url };
}

// ─── Wizard state ─────────────────────────────────────────────────────────────

interface ProjectWizard {
    step: "git" | "model" | "server";
    absPath: string;          // resolved absolute path to the project folder
    projectName: string;      // basename of the folder
    gitSource?: "none" | "github" | "gitea" | "local" | "existing";
    model?: string;
    existingGit: boolean;
}

export class ProjectsHandler {
    private readonly pathIndex = new Map<string, string>();
    private readonly wizardState = new Map<number, ProjectWizard>();
    private readonly createFolderPrompt = new Map<number, string>();
    private pathIndexCounter = 0;

    constructor(private readonly ctx: BotContext) {}

    // Public helpers for state checking
    isWizardModel(userId: number): boolean {
        const wizard = this.wizardState.get(userId);
        return wizard?.step === "model";
    }

    isCreateFolderPrompt(userId: number): boolean {
        return this.createFolderPrompt.has(userId);
    }

    private makeKey(absPath: string): string {
        const key = `p${this.pathIndexCounter++}`;
        this.pathIndex.set(key, absPath);
        return key;
    }

    private readonly userRoots = new Map<number, string>();

    private isRoot(userId: number, absPath: string): boolean {
        const root = this.userRoots.get(userId) || workspaceDir();
        return absPath === root;
    }

    // ─── /proyectos [path] ────────────────────────────────────────────────────────

    async handleProjects(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
        const pathArg = args[0]?.trim();

        let startPath: string;
        if (pathArg) {
            startPath = resolveHome(pathArg);
            if (!nodePath.isAbsolute(startPath)) startPath = nodePath.join(workspaceDir(), startPath);
            if (!fs.existsSync(startPath)) {
                await ctx.reply(`❌ El directorio no existe: <code>${escapeHtml(startPath)}</code>`, { parse_mode: "HTML" });
                return;
            }
            if (!fs.statSync(startPath).isDirectory()) {
                await ctx.reply(`❌ No es un directorio: <code>${escapeHtml(startPath)}</code>`, { parse_mode: "HTML" });
                return;
            }
        } else {
            startPath = workspaceDir();
        }

        this.userRoots.set(userId, startPath);
        await this.showExplorer(ctx, userId, startPath);
    }

    // ─── Explorer: Directory listing ──────────────────────────────────────────────

    private async showExplorer(ctx: Context, userId: number, absPath: string, editMsgId?: number): Promise<void> {
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

        // Botón: Abrir servidor aquí
        const existingServers = allAgents.filter(a => resolveDir(a.workdir) === resolveDir(absPath));
        let openIcon = "⚡";
        if (existingServers.length > 0) {
            openIcon = existingServers.some(s => s.id === activeId) ? "✅" : "🟢";
        }
        const openKey = this.makeKey(absPath);
        keyboard.text(`${openIcon} Abrir aquí`, `proj:open:${openKey}`).row();

        // Botón: Crear folder (siempre disponible)
        const createKey = this.makeKey(absPath);
        keyboard.text("🆕 Crear folder", `proj:create-folder:${createKey}`).row();

        // Subcarpetas
        for (const name of dirs) {
            const subPath = nodePath.join(absPath, name);
            const hasServer = allAgents.some(a => resolveDir(a.workdir) === resolveDir(subPath));
            const isActive = allAgents.some(a => a.id === activeId && resolveDir(a.workdir) === resolveDir(subPath));
            const prefix = isActive ? "✅" : hasServer ? "🟢" : "📁";
            const key = this.makeKey(subPath);
            keyboard.text(`${prefix} ${name}`, `proj:nav:${key}`).row();
        }

        // Botón atrás
        if (!this.isRoot(userId, absPath)) {
            const parentPath = nodePath.dirname(absPath);
            const parentKey = this.makeKey(parentPath);
            keyboard.text("⬅️ Atrás", `proj:nav:${parentKey}`);
        }

        const maxAgents = this.ctx.configService.getMaxAgents();
        const running = this.ctx.agentDb.countRunningLocal();
        const relPath = this.isRoot(userId, absPath) ? "/" : nodePath.relative(workspaceDir(), absPath) || "/";

        const header =
            `📂 <b>${escapeHtml(relPath)}</b>\n` +
            `Servidores activos: ${running}/${maxAgents}\n\n` +
            (dirs.length === 0 && this.isRoot(userId, absPath)
                ? `No hay subdirectorios. Pulsa 🆕 para crear uno.`
                : dirs.length === 0
                ? `Esta carpeta está vacía. Puedes abrir servidor aquí o crear folder.`
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

    // ─── proj:nav:<key> — Navigate into directory ───────────────────────────────

    async handleProjectNav(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:nav:")) return;
        const key = data.slice("proj:nav:".length);
        const absPath = this.pathIndex.get(key);
        if (!absPath) {
            await ctx.reply("❌ Ruta caducada, ejecuta /proyectos de nuevo.");
            return;
        }
        if (!fs.existsSync(absPath)) {
            await ctx.reply(`❌ Ya no existe: <code>${escapeHtml(absPath)}</code>`, { parse_mode: "HTML" });
            return;
        }
        const msgId = ctx.callbackQuery?.message?.message_id;
        await this.showExplorer(ctx, userId, absPath, msgId);
    }

    // ─── proj:open:<key> — Open server in directory ──────────────────────────────

    async handleProjectOpen(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:open:")) return;
        const key = data.slice("proj:open:".length);
        const absPath = this.pathIndex.get(key);
        if (!absPath) {
            await ctx.reply("❌ Ruta caducada, ejecuta /proyectos de nuevo.");
            return;
        }
        if (!fs.existsSync(absPath)) {
            await ctx.reply(`❌ Ya no existe: <code>${escapeHtml(absPath)}</code>`, { parse_mode: "HTML" });
            return;
        }

        const absPathResolved = resolveDir(absPath);
        const existingServers = this.ctx.agentDb.getAll().filter(a => resolveDir(a.workdir) === absPathResolved);
        const projectName = nodePath.basename(absPath) || "workspace";

        // Existing server(s) in this folder → show list
        if (existingServers.length > 0) {
            const keyboard = new InlineKeyboard();
            const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);

            for (const server of existingServers) {
                const isActive = server.id === activeId;
                const icon = isActive ? "✅" : server.status === "running" ? "🟢" : "🔴";
                keyboard.text(`${icon} ${escapeHtml(server.name)} [${server.model}]`, `proj:activate:${server.id}`).row();
            }

            keyboard.text("🆕 Crear nuevo server aquí", `proj:wizard:${key}`).row();
            keyboard.text("❌ Cancelar", `proj:cancel`);

            await ctx.deleteMessage().catch(() => {});
            await ctx.reply(
                `⚡ <b>${escapeHtml(projectName)}</b> — servidores existentes:\n\n` +
                existingServers.map(s => `• <b>${escapeHtml(s.name)}</b> [${escapeHtml(s.model)}]`).join("\n"),
                { parse_mode: "HTML", reply_markup: keyboard }
            );
            return;
        }

        // No server → start wizard directly with this folder
        await this.startWizard(ctx, userId, absPath);
    }

    // ─── proj:activate:<agentId> — Activate existing server ──────────────────────

    async handleProjectActivate(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:activate:")) return;
        const agentId = data.slice("proj:activate:".length);
        const agent = this.ctx.agentDb.getById(agentId);
        if (!agent) {
            await ctx.reply("❌ Server no encontrado.", { parse_mode: "HTML" });
            return;
        }

        this.ctx.persistentAgentService.setActiveAgent(userId, agent.id);
        this.ctx.agentDb.setLastUsed(userId, agent.id);
        this.ctx.persistentAgentService.touchLastUsed(agent.id);

        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
            `✅ <b>${escapeHtml(agent.name)}</b> activado.\n` +
            `Tus mensajes van a este servidor. /esc para desactivar.`,
            { parse_mode: "HTML" }
        );
    }

    // ─── proj:create-folder:<key> — Prompt for folder name ──────────────────────

    async handleCreateFolder(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:create-folder:")) return;
        const key = data.slice("proj:create-folder:".length);
        const absPath = this.pathIndex.get(key);
        if (!absPath) {
            await ctx.reply("❌ Ruta caducada, ejecuta /proyectos de nuevo.");
            return;
        }

        this.createFolderPrompt.set(userId, absPath);
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(
            `🆕 <b>Crear folder en:</b> <code>${escapeHtml(absPath)}</code>\n\n` +
            `Escribe el nombre del folder:`,
            { parse_mode: "HTML" }
        );
    }

    // ─── Text handler: Create folder name ───────────────────────────────────────

    async handleCreateFolderText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const absPath = this.createFolderPrompt.get(userId);
        if (!absPath) return;

        const name = ctx.message?.text?.trim();
        if (!name) {
            await ctx.reply("❌ Nombre vacío.", { parse_mode: "HTML" });
            return;
        }

        // Validate name
        if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
            await ctx.reply("❌ Nombre inválido (no usar /, \\, o .)", { parse_mode: "HTML" });
            return;
        }

        const newPath = nodePath.join(absPath, name);
        if (fs.existsSync(newPath)) {
            await ctx.reply(`❌ Ya existe: <code>${escapeHtml(newPath)}</code>`, { parse_mode: "HTML" });
            return;
        }

        try {
            fs.mkdirSync(newPath, { recursive: true });
            this.createFolderPrompt.delete(userId);
            await ctx.reply(`✅ Folder creado: <code>${escapeHtml(newPath)}</code>`, { parse_mode: "HTML" });
            await this.showExplorer(ctx, userId, absPath);
        } catch (err) {
            await ctx.reply(`❌ Error: ${escapeHtml(String(err))}`, { parse_mode: "HTML" });
        }
    }

    // ─── Wizard: Start (no existing server) ─────────────────────────────────────

    /**
     * Start the wizard for a given folder.
     * absPath must be the resolved project folder (already chosen by the user).
     */
    private async startWizard(
        ctx: Context,
        userId: number,
        absPath: string,
    ): Promise<void> {
        const projectPath = resolveDir(absPath);
        const projectName = nodePath.basename(projectPath) || "project";
        const existingGit = fs.existsSync(nodePath.join(projectPath, ".git"));

        await ctx.deleteMessage().catch(() => {});

        const wizard: ProjectWizard = {
            step: "git",
            absPath: projectPath,
            projectName,
            existingGit,
        };
        this.wizardState.set(userId, wizard);

        if (existingGit) {
            // Skip git step — already has git
            wizard.gitSource = "existing";
            wizard.step = "model";
            await this.askWizardModel(ctx, userId);
        } else {
            await this.askWizardGit(ctx, userId);
        }
    }

    // ─── proj:wizard:<key> — Start wizard from existing servers menu ────────────

    async handleWizardStart(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:wizard:")) return;
        const key = data.slice("proj:wizard:".length);
        const absPath = this.pathIndex.get(key);
        if (!absPath) {
            await ctx.reply("❌ Ruta caducada, ejecuta /proyectos de nuevo.");
            return;
        }

        // absPath is the chosen directory — start wizard directly
        await this.startWizard(ctx, userId, absPath);
    }

    // ─── Wizard Step 1: Git ─────────────────────────────────────────────────────

    private async askWizardGit(ctx: Context, userId: number): Promise<void> {
        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        const isGitea = !!process.env.GITEA_URL && !!process.env.GITEA_TOKEN;
        const isGithub = !!process.env.GITHUB_TOKEN;
        const folderExists = fs.existsSync(wizard.absPath);

        const keyboard = new InlineKeyboard();

        let msg: string;
        if (folderExists && !wizard.existingGit) {
            // Existing folder without git
            keyboard.text("✅ Inicializar git local", `proj:wizard-git:local`).row();
            keyboard.text("❌ Sin git", `proj:wizard-git:none`).row();
            msg =
                `🔀 <b>Step 1/3: Git</b>\n\n` +
                `Carpeta: <b>${escapeHtml(wizard.projectName)}</b>\n` +
                `La carpeta ya existe sin git.\n\n` +
                `¿Inicializar git localmente?`;
        } else {
            // New folder or no git
            keyboard.text("❌ Sin git", `proj:wizard-git:none`).row();
            if (isGithub) keyboard.text("🐙 GitHub", `proj:wizard-git:github`).row();
            if (isGitea) keyboard.text("☕ Gitea", `proj:wizard-git:gitea`).row();
            keyboard.text("✅ Git local", `proj:wizard-git:local`).row();
            msg =
                `🔀 <b>Step 1/3: Git</b>\n\n` +
                `Carpeta: <b>${escapeHtml(wizard.projectName)}</b>\n\n` +
                `¿Configurar repositorio?`;
        }

        keyboard.text("❌ Cancelar", `proj:cancel`);

        await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
    }

    async handleWizardGit(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:wizard-git:")) return;
        const source = data.slice("proj:wizard-git:".length) as ProjectWizard["gitSource"];

        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        wizard.gitSource = source;
        wizard.step = "model";
        await ctx.deleteMessage().catch(() => {});
        await this.askWizardModel(ctx, userId);
    }

    // ─── Wizard Step 3: Model ───────────────────────────────────────────────────

    private async askWizardModel(ctx: Context, userId: number): Promise<void> {
        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        // Fetch models from opencode CLI
        let modelsCache: Record<string, string[]> = {};
        try {
            const opencodeCmd = await findOpencodeCmd();
            const output = execSync(`"${opencodeCmd}" models 2>/dev/null`, { encoding: "utf-8" });
            for (const line of output.trim().split("\n")) {
                const trimmed = line.trim();
                if (trimmed && trimmed.includes("/")) {
                    const [provider, ...modelParts] = trimmed.split("/");
                    const model = modelParts.join("/");
                    if (!modelsCache[provider]) modelsCache[provider] = [];
                    modelsCache[provider].push(`${provider}/${model}`);
                }
            }
        } catch (err) {
            console.error("askWizardModel: error fetching models", err);
        }

        const providers = Object.keys(modelsCache).sort();

        this.ctx.modelSelection.set(userId, {
            agentId: `wizard:${userId}`,
            modelsCache,
            providers,
        });

        const keyboard = new InlineKeyboard();
        for (const provider of providers) {
            const shortKey = this.ctx.makeShortKey("wmdl_pr_");
            this.ctx.modelIndex.set(shortKey, provider);
            keyboard.text(provider, shortKey).row();
        }
        keyboard.text("❌ Cancelar", `proj:cancel`);

        const gitStatus = wizard.gitSource === "existing"
            ? "✅ Git existente"
            : wizard.gitSource === "local"
            ? "✅ Git local"
            : wizard.gitSource === "none"
            ? "❌ Sin git"
            : wizard.gitSource === "github"
            ? "🐙 GitHub"
            : "☕ Gitea";

        await ctx.reply(
            `🤖 <b>Step 2/3: Modelo</b>\n\n` +
            `Carpeta: <b>${escapeHtml(wizard.projectName)}</b>\n` +
            `Git: ${gitStatus}\n\n` +
            `Elige proveedor:`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    // ─── Wizard Model picker callbacks (wmdl_*) ────────────────────────────────

    async handleWizardModelPicker(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data) return;

        const wizard = this.wizardState.get(userId);
        if (!wizard) { await ctx.editMessageText("❌ Sesión expirada. Reinicia el wizard."); return; }

        const state = this.ctx.modelSelection.get(userId);

        // Provider selected — show model list
        if (data.startsWith("wmdl_pr_")) {
            if (!state) { await ctx.editMessageText("❌ Sesión expirada. Reinicia el wizard."); return; }
            const provider = this.ctx.modelIndex.get(data);
            if (!provider) { await ctx.editMessageText("❌ Proveedor no encontrado."); return; }

            const models = state.modelsCache[provider] || [];
            const keyboard = new InlineKeyboard();
            for (const model of models) {
                const modelName = model.split("/").slice(1).join("/");
                const shortKey = this.ctx.makeShortKey("wmdl_mo_");
                this.ctx.modelIndex.set(shortKey, model);
                keyboard.text(modelName, shortKey).row();
            }
            keyboard.text("← Volver", "wmdl_back").row();

            state.currentProvider = provider;
            await ctx.editMessageText(
                `🧠 <b>${escapeHtml(provider)}</b> — elige modelo:`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
            return;
        }

        // Back to provider list
        if (data === "wmdl_back") {
            if (!state) { await ctx.editMessageText("❌ Sesión expirada. Reinicia el wizard."); return; }
            const keyboard = new InlineKeyboard();
            for (const provider of state.providers) {
                const shortKey = this.ctx.makeShortKey("wmdl_pr_");
                this.ctx.modelIndex.set(shortKey, provider);
                keyboard.text(provider, shortKey).row();
            }
            keyboard.text("❌ Cancelar", `proj:cancel`).row();
            await ctx.editMessageText(
                `🤖 <b>Step 2/3: Modelo</b>\n\nElige proveedor:`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
            return;
        }

        // Model selected → go to server step
        if (data.startsWith("wmdl_mo_")) {
            const model = this.ctx.modelIndex.get(data);
            if (!model) { await ctx.editMessageText("❌ Modelo no encontrado."); return; }

            this.ctx.modelSelection.delete(userId);
            wizard.model = model;
            wizard.step = "server";
            await this.askWizardServer(ctx, userId);
            return;
        }
    }

    // ─── Wizard Step 3: Server selector ────────────────────────────────────────

    private async askWizardServer(ctx: Context, userId: number): Promise<void> {
        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        const allServers = this.ctx.agentDb.getAll();
        const keyboard = new InlineKeyboard();

        for (const server of allServers) {
            const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId);
            const icon = server.id === activeId ? "✅" : server.status === "running" ? "🟢" : "🔴";
            keyboard.text(
                `${icon} ${server.name} [${server.model.split("/").slice(-1)[0]}]`,
                `proj:wizard-server:${server.id}`
            ).row();
        }

        keyboard.text("🆕 Nuevo servidor", `proj:wizard-server:new`).row();
        keyboard.text("❌ Cancelar", `proj:cancel`);

        const gitStatus = wizard.gitSource === "existing"
            ? "✅ Git existente"
            : wizard.gitSource === "local"
            ? "✅ Git local"
            : wizard.gitSource === "none"
            ? "❌ Sin git"
            : wizard.gitSource === "github"
            ? "🐙 GitHub"
            : "☕ Gitea";

        await ctx.reply(
            `🖥️ <b>Step 3/3: Servidor</b>\n\n` +
            `Carpeta: <b>${escapeHtml(wizard.projectName)}</b>\n` +
            `Git: ${gitStatus}\n` +
            `Modelo: <code>${escapeHtml(wizard.model!)}</code>\n\n` +
            `Elige un servidor existente para reasignar o crea uno nuevo:`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    async handleWizardServer(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:wizard-server:")) return;

        const wizard = this.wizardState.get(userId);
        if (!wizard) { await ctx.reply("❌ Sesión expirada."); return; }

        const choice = data.slice("proj:wizard-server:".length);

        if (choice === "new") {
            await this.launchProject(ctx, userId, wizard, null);
        } else {
            const existing = this.ctx.agentDb.getById(choice);
            if (!existing) { await ctx.reply("❌ Servidor no encontrado."); return; }
            await this.launchProject(ctx, userId, wizard, existing);
        }
    }

    // ─── Wizard: Cancel ────────────────────────────────────────────────────────

    async handleWizardCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        this.wizardState.delete(userId);
        this.createFolderPrompt.delete(userId);

        await ctx.deleteMessage().catch(() => {});
        await ctx.reply("❌ Wizard cancelado.", { parse_mode: "HTML" });
    }

    // ─── Project Launch ─────────────────────────────────────────────────────────

    private async launchProject(
        ctx: Context,
        userId: number,
        wizard: ProjectWizard,
        reuseAgent: PersistentAgent | null,
    ): Promise<void> {
        const projectPath = wizard.absPath;
        const projectName = wizard.projectName;

        await ctx.deleteMessage().catch(() => {});

        // Ensure folder exists
        if (!fs.existsSync(projectPath)) {
            try {
                fs.mkdirSync(projectPath, { recursive: true });
            } catch (err) {
                await ctx.reply(`❌ Error creando carpeta: ${escapeHtml(String(err))}`, { parse_mode: "HTML" });
                this.wizardState.delete(userId);
                return;
            }
        }

        // Git setup
        if (wizard.gitSource !== "none" && wizard.gitSource !== "existing") {
            const statusMsg = await ctx.reply(`⏳ Configurando git...`, { parse_mode: "HTML" });
            try {
                if (wizard.gitSource === "github") {
                    const repo = await githubCreateRepo(projectName);
                    if (repo) {
                        execSync(`git clone ${repo.cloneUrl} "${projectPath}"`, { stdio: "ignore" });
                        await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                            `✅ GitHub: <a href="${repo.htmlUrl}">${escapeHtml(projectName)}</a>`,
                            { parse_mode: "HTML" });
                    }
                } else if (wizard.gitSource === "gitea") {
                    const repo = await giteaCreateOrGetRepo(projectName);
                    if (repo) {
                        execSync(`git clone ${repo.cloneUrl} "${projectPath}"`, { stdio: "ignore" });
                        await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                            `✅ Gitea: <a href="${repo.htmlUrl}">${escapeHtml(projectName)}</a>`,
                            { parse_mode: "HTML" });
                    }
                } else if (wizard.gitSource === "local") {
                    if (!fs.existsSync(nodePath.join(projectPath, ".git"))) {
                        execSync(`git init "${projectPath}"`, { stdio: "ignore" });
                    }
                    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                        `✅ Git inicializado`, { parse_mode: "HTML" });
                }
            } catch (err) {
                await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                    `⚠️ Git falló: ${escapeHtml(String(err))}\nContinuando...`, { parse_mode: "HTML" });
            }
        }

        // Ensure AGENTS.md
        const agentsPath = nodePath.join(projectPath, "AGENTS.md");
        if (!fs.existsSync(agentsPath)) {
            try { fs.writeFileSync(agentsPath, `# ${projectName}\n\nProject created via TelegramCoder.\n`, "utf8"); } catch { /* ignore */ }
        }

        // Ensure opencode.json
        const opencodeJsonPath = nodePath.join(projectPath, "opencode.json");
        if (!fs.existsSync(opencodeJsonPath)) {
            try { fs.writeFileSync(opencodeJsonPath, JSON.stringify({ "$schema": "https://opencode.ai/config.json" }) + "\n", "utf8"); } catch { /* ignore */ }
        }

        if (reuseAgent) {
            // ── Reasignar servidor existente ─────────────────────────────────
            const statusMsg = await ctx.reply(
                `⏳ Parando <b>${escapeHtml(reuseAgent.name)}</b>...`,
                { parse_mode: "HTML" }
            );

            await this.ctx.persistentAgentService.evictAgent(reuseAgent);

            // Update agent in DB
            reuseAgent.workdir = projectPath;
            reuseAgent.model   = wizard.model!;
            reuseAgent.name    = projectName;
            reuseAgent.status  = "running";
            reuseAgent.lastUsedAt = new Date().toISOString();
            this.ctx.agentDb.save(reuseAgent);

            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                `⏳ Arrancando <b>${escapeHtml(projectName)}</b>...`, { parse_mode: "HTML" });

            const result = await this.ctx.persistentAgentService.startAgent(reuseAgent);
            if (!result.success) {
                this.ctx.agentDb.delete(reuseAgent.id);
                await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                    `❌ No se pudo arrancar: ${escapeHtml(result.message)}`, { parse_mode: "HTML" });
                this.wizardState.delete(userId);
                return;
            }

            this.ctx.persistentAgentService.setActiveAgent(userId, reuseAgent.id);
            this.ctx.agentDb.setLastUsed(userId, reuseAgent.id);
            this.wizardState.delete(userId);

            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                `✅ <b>${escapeHtml(projectName)}</b> listo (servidor reasignado).\n` +
                `Modelo: <code>${escapeHtml(wizard.model!)}</code>\n\n` +
                `Tus mensajes van a este servidor. /esc para desactivar.`,
                { parse_mode: "HTML" });

        } else {
            // ── Nuevo servidor ────────────────────────────────────────────────
            const maxAgents = this.ctx.configService.getMaxAgents();
            const runningCount = this.ctx.agentDb.countRunningLocal();

            if (runningCount >= maxAgents) {
                const lruCandidates = this.ctx.agentDb.getRunningOrderedByLRU();
                const evictCandidate = lruCandidates[0];
                if (!evictCandidate) {
                    await ctx.reply("❌ Error: no se encontró servidor a evictar.", { parse_mode: "HTML" });
                    this.wizardState.delete(userId);
                    return;
                }
                await ctx.reply(
                    `♻️ Todos los slots ocupados (${runningCount}/${maxAgents})\n` +
                    `Parando <b>${escapeHtml(evictCandidate.name)}</b>...`,
                    { parse_mode: "HTML" }
                );
                await this.ctx.persistentAgentService.evictAgent(evictCandidate);
            }

            const port = pickPort(this.ctx.agentDb.usedPorts());
            const agent: PersistentAgent = {
                id: randomUUID(),
                userId,
                name: projectName,
                role: "",
                workdir: projectPath,
                model: wizard.model!,
                port,
                status: "running",
                createdAt: new Date().toISOString(),
                lastUsedAt: new Date().toISOString(),
            };
            this.ctx.agentDb.save(agent);

            const statusMsg = await ctx.reply(`⏳ Arrancando servidor en puerto <code>${port}</code>...`, { parse_mode: "HTML" });
            const result = await this.ctx.persistentAgentService.startAgent(agent);
            if (!result.success) {
                this.ctx.agentDb.delete(agent.id);
                await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                    `❌ No se pudo arrancar: ${escapeHtml(result.message)}`, { parse_mode: "HTML" });
                this.wizardState.delete(userId);
                return;
            }

            this.ctx.persistentAgentService.setActiveAgent(userId, agent.id);
            this.ctx.agentDb.setLastUsed(userId, agent.id);
            this.wizardState.delete(userId);

            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                `✅ <b>${escapeHtml(projectName)}</b> listo (nuevo servidor).\n` +
                `Modelo: <code>${escapeHtml(wizard.model!)}</code>\n` +
                `Puerto: <code>${port}</code>\n\n` +
                `Tus mensajes van a este servidor. /esc para desactivar.`,
                { parse_mode: "HTML" });
        }
    }
}