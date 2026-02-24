import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { InlineKeyboard } from "grammy";
import { escapeHtml } from "./utils.js";

type PermissionUpdatedEvent = Extract<Event, { type: "permission.updated" }>;

/**
 * Handles permission.updated events from OpenCode.
 * Sends an inline keyboard asking the user to approve or reject the action.
 */
export default async function permissionUpdatedHandler(
    event: PermissionUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    const props = event.properties;
    const permissionId: string = props?.id ?? "";
    const permissionType: string = (props as any)?.type ?? props?.type ?? "unknown";
    const pattern: string | string[] | undefined = (props as any)?.pattern;
    const title: string = (props as any)?.title ?? permissionType;
    const metadata: Record<string, unknown> = (props as any)?.metadata ?? {};

    if (!permissionId || !userSession.chatId) return null;

    // Build a human-readable description
    const typeLabel: Record<string, string> = {
        file: "✏️ Archivo",
        command: "⚡ Comando",
        network: "🌐 Red",
        browser: "🌐 Navegador",
    };
    const actionLabel = typeLabel[permissionType] ?? `🔐 ${escapeHtml(permissionType)}`;

    const patterns = Array.isArray(pattern) ? pattern : pattern ? [pattern] : [];
    const patternList = patterns.map(p => `  • <code>${escapeHtml(p)}</code>`).join("\n");

    const metaLines = Object.entries(metadata)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
        .map(([k, v]) => `  <b>${escapeHtml(k)}:</b> <code>${escapeHtml(String(v))}</code>`)
        .join("\n");

    const text =
        `🔐 <b>OpenCode pide permiso</b>\n\n` +
        `<b>Tipo:</b> ${actionLabel}\n` +
        `<b>Acción:</b> <code>${escapeHtml(title)}</code>\n` +
        (patternList ? `<b>Patrones:</b>\n${patternList}\n` : "") +
        (metaLines ? `\n${metaLines}\n` : "") +
        `\n¿Qué quieres hacer?`;

    const keyboard = new InlineKeyboard()
        .text("✅ Permitir una vez", `perm:once:${permissionId}`)
        .text("♾️ Permitir siempre", `perm:always:${permissionId}`)
        .row()
        .text("❌ Rechazar", `perm:reject:${permissionId}`);

    const msg = await ctx.api.sendMessage(userSession.chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
    });

    // Track the pending permission so we can edit the message after the user replies
    userSession.pendingPermissionId = permissionId;
    userSession.pendingPermissionMsgId = msg.message_id;

    return null; // message sent directly, not via return value
}
