/**
 * ServerSlotDbService
 *
 * Manages the slot-based opencode server model:
 *
 *   - `server_slots`       → one row per opencode server process (max 2 by default).
 *                            Each slot has a fixed port and may have a "current project"
 *                            attached (the workdir of the last `POST /session` call).
 *   - `project_sessions`   → memoised OpenCode sessionId per (slot, project) pair, so
 *                            re-opening the same project on the same slot resumes the
 *                            conversation.
 *   - `active_slot_by_user` → which slot the user is currently talking to (sticky
 *                            routing for incoming Telegram messages).
 */

import Database from 'better-sqlite3';
import * as path from 'path';

export interface ServerSlot {
    id: string;                    // UUID
    userId: number;
    slotIndex: number;             // 1..MAX_SERVERS
    port: number;                  // Fixed port for the opencode serve process
    currentProjectId?: string;     // Project currently loaded in this slot (nullable)
    status: 'running' | 'stopped';
    createdAt: string;
}

export interface ProjectSession {
    slotId: string;
    projectId: string;
    sessionId: string;
    updatedAt: string;
}

const DB_PATH = path.join(
    process.env.SESSIONS_PERSIST_PATH || path.resolve('./'),
    'opencode_bot_sessions.sqlite'
);

export class ServerSlotDbService {
    private db: Database.Database;

    constructor() {
        this.db = new Database(DB_PATH);
        this.init();
    }

    private init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS server_slots (
                id                  TEXT PRIMARY KEY,
                user_id             INTEGER NOT NULL,
                slot_index          INTEGER NOT NULL,
                port                INTEGER NOT NULL UNIQUE,
                current_project_id  TEXT,
                status              TEXT NOT NULL DEFAULT 'running',
                created_at          DATETIME NOT NULL,
                UNIQUE(user_id, slot_index)
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS project_sessions (
                slot_id     TEXT NOT NULL,
                project_id  TEXT NOT NULL,
                session_id  TEXT NOT NULL,
                updated_at  DATETIME NOT NULL,
                PRIMARY KEY (slot_id, project_id)
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS active_slot_by_user (
                user_id     INTEGER PRIMARY KEY,
                slot_id     TEXT NOT NULL,
                updated_at  DATETIME NOT NULL
            )
        `);
    }

    private generateUuid(): string {
        return (global as any).crypto?.randomUUID?.() ?? require('crypto').randomUUID();
    }

    // ───────── server_slots ─────────

    createSlot(userId: number, slotIndex: number, port: number): ServerSlot {
        const slot: ServerSlot = {
            id: this.generateUuid(),
            userId,
            slotIndex,
            port,
            currentProjectId: undefined,
            status: 'running',
            createdAt: new Date().toISOString(),
        };
        this.db.prepare(`
            INSERT INTO server_slots (id, user_id, slot_index, port, current_project_id, status, created_at)
            VALUES (?, ?, ?, ?, NULL, 'running', ?)
        `).run(slot.id, slot.userId, slot.slotIndex, slot.port, slot.createdAt);
        return slot;
    }

    getSlotById(id: string): ServerSlot | undefined {
        const row = this.db.prepare('SELECT * FROM server_slots WHERE id = ?').get(id) as any;
        return row ? this.mapSlot(row) : undefined;
    }

    getSlotByPrefix(prefix: string): ServerSlot | undefined {
        const row = this.db.prepare('SELECT * FROM server_slots WHERE id LIKE ?').get(prefix + '%') as any;
        return row ? this.mapSlot(row) : undefined;
    }

    static shortId(slot: ServerSlot): string {
        return slot.id.slice(0, 8);
    }

    getSlotsByUser(userId: number): ServerSlot[] {
        return (this.db.prepare(
            'SELECT * FROM server_slots WHERE user_id = ? ORDER BY slot_index ASC'
        ).all(userId) as any[]).map(this.mapSlot);
    }

    getRunningSlotsByUser(userId: number): ServerSlot[] {
        return (this.db.prepare(
            "SELECT * FROM server_slots WHERE user_id = ? AND status = 'running' ORDER BY slot_index ASC"
        ).all(userId) as any[]).map(this.mapSlot);
    }

    getByPort(port: number): ServerSlot | undefined {
        const row = this.db.prepare('SELECT * FROM server_slots WHERE port = ?').get(port) as any;
        return row ? this.mapSlot(row) : undefined;
    }

    usedPorts(): number[] {
        return (this.db.prepare('SELECT port FROM server_slots').all() as any[]).map(r => r.port);
    }

    usedSlotIndexes(userId: number): number[] {
        return (this.db.prepare('SELECT slot_index FROM server_slots WHERE user_id = ?').all(userId) as any[])
            .map(r => r.slot_index);
    }

    /**
     * Returns the lowest positive slot index not yet used by this user.
     * Caller enforces the MAX_SERVERS cap.
     */
    nextFreeSlotIndex(userId: number): number {
        const used = new Set(this.usedSlotIndexes(userId));
        let i = 1;
        while (used.has(i)) i++;
        return i;
    }

    setSlotStatus(slotId: string, status: 'running' | 'stopped'): void {
        this.db.prepare('UPDATE server_slots SET status = ? WHERE id = ?').run(status, slotId);
    }

    setCurrentProject(slotId: string, projectId: string | null): void {
        this.db.prepare('UPDATE server_slots SET current_project_id = ? WHERE id = ?').run(projectId, slotId);
    }

    deleteSlot(id: string): void {
        this.db.prepare('DELETE FROM project_sessions WHERE slot_id = ?').run(id);
        this.db.prepare('DELETE FROM active_slot_by_user WHERE slot_id = ?').run(id);
        this.db.prepare('DELETE FROM server_slots WHERE id = ?').run(id);
    }

    // ───────── project_sessions ─────────

    getSessionId(slotId: string, projectId: string): string | undefined {
        const row = this.db.prepare(
            'SELECT session_id FROM project_sessions WHERE slot_id = ? AND project_id = ?'
        ).get(slotId, projectId) as any;
        return row?.session_id ?? undefined;
    }

    setSessionId(slotId: string, projectId: string, sessionId: string): void {
        this.db.prepare(`
            INSERT INTO project_sessions (slot_id, project_id, session_id, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(slot_id, project_id) DO UPDATE SET
                session_id = excluded.session_id,
                updated_at = excluded.updated_at
        `).run(slotId, projectId, sessionId, new Date().toISOString());
    }

    clearSessionId(slotId: string, projectId: string): void {
        this.db.prepare('DELETE FROM project_sessions WHERE slot_id = ? AND project_id = ?')
            .run(slotId, projectId);
    }

    /** All (project, sessionId) pairs memoised for a slot — useful when wiping a slot. */
    getSessionsForSlot(slotId: string): ProjectSession[] {
        return (this.db.prepare(
            'SELECT * FROM project_sessions WHERE slot_id = ? ORDER BY updated_at DESC'
        ).all(slotId) as any[]).map(this.mapProjectSession);
    }

    /** Remove memoised sessions for a given project across all slots (e.g. when the project is deleted). */
    clearSessionsForProject(projectId: string): void {
        this.db.prepare('DELETE FROM project_sessions WHERE project_id = ?').run(projectId);
    }

    // ───────── active_slot_by_user ─────────

    setActiveSlot(userId: number, slotId: string): void {
        this.db.prepare(`
            INSERT INTO active_slot_by_user (user_id, slot_id, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                slot_id = excluded.slot_id,
                updated_at = excluded.updated_at
        `).run(userId, slotId, new Date().toISOString());
    }

    getActiveSlot(userId: number): ServerSlot | undefined {
        const row = this.db.prepare('SELECT slot_id FROM active_slot_by_user WHERE user_id = ?')
            .get(userId) as any;
        if (!row) return undefined;
        return this.getSlotById(row.slot_id);
    }

    clearActiveSlot(userId: number): void {
        this.db.prepare('DELETE FROM active_slot_by_user WHERE user_id = ?').run(userId);
    }

    // ───────── mappers ─────────

    private mapSlot(row: any): ServerSlot {
        return {
            id: row.id,
            userId: row.user_id,
            slotIndex: row.slot_index,
            port: row.port,
            currentProjectId: row.current_project_id ?? undefined,
            status: (row.status === 'stopped' ? 'stopped' : 'running') as 'running' | 'stopped',
            createdAt: row.created_at,
        };
    }

    private mapProjectSession(row: any): ProjectSession {
        return {
            slotId: row.slot_id,
            projectId: row.project_id,
            sessionId: row.session_id,
            updatedAt: row.updated_at,
        };
    }
}
