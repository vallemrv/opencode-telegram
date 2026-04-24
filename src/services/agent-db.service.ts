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
    status: "running" | "stopped";
    createdAt: string;
    lastUsedAt: string;
    host?: string;
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
                status      TEXT NOT NULL DEFAULT 'running',
                created_at  DATETIME NOT NULL,
                last_used_at DATETIME,
                host        TEXT DEFAULT 'localhost'
            )
        `);
        try {
            this.db.exec(`ALTER TABLE persistent_agents ADD COLUMN session_id TEXT`);
        } catch { /* Column already exists */ }
        try {
            this.db.exec(`ALTER TABLE persistent_agents ADD COLUMN status TEXT NOT NULL DEFAULT 'running'`);
        } catch { /* Column already exists */ }
        try {
            this.db.exec(`ALTER TABLE persistent_agents ADD COLUMN host TEXT DEFAULT 'localhost'`);
        } catch { /* Column already exists */ }
        try {
            this.db.exec(`ALTER TABLE persistent_agents ADD COLUMN last_used_at DATETIME`);
            this.db.exec(`UPDATE persistent_agents SET last_used_at = created_at WHERE last_used_at IS NULL`);
        } catch { /* Column already exists */ }

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
            INSERT INTO persistent_agents (id, user_id, name, role, workdir, model, port, session_id, status, created_at, last_used_at, host)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                role = excluded.role,
                workdir = excluded.workdir,
                model = excluded.model,
                port = excluded.port,
                session_id = excluded.session_id,
                status = excluded.status,
                last_used_at = excluded.last_used_at,
                host = excluded.host
        `).run(
            agent.id,
            agent.userId,
            agent.name,
            agent.role,
            agent.workdir,
            agent.model,
            agent.port,
            agent.sessionId ?? null,
            agent.status ?? "running",
            agent.createdAt,
            agent.lastUsedAt ?? agent.createdAt,
            agent.host ?? 'localhost',
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

    getByPrefix(prefix: string): PersistentAgent | undefined {
        const row = this.db.prepare("SELECT * FROM persistent_agents WHERE id LIKE ?").get(prefix + '%') as any;
        return row ? this.mapRow(row) : undefined;
    }

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

    setSessionId(agentId: string, sessionId: string): void {
        this.db.prepare('UPDATE persistent_agents SET session_id = ? WHERE id = ?').run(sessionId, agentId);
    }

    clearSessionId(agentId: string): void {
        this.db.prepare('UPDATE persistent_agents SET session_id = NULL WHERE id = ?').run(agentId);
    }

    setStatus(agentId: string, status: "running" | "stopped"): void {
        this.db.prepare('UPDATE persistent_agents SET status = ? WHERE id = ?').run(status, agentId);
    }

    getRunningByUser(userId: number): PersistentAgent[] {
        return (this.db.prepare(
            "SELECT * FROM persistent_agents WHERE user_id = ? AND status = 'running' ORDER BY created_at ASC"
        ).all(userId) as any[]).map(this.mapRow);
    }

    usedPorts(): number[] {
        return (this.db.prepare('SELECT port FROM persistent_agents').all() as any[]).map(r => r.port);
    }

    setLastUsed(userId: number, agentId: string): void {
        this.db.prepare(`
            INSERT INTO agent_last_used (user_id, agent_id, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at
        `).run(userId, agentId, new Date().toISOString());
    }

    getLastUsed(userId: number): PersistentAgent | undefined {
        const row = this.db.prepare('SELECT agent_id FROM agent_last_used WHERE user_id = ?').get(userId) as any;
        if (!row) return undefined;
        return this.getById(row.agent_id);
    }

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
            status: (row.status === "stopped" ? "stopped" : "running") as "running" | "stopped",
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at ?? row.created_at,
            host: row.host ?? 'localhost',
        };
    }

    touchLastUsed(agentId: string): void {
        this.db.prepare('UPDATE persistent_agents SET last_used_at = ? WHERE id = ?')
            .run(new Date().toISOString(), agentId);
    }

    getRunningOrderedByLRU(): PersistentAgent[] {
        return (this.db.prepare(
            `SELECT * FROM persistent_agents WHERE status = 'running' ORDER BY last_used_at ASC`
        ).all() as any[]).map(this.mapRow);
    }

    countRunningLocal(): number {
        const row = this.db.prepare(
            `SELECT COUNT(*) as c FROM persistent_agents WHERE status = 'running'`
        ).get() as any;
        return row?.c ?? 0;
    }

    findByWorkdir(workdir: string): PersistentAgent | undefined {
        const row = this.db.prepare(
            `SELECT * FROM persistent_agents WHERE workdir = ? LIMIT 1`
        ).get(workdir) as any;
        return row ? this.mapRow(row) : undefined;
    }
}