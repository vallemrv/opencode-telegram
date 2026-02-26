/**
 * AgentDbService
 *
 * Manages the `persistent_agents` table in the existing SQLite database.
 * Each persistent agent has its own opencode server running on a fixed port.
 */

import Database from 'better-sqlite3';
import * as path from 'path';

export interface PersistentAgent {
    id: string;           // UUID
    userId: number;       // Telegram user who created it
    name: string;         // Human-readable name (e.g. "backend-helper")
    role: string;         // System-prompt role injected on every message
    workdir: string;      // Resolved absolute path
    model: string;        // provider/model
    port: number;         // Fixed port for its opencode serve process
    sessionId?: string;   // Long-lived OpenCode session UUID (persisted across restarts)
    createdAt: string;
}

const DB_PATH = path.join(
    process.env.SESSIONS_PERSIST_PATH || path.resolve('./'),
    'opencode_bot_sessions.sqlite'
);

export class AgentDbService {
    private db: Database.Database;

    constructor() {
        this.db = new Database(DB_PATH);
        this.init();
    }

    private init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS persistent_agents (
                id          TEXT PRIMARY KEY,
                user_id     INTEGER NOT NULL,
                name        TEXT NOT NULL,
                role        TEXT NOT NULL,
                workdir     TEXT NOT NULL,
                model       TEXT NOT NULL,
                port        INTEGER NOT NULL UNIQUE,
                session_id  TEXT,
                created_at  DATETIME NOT NULL
            )
        `);
        // Migrate existing databases that don't have the session_id column yet
        try {
            this.db.exec(`ALTER TABLE persistent_agents ADD COLUMN session_id TEXT`);
        } catch {
            // Column already exists — ignore
        }
        // Tracks which agent was last used per user (for auto-routing messages)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_last_used (
                user_id     INTEGER PRIMARY KEY,
                agent_id    TEXT NOT NULL,
                updated_at  DATETIME NOT NULL
            )
        `);
    }

    save(agent: PersistentAgent): void {
        this.db.prepare(`
            INSERT INTO persistent_agents (id, user_id, name, role, workdir, model, port, session_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                role = excluded.role,
                workdir = excluded.workdir,
                model = excluded.model,
                port = excluded.port,
                session_id = excluded.session_id
        `).run(
            agent.id,
            agent.userId,
            agent.name,
            agent.role,
            agent.workdir,
            agent.model,
            agent.port,
            agent.sessionId ?? null,
            agent.createdAt,
        );
    }

    getAll(): PersistentAgent[] {
        return (this.db.prepare('SELECT * FROM persistent_agents ORDER BY created_at ASC').all() as any[])
            .map(this.mapRow);
    }

    getByUser(userId: number): PersistentAgent[] {
        return (this.db.prepare('SELECT * FROM persistent_agents WHERE user_id = ? ORDER BY created_at ASC').all(userId) as any[])
            .map(this.mapRow);
    }

    getById(id: string): PersistentAgent | undefined {
        const row = this.db.prepare('SELECT * FROM persistent_agents WHERE id = ?').get(id) as any;
        return row ? this.mapRow(row) : undefined;
    }

    /** Look up an agent by the first 8 characters of its UUID (for compact callback data). */
    getByPrefix(prefix: string): PersistentAgent | undefined {
        const row = this.db.prepare("SELECT * FROM persistent_agents WHERE id LIKE ?").get(prefix + '%') as any;
        return row ? this.mapRow(row) : undefined;
    }

    /** Returns the first 8 characters of the agent UUID — safe for Telegram callback_data. */
    static shortId(agent: PersistentAgent): string {
        return agent.id.slice(0, 8);
    }

    getByPort(port: number): PersistentAgent | undefined {
        const row = this.db.prepare('SELECT * FROM persistent_agents WHERE port = ?').get(port) as any;
        return row ? this.mapRow(row) : undefined;
    }

    delete(id: string): void {
        this.db.prepare('DELETE FROM persistent_agents WHERE id = ?').run(id);
    }

    updateModel(id: string, model: string): void {
        this.db.prepare('UPDATE persistent_agents SET model = ? WHERE id = ?').run(model, id);
    }

    /** Persist the long-lived OpenCode session ID for an agent */
    setSessionId(agentId: string, sessionId: string): void {
        this.db.prepare('UPDATE persistent_agents SET session_id = ? WHERE id = ?').run(sessionId, agentId);
    }

    /** Clear the persisted session ID (e.g. after a session is deleted or corrupted) */
    clearSessionId(agentId: string): void {
        this.db.prepare('UPDATE persistent_agents SET session_id = NULL WHERE id = ?').run(agentId);
    }

    /** Returns all ports already in use by persistent agents */
    usedPorts(): number[] {
        return (this.db.prepare('SELECT port FROM persistent_agents').all() as any[]).map(r => r.port);
    }

    /** Persist the last-used agent for a user */
    setLastUsed(userId: number, agentId: string): void {
        this.db.prepare(`
            INSERT INTO agent_last_used (user_id, agent_id, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at
        `).run(userId, agentId, new Date().toISOString());
    }

    /** Returns the last-used agent for a user, or undefined */
    getLastUsed(userId: number): PersistentAgent | undefined {
        const row = this.db.prepare('SELECT agent_id FROM agent_last_used WHERE user_id = ?').get(userId) as any;
        if (!row) return undefined;
        return this.getById(row.agent_id);
    }

    /** Clear last-used record (e.g. when the agent is deleted) */
    clearLastUsed(userId: number): void {
        this.db.prepare('DELETE FROM agent_last_used WHERE user_id = ?').run(userId);
    }

    private mapRow(row: any): PersistentAgent {
        return {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            role: row.role,
            workdir: row.workdir,
            model: row.model,
            port: row.port,
            sessionId: row.session_id ?? undefined,
            createdAt: row.created_at,
        };
    }
}
