import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { sendAndAutoDelete } from "./utils.js";

type ServerConnectedEvent = Extract<Event, { type: "server.connected" }>;

export default async function serverConnectedHandler(
    event: ServerConnectedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        await sendAndAutoDelete(ctx, "📡 Conexión con servidor restablecida", 2500);
    } catch (error) {
        console.error("Error in server.connected handler:", error);
    }

    return null;
}
