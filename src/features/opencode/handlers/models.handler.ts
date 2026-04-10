/**
 * ModelsHandler — handles /models command and the provider/model picker callbacks.
 */

import { Context, InlineKeyboard } from "grammy";
import { execSync } from "child_process";
import { findOpencodeCmd } from "../../../services/persistent-agent.service.js";
import { escapeHtml } from "../event-handlers/utils.js";
import type { BotContext } from "./bot-context.js";

function getAgentBaseUrl(agent: { host?: string; port: number }): string {
    const host = agent.host || "localhost";
    return `http://${host}:${agent.port}`;
}

export class ModelsHandler {
    constructor(private readonly ctx: BotContext) {}

    // ── /models ───────────────────────────────────────────────────────────────

    async handleModels(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        this.ctx.disconnectRemoteAgent(userId);

        const activeId = this.ctx.persistentAgentService.getActiveAgentId(userId)
            ?? this.ctx.agentDb.getLastUsed(userId)?.id;

        if (!activeId) {
            await this.showAgentPickerForModels(ctx);
            return;
        }

        const agent = this.ctx.agentDb.getById(activeId);
        if (!agent) { await ctx.reply("❌ Agente no encontrado."); return; }

        await this.showProviderPicker(ctx, agent.id, agent.model);
    }

    // ── model callback: mdl_* ─────────────────────────────────────────────────

    async handleModelCallback(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const data = ctx.callbackQuery?.data;
        if (!data || !data.startsWith("mdl_")) return;

        await ctx.answerCallbackQuery();

        if (data.startsWith("mdl_ag_")) {
            const agentId = this.ctx.modelIndex.get(data);
            if (!agentId) { await ctx.editMessageText("❌ Sesión expirada."); return; }
            const agent = this.ctx.agentDb.getById(agentId);
            if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }
            await this.showProviderPicker(ctx, agent.id, agent.model);
            return;
        }

        if (data.startsWith("mdl_pr_")) {
            const provider = this.ctx.modelIndex.get(data);
            if (!provider) { await ctx.editMessageText("❌ Sesión expirada."); return; }
            const state = this.ctx.modelSelection.get(userId);
            if (!state) { await ctx.editMessageText("❌ Sesión expirada. Usa /models."); return; }

            const models = state.modelsCache[provider] || [];
            const keyboard = new InlineKeyboard();
            for (const model of models) {
                const modelName = model.split("/")[1];
                const shortKey = this.ctx.makeShortKey("mdl_mo_");
                this.ctx.modelIndex.set(shortKey, model);
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
            const state = this.ctx.modelSelection.get(userId);
            if (!state) { await ctx.editMessageText("❌ Sesión expirada. Usa /models."); return; }

            const keyboard = new InlineKeyboard();
            for (const provider of state.providers) {
                const shortKey = this.ctx.makeShortKey("mdl_pr_");
                this.ctx.modelIndex.set(shortKey, provider);
                keyboard.text(provider, shortKey).row();
            }

            const agent = this.ctx.agentDb.getById(state.agentId);
            await ctx.editMessageText(
                `🧠 <b>Modelo actual:</b> <code>${escapeHtml(agent?.model || "desconocido")}</code>\n\nElige proveedor:`,
                { parse_mode: "HTML", reply_markup: keyboard }
            );
            return;
        }

        if (data.startsWith("mdl_mo_")) {
            const model = this.ctx.modelIndex.get(data);
            if (!model) { await ctx.editMessageText("❌ Sesión expirada."); return; }
            const state = this.ctx.modelSelection.get(userId);
            if (!state) { await ctx.editMessageText("❌ Sesión expirada. Usa /models."); return; }

            const agent = this.ctx.agentDb.getById(state.agentId);
            if (!agent) { await ctx.editMessageText("❌ Agente no encontrado."); return; }

            this.ctx.agentDb.updateModel(state.agentId, model);
            this.ctx.modelSelection.delete(userId);

            await ctx.editMessageText(
                `✅ Modelo de <b>${escapeHtml(agent.name)}</b> cambiado a <code>${escapeHtml(model)}</code>\n\n🔄 El nuevo modelo se usará en el próximo mensaje (misma sesión).`,
                { parse_mode: "HTML" }
            );
            return;
        }
    }

    // ── agent:model:* (re-route to /models) ───────────────────────────────────

    async handleAgentModelSelect(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery();
        await this.handleModels(ctx);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async showAgentPickerForModels(ctx: Context): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const agents = this.ctx.agentDb.getByUser(userId);
        if (agents.length === 0) {
            await ctx.reply("ℹ️ No tienes agentes. Crea uno con /new.");
            return;
        }

        const keyboard = new InlineKeyboard();
        for (const agent of agents) {
            const shortKey = this.ctx.makeShortKey("mdl_ag_");
            this.ctx.modelIndex.set(shortKey, agent.id);
            keyboard.text(agent.name, shortKey).row();
        }

        await ctx.reply("Selecciona un agente para cambiar su modelo:", { reply_markup: keyboard });
    }

    private async showProviderPicker(ctx: Context, agentId: string, currentModel: string): Promise<void> {
        const userId = ctx.from?.id;
        if (!userId) return;

        const modelsCache = await this.getAvailableModels();
        const providers = Object.keys(modelsCache).sort();

        this.ctx.modelSelection.set(userId, { agentId, modelsCache, providers });

        const keyboard = new InlineKeyboard();
        for (const provider of providers) {
            const shortKey = this.ctx.makeShortKey("mdl_pr_");
            this.ctx.modelIndex.set(shortKey, provider);
            keyboard.text(provider, shortKey).row();
        }

        await ctx.reply(
            `🧠 <b>Modelo actual:</b> <code>${escapeHtml(currentModel)}</code>\n\nElige proveedor:`,
            { parse_mode: "HTML", reply_markup: keyboard }
        );
    }

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
                    if (!modelsByProvider[provider]) modelsByProvider[provider] = [];
                    modelsByProvider[provider].push(`${provider}/${model}`);
                }
            }
            return modelsByProvider;
        } catch (error) {
            console.error("Error fetching models from opencode:", error);
            return {};
        }
    }
}
