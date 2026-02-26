import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";

/**
 * Durante el streaming de texto, no enviamos mensajes intermedios.
 * Solo mandamos "typing" y acumulamos el texto en finalResponseText.
 * La respuesta completa se enviará al usuario cuando llegue session.idle.
 */
export async function handleTextPart(ctx: Context, text: string, userSession: UserSession): Promise<void> {
    try {
        if (!text || text.trim() === '') {
            return;
        }

        // Cancelar cualquier timeout pendiente
        if (userSession.streamingDeleteTimeout) {
            clearTimeout(userSession.streamingDeleteTimeout);
            userSession.streamingDeleteTimeout = undefined;
        }

        // Mostrar "escribiendo..." en Telegram — sin mensaje visible
        ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => { });

        // Acumular el texto: OpenCode envía el texto completo acumulado en cada evento,
        // así que simplemente reemplazamos con el último valor recibido (ya viene acumulado).
        // Si por algún motivo el nuevo texto es más corto que el anterior (truncado),
        // conservamos el más largo para no perder contenido.
        if (!userSession.finalResponseText || text.length >= userSession.finalResponseText.length) {
            userSession.finalResponseText = text;
        }

    } catch (error) {
        console.log("Error in text part handler:", error);
    }
}
