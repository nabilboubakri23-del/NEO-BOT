import { findParticipant, getGroup, isParticipantAdmin } from '../groups/groupCache.js';
import { getOverride, isAllowed, isDenied, isLocked } from './commandOverrides.js';
import { resolveRank } from './resolveRank.js';
import { atLeast, badge, DEFAULT_RANK, getRank, isRankName, levelOf, rankName } from './ranks.js';

/**
 * Permission System V2.
 *
 * A command declares who may use it with ONE field — the minimum rank:
 *
 *   permission: 'premium'          // creator | owner | moderator | vip | premium | user | public
 *
 * Optional context conditions, kept separate from the rank:
 *
 *   scope: 'group' | 'private'      where it works
 *   requires: ['groupAdmin', 'botAdmin']
 *        groupAdmin  the sender is a group admin (owners and the creator always pass)
 *        botAdmin    the bot itself is a group admin (WhatsApp enforces this, nobody bypasses it)
 *
 * The old `permissions: [...]` array still works and is mapped:
 *   owner → owner, mainOwner → creator, user/public → user,
 *   admin → requires groupAdmin, botAdmin → requires botAdmin, group/private → scope.
 *
 * At runtime the creator may override a command's rank, lock it (creator only),
 * or allow / deny single users (".perm"). Deny always wins; the creator is immune.
 */

export const SCOPES = Object.freeze(['group', 'private']);
export const REQUIREMENTS = Object.freeze(['groupAdmin', 'botAdmin']);
const LEGACY = Object.freeze({
    public: { rank: 'user' },
    user: { rank: 'user' },
    owner: { rank: 'owner' },
    mainOwner: { rank: 'creator' },
    admin: { requires: 'groupAdmin' },
    botAdmin: { requires: 'botAdmin' },
    group: { scope: 'group' },
    private: { scope: 'private' }
});

const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Problems with a command's access fields (empty = valid). Unknown values fail closed. */
export const validateAccessFields = (mod) => {
    const problems = [];
    if (mod.permission !== undefined && !isRankName(mod.permission)) problems.push(`Unknown permission rank "${mod.permission}".`);
    if (mod.permission !== undefined && rankName(mod.permission) === 'banned') problems.push('permission cannot be "banned".');
    if (mod.permission !== undefined && mod.permissions !== undefined) problems.push('Use either "permission" or the old "permissions", not both.');
    const unknown = asList(mod.permissions).filter((p) => !LEGACY[p]);
    if (unknown.length) problems.push(`Unknown permissions: ${unknown.join(', ')}.`);
    if (mod.scope !== undefined && !SCOPES.includes(mod.scope)) problems.push(`scope must be one of: ${SCOPES.join(', ')}.`);
    const badRequires = asList(mod.requires).filter((r) => !REQUIREMENTS.includes(r));
    if (badRequires.length) problems.push(`Unknown requires: ${badRequires.join(', ')}.`);
    const scopes = new Set([mod.scope, ...asList(mod.permissions).map((p) => LEGACY[p]?.scope)].filter(Boolean));
    if (scopes.size > 1) problems.push('A command cannot be both group-only and private-only.');
    return problems;
};

const specs = new WeakMap();

/** Normalised access definition of a command: { rank, scope, requires[] } (cached). */
export const accessSpec = (command) => {
    if (specs.has(command)) return specs.get(command);
    let rank = command.permission !== undefined ? rankName(command.permission) : null;
    let scope = command.scope || null;
    const requires = new Set(asList(command.requires));
    for (const p of asList(command.permissions)) {
        const m = LEGACY[p];
        if (!m) continue;
        if (m.rank && (!rank || levelOf(m.rank) > levelOf(rank))) rank = m.rank;
        if (m.scope) scope = m.scope;
        if (m.requires) requires.add(m.requires);
    }
    const spec = Object.freeze({ rank: rank || DEFAULT_RANK, scope, requires: Object.freeze([...requires]) });
    specs.set(command, spec);
    return spec;
};

const keyOf = (command) => String(command.name).toLowerCase();

/** The minimum rank that applies now: a creator override wins over the file default; a lock means creator. */
export const effectiveRank = (command) => {
    const key = keyOf(command);
    if (isLocked(key)) return { rank: 'creator', locked: true, overridden: true };
    const override = getOverride(key);
    return { rank: override || accessSpec(command).rank, locked: false, overridden: Boolean(override) };
};

/** Lazily computed facts about the sender and chat (group metadata fetched at most once). */
export const createAccess = (sock, message) => {
    let groupPromise = null;
    const group = () => {
        if (!message.isGroup) return Promise.resolve(null);
        groupPromise ||= getGroup(sock, message.chat);
        return groupPromise;
    };
    const rank = resolveRank(message);
    return {
        subject: { senderNumber: message.senderNumber || '', senderLid: message.senderLid || '' },
        rank,
        level: rank.level,
        isCreator: rank.name === 'creator',
        isMainOwner: rank.name === 'creator', // kept for older code
        isOwner: rank.level >= levelOf('owner'),
        atLeast: (name) => atLeast(rank.name, name),
        group,
        async isAdmin() {
            if (!message.isGroup) return false;
            return isParticipantAdmin(findParticipant(await group(), message.senderNumber, message.senderLid));
        },
        async isBotAdmin() {
            if (!message.isGroup) return false;
            const me = sock.user || {};
            const ids = [me.id, me.lid].filter(Boolean).map((j) => String(j).split('@')[0].split(':')[0]);
            return isParticipantAdmin(findParticipant(await group(), ...ids));
        }
    };
};

const SCOPE_TEXT = { group: 'This command only works in groups.', private: 'This command only works in private chat.' };
const REQUIRE_TEXT = { groupAdmin: 'This command is for group admins only.', botAdmin: 'Make the bot a group admin first.' };

/**
 * Full permission check: deny → lock → rank (override / allow) → scope → requires.
 * @returns {Promise<{ ok: true } | { ok: false, requirement: string, reason: string, silent: boolean, needed?: string }>}
 */
export const checkPermissions = async (command, message, access) => {
    const key = keyOf(command);
    const spec = accessSpec(command);
    const creator = access.isCreator;

    if (!creator) {
        if (isDenied(key, message)) return { ok: false, requirement: 'denied', reason: 'You are blocked from using this command.', silent: Boolean(command.hidden) };
        const { rank, locked } = effectiveRank(command);
        if (locked) return { ok: false, requirement: 'locked', reason: '🔒 This command is locked by the creator.', silent: !access.isOwner };
        if (access.level < levelOf(rank) && !isAllowed(key, message)) {
            return { ok: false, requirement: 'rank', needed: rank, reason: `Requires ${badge(rank)}. Your rank: ${badge(access.rank.name)}.`, silent: Boolean(command.hidden) };
        }
    }

    if (spec.scope === 'group' && !message.isGroup) return { ok: false, requirement: 'group', reason: SCOPE_TEXT.group, silent: false };
    if (spec.scope === 'private' && message.isGroup) return { ok: false, requirement: 'private', reason: SCOPE_TEXT.private, silent: false };

    for (const requirement of spec.requires) {
        let ok;
        if (requirement === 'groupAdmin') ok = access.isOwner || (await access.isAdmin());
        else if (requirement === 'botAdmin') ok = await access.isBotAdmin();
        else ok = false; // unknown requirement → fail closed
        if (!ok) return { ok: false, requirement, reason: REQUIRE_TEXT[requirement] || 'You are not allowed to use this command.', silent: false };
    }
    return { ok: true };
};

/** May the sender see this command in .help / .menu? (rank, lock and deny only; context is not checked). */
export const canSee = (command, access) => {
    if (command.hidden) return false;
    if (access.isCreator) return true;
    const key = keyOf(command);
    if (isDenied(key, access.subject)) return false;
    const { rank, locked } = effectiveRank(command);
    if (locked) return false;
    return access.level >= levelOf(rank) || isAllowed(key, access.subject);
};

/** "💎 Premium" for commands above the default rank, '' otherwise. */
export const rankBadge = (command) => {
    const { rank, locked } = effectiveRank(command);
    if (locked) return '🔒';
    return levelOf(rank) > levelOf(DEFAULT_RANK) ? getRank(rank).emoji : '';
};

/** Human description of every access condition of a command, for .help <cmd>. */
export const describeAccess = (command) => {
    const spec = accessSpec(command);
    const { rank, locked, overridden } = effectiveRank(command);
    return {
        permission: locked ? `🔒 Locked (${badge('creator')} only)` : `${badge(rank)}${overridden ? ' (changed by the creator)' : ''}`,
        scope: spec.scope === 'group' ? 'Groups only' : spec.scope === 'private' ? 'Private chat only' : null,
        requires: spec.requires.map((r) => (r === 'groupAdmin' ? 'Group admin' : 'Bot must be group admin'))
    };
};
