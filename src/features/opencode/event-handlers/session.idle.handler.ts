import type { Event } from "@opencode-ai/sdk";
import type { Context } from "grammy";
import type { UserSession } from "../opencode.types.js";
import { InputFile } from "grammy";
import { formatAsHtml } from "./utils.js";

type SessionIdleEvent = Extract<Event, { type: "session.idle" }>;

const MAX_TELEGRAM_LENGTH = 4000;

function splitIntoChunks(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    for (const line of text.split("\n")) {
        if (currentChunk.length + line.length + 1 > maxLength) {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = line;
        } else {
            currentChunk = currentChunk ? currentChunk + "\n" + line : line;
        }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
}

/**
 * session.idle se dispara cuando OpenCode termina de procesar.
 * Aquí enviamos la respuesta final acumulada al usuario — con notificación.
 */
export default async function sessionIdleHandler(
    event: SessionIdleEvent,
    ctx: Context,
    userSession: UserSession
): Promise<string | null> {
    try {
        // 🔒 Ignorar eventos de otras sesiones — el stream SSE es global
        if (event.properties.sessionID && event.properties.sessionID !== userSession.sessionId) {
            return null;
        }

        // ✅ OpenCode ha terminado → liberar el bloqueo para nuevos prompts
        userSession.isProcessing = false;

        // Limpiar cualquier mensaje de streaming pendiente
        if (userSession.streamingDeleteTimeout) {
            clearTimeout(userSession.streamingDeleteTimeout);
            userSession.streamingDeleteTimeout = undefined;
        }

        // Si hay texto acumulado, lo enviamos ahora
        const text = userSession.finalResponseText;
        if (!text || text.trim() === "") {
            return null;
        }

        // Limpiar el texto acumulado para la próxima respuesta
        userSession.finalResponseText = undefined;
        userSession.streamingMessageId = undefined;
        userSession.streamingLatestText = undefined;
        userSession.streamingLastUpdate = undefined;

        // Si el texto es muy largo o tiene markdown con headers, enviarlo como fichero .md
        const hasHeaders = /^#{1,3}\s/m.test(text);
        const hasManyLines = text.split("\n").length > 50;

        if (hasHeaders || hasManyLines) {
            const buffer = Buffer.from(text, "utf-8");
            await ctx.replyWithDocument(new InputFile(buffer, "respuesta.md"));
            return null;
        }

        // Enviar como texto HTML (con notificación para que el usuario se entere)
        const formatted = formatAsHtml(text);

        if (formatted.length <= MAX_TELEGRAM_LENGTH) {
            await ctx.reply(formatted, { parse_mode: "HTML" });
        } else {
            const chunks = splitIntoChunks(text, MAX_TELEGRAM_LENGTH);
            for (const chunk of chunks) {
                await ctx.reply(formatAsHtml(chunk), { parse_mode: "HTML" });
            }
        }

    } catch (error) {
        console.log("Error in session.idle handler:", error);
    }

    return null;
}
