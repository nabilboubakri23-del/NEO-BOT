import { getSetting } from '../settings/settingsStore.js';

/**
 * Rank perks turned into concrete numbers (see the perks of each rank in ranks.js).
 */

/** Commands per day for a rank: Infinity = unlimited. The "dailyLimit" setting (0 = unlimited) feeds the User rank. */
export const dailyLimitFor = (rank) => {
    const value = rank.perks.dailyLimit;
    if (value === 'setting') {
        const configured = getSetting('dailyLimit');
        return configured > 0 ? configured : Infinity;
    }
    return value;
};

/** Cooldown in seconds for a command after the rank multiplier (0 = none). */
export const cooldownFor = (command, rank) => {
    const base = command.cooldown ?? getSetting('cooldown');
    return Math.round(base * rank.perks.cooldownMultiplier * 100) / 100;
};

/** Moderators and above (multiplier 0) skip anti-spam as well. */
export const isRateExempt = (rank) => rank.perks.cooldownMultiplier === 0;
