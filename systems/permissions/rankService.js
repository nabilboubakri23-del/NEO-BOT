import * as owners from '../owners/ownerStore.js';
import { setBanned } from '../users/userStore.js';
import { audit, who } from './auditLog.js';
import { canSetRank, canTarget } from './rankRules.js';
import { removeStoredRank, setStoredRank } from './rankStore.js';
import { rankOfTarget } from './resolveRank.js';
import { badge, getRank, STORED_RANKS } from './ranks.js';
import { UserError } from '../../utils/errors.js';

/**
 * Changing someone's rank, with the rules checked and every change audited.
 * Each rank is written to its own single source of truth:
 *   owner → ownerStore, banned → userStore, moderator/vip/premium → rankStore, user → clears them.
 *
 * `actor` is { rank, person } where rank comes from resolveRank / ctx.access.rank
 * and person is the actor's message (for the audit log).
 */

const fail = (result) => {
    if (!result.ok) throw new UserError(result.reason);
};

/**
 * Sets `target` ({ number, lid }) to rank `next`. `durationMs` null = permanent.
 * @returns {{ before: object, after: string, expiresAt: number|null }}
 */
export const changeRank = async (actor, target, next, { durationMs = null, reason = '' } = {}) => {
    const wanted = getRank(next);
    if (!wanted) throw new UserError(`Unknown rank "${next}".`);
    const before = rankOfTarget(target);
    fail(canSetRank(actor.rank, before, wanted.name));
    if (durationMs && !STORED_RANKS.includes(wanted.name)) throw new UserError(`${badge(wanted.name)} cannot be temporary.`);

    // Leave the previous source of truth first.
    if (before.name === 'owner' && wanted.name !== 'owner') await owners.removeAdmin(target.number || target.lid).catch(() => target.lid && owners.removeAdmin(target.lid));
    if (before.name === 'banned' && wanted.name !== 'banned') setBanned(target, false);

    let expiresAt = null;
    if (wanted.name === 'owner') {
        removeStoredRank(target);
        if (before.name !== 'owner') await owners.addAdmin(target);
    } else if (wanted.name === 'banned') {
        setBanned(target, true, reason);
    } else if (wanted.name === 'user') {
        removeStoredRank(target);
    } else {
        expiresAt = setStoredRank(target, wanted.name, { grantedBy: who(actor.person), durationMs, reason }).expiresAt;
    }

    audit({ action: wanted.name === 'user' ? 'rank:revoke' : 'rank:set', actor: actor.person, target, detail: `${before.name} → ${wanted.name}${durationMs ? ` (until ${new Date(expiresAt).toISOString()})` : ''}${reason ? ` · ${reason}` : ''}` });
    return { before, after: wanted.name, expiresAt };
};

/** Ban keeps any granted rank underneath; unban brings it back. */
export const banUser = (actor, target, reason = '') => {
    const before = rankOfTarget(target);
    fail(canTarget(actor.rank, before));
    const user = setBanned(target, true, reason);
    audit({ action: 'ban', actor: actor.person, target, detail: reason });
    return user;
};

export const unbanUser = (actor, target) => {
    const user = setBanned(target, false);
    audit({ action: 'unban', actor: actor.person, target });
    return user;
};
