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

// ─── Wizard / in-memory state types ──────────────────────────────────────────

export type WizardStep = "name" | "git" | "confirm";

export interface NewAgentWizard {
    step: WizardStep;
    name?: string;
    workdir?: string;
    gitSource?: "gitea" | "github" | "none";
    repoName?: string;
    model: string;
}

export interface ModelSelectionState {
    agentId: string;
    modelsCache: Record<string, string[]>;
    providers: string[];
    currentProvider?: string;
}

export interface RemoteAgentInfo {
    host: string;
    port: number;
    project: string;
    workdir: string;
    sessionId?: string;
    model?: string;
}

// ─── Context interface ────────────────────────────────────────────────────────

export interface BotContext {
    // Core services
    readonly bot: Bot | undefined;
    readonly agentDb: AgentDbService;
    readonly persistentAgentService: PersistentAgentService;
    readonly configService: ConfigService;
    readonly transcriptionService: TranscriptionService;
    readonly sessionDb: SessionDbService;

    // Wizard state maps
    readonly newWizard: Map<number, NewAgentWizard>;
    readonly runWizard: Map<number, { prompt: string; agentId?: string }>;
    readonly renameWizard: Map<number, string>;
    readonly modelSelection: Map<number, ModelSelectionState>;

    // Index / lookup maps
    readonly remoteAgentIndex: Map<string, RemoteAgentInfo>;
    readonly remoteAgentsInMemory: Map<number, { id: string; host: string; port: number; model: string }>;
    readonly modelIndex: Map<string, string>;
    readonly pendingAgentQuestions: Map<string, { agentId: string; port: number; req: any }>;
    /** userId → { shortKey, chatId, msgId } — user is typing a custom answer to a question */
    readonly pendingCustomAnswer: Map<number, { shortKey: string; chatId: number; msgId: number }>;
    readonly heartbeatMessages: Map<string, { chatId: number; msgId: number; userId?: number }>;
    readonly queueStatusMessage: Map<string, { chatId: number; msgId: number }>;
    readonly sessIndex: Map<string, { agentId: string; sessionId: string }>;

    // Counters (mutable)
    remoteAgentIndexCounter: number;
    modelIndexCounter: number;
    sessIndexCounter: number;

    // Shared helper methods
    makeShortKey(prefix: string): string;
    disconnectRemoteAgent(userId: number): void;
    getActiveOrLastAgent(userId: number): import("../../../services/agent-db.service.js").PersistentAgent | undefined;
    editOrSendResult(chatId: number, msgId: number, agent: import("../../../services/agent-db.service.js").PersistentAgent, result: import("../../../services/persistent-agent.service.js").AgentSendResult): Promise<void>;
    sendAgentResult(chatId: number, agent: import("../../../services/agent-db.service.js").PersistentAgent, result: import("../../../services/persistent-agent.service.js").AgentSendResult): Promise<void>;
    sendPromptToAgent(ctx: import("grammy").Context, agent: import("../../../services/agent-db.service.js").PersistentAgent, prompt: string): Promise<void>;

    /**
     * Resolve where agent-initiated messages (questions, session errors,
     * adopted-session notifications) should be delivered. Prefers the last
     * chat where the agent was spoken to (persisted in agent_last_chat so it
     * survives restarts); falls back to the agent creator's DM if unknown.
     *
     * This is what makes multi-user / group-chat routing work: the agent no
     * longer always writes back to its creator.
     */
    resolveAgentChat(agentId: string): { chatId: number; userId: number };
}
