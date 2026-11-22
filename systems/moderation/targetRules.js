import { canModerateMember } from '../permissions/rankRules.js';
import { rankOfTarget } from '../permissions/resolveRank.js';
import { UserError } from '../../utils/errors.js';
import { isSelf, targetJid } from '../../utils/targets.js';

/**
 * Shared checks before a member-level moderation action (warn, mute):
 * never the bot itself, and ranked members are protected from lower ranks.
 * Throws a UserError with the reason when the action is not allowed.
 */
export const assertCanModerate = (sock, actorRank, target) => {
    if (isSelf(sock, targetJid(target)) || (target.lid && isSelf(sock, `${target.lid}@lid`))) throw new UserError('That is me. 🙂');
    const allowed = canModerateMember(actorRank, rankOfTarget(target));
    if (!allowed.ok) throw new UserError(allowed.reason);
};
