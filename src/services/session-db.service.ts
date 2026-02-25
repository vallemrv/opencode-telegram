import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

export interface DbSession {
    id: string; // OpenCode session ID
    userId: number;
    projectId: string; // To differentiate by project visually if needed
    title: string;
    model: string;
    chatId: number | null;
    lastMessageId: number | null;
    currentAgent: string;
    createdAt: string;
    lastActive: string;
    isActive: boolean;
}

const DB_PATH = path.join(
    process.env.SESSIONS_PERSIST_PATH || path.resolve('./'),
    'opencode_bot_sessions.sqlite'
);

export class SessionDbService {
    private db: Database.Database;

    constructor() {
        this.db = new Database(DB_PATH, {
            // verbose: console.log
        });

        this.init();
    }

    private init() {
        // Create table for sessions
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                project_id TEXT,
                title TEXT,
                model TEXT,
                chat_id INTEGER,
                last_message_id INTEGER,
                current_agent TEXT,
                created_at DATETIME,
                last_active DATETIME,
                is_active BOOLEAN
            )
        `);

        // Generic key/value store for bot state persistence across restarts
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS bot_state (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);
    }

    setState(key: string, value: string): void {
        this.db.prepare(`
            INSERT INTO bot_state (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value);
    }

    getState(key: string): string | undefined {
        const row = this.db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as any;
        return row?.value;
    }

    deleteState(key: string): void {
        this.db.prepare('DELETE FROM bot_state WHERE key = ?').run(key);
    }

    // Load the active session for a specific user
    getActiveSession(userId: number): DbSession | undefined {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE user_id = ? AND is_active = 1 LIMIT 1');
        const row = stmt.get(userId) as any;
        return row ? this.mapRow(row) : undefined;
    }

    // Set a session as active (and others as inactive for that user)
    setActiveSession(userId: number, sessionId: string) {
        // Transaction to ensure atomic update
        const transaction = this.db.transaction(() => {
            // Set all user sessions to inactive
            this.db.prepare('UPDATE sessions SET is_active = 0 WHERE user_id = ?').run(userId);
            // Set the target session to active
            this.db.prepare('UPDATE sessions SET is_active = 1, last_active = ? WHERE id = ?').run(
                new Date().toISOString(),
                sessionId
            );
        });
        transaction();
    }

    // Insert or update a session
    saveSession(session: Omit<DbSession, 'lastActive'> & { lastActive?: string }) {
        const stmt = this.db.prepare(`
            INSERT INTO sessions (id, user_id, project_id, title, model, chat_id, last_message_id, current_agent, created_at, last_active, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                model = excluded.model,
                chat_id = COALESCE(excluded.chat_id, sessions.chat_id),
                last_message_id = COALESCE(excluded.last_message_id, sessions.last_message_id),
                current_agent = excluded.current_agent,
                last_active = excluded.last_active,
                is_active = excluded.is_active
        `);

        stmt.run(
            session.id,
            session.userId,
            session.projectId || 'global',
            session.title,
            session.model,
            session.chatId || null,
            session.lastMessageId || null,
            session.currentAgent || 'build',
            session.createdAt,
            session.lastActive || new Date().toISOString(),
            session.isActive ? 1 : 0
        );
    }

    // Update specific fields of a session
    updateSession(sessionId: string, updates: Partial<DbSession>) {
        const setClauses: string[] = [];
        const values: any[] = [];

        const mapping: Record<string, string> = {
            title: 'title',
            model: 'model',
            chatId: 'chat_id',
            lastMessageId: 'last_message_id',
            currentAgent: 'current_agent',
            lastActive: 'last_active'
        };

        for (const [key, dbColumn] of Object.entries(mapping)) {
            if (updates[key as keyof DbSession] !== undefined) {
                setClauses.push(`${dbColumn} = ?`);
                values.push(updates[key as keyof DbSession]);
            }
        }

        if (setClauses.length === 0) return;

        values.push(sessionId);
        const stmt = this.db.prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`);
        stmt.run(...values);
    }

    // Get all sessions for a user, sorted by last_active
    getUserSessions(userId: number, limit: number = 10): DbSession[] {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_active DESC LIMIT ?');
        const rows = stmt.all(userId, limit) as any[];
        return rows.map(r => this.mapRow(r));
    }

    // Get a specific session by ID
    getSessionById(sessionId: string): DbSession | undefined {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
        const row = stmt.get(sessionId) as any;
        return row ? this.mapRow(row) : undefined;
    }

    // Delete a session
    deleteSession(sessionId: string) {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    }

    // Delete all sessions for a user
    deleteAllUserSessions(userId: number) {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }

    // Load active sessions on boot (used by opencode.service.ts on restore array)
    getAllActiveSessions(): DbSession[] {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE is_active = 1');
        const rows = stmt.all() as any[];
        return rows.map(r => this.mapRow(r));
    }

    private mapRow(row: any): DbSession {
        return {
            id: row.id,
            userId: row.user_id,
            projectId: row.project_id,
            title: row.title,
            model: row.model,
            chatId: row.chat_id,
            lastMessageId: row.last_message_id,
            currentAgent: row.current_agent,
            createdAt: row.created_at,
            lastActive: row.last_active,
            isActive: Boolean(row.is_active)
        };
    }
}
