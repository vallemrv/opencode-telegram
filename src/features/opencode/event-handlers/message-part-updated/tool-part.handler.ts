import type { Context } from "grammy";
import type { UserSession } from "../../opencode.types.js";

/**
 * Cuando OpenCode ejecuta una herramienta (tool), no enviamos ningún mensaje.
 * Solo mandamos "typing" para que Telegram muestre "escribiendo..."
 */
export async function handleToolPart(ctx: Context, part: any, userSession: UserSession): Promise<void> {
    try {
        // Cancelar cualquier timeout pendiente
        if (userSession.streamingDeleteTimeout) {
            clearTimeout(userSession.streamingDeleteTimeout);
            userSession.streamingDeleteTimeout = undefined;
        }

        // Solo mostrar "escribiendo..." en Telegram — sin mensaje
        ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => { });

    } catch (error) {
        console.log("Error in tool part handler:", error);
    }
}
