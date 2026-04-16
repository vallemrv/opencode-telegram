import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml, sendAndAutoDelete } from "./utils.js";

type CommandExecutedEvent = Extract<Event, { type: "command.executed" }>;

export default async function commandExecutedHandler(
    event: CommandExecutedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const props: any = event.properties ?? {};
        const sessionID: string | undefined = props.sessionID;
        if (sessionID && sessionID !== userSession.sessionId) return null;

        const cmd = props.command ?? props.name ?? "comando";
        await sendAndAutoDelete(ctx, `⚡ Ejecutado: <code>${escapeHtml(String(cmd))}</code>`, 3000);
    } catch (error) {
        console.error("Error in command.executed handler:", error);
    }

    return null;
}
