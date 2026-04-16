import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { sendAndAutoDelete } from "./utils.js";

type PtyExitedEvent = Extract<Event, { type: "pty.exited" }>;

export default async function ptyExitedHandler(
    event: PtyExitedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const props: any = event.properties ?? {};
        const sessionID: string | undefined = props.sessionID;
        if (sessionID && sessionID !== userSession.sessionId) return null;
        const exitCode = typeof props.exitCode === "number" ? props.exitCode : "?";
        await sendAndAutoDelete(ctx, `🧩 PTY salió con code ${exitCode}`, 3000);
    } catch (error) {
        console.error("Error in pty.exited handler:", error);
    }

    return null;
}
