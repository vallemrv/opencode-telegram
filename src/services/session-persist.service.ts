import * as fs from 'fs';
import * as path from 'path';

/**
 * Datos mínimos que se persisten en disco para recuperar una sesión tras reinicio.
 * No guardamos campos volátiles como timeouts o el objeto Session completo.
 */
export interface PersistedSession {
    userId: number;
    sessionId: string;
    chatId?: number;
    lastMessageId?: number;
    currentAgent?: string;
    currentModel?: string;
    createdAt: string; // ISO string
}

const SESSIONS_FILE = path.join(
    process.env.SESSIONS_PERSIST_PATH ||
    path.resolve('./'),
    'sessions.json'
);

export class SessionPersistService {
    /** Lee todas las sesiones persistidas del disco */
    loadSessions(): Map<number, PersistedSession> {
        const result = new Map<number, PersistedSession>();
        try {
            if (!fs.existsSync(SESSIONS_FILE)) return result;
            const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
            const arr: PersistedSession[] = JSON.parse(raw);
            for (const s of arr) {
                result.set(s.userId, s);
            }
            console.log(`[SessionPersist] Loaded ${result.size} session(s) from disk`);
        } catch (err) {
            console.error('[SessionPersist] Could not load sessions from disk:', err);
        }
        return result;
    }

    /** Guarda una sesión en disco */
    saveSession(session: PersistedSession): void {
        try {
            const all = this.loadSessions();
            all.set(session.userId, session);
            this._writeToDisk(all);
        } catch (err) {
            console.error('[SessionPersist] Could not save session to disk:', err);
        }
    }

    /** Elimina una sesión del disco */
    deleteSession(userId: number): void {
        try {
            const all = this.loadSessions();
            all.delete(userId);
            this._writeToDisk(all);
        } catch (err) {
            console.error('[SessionPersist] Could not delete session from disk:', err);
        }
    }

    /** Actualiza campos específicos de una sesión (chatId, lastMessageId) */
    updateSession(userId: number, updates: Partial<PersistedSession>): void {
        try {
            const all = this.loadSessions();
            const existing = all.get(userId);
            if (existing) {
                all.set(userId, { ...existing, ...updates });
                this._writeToDisk(all);
            }
        } catch (err) {
            console.error('[SessionPersist] Could not update session on disk:', err);
        }
    }

    private _writeToDisk(sessions: Map<number, PersistedSession>): void {
        const arr = Array.from(sessions.values());
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
    }
}
