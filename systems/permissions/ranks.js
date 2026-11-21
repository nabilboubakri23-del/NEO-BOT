/**
 * Rank hierarchy — the single source of truth for every permission level.
 *
 *   🔱 creator    100  exactly one person: the main owner (data/owners.json, MAIN_OWNER,
 *                      OWNER_NUMBERS) or the linked account itself. Bypasses everything
 *                      except physical WhatsApp rules (the bot must be a group admin to kick).
 *   👑 owner       80  co-owners (the "admins" list in data/owners.json)
 *   🛡️ moderator   60  can ban users and grant ranks below moderator
 *   🌟 vip         40
 *   💎 premium     30
 *   👤 user        10  everyone by default ("public" is an alias)
 *   🚫 banned       0  ignored by the bot
 *
 * A command declares ONE minimum rank:  permission: 'premium'
 * Higher ranks always pass.
 *
 * Perks:
 *   cooldownMultiplier  scales a command's cooldown (0 = no cooldown, no anti-spam)
 *   dailyLimit          commands per day; 'setting' = the "dailyLimit" setting, Infinity = unlimited
 */

const define = (name, level, emoji, label, perks) => Object.freeze({ name, level, emoji, label, perks: Object.freeze(perks) });

export const RANKS = Object.freeze([
    define('creator', 100, '🔱', 'Creator', { cooldownMultiplier: 0, dailyLimit: Infinity }),
    define('owner', 80, '👑', 'Owner', { cooldownMultiplier: 0, dailyLimit: Infinity }),
    define('moderator', 60, '🛡️', 'Moderator', { cooldownMultiplier: 0, dailyLimit: Infinity }),
    define('vip', 40, '🌟', 'VIP', { cooldownMultiplier: 0.25, dailyLimit: Infinity }),
    define('premium', 30, '💎', 'Premium', { cooldownMultiplier: 0.5, dailyLimit: Infinity }),
    define('user', 10, '👤', 'User', { cooldownMultiplier: 1, dailyLimit: 'setting' }),
    define('banned', 0, '🚫', 'Banned', { cooldownMultiplier: 1, dailyLimit: 0 })
]);

/** Other accepted spellings of a rank name. */
const ALIASES = Object.freeze({ public: 'user', everyone: 'user', member: 'user', mainowner: 'creator', mod: 'moderator', prem: 'premium', ban: 'banned' });

const BY_NAME = new Map(RANKS.map((r) => [r.name, r]));

/** Canonical rank name for any accepted spelling, or null when unknown. */
export const rankName = (value) => {
    const key = String(value ?? '').trim().toLowerCase();
    const name = ALIASES[key] || key;
    return BY_NAME.has(name) ? name : null;
};

/** Rank definition for a name or alias (null when unknown). */
export const getRank = (value) => BY_NAME.get(rankName(value)) || null;

export const isRankName = (value) => rankName(value) !== null;

export const levelOf = (value) => getRank(value)?.level ?? -1;

/** True when rank `a` is at least rank `b`. */
export const atLeast = (a, b) => levelOf(a) >= levelOf(b) && levelOf(b) >= 0;

/** "💎 Premium" */
export const badge = (value) => {
    const rank = getRank(value);
    return rank ? `${rank.emoji} ${rank.label}` : String(value);
};

/** Ranks that can be stored for a user in the rank store (creator/owner/banned/user live elsewhere). */
export const STORED_RANKS = Object.freeze(['moderator', 'vip', 'premium']);

export const DEFAULT_RANK = 'user';
export const CREATOR = 'creator';
