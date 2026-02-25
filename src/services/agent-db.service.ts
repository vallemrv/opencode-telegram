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
                created_at  DATETIME NOT NULL
            )
        `);
    }

    save(agent: PersistentAgent): void {
        this.db.prepare(`
            INSERT INTO persistent_agents (id, user_id, name, role, workdir, model, port, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                role = excluded.role,
                workdir = excluded.workdir,
                model = excluded.model,
                port = excluded.port
        `).run(
            agent.id,
            agent.userId,
            agent.name,
            agent.role,
            agent.workdir,
            agent.model,
            agent.port,
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

    /** Returns all ports already in use by persistent agents */
    usedPorts(): number[] {
        return (this.db.prepare('SELECT port FROM persistent_agents').all() as any[]).map(r => r.port);
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
            createdAt: row.created_at,
        };
    }
}
