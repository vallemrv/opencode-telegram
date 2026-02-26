import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { handleTextPart } from "./message-part-updated/text-part.handler.js";
import { handleReasoningPart } from "./message-part-updated/reasoning-part.handler.js";
import { handleToolPart } from "./message-part-updated/tool-part.handler.js";

type MessagePartUpdatedEvent = Extract<Event, { type: "message.part.updated" }>;

export default async function messagePartUpdatedHandler(
    event: MessagePartUpdatedEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        const { part } = event.properties;

        // 🔒 Ignorar partes de otras sesiones — el stream SSE es global
        if ((part as any).sessionID && (part as any).sessionID !== userSession.sessionId) {
            return null;
        }
        
        if (part.type === "reasoning") {
            await handleReasoningPart(ctx, userSession);
            return null;
        }
        
        if (part.type !== "text") {
            return null;
        }

        await handleTextPart(ctx, part.text, userSession);

    } catch (error) {
        console.log("Error in message.part.updated handler:", error);
    }

    return null;
}
