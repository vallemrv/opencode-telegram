import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";

type SessionStatusEvent = Extract<Event, { type: "session.status" }>;

export default async function sessionStatusHandler(
    event: SessionStatusEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    const status = (event.properties as any)?.status;
    if (!status || !userSession.chatId) return null;

    if (status.type === "retry") {
        const attempt: number = status.attempt ?? 0;
        const message: string = status.message ?? "";
        const nextTs: number = status.next ?? 0;

        // Notify on first retry and every 5 attempts after to avoid spam
        if (attempt !== 1 && attempt % 5 !== 0) return null;

        // Extract a clean error reason
        let reason = message;
        const rateMatch = message.match(/Rate limit[^".\n]*/i);
        const quotaMatch = message.match(/quota[^".\n]*/i);
        if (rateMatch) reason = rateMatch[0];
        else if (quotaMatch) reason = quotaMatch[0];
        else reason = message.replace(/data:.*$/s, "").trim().slice(0, 120);

        const waitSecs = nextTs ? Math.round((nextTs - Date.now()) / 1000) : null;
        const waitText = waitSecs && waitSecs > 0 ? ` (~${waitSecs}s)` : "";

        const text =
            `⏳ <b>OpenCode en espera (intento ${attempt})</b>\n` +
            `<i>${reason}</i>${waitText}\n\n` +
            `OpenCode reintentará automáticamente. Usa /esc para abortar.`;

        try {
            const msg = await ctx.api.sendMessage(userSession.chatId, text, {
                parse_mode: "HTML",
                disable_notification: true,
            });
            // Auto-delete after 30s
            setTimeout(() => {
                ctx.api.deleteMessage(userSession.chatId!, msg.message_id).catch(() => {});
            }, 30000);
        } catch (err) {
            console.error("[session.status] Error sending retry notice:", err);
        }
        return null;
    }

    if (status.type === "busy") {
        // Keep typing indicator alive
        await ctx.api.sendChatAction(userSession.chatId, "typing").catch(() => {});
        return null;
    }

    return null;
}
