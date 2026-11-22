/**
 * One running game per chat, kept in memory (games are short; a restart simply ends them).
 * Each session has an inactivity timer: when it fires the session is removed and
 * `onTimeout(session)` runs (e.g. to announce the answer).
 */
export class GameSessions {
    constructor({ timeoutMs, onTimeout = () => {} } = {}) {
        this.timeoutMs = timeoutMs;
        this.onTimeout = onTimeout;
        this.sessions = new Map(); // chat → { state, timer }
    }

    get(chat) {
        return this.sessions.get(chat)?.state || null;
    }

    has(chat) {
        return this.sessions.has(chat);
    }

    /** Starts (or replaces) the session of a chat. */
    start(chat, state, timeoutMs = this.timeoutMs) {
        this.end(chat);
        const entry = { state, timer: null };
        this.sessions.set(chat, entry);
        this.touch(chat, timeoutMs);
        return state;
    }

    /** Restarts the inactivity timer (call after every valid move). */
    touch(chat, timeoutMs = this.timeoutMs) {
        const entry = this.sessions.get(chat);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            if (this.sessions.get(chat) !== entry) return;
            this.sessions.delete(chat);
            Promise.resolve(this.onTimeout(entry.state, chat)).catch(() => {});
        }, timeoutMs);
        entry.timer.unref?.();
    }

    /** Ends a session without calling onTimeout. Returns its state (or null). */
    end(chat) {
        const entry = this.sessions.get(chat);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.sessions.delete(chat);
        return entry.state;
    }

    clear() {
        for (const chat of [...this.sessions.keys()]) this.end(chat);
    }

    get size() {
        return this.sessions.size;
    }
}
