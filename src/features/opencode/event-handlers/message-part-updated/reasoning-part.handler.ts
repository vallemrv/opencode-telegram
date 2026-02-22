import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";

/**
 * Cuando OpenCode está "pensando" (reasoning), no enviamos ningún mensaje.
 * Solo mandamos la acción "typing" para que Telegram muestre "escribiendo..."
 * El texto final se enviará cuando llegue session.idle.
 */
export async function handleReasoningPart(ctx: Context, userSession: UserSession): Promise<void> {
    try {
        // Cancelar cualquier timeout de borrado pendiente
        if (userSession.streamingDeleteTimeout) {
            clearTimeout(userSession.streamingDeleteTimeout);
            userSession.streamingDeleteTimeout = undefined;
        }

        // Solo mostrar "escribiendo..." en Telegram — sin mensaje
        ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => { });

    } catch (error) {
        console.log("Error in reasoning part handler:", error);
    }
}
