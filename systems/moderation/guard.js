import events from '../../core/events.js';
import { createAccess } from '../permissions/permissions.js';
import { mentionOf } from '../../utils/mentions.js';
import { box } from '../../utils/formatter.js';
import { senderOf } from '../../utils/targets.js';
import { hasLink, hasVCard } from './detectors.js';
import { getGroupConfig, getGroupOption, hasActiveGuards } from './groupConfig.js';
import { activeMute, hasMutes } from './mutes.js';
import { NoticeLimiter } from '../security/noticeLimiter.js';
import { applyWarning, deleteMessage, removeMember } from './actions.js';

/**
 * Message guard: enforces mutes, anti-link and anti-vCard in groups, and the
 * "adminonly" option for commands. Registered once on the core event bus.
 *
 * Exempt: the bot itself, bot staff (🛡️ Moderator and above) and group admins.
 * Nothing is enforced while the bot is not a group admin (WhatsApp would refuse).
 */

const TAG = 'core:moderation';
const notices = new NoticeLimiter();

/** What a message breaks, or null. Pure: config + content only. */
export const findViolation = (message, config, muted) => {
    if (muted) return { kind: 'mute', action: 'delete' };
    if (config.antilink !== 'off' && hasLink(message.text, config.linkscope)) return { kind: 'link', action: config.antilink };
    if (config.antivcard !== 'off' && hasVCard(message)) return { kind: 'vcard', action: config.antivcard };
    return null;
};

const REASON = { link: 'Links are not allowed here', vcard: 'Contact cards are not allowed here' };

const isExempt = async (access) => access.atLeast('moderator') || (await access.isAdmin());

/** 'message' listener. Returns false when the message was removed (stops routing). */
export const guardMessage = async ({ sock, message }) => {
    if (!message.isGroup || message.fromMe) return true;
    const group = message.chat;
    const who = senderOf(message);
    if (!hasActiveGuards(group) && !hasMutes(group)) return true;

    const violation = findViolation(message, getGroupConfig(group), activeMute(group, who));
    if (!violation) return true;

    const access = createAccess(sock, message);
    if (await isExempt(access)) return true;
    if (!(await access.isBotAdmin())) return true;

    await deleteMessage(sock, message.raw.key);
    if (violation.kind === 'mute') return false;

    const jid = message.raw.key.participant || message.sender;
    const tag = mentionOf(message);
    const reason = REASON[violation.kind];
    let lines;
    if (violation.action === 'kick') {
        const kicked = await removeMember(sock, group, jid);
        lines = [`🚫 ${tag.text} — ${reason}.`, kicked ? 'Removed from the group.' : 'Could not remove them.'];
    } else if (violation.action === 'warn') {
        const result = await applyWarning(sock, group, who, jid, { by: 'auto', reason });
        lines = [`⚠️ ${tag.text} — ${reason}.`, `Warning ${result.count}/${result.limit}.`, result.kicked ? 'Limit reached: removed from the group.' : null];
    } else {
        lines = [`🗑️ ${tag.text} — ${reason}.`];
    }
    if (violation.action !== 'delete' || notices.allow(`${group}|${tag.jid}`)) {
        await sock.sendMessage(group, { text: box('MODERATION', lines), mentions: [tag.jid] }).catch(() => {});
    }
    return false;
};

/** 'command:before' listener: "adminonly" groups ignore commands from regular members. */
export const guardCommand = async ({ sock, message }) => {
    if (!message.isGroup || !getGroupOption(message.chat, 'adminonly')) return true;
    const access = createAccess(sock, message);
    return isExempt(access);
};

let installed = false;

/** Registers the guard on the event bus (idempotent). */
export const installModerationGuard = (bus = events) => {
    if (installed && bus === events) return;
    bus.on('message', guardMessage, { tag: TAG });
    bus.on('command:before', guardCommand, { tag: TAG });
    if (bus === events) installed = true;
};
