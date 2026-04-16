import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml, sendAndAutoDelete } from "./utils.js";

type PtyUpdatedEvent = Extract<Event, { type: "pty.updated" }>;

export default async function ptyUpdatedHandler(
    event: PtyUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const info: any = (event.properties as any)?.info ?? {};
        const sessionID: string | undefined = info.sessionID;
        if (sessionID && sessionID !== userSession.sessionId) return null;

        if (info.status === "exited") {
            const code = typeof info.exitCode === "number" ? ` (code ${info.exitCode})` : "";
            await sendAndAutoDelete(ctx, `🧩 PTY finalizado${code}`, 3000);
        }
    } catch (error) {
        console.error("Error in pty.updated handler:", error);
    }

    return null;
}
