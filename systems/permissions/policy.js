import { getChatSetting, getSetting } from '../settings/settingsStore.js';
import { isBanned } from '../users/userStore.js';

/**
 * Who the bot answers at all, before any command permission is checked.
 * Owners always pass. Order: banned → bot mode → chat switched off.
 *
 * @returns {{ ok: true } | { ok: false, reason: string, silent: boolean }}
 */
export const checkPolicy = (message, access, command = null) => {
    if (access.isOwner) return { ok: true };
    if (isBanned(message)) return { ok: false, reason: 'banned', silent: true };

    const mode = getSetting('mode');
    if (mode === 'private') return { ok: false, reason: 'mode:private', silent: true };
    if (mode === 'groups' && !message.isGroup) return { ok: false, reason: 'mode:groups', silent: true };
    if (mode === 'inbox' && message.isGroup) return { ok: false, reason: 'mode:inbox', silent: true };

    // A switched-off chat still accepts commands marked `allowWhenOff` (e.g. ".bot on").
    if (!getChatSetting(message.chat, 'enabled') && !command?.allowWhenOff) {
        return { ok: false, reason: 'chat:off', silent: true };
    }
    return { ok: true };
};
