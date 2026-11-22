/**
 * Level math and reward tables. Pure functions, no storage.
 * Total XP to reach level L = 50 × L × (L + 1): L1 100, L2 300, L3 600, L4 1000 …
 */

export const xpForLevel = (level) => 50 * level * (level + 1);

export const levelForXp = (xp) => {
    let level = Math.max(0, Math.floor((Math.sqrt(1 + (4 * Math.max(0, xp)) / 50) - 1) / 2));
    while (xpForLevel(level + 1) <= xp) level += 1; // guard against float rounding
    while (level > 0 && xpForLevel(level) > xp) level -= 1;
    return level;
};

/** { level, into, needed, percent } — XP into the current level and needed for the next. */
export const progress = (xp) => {
    const level = levelForXp(xp);
    const start = xpForLevel(level);
    const needed = xpForLevel(level + 1) - start;
    const into = xp - start;
    return { level, into, needed, percent: Math.floor((into / needed) * 100) };
};

const TITLES = [
    [0, '🌱 Newcomer'],
    [3, '💬 Regular'],
    [6, '🔥 Active'],
    [10, '⚔️ Veteran'],
    [15, '💠 Elite'],
    [20, '👑 Master'],
    [30, '🌟 Legend'],
    [50, '🌀 Mythic']
];

export const titleFor = (level) => TITLES.filter(([min]) => level >= min).at(-1)[1];

/** Text progress bar: ▰▰▰▱▱▱▱▱▱▱ */
export const bar = (percent, width = 10) => {
    const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
};

const DAY = 86_400_000;

export const CLAIMS = Object.freeze({
    daily: { coins: 100, xp: 50, every: DAY },
    weekly: { coins: 500, xp: 250, every: 7 * DAY },
    monthly: { coins: 2000, xp: 1000, every: 30 * DAY }
});

/** XP for one chat message (random 5–15) and the minimum gap between rewarded messages. */
export const MESSAGE_XP = Object.freeze({ min: 5, max: 15, cooldownMs: 60_000 });
export const rollMessageXp = (random = Math.random) => MESSAGE_XP.min + Math.floor(random() * (MESSAGE_XP.max - MESSAGE_XP.min + 1));
