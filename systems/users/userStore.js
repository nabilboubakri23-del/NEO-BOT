import docStore from '../database/docStore.js';

/**
 * Users the bot has seen: identity, activity counters and ban state.
 * Keyed by phone number when known, otherwise by LID.
 * Counters change in memory and are saved with the database debounce.
 */

const NAME = 'users';
let doc = null;

export const loadUsers = async () => {
    doc = await docStore.open(NAME, () => ({}));
    return doc;
};

const keyOf = ({ number, lid }) => String(number || lid || '').replace(/\D/g, '');

const find = (who) => {
    if (!doc) return null;
    const number = String(who.number || '').replace(/\D/g, '');
    const lid = String(who.lid || '').replace(/\D/g, '');
    if (number && doc[number]) return doc[number];
    if (lid && doc[lid]) return doc[lid];
    if (lid) return Object.values(doc).find((u) => u.lid === lid) || null;
    return null;
};

/** Updates (or creates) the sender's record for an incoming message. */
export const trackMessage = (message, { command = null } = {}) => {
    if (!doc) return null;
    const who = { number: message.senderNumber, lid: message.senderLid };
    const key = keyOf(who);
    if (!key) return null;
    let user = find(who);
    const now = Date.now();
    if (!user) {
        user = { number: who.number || '', lid: who.lid || '', name: '', firstSeen: now, lastSeen: now, messages: 0, commands: 0, banned: false };
        doc[key] = user;
    }
    if (who.number && !user.number) user.number = who.number;
    if (who.lid && !user.lid) user.lid = who.lid;
    if (message.pushName) user.name = message.pushName;
    user.lastSeen = now;
    user.messages += 1;
    if (command) {
        user.commands += 1;
        user.lastCommand = command;
    }
    docStore.touch(NAME);
    return user;
};

export const getUser = (who) => find(who);

export const isBanned = (message) => Boolean(find({ number: message.senderNumber, lid: message.senderLid })?.banned);

export const setBanned = (who, banned, reason = '') => {
    const key = keyOf(who);
    if (!key) throw new Error('No user given.');
    let user = find(who);
    if (!user) {
        const now = Date.now();
        user = { number: who.number || '', lid: who.lid || '', name: '', firstSeen: now, lastSeen: 0, messages: 0, commands: 0, banned: false };
        doc[key] = user;
    }
    user.banned = banned;
    user.banReason = banned ? reason : '';
    user.bannedAt = banned ? Date.now() : undefined;
    docStore.touch(NAME);
    return user;
};

export const listBanned = () => Object.values(doc || {}).filter((u) => u.banned);

export const userCount = () => Object.keys(doc || {}).length;

/** Most active users by commands run. */
export const topUsers = (limit = 5) =>
    Object.values(doc || {})
        .sort((a, b) => b.commands - a.commands)
        .slice(0, limit);
