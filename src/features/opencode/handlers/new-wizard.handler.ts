/**
 * NewWizardHandler — handles the /new multi-step wizard.
 *
 * Steps:  name → git → confirm → create agent
 */

import { Context, InlineKeyboard } from "grammy";
import { execSync } from "child_process";
import * as fs from "fs";
import * as nodePath from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import type { PersistentAgent } from "../../../services/agent-db.service.js";
import { pickPort } from "../../../services/persistent-agent.service.js";
import { ErrorUtils } from "../../../utils/error.utils.js";
import { escapeHtml } from "../event-handlers/utils.js";
import type { BotContext, NewAgentWizard } from "./bot-context.js";

// ─── Path helpers ─────────────────────────────────────────────────────────────

function resolveHome(p: string): string {
    if (p.startsWith("~/") || p === "~") {
        return nodePath.join(os.homedir(), p.slice(1));
    }
    return p;
}

function workspaceDir(): string {
    const raw = process.env.WORKSPACE_DIR || "~/proyectos";
    const resolved = resolveHome(raw);
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    return resolved;
}

function resolveProjectPath(nameOrPath: string): string {
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

// ─── Handler class ────────────────────────────────────────────────────────────

export class NewWizardHandler {
    constructor(private readonly ctx: BotContext) {}

    // ── /new ─────────────────────────────────────────────────────────────────

    async handleNew(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        this.ctx.disconnectRemoteAgent(userId);

        const inWizard = this.ctx.newWizard.get(userId);
        if (inWizard) {
            await ctx.reply("ℹ️ Ya estás creando un agente. Termina ese proceso o usa /esc para cancelar.");
            return;
        }

        const defaultModel = process.env.OPENCODE_DEFAULT_MODEL || "bailian-coding-plan/qwen3.5-plus";
        const inlineName = ctx.message?.text?.replace(/^\/new\s*/i, "").trim() || "";

        if (inlineName) {
            const wizard: NewAgentWizard = { step: "git", name: inlineName, model: defaultModel };
            wizard.workdir = resolveProjectPath(inlineName);
            this.ctx.newWizard.set(userId, wizard);
            await this.sendGitPicker(ctx, wizard);
        } else {
            this.ctx.newWizard.set(userId, { step: "name", model: defaultModel });
            await ctx.reply(
                `🆕 <b>Nuevo agente</b>\n\nEscribe el nombre o ruta del proyecto:\n` +
                `<i>· <code>mi-proyecto</code> → crea ${escapeHtml(workspaceDir())}/mi-proyecto\n` +
                `· <code>/ruta/absoluta</code> → usa esa ruta directamente</i>`,
                { parse_mode: "HTML" }
            );
        }
    }

    // ── Wizard text step ─────────────────────────────────────────────────────

    async handleNewWizardText(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;
        const wizard = this.ctx.newWizard.get(userId);
        if (!wizard) return;

        const text = ctx.message?.text?.trim() || "";

        switch (wizard.step) {
            case "name": {
                if (!text) { await ctx.reply("❌ Nombre requerido."); return; }
                wizard.name = text;
                wizard.workdir = resolveProjectPath(text);
                wizard.step = "git";
                await this.sendGitPicker(ctx, wizard);
                break;
            }
            case "git": {
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

    // ── Source picker callback: new:source:* ─────────────────────────────────

    async handleNewSource(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const wizard = this.ctx.newWizard.get(userId);
        if (!wizard) { await ctx.editMessageText("❌ Sesión expirada. Usa /new."); return; }

        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData?.startsWith("new:source:")) return;
        const source = callbackData.replace("new:source:", "") as "gitea" | "github" | "none";
        wizard.gitSource = source;

        await ctx.deleteMessage().catch(() => {});

        if (source === "none") {
            wizard.step = "confirm";
            await this.sendNewConfirm(ctx, wizard);
        } else {
            wizard.repoName = wizard.name!;
            wizard.step = "confirm";
            await this.sendNewConfirm(ctx, wizard);
        }
    }

    // ── Confirm callback: new:confirm ────────────────────────────────────────

    async handleNewConfirm(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (!userId) return;

        const wizard = this.ctx.newWizard.get(userId);
        if (!wizard || !wizard.name) {
            await ctx.editMessageText("❌ Sesión expirada. Usa /new.");
            return;
        }
        this.ctx.newWizard.delete(userId);

        const statusMsg = await ctx.editMessageText(`⏳ Creando agente <b>${escapeHtml(wizard.name)}</b>...`, { parse_mode: "HTML" });
        const msgId = (statusMsg as any).message_id ?? ctx.callbackQuery!.message!.message_id;
        const chatId = ctx.chat!.id;

        const edit = (text: string) =>
            ctx.api.editMessageText(chatId, msgId, text, { parse_mode: "HTML" }).catch(() => {});

        try {
            const workdir = wizard.workdir || resolveProjectPath(wizard.name);
            if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive: true });

            // Optional: create/clone remote repo
            if (wizard.gitSource === "gitea" || wizard.gitSource === "github") {
                const repoName = wizard.repoName || wizard.name;
                await edit(`⏳ ${wizard.gitSource === "gitea" ? "🟠 Gitea" : "⚫ GitHub"}: creando/obteniendo repo <b>${escapeHtml(repoName)}</b>...`);

                if (wizard.gitSource === "gitea") {
                    const repo = await giteaCreateOrGetRepo(repoName);
                    if (!repo) {
                        await edit("❌ No se pudo crear/obtener el repo en Gitea. Verifica GITEA_URL y GITEA_TOKEN.");
                        return;
                    }
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

            // Pick port and save agent to DB
            const port = pickPort(this.ctx.agentDb.usedPorts());
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
            this.ctx.agentDb.save(agent);

            // Start the opencode server
            await edit(`⏳ Arrancando servidor OpenCode en puerto <code>${port}</code>...`);
            const startResult = await this.ctx.persistentAgentService.startAgent(agent);
            if (!startResult.success) {
                this.ctx.agentDb.delete(agent.id);
                await edit(`❌ No se pudo arrancar el servidor: ${startResult.message}`);
                return;
            }

            // Inject git credentials (best-effort)
            await this.injectCredentials(agent.port);

            // Mark as active and save last used
            this.ctx.persistentAgentService.setActiveAgent(userId, agent.id);
            this.ctx.agentDb.setLastUsed(userId, agent.id);

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

    // ── Cancel callback: new:cancel ──────────────────────────────────────────

    async handleNewCancel(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (userId) this.ctx.newWizard.delete(userId);
        await ctx.editMessageText("❌ Cancelado.").catch(() => {});
    }

    // ── "➕ Nuevo agente" button from /agents ─────────────────────────────────

    async handleAgentNew(ctx: Context): Promise<void> {
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
        const defaultModel = process.env.OPENCODE_DEFAULT_MODEL || "bailian-coding-plan/qwen3.5-plus";
        this.ctx.newWizard.set(userId, { step: "name", model: defaultModel });
    }

    // ── Private helpers ───────────────────────────────────────────────────────

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

    private async injectCredentials(port: number): Promise<void> {
        const baseUrl = `http://localhost:${port}`;
        const creds: Array<{ id: string; type: string; token?: string; url?: string }> = [];

        if (process.env.GITEA_TOKEN && process.env.GITEA_URL) {
            creds.push({ id: "gitea", type: "gitea", token: process.env.GITEA_TOKEN, url: process.env.GITEA_URL });
        }
        if (process.env.GITHUB_TOKEN) {
            creds.push({ id: "github", type: "github", token: process.env.GITHUB_TOKEN });
        }

        for (const cred of creds) {
            try {
                await fetch(`${baseUrl}/auth/${cred.id}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(cred),
                    signal: AbortSignal.timeout(5000),
                });
            } catch { /* best-effort */ }
        }
    }
}
