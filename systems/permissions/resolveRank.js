import { isAdmin as isCoOwner, isMainOwner } from '../owners/ownerStore.js';
import { isBanned } from '../users/userStore.js';
import { getStoredRank } from './rankStore.js';
import { DEFAULT_RANK, getRank } from './ranks.js';

/**
 * Works out the rank of a person from the one place each rank lives:
 *
 *   creator    linked account (fromMe) or the main owner   → ownerStore
 *   owner      co-owners ("admins" in data/owners.json)     → ownerStore
 *   banned     banned flag on the user record               → userStore
 *   moderator / vip / premium (maybe temporary)             → rankStore
 *   user       everyone else
 *
 * `person` is a message or { senderNumber, senderLid, fromMe }.
 * Returns { name, level, emoji, label, perks, source, expiresAt }.
 */
export const resolveRank = (person) => {
    const make = (name, source, extra = {}) => ({ ...getRank(name), source, expiresAt: null, ...extra });
    if (person.fromMe || isMainOwner(person)) return make('creator', 'owners');
    if (isCoOwner(person)) return make('owner', 'owners');
    if (isBanned(person)) return make('banned', 'users');
    const stored = getStoredRank({ number: person.senderNumber, lid: person.senderLid });
    if (stored) return make(stored.rank, 'ranks', { expiresAt: stored.expiresAt, grantedBy: stored.grantedBy, reason: stored.reason });
    return make(DEFAULT_RANK, 'default');
};

/** Rank of a target given as { number, lid } (e.g. from utils/targets.js). */
export const rankOfTarget = (target) => resolveRank({ senderNumber: target.number || '', senderLid: target.lid || '', fromMe: false });
