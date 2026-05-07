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
import { pickPort, resolveDir } from "../../../services/persistent-agent.service.js";
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
    step: "name" | "git" | "model" | "confirm";
    absPath: string;
    projectName?: string;
    gitSource?: "none" | "github" | "gitea" | "existing";
    model?: string;
    existingGit?: boolean;
    isNewProject?: boolean;
}

export class ProjectsHandler {
    private readonly pathIndex = new Map<string, string>();
    private readonly wizardState = new Map<number, ProjectWizard>();
    private readonly createFolderPrompt = new Map<number, string>();
    private pathIndexCounter = 0;

    constructor(private readonly ctx: BotContext) {}

    // Public helpers for state checking
    isWizardName(userId: number): boolean {
        const wizard = this.wizardState.get(userId);
        console.log(`[ProjectsHandler.isWizardName] userId=${userId}, wizard exists=${!!wizard}, step=${wizard?.step || 'N/A'}, result=${wizard?.step === "name"}`);
        return wizard?.step === "name";
    }

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

        // No server → start wizard
        await this.startWizard(ctx, userId, absPath, projectName);
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

    private async startWizard(ctx: Context, userId: number, absPath: string, projectName: string): Promise<void> {
        const absPathResolved = resolveDir(absPath);
        const projectPath = projectName !== "workspace" ? nodePath.join(absPathResolved, projectName) : absPathResolved;
        const isNewProject = !fs.existsSync(projectPath);
        const existingGit = !isNewProject && fs.existsSync(nodePath.join(projectPath, ".git"));

        console.log(`[ProjectsHandler.startWizard] userId=${userId}, absPath="${absPathResolved}", projectName="${projectName}", isNewProject=${isNewProject}, existingGit=${existingGit}`);

        this.wizardState.set(userId, {
            step: "name",
            absPath: absPathResolved,
            projectName: projectName !== "workspace" ? projectName : undefined,
            existingGit,
            isNewProject,
        });

        console.log(`[ProjectsHandler.startWizard] Wizard state saved for userId=${userId}, current wizardState.size=${this.wizardState.size}`);

        await ctx.deleteMessage().catch(() => {});

        if (projectName !== "workspace") {
            // Use existing folder name as default
            await this.askWizardName(ctx, userId, projectName);
        } else {
            await this.askWizardName(ctx, userId);
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

        const projectName = nodePath.basename(absPath) || "workspace";
        await this.startWizard(ctx, userId, absPath, projectName);
    }

    // ─── Wizard Step 1: Name ────────────────────────────────────────────────────

    private async askWizardName(ctx: Context, userId: number, defaultName?: string): Promise<void> {
        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        const keyboard = new InlineKeyboard()
            .text("❌ Cancelar", `proj:cancel`);

        const msg = defaultName
            ? `📝 <b>Step 1/4: Nombre del proyecto</b>\n\n` +
              `Usar nombre del folder: <b>${escapeHtml(defaultName)}</b>\n\n` +
              `O escribir otro nombre:`
            : `📝 <b>Step 1/4: Nombre del proyecto</b>\n\n` +
              `Escribe el nombre del proyecto:`;

        await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
    }

    async handleWizardNameText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        console.log(`[ProjectsHandler.handleWizardNameText] ENTER: userId=${userId || 'N/A'}`);
        if (!userId) return;

        const wizard = this.wizardState.get(userId);
        console.log(`[ProjectsHandler.handleWizardNameText] Wizard state: exists=${!!wizard}, step=${wizard?.step || 'N/A'}, wizardState.size=${this.wizardState.size}`);
        if (!wizard || wizard.step !== "name") {
            console.log(`[ProjectsHandler.handleWizardNameText] EARLY RETURN: wizard invalid or step not 'name'`);
            return;
        }

        const name = ctx.message?.text?.trim();
        console.log(`[ProjectsHandler.handleWizardNameText] User input: "${name || 'N/A'}"`);
        if (!name) {
            await ctx.reply("❌ Nombre vacío.", { parse_mode: "HTML" });
            return;
        }

        wizard.projectName = name;
        console.log(`[ProjectsHandler.handleWizardNameText] Name saved: "${name}", continuing to git step...`);
        
        // Re-check project status with new name
        const projectPath = nodePath.join(wizard.absPath, name);
        wizard.isNewProject = !fs.existsSync(projectPath);
        wizard.existingGit = !wizard.isNewProject && fs.existsSync(nodePath.join(projectPath, ".git"));

        // Skip Git step if project already exists with git
        if (!wizard.isNewProject && wizard.existingGit) {
            wizard.gitSource = "existing";
            wizard.step = "model";
            await ctx.reply(
                `✅ Git ya configurado en proyecto existente.\n` +
                `Continuando sin modificar repo...`,
                { parse_mode: "HTML" }
            );
            await this.askWizardModel(ctx, userId);
        } else {
            wizard.step = "git";
            await this.askWizardGit(ctx, userId);
        }
        console.log(`[ProjectsHandler.handleWizardNameText] Wizard step updated to: ${wizard.step}`);
    }

    // ─── Wizard Step 2: Git ─────────────────────────────────────────────────────

    private async askWizardGit(ctx: Context, userId: number): Promise<void> {
        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        const isGitea = !!process.env.GITEA_URL && !!process.env.GITEA_TOKEN;
        const isGithub = !!process.env.GITHUB_TOKEN;

        // Different options based on project state
        const keyboard = new InlineKeyboard();
        
        if (!wizard.isNewProject && !wizard.existingGit) {
            // Existing project WITHOUT git → only local init
            keyboard.text("✅ Inicializar git local", `proj:wizard-git:local`).row();
            keyboard.text("❌ Sin git", `proj:wizard-git:none`).row();
            const msg = 
                `🔀 <b>Step 2/4: Git (Proyecto existente)</b>\n\n` +
                `Nombre: <b>${escapeHtml(wizard.projectName!)}</b>\n` +
                `Folder ya existe SIN git.\n\n` +
                `¿Inicializar git localmente?`;
        } else if (wizard.isNewProject) {
            // New project → full options
            keyboard.text("❌ Sin git", `proj:wizard-git:none`).row();
            if (isGithub) keyboard.text("🐙 GitHub", `proj:wizard-git:github`).row();
            if (isGitea) keyboard.text("☕ Gitea", `proj:wizard-git:gitea`).row();
            const msg = 
                `🔀 <b>Step 2/4: Repositorio Git</b>\n\n` +
                `Nombre: <b>${escapeHtml(wizard.projectName!)}</b>\n\n` +
                `¿Crear repositorio remoto?`;
        }
        
        keyboard.text("⬅️ Atrás", `proj:wizard-back:name`);

        await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
    }

    async handleWizardGit(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:wizard-git:")) return;
        const source = data.slice("proj:wizard-git:".length) as "none" | "github" | "gitea" | "local";

        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        wizard.gitSource = source;
        wizard.step = "model";
        await this.askWizardModel(ctx, userId);
    }

    // ─── Wizard Step 3: Model ───────────────────────────────────────────────────

    private async askWizardModel(ctx: Context, userId: number): Promise<void> {
        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        const models = this.ctx.configService.getAvailableModels();
        const keyboard = new InlineKeyboard();

        // Show top 5 models
        const topModels = models.slice(0, 5);
        for (const model of topModels) {
            const parts = model.split("/");
            const providerName = parts[0] || "";
            const modelName = parts.slice(1).join("/") || model;
            const shortModel = modelName.length > 20 ? modelName.slice(0, 17) + "..." : modelName;
            keyboard.text(`${providerName}/${shortModel}`, `proj:wizard-model:${model}`).row();
        }

        keyboard.text("📝 Otro modelo", `proj:wizard-model-custom`).row();
        
        // Adjust back button based on wizard flow
        if (wizard.existingGit && !wizard.isNewProject) {
            // Git was skipped, back goes to name
            keyboard.text("⬅️ Atrás", `proj:wizard-back:name`);
        } else {
            keyboard.text("⬅️ Atrás", `proj:wizard-back:git`);
        }

        const gitStatus = wizard.gitSource === "existing" 
            ? "✅ Git existente (sin cambios)"
            : wizard.gitSource === "local"
            ? "✅ Inicializar git local"
            : wizard.gitSource === "none"
            ? "❌ Sin git"
            : wizard.gitSource === "github"
            ? "🐙 GitHub"
            : "☕ Gitea";

        await ctx.reply(
            `🤖 <b>Step 3/4: Modelo</b>\n\n` +
            `Nombre: <b>${escapeHtml(wizard.projectName!)}</b>\n` +
            `Git: ${gitStatus}\n\n` +
            `Elige modelo:`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    async handleWizardModel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:wizard-model:")) return;

        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        if (data === "proj:wizard-model-custom") {
            await ctx.reply("📝 Escribe el modelo (formato: provider/model):", { parse_mode: "HTML" });
            return;
        }

        const model = data.slice("proj:wizard-model:".length);
        wizard.model = model;
        wizard.step = "confirm";
        await this.askWizardConfirm(ctx, userId);
    }

    async handleWizardModelText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const wizard = this.wizardState.get(userId);
        if (!wizard || wizard.step !== "model") return;

        const model = ctx.message?.text?.trim();
        if (!model) {
            await ctx.reply("❌ Modelo vacío.", { parse_mode: "HTML" });
            return;
        }

        wizard.model = model;
        wizard.step = "confirm";
        await this.askWizardConfirm(ctx, userId);
    }

    // ─── Wizard Step 4: Confirm ────────────────────────────────────────────────

    private async askWizardConfirm(ctx: Context, userId: number): Promise<void> {
        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        const keyboard = new InlineKeyboard()
            .text("✅ Crear proyecto", `proj:wizard-confirm`)
            .text("❌ Cancelar", `proj:cancel`).row();
        
        // Adjust back button based on wizard flow
        if (wizard.existingGit && !wizard.isNewProject) {
            keyboard.text("⬅️ Atrás", `proj:wizard-back:model-to-name`);
        } else {
            keyboard.text("⬅️ Atrás", `proj:wizard-back:model`);
        }

        const gitStatus = wizard.gitSource === "existing" 
            ? "✅ Git existente (sin cambios)"
            : wizard.gitSource === "local"
            ? "✅ Inicializar git local"
            : wizard.gitSource === "none"
            ? "❌ Sin git"
            : wizard.gitSource === "github"
            ? "🐙 GitHub"
            : "☕ Gitea";

        const projectStatus = wizard.isNewProject 
            ? "🆕 Proyecto nuevo"
            : "📁 Proyecto existente";

        await ctx.reply(
            `✅ <b>Step 4/4: Confirmar</b>\n\n` +
            `${projectStatus}\n` +
            `Nombre: <b>${escapeHtml(wizard.projectName!)}</b>\n` +
            `Git: ${gitStatus}\n` +
            `Modelo: <code>${escapeHtml(wizard.model!)}</code>\n\n` +
            `¿Crear server?`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

    async handleWizardConfirm(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        await this.createProject(ctx, userId, wizard);
    }

    // ─── Wizard: Back navigation ───────────────────────────────────────────────

    async handleWizardBack(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data?.startsWith("proj:wizard-back:")) return;
        const backTo = data.slice("proj:wizard-back:".length);

        const wizard = this.wizardState.get(userId);
        if (!wizard) return;

        switch (backTo) {
            case "name":
                wizard.step = "name";
                await ctx.deleteMessage().catch(() => {});
                await this.askWizardName(ctx, userId, wizard.projectName);
                break;
            case "git":
                wizard.step = "git";
                await ctx.deleteMessage().catch(() => {});
                await this.askWizardGit(ctx, userId);
                break;
            case "model":
                wizard.step = "model";
                await ctx.deleteMessage().catch(() => {});
                await this.askWizardModel(ctx, userId);
                break;
            case "model-to-name":
                // Special case: skip git step, go back to name
                wizard.step = "name";
                await ctx.deleteMessage().catch(() => {});
                await this.askWizardName(ctx, userId, wizard.projectName);
                break;
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

    // ─── Project Creation ───────────────────────────────────────────────────────

    private async createProject(ctx: Context, userId: number, wizard: ProjectWizard): Promise<void> {
        const absPath = resolveDir(wizard.absPath);
        const projectName = wizard.projectName || nodePath.basename(absPath) || "project";
        const projectPath = wizard.isNewProject 
            ? nodePath.join(absPath, projectName) 
            : absPath;

        // Create folder ONLY if new project
        if (wizard.isNewProject && !fs.existsSync(projectPath)) {
            try {
                fs.mkdirSync(projectPath, { recursive: true });
            } catch (err) {
                await ctx.reply(`❌ Error creando folder: ${escapeHtml(String(err))}`, { parse_mode: "HTML" });
                this.wizardState.delete(userId);
                return;
            }
        }

        // Git setup - ONLY for new projects or local init
        if (!wizard.existingGit && wizard.gitSource !== "none" && wizard.gitSource !== "existing") {
            const statusMsg = await ctx.reply(`⏳ Configurando git...`, { parse_mode: "HTML" });

            try {
                if (wizard.gitSource === "github" && wizard.isNewProject) {
                    // Create GitHub repo ONLY for new projects
                    const repo = await githubCreateRepo(projectName);
                    if (repo) {
                        // Clone into new folder
                        execSync(`git clone ${repo.cloneUrl} "${projectPath}"`, { stdio: "ignore" });
                        await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                            `✅ GitHub: <a href="${repo.htmlUrl}">${escapeHtml(projectName)}</a>`,
                            { parse_mode: "HTML" }
                        );
                    }
                } else if (wizard.gitSource === "gitea" && wizard.isNewProject) {
                    // Create Gitea repo ONLY for new projects
                    const repo = await giteaCreateOrGetRepo(projectName);
                    if (repo) {
                        // Clone into new folder
                        execSync(`git clone ${repo.cloneUrl} "${projectPath}"`, { stdio: "ignore" });
                        await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                            `✅ Gitea: <a href="${repo.htmlUrl}">${escapeHtml(projectName)}</a>`,
                            { parse_mode: "HTML" }
                        );
                    }
                } else if (wizard.gitSource === "local") {
                    // Initialize git locally (for existing projects without git)
                    if (!fs.existsSync(nodePath.join(projectPath, ".git"))) {
                        execSync(`git init "${projectPath}"`, { stdio: "ignore" });
                        await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                            `✅ Git inicializado localmente`,
                            { parse_mode: "HTML" }
                        );
                    }
                }
            } catch (err) {
                await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                    `⚠️ Git falló: ${escapeHtml(String(err))}\nContinuando sin git.`,
                    { parse_mode: "HTML" }
                );
            }
        }

        // Ensure AGENTS.md exists
        const agentsPath = nodePath.join(projectPath, "AGENTS.md");
        if (!fs.existsSync(agentsPath)) {
            try {
                fs.writeFileSync(agentsPath, `# ${projectName}\n\nProject created via TelegramCoder.\n`, "utf8");
            } catch { /* ignore */ }
        }

        // Ensure opencode.json
        const opencodeJsonPath = nodePath.join(projectPath, "opencode.json");
        if (!fs.existsSync(opencodeJsonPath)) {
            try {
                fs.writeFileSync(opencodeJsonPath, JSON.stringify({ "$schema": "https://opencode.ai/config.json" }) + "\n", "utf8");
            } catch { /* ignore */ }
        }

        // Check slots availability
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
                `Parando <b>${escapeHtml(evictCandidate.name)}</b> para crear nuevo...`,
                { parse_mode: "HTML" }
            );
            await this.ctx.persistentAgentService.evictAgent(evictCandidate);
        }

        // Create agent
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

        // Start server
        const statusMsg = await ctx.reply(`⏳ Arrancando servidor en puerto <code>${port}</code>...`, { parse_mode: "HTML" });
        const result = await this.ctx.persistentAgentService.startAgent(agent);
        if (!result.success) {
            this.ctx.agentDb.delete(agent.id);
            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
                `❌ No se pudo arrancar: ${escapeHtml(result.message)}`,
                { parse_mode: "HTML" }
            );
            this.wizardState.delete(userId);
            return;
        }

        // Activate and finish
        this.ctx.persistentAgentService.setActiveAgent(userId, agent.id);
        this.ctx.agentDb.setLastUsed(userId, agent.id);
        this.wizardState.delete(userId);

        const projectStatus = wizard.isNewProject ? "🆕 Nuevo" : "📁 Existente";
        await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id,
            `✅ <b>${escapeHtml(projectName)}</b> listo (${projectStatus}).\n` +
            `Modelo: <code>${escapeHtml(wizard.model!)}</code>\n` +
            `Puerto: <code>${port}</code>\n\n` +
            `Tus mensajes van a este servidor. /esc para desactivar.`,
            { parse_mode: "HTML" }
        );
    }
}