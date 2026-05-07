/**
 * BotContext — shared interface injected into every handler class.
 *
 * Provides typed access to OpenCodeBot's shared state and core services
 * without coupling handler files to the full OpenCodeBot class.
 */

import type { Bot } from "grammy";
import type { AgentDbService } from "../../../services/agent-db.service.js";
import type { PersistentAgentService } from "../../../services/persistent-agent.service.js";
import type { ConfigService } from "../../../services/config.service.js";
import type { TranscriptionService } from "../../../services/transcription.service.js";
import type { SessionDbService } from "../../../services/session-db.service.js";

export interface ModelSelectionState {
    agentId: string;
    modelsCache: Record<string, string[]>;
    providers: string[];
    currentProvider?: string;
}

export interface BotContext {
    readonly bot: Bot | undefined;
    readonly agentDb: AgentDbService;
    readonly persistentAgentService: PersistentAgentService;
    readonly configService: ConfigService;
    readonly transcriptionService: TranscriptionService;
    readonly sessionDb: SessionDbService;

    readonly runWizard: Map<number, { prompt: string; agentId?: string }>;
    readonly renameWizard: Map<number, string>;
    readonly modelSelection: Map<number, ModelSelectionState>;

    readonly modelIndex: Map<string, string>;
    readonly pendingAgentQuestions: Map<string, { agentId: string; port: number; req: any }>;
    readonly pendingCustomAnswer: Map<number, { shortKey: string; chatId: number; msgId: number }>;
    readonly heartbeatMessages: Map<string, { chatId: number; msgId: number; userId?: number }>;
    readonly queueStatusMessage: Map<string, { chatId: number; msgId: number }>;
    readonly sessIndex: Map<string, { agentId: string; sessionId: string }>;

    modelIndexCounter: number;
    sessIndexCounter: number;

    // Handler instances
    readonly projectsHandler: import("./projects.handler.js").ProjectsHandler;
    readonly serversHandler: import("./servers.handler.js").ServersHandler;
    readonly modelsHandler: import("./models.handler.js").ModelsHandler;
    readonly sessionHandler: import("./session.handler.js").SessionHandler;
    readonly messageHandler: import("./message.handler.js").MessageHandler;

    makeShortKey(prefix: string): string;
    getActiveOrLastAgent(userId: number): import("../../../services/agent-db.service.js").PersistentAgent | undefined;
    editOrSendResult(chatId: number, msgId: number, agent: import("../../../services/agent-db.service.js").PersistentAgent, result: import("../../../services/persistent-agent.service.js").AgentSendResult): Promise<void>;
    sendAgentResult(chatId: number, agent: import("../../../services/agent-db.service.js").PersistentAgent, result: import("../../../services/persistent-agent.service.js").AgentSendResult): Promise<void>;
    sendPromptToAgent(ctx: import("grammy").Context, agent: import("../../../services/agent-db.service.js").PersistentAgent, prompt: string): Promise<void>;

    resolveAgentChat(agentId: string): { chatId: number; userId: number };
}