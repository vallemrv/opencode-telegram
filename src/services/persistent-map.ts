/**
 * PersistentHeartbeatMap
 *
 * Drop-in replacement for `Map<string, { chatId: number; msgId: number }>` that
 * also mirrors every mutation to the `heartbeat_messages` SQLite table via
 * SessionDbService. The in-memory Map is the fast path; the DB is the source
 * of truth when the bot restarts mid-prompt.
 *
 * The userId is kept alongside each entry so that we can still send fallback
 * notifications (e.g. to the agent creator) if we ever lose the originating
 * chatId — but the chatId is what routes the heartbeat in multi-chat scenarios.
 */

import type { SessionDbService } from "./session-db.service.js";

export interface HeartbeatEntry {
    chatId: number;
    msgId: number;
    /**
     * Optional Telegram userId of the user who triggered the prompt. Kept only
     * as metadata for multi-user routing; NOT part of the Map key.
     */
    userId?: number;
}

export class PersistentHeartbeatMap extends Map<string, HeartbeatEntry> {
    constructor(private readonly db: SessionDbService) {
        super();
        for (const row of db.getAllHeartbeats()) {
            super.set(row.agentId, { chatId: row.chatId, msgId: row.msgId, userId: row.userId });
        }
    }

    set(agentId: string, entry: HeartbeatEntry): this {
        super.set(agentId, entry);
        try {
            this.db.saveHeartbeat(agentId, entry.chatId, entry.msgId, entry.userId ?? 0);
        } catch (err) {
            console.error("[PersistentHeartbeatMap] saveHeartbeat failed:", err);
        }
        return this;
    }

    delete(agentId: string): boolean {
        const had = super.delete(agentId);
        try {
            this.db.deleteHeartbeat(agentId);
        } catch (err) {
            console.error("[PersistentHeartbeatMap] deleteHeartbeat failed:", err);
        }
        return had;
    }

    clear(): void {
        for (const key of this.keys()) {
            try {
                this.db.deleteHeartbeat(key);
            } catch { /* ignore */ }
        }
        super.clear();
    }
}
