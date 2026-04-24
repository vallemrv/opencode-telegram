/**
 * ProjectDbService
 *
 * Manages the `projects` table. Each row is a workdir that the user has
 * opened at least once — independent of which server slot ran it.
 *
 * One project = one absolute path. The same project can be opened from any
 * server slot; the binding (project × slot → sessionId) lives in
 * ServerSlotDbService.
 */

import Database from 'better-sqlite3';
import * as path from 'path';

export interface Project {
    id: string;            // UUID
    userId: number;        // Telegram user who registered it
    name: string;          // Human-readable (defaults to basename of path)
    path: string;          // Absolute workdir
    createdAt: string;     // ISO timestamp
    lastUsedAt: string;    // ISO timestamp (for "recent" ordering)
    createdWithGit?: boolean; // True if the project directory was initialised via `git init`
}

const DB_PATH = path.join(
    process.env.SESSIONS_PERSIST_PATH || path.resolve('./'),
    'opencode_bot_sessions.sqlite'
);

export class ProjectDbService {
    private db: Database.Database;

    constructor() {
        this.db = new Database(DB_PATH);
        this.init();
    }

    private init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS projects (
                id                TEXT PRIMARY KEY,
                user_id           INTEGER NOT NULL,
                name              TEXT NOT NULL,
                path              TEXT NOT NULL,
                created_at        DATETIME NOT NULL,
                last_used_at      DATETIME NOT NULL,
                created_with_git  INTEGER DEFAULT 0,
                UNIQUE(user_id, path)
            )
        `);
        this.migrateFromPersistentAgents();
    }

    /**
     * One-shot migration: if the `projects` table is empty, import the distinct
     * (user_id, workdir) pairs from `persistent_agents` so existing users don't
     * lose their project history when upgrading to the slot-based model.
     */
    private migrateFromPersistentAgents() {
        const count = (this.db.prepare('SELECT COUNT(*) AS c FROM projects').get() as any).c as number;
        if (count > 0) return;

        let rows: any[] = [];
        try {
            rows = this.db.prepare(
                `SELECT DISTINCT user_id, workdir, MIN(created_at) AS created_at
                 FROM persistent_agents
                 GROUP BY user_id, workdir`
            ).all() as any[];
        } catch {
            // persistent_agents table doesn't exist on a fresh install — nothing to migrate.
            return;
        }

        for (const row of rows) {
            const workdir = row.workdir as string;
            if (!workdir) continue;
            const id = this.generateUuid();
            const createdAt = (row.created_at as string) || new Date().toISOString();
            this.db.prepare(`
                INSERT OR IGNORE INTO projects (id, user_id, name, path, created_at, last_used_at, created_with_git)
                VALUES (?, ?, ?, ?, ?, ?, 0)
            `).run(
                id,
                row.user_id,
                path.basename(workdir) || workdir,
                workdir,
                createdAt,
                createdAt,
            );
        }
    }

    private generateUuid(): string {
        // better-sqlite3 runs sync; use crypto here to avoid importing uuid just for this.
        return (global as any).crypto?.randomUUID?.() ?? require('crypto').randomUUID();
    }

    /** Insert or update (by user_id+path). Returns the stored Project. */
    upsert(userId: number, absolutePath: string, name?: string, createdWithGit = false): Project {
        const existing = this.getByPath(userId, absolutePath);
        const now = new Date().toISOString();
        if (existing) {
            this.db.prepare('UPDATE projects SET last_used_at = ?, name = COALESCE(?, name) WHERE id = ?')
                .run(now, name ?? null, existing.id);
            return { ...existing, lastUsedAt: now, name: name ?? existing.name };
        }
        const id = this.generateUuid();
        const project: Project = {
            id,
            userId,
            name: name ?? path.basename(absolutePath) ?? absolutePath,
            path: absolutePath,
            createdAt: now,
            lastUsedAt: now,
            createdWithGit,
        };
        this.db.prepare(`
            INSERT INTO projects (id, user_id, name, path, created_at, last_used_at, created_with_git)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(project.id, project.userId, project.name, project.path, project.createdAt, project.lastUsedAt, project.createdWithGit ? 1 : 0);
        return project;
    }

    /** Touch last_used_at (used when the user re-opens an existing project). */
    touch(id: string): void {
        this.db.prepare('UPDATE projects SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    }

    getById(id: string): Project | undefined {
        const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
        return row ? this.mapRow(row) : undefined;
    }

    getByPath(userId: number, absolutePath: string): Project | undefined {
        const row = this.db.prepare('SELECT * FROM projects WHERE user_id = ? AND path = ?')
            .get(userId, absolutePath) as any;
        return row ? this.mapRow(row) : undefined;
    }

    /** Look up a project by the first 8 characters of its UUID (for compact callback data). */
    getByPrefix(prefix: string): Project | undefined {
        const row = this.db.prepare('SELECT * FROM projects WHERE id LIKE ?').get(prefix + '%') as any;
        return row ? this.mapRow(row) : undefined;
    }

    /** Returns the first 8 characters of the project UUID — safe for Telegram callback_data. */
    static shortId(project: Project): string {
        return project.id.slice(0, 8);
    }

    /** All projects for a user, most recently used first. */
    getRecent(userId: number, limit = 20): Project[] {
        return (this.db.prepare(
            'SELECT * FROM projects WHERE user_id = ? ORDER BY last_used_at DESC LIMIT ?'
        ).all(userId, limit) as any[]).map(this.mapRow);
    }

    getAllByUser(userId: number): Project[] {
        return (this.db.prepare(
            'SELECT * FROM projects WHERE user_id = ? ORDER BY last_used_at DESC'
        ).all(userId) as any[]).map(this.mapRow);
    }

    delete(id: string): void {
        this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    }

    rename(id: string, newName: string): void {
        this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(newName, id);
    }

    private mapRow(row: any): Project {
        return {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            path: row.path,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
            createdWithGit: !!row.created_with_git,
        };
    }
}
