import { badge, getRank, levelOf } from './ranks.js';

/**
 * Who may act on whom. Pure functions on rank objects/names, no storage.
 *
 *   - Rank management needs at least MANAGE_MIN (moderator).
 *   - You can only grant or revoke ranks strictly BELOW your own level.
 *   - You can never act on someone of equal or higher rank.
 *   - Only the creator grants or removes "owner".
 *   - Nobody can target the creator.
 */

export const MANAGE_MIN = 'moderator';

const deny = (reason) => ({ ok: false, reason });
const OK = Object.freeze({ ok: true });

/** May `actor` act on `target` at all (ban, rank change, kick through the bot)? */
export const canTarget = (actor, target) => {
    if (target.name === 'creator') return deny('The creator cannot be targeted.');
    if (actor.name === 'creator') return OK;
    if (target.level >= actor.level) return deny(`${badge(target.name)} is not below your rank (${badge(actor.name)}).`);
    return OK;
};

/** May `actor` change `target` from its current rank to `next` (a rank name)? */
export const canSetRank = (actor, target, next) => {
    const wanted = getRank(next);
    if (!wanted) return deny(`Unknown rank "${next}".`);
    if (wanted.name === 'creator') return deny('There is only one creator. Use .owner claim on first setup.');
    if (actor.level < levelOf(MANAGE_MIN)) return deny(`Managing ranks requires ${badge(MANAGE_MIN)}.`);
    const reach = canTarget(actor, target);
    if (!reach.ok) return reach;
    if (wanted.name === 'owner' && actor.name !== 'creator') return deny(`Only the creator can grant ${badge('owner')}.`);
    if (target.name === 'owner' && actor.name !== 'creator') return deny(`Only the creator can remove ${badge('owner')}.`);
    if (actor.name !== 'creator' && wanted.level >= actor.level) return deny(`You can only grant ranks below ${badge(actor.name)}.`);
    return OK;
};

/**
 * Kick / promote / demote through the bot: ranked members (above user) are
 * protected from anyone not above them. Plain members follow WhatsApp's own admin rules.
 */
export const canModerateMember = (actor, target) => {
    if (target.name === 'creator') return deny('The creator cannot be targeted.');
    if (target.level <= levelOf('user')) return OK;
    return canTarget(actor, target);
};
