import { isMainOwner, isOwner } from '../owners/ownerStore.js';
import { findParticipant, getGroup, isParticipantAdmin } from '../groups/groupCache.js';

/**
 * Permission system.
 *
 * A command lists the requirements it needs in `permissions`. ALL of them must pass.
 *
 *   public / user  everyone (default)
 *   owner          main owner, owners in data/owners.json, or the linked account
 *   mainOwner      the main owner only
 *   admin          group admin (owners always pass); in private chats: owners only
 *   botAdmin       the bot itself must be a group admin (e.g. kick, promote)
 *   group          only inside groups
 *   private        only in private chats
 *
 * Example: permissions: ['group', 'admin', 'botAdmin']
 */

export const LEVELS = Object.freeze(['public', 'user', 'owner', 'mainOwner', 'admin', 'botAdmin', 'group', 'private']);

const DENIED = {
    owner: 'This command is for the bot owners only.',
    mainOwner: 'This command is for the main owner only.',
    admin: 'This command is for group admins only.',
    botAdmin: 'Make the bot a group admin first.',
    group: 'This command only works in groups.',
    private: 'This command only works in private chat.'
};

/** Normalizes a command's permissions field into a list of known requirements. */
export const requirementsOf = (command) => {
    const list = Array.isArray(command.permissions) ? command.permissions : [command.permissions || 'public'];
    return list.filter((p) => p && p !== 'public' && p !== 'user');
};

/** Lazily computed facts about the sender and chat (group fetched at most once). */
export const createAccess = (sock, message) => {
    let groupPromise = null;
    const group = () => {
        if (!message.isGroup) return Promise.resolve(null);
        groupPromise ||= getGroup(sock, message.chat);
        return groupPromise;
    };
    const access = {
        isOwner: isOwner(message),
        isMainOwner: Boolean(message.fromMe) || isMainOwner(message),
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
    return access;
};

/**
 * Checks every requirement of a command.
 * @returns {Promise<{ ok: true } | { ok: false, requirement: string, reason: string }>}
 */
export const checkPermissions = async (command, message, access) => {
    for (const requirement of requirementsOf(command)) {
        let ok;
        switch (requirement) {
            case 'owner': ok = access.isOwner; break;
            case 'mainOwner': ok = access.isMainOwner; break;
            case 'group': ok = message.isGroup; break;
            case 'private': ok = !message.isGroup; break;
            case 'admin': ok = access.isOwner || (await access.isAdmin()); break;
            case 'botAdmin': ok = await access.isBotAdmin(); break;
            default: ok = false; // unknown requirement → fail closed
        }
        if (!ok) return { ok: false, requirement, reason: DENIED[requirement] || 'You are not allowed to use this command.' };
    }
    return { ok: true };
};

/** True when the command needs owner-level access (used to hide it in menus/help). */
export const isOwnerOnly = (command) => requirementsOf(command).some((p) => p === 'owner' || p === 'mainOwner');
