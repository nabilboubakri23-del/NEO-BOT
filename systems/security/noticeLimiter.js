/**
 * At most one action per key per time window (bounded memory). Used for bot notices
 * ("link deleted") and auto-replies, so nobody can make the bot flood a chat in return.
 */
export class NoticeLimiter {
    constructor(windowMs = 30_000, max = 500) {
        this.windowMs = windowMs;
        this.max = max;
        this.last = new Map();
    }

    allow(key, now = Date.now()) {
        const at = this.last.get(key);
        if (at !== undefined && now - at < this.windowMs) return false;
        this.last.set(key, now);
        if (this.last.size > this.max) this.last.delete(this.last.keys().next().value);
        return true;
    }
}
