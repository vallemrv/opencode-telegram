import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml, sendAndAutoDelete } from "./utils.js";

type PtyCreatedEvent = Extract<Event, { type: "pty.created" }>;

export default async function ptyCreatedHandler(
    event: PtyCreatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const info: any = (event.properties as any)?.info ?? {};
        const sessionID: string | undefined = info.sessionID;
        if (sessionID && sessionID !== userSession.sessionId) return null;
        const title = info.title ?? info.command ?? info.id ?? "proceso";
        await sendAndAutoDelete(ctx, `🧩 PTY iniciado: <code>${escapeHtml(String(title))}</code>`, 3000);
    } catch (error) {
        console.error("Error in pty.created handler:", error);
    }

    return null;
}
