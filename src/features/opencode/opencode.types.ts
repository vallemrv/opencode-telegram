import type { Session } from "@opencode-ai/sdk";
import type { Context } from "grammy";

export interface UserSession {
    userId: number;
    sessionId: string;
    session: Session;
    createdAt: Date;
    chatId?: number;
    lastMessageId?: number;
    currentAgent?: string;
    currentModel?: string;
    // Streaming internos (solo para typing indicator, no se muestran)
    streamingMessageId?: number;
    streamingLastUpdate?: number;
    streamingDeleteTimeout?: NodeJS.Timeout;
    streamingLatestText?: string;
    // Texto final acumulado que se envía cuando OpenCode termina (session.idle)
    finalResponseText?: string;
    // Bloqueo: true mientras OpenCode está procesando un prompt
    isProcessing?: boolean;
}
