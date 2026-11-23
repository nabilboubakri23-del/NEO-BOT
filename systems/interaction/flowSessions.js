import crypto from 'node:crypto';
import { UserError } from '../../utils/errors.js';

/**
 * Per-user interactive flow state (used by .spotify and .pinterest).
 * One session per (chat, sender): a new menu always invalidates the previous one,
 * so an old button can never start a download. Sessions expire after 5 minutes,
 * and "waiting for input" (after Search by name / Download by link) after 2 minutes.
 */
export const SESSION_TTL = 5 * 60_000;
export const INPUT_TTL = 2 * 60_000;
const MAX_SESSIONS = 500;
const MAX_ACTIVE = 3; // concurrent searches/downloads across the whole bot (Render free RAM)

export class FlowSessions {
    /** @param {{ name?: string, command?: string, now?: () => number, maxActive?: number }} [options] */
    constructor({ name = 'This', command = '', now = Date.now, maxActive = MAX_ACTIVE } = {}) {
        this.name = name;
        this.command = command;
        this.maxActive = maxActive;
        this.now = now;
        this.sessions = new Map();
        this.active = new Set();
        this.limits = new Map();
    }

    key(m) { return JSON.stringify([m.chat, m.senderNumber || m.sender]); }

    prune() {
        const now = this.now();
        for (const [k, s] of this.sessions) if (s.expires <= now) { s.cancelled = true; this.sessions.delete(k); }
        for (const [k, until] of this.limits) if (until <= now) this.limits.delete(k);
    }

    create(m, tracks = []) {
        this.prune();
        const key = this.key(m);
        if (this.sessions.size >= MAX_SESSIONS && !this.sessions.has(key)) throw new UserError(`${this.name} is busy right now. Try again in a minute.`);
        this.cancel(m);
        const s = { token: crypto.randomBytes(8).toString('hex'), expires: this.now() + SESSION_TTL, tracks, items: tracks, awaiting: null, used: false, cancelled: false };
        this.sessions.set(key, s);
        return s;
    }

    get(m, token) {
        this.prune();
        const s = this.sessions.get(this.key(m));
        if (!s || s.token !== token) throw new UserError(`This ${this.name} menu expired or belongs to someone else. Send .${this.command} again.`);
        return s;
    }

    /** Current session of this sender, if any (no token check; used for typed input). */
    peek(m) {
        this.prune();
        return this.sessions.get(this.key(m)) || null;
    }

    cancel(m) {
        const s = this.sessions.get(this.key(m));
        if (s) s.cancelled = true;
        this.sessions.delete(this.key(m));
        return Boolean(s);
    }

    /** Wait for the sender's next plain message as a song name or link. */
    expect(m, token, mode) {
        const s = this.get(m, token);
        s.awaiting = { mode, until: this.now() + INPUT_TTL };
        return s;
    }

    /** One-shot: returns the awaited mode and clears it, or null. */
    takeAwaiting(m) {
        const s = this.peek(m);
        if (!s?.awaiting) return null;
        const { mode, until } = s.awaiting;
        s.awaiting = null;
        return until > this.now() ? { mode, session: s } : null;
    }

    /** Keeps a session alive while the user browses it. */
    touch(s) { s.expires = this.now() + SESSION_TTL; return s; }

    rate(m, action, ms) {
        this.prune();
        const key = this.key(m) + action;
        if (this.limits.get(key) > this.now()) throw new UserError(`Slow down a little, then try this ${this.name} action again.`);
        if (this.limits.size >= 2000 && !this.limits.has(key)) throw new UserError(`${this.name} is busy right now. Try again in a minute.`);
        this.limits.set(key, this.now() + ms);
    }

    isBusy(m) { return this.active.has(this.key(m)); }

    async run(m, action, ms, fn) {
        const key = this.key(m);
        if (this.active.has(key)) throw new UserError(`Your ${this.name} request is still running. Wait for it to finish.`);
        if (this.active.size >= this.maxActive) throw new UserError(`${this.name} is handling other requests. Try again in a few seconds.`);
        this.rate(m, action, ms);
        this.active.add(key);
        try { return await fn(); } finally { this.active.delete(key); }
    }
}

