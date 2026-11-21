/**
 * Cooldowns and anti-spam.
 *
 * Cooldown: the same user cannot run the same command again for N seconds.
 * Anti-spam: a user running more than `limit` commands within WINDOW_MS is
 * muted for MUTE_MS. Each case is answered once, then ignored silently,
 * so the bot can never be used to flood a chat with warnings.
 */

const WINDOW_MS = 10_000;
const MUTE_MS = 60_000;
const MAX_KEYS = 10_000;

const lastUse = new Map(); // `${user}:${command}` → timestamp
const warned = new Map(); // `${user}:${command}` → timestamp of the warning
const recent = new Map(); // user → timestamps[]
const muted = new Map(); // user → until

const trim = (map) => {
    if (map.size > MAX_KEYS) map.delete(map.keys().next().value);
};

/**
 * @returns {{ ok: true } | { ok: false, remainingMs: number, notify: boolean }}
 */
export const checkCooldown = (user, command, seconds, now = Date.now()) => {
    if (!seconds) return { ok: true };
    const key = `${user}:${command}`;
    const last = lastUse.get(key);
    const remainingMs = last === undefined ? 0 : last + seconds * 1000 - now;
    if (remainingMs > 0) {
        const notify = (warned.get(key) || 0) < last;
        if (notify) warned.set(key, now);
        return { ok: false, remainingMs, notify };
    }
    lastUse.set(key, now);
    trim(lastUse);
    trim(warned);
    return { ok: true };
};

/**
 * @returns {{ ok: true } | { ok: false, notify: boolean, remainingMs: number }}
 */
export const checkSpam = (user, limit, now = Date.now()) => {
    const until = muted.get(user);
    if (until && until > now) return { ok: false, notify: false, remainingMs: until - now };
    if (until) muted.delete(user);

    const times = (recent.get(user) || []).filter((t) => now - t < WINDOW_MS);
    times.push(now);
    recent.set(user, times);
    trim(recent);
    if (times.length > limit) {
        muted.set(user, now + MUTE_MS);
        recent.delete(user);
        return { ok: false, notify: true, remainingMs: MUTE_MS };
    }
    return { ok: true };
};

export const resetLimits = () => {
    lastUse.clear();
    warned.clear();
    recent.clear();
    muted.clear();
};
