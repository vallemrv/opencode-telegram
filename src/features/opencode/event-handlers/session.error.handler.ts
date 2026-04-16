import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml } from "./utils.js";

type SessionErrorEvent = Extract<Event, { type: "session.error" }>;

export default async function sessionErrorHandler(
    event: SessionErrorEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const props: any = event.properties ?? {};
        const sessionID: string | undefined = props.sessionID ?? props.id;
        if (sessionID && sessionID !== userSession.sessionId) return null;

        const msg =
            props?.error?.message ??
            props?.message ??
            (typeof props?.error === "string" ? props.error : "Error desconocido del modelo");

        const text = `⚠️ <b>Error de sesión</b>\n\n<code>${escapeHtml(String(msg))}</code>`;
        await ctx.reply(text, { parse_mode: "HTML", disable_notification: true });
    } catch (error) {
        console.error("Error in session.error handler:", error);
    }

    return null;
}
