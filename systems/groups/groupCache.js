import { child } from '../../core/logger.js';
import { describeError } from '../../utils/errors.js';

/**
 * Group metadata cache.
 * - Permission checks (group admin, bot admin) read from here instead of
 *   asking WhatsApp on every command.
 * - Also passed to the socket as `cachedGroupMetadata`, so sending to a group
 *   does not refetch its participant list each time.
 * - Entries expire after TTL and are dropped when WhatsApp reports a change.
 */

const log = child('groups');
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

const cache = new Map(); // jid → { data, at }
const pending = new Map(); // jid → Promise (one fetch at a time per group)

/** Cached metadata or undefined (never fetches). Used by the socket. */
export const peekGroup = (jid) => {
    const entry = cache.get(jid);
    if (!entry || Date.now() - entry.at > TTL_MS) return undefined;
    return entry.data;
};

/** Metadata from cache, fetched from WhatsApp when missing or stale. */
export const getGroup = async (sock, jid) => {
    const cached = peekGroup(jid);
    if (cached) return cached;
    if (pending.has(jid)) return pending.get(jid);
    const request = sock
        .groupMetadata(jid)
        .then((data) => {
            // Invalidated while fetching (admin change, join, leave): the answer may predate it.
            if (pending.get(jid) === request) {
                cache.set(jid, { data, at: Date.now() });
                if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
            }
            return data;
        })
        .catch((error) => {
            log.warn(`Group metadata unavailable: ${describeError(error)}`);
            return null;
        })
        .finally(() => {
            if (pending.get(jid) === request) pending.delete(jid);
        });
    pending.set(jid, request);
    return request;
};

export const invalidateGroup = (jid) => {
    if (!jid) return;
    cache.delete(jid);
    pending.delete(jid);
};

export const clearGroups = () => cache.clear();

/** Every id a participant can be known by (JID user part, phone number, LID). */
const participantIds = (p) =>
    [p.id, p.phoneNumber, p.lid]
        .filter(Boolean)
        .map((jid) => String(jid).split('@')[0].split(':')[0]);

/** Finds a participant by phone number or LID (digits only). */
export const findParticipant = (metadata, ...ids) => {
    const wanted = ids.filter(Boolean).map(String);
    if (!metadata?.participants || !wanted.length) return null;
    return metadata.participants.find((p) => participantIds(p).some((id) => wanted.includes(id))) || null;
};

export const isParticipantAdmin = (participant) => participant?.admin === 'admin' || participant?.admin === 'superadmin';
