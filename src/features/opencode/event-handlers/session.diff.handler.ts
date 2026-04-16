import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { escapeHtml, sendAndAutoDelete } from "./utils.js";

type SessionDiffEvent = Extract<Event, { type: "session.diff" }>;

export default async function sessionDiffHandler(
    event: SessionDiffEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const props: any = event.properties ?? {};
        const sessionID: string | undefined = props.sessionID;
        if (sessionID && sessionID !== userSession.sessionId) return null;

        const diff = Array.isArray(props.diff) ? props.diff : [];
        if (diff.length === 0) return null;

        const files = diff
            .map((d: any) => d?.file)
            .filter((f: unknown) => typeof f === "string")
            .slice(0, 3)
            .map((f: string) => {
                const p = f.replace(/\\/g, "/").split("/");
                return p.length > 2 ? `…/${p.slice(-2).join("/")}` : f;
            });

        const preview = files.map(f => `<code>${escapeHtml(f)}</code>`).join(", ");
        const extra = diff.length > files.length ? ` +${diff.length - files.length}` : "";
        await sendAndAutoDelete(ctx, `📝 Diff actualizado: ${preview}${extra}`, 3500);
    } catch (error) {
        console.error("Error in session.diff handler:", error);
    }

    return null;
}
