import config from '../../config/config.js';
import events from '../../core/events.js';
import { createAccess } from '../permissions/permissions.js';
import { mentionOf } from '../../utils/mentions.js';
import { box } from '../../utils/formatter.js';
import { senderOf, personKey } from '../../utils/targets.js';
import { hasLink, hasVCard } from './detectors.js';
import { getGroupConfig, getGroupOption, hasActiveGuards } from './groupConfig.js';
import { activeMute, hasMutes, muteMember } from './mutes.js';
import { NoticeLimiter } from '../security/noticeLimiter.js';
import { applyWarning, deleteMessage, removeMember } from './actions.js';
import { checkText } from './profanity/matcher.js';
import { getCustomWords } from './profanity/customWords.js';
import { FloodDetector } from './spam/floodDetector.js';
import { CommandTracker, scoreMessage } from './botDetector.js';
import { flagBot, isAllowedBot, isKnownBot } from './knownBots.js';

/**
 * Message guard: enforces mutes, anti-link, anti-vCard, anti-profanity and anti-spam
 * in groups, and the "adminonly" option for commands. Registered once on the core event bus.
 *
 * Hard to get around:
 *  - every text a member can send is scanned (captions, polls, edits, view-once, documents)
 *  - profanity is matched after normalization (tashkeel, tatweel, spacing, leetspeak, look-alikes)
 *  - flood counts every message type and repeats are compared after normalization
 *  - edited messages are re-checked, so "send clean, then edit" does not work
 *  - options can only be changed by group admins; staff and admins are exempt, nobody else
 *
 * Nothing is enforced while the bot is not a group admin (WhatsApp would refuse).
 */

const TAG = 'core:moderation';
const notices = new NoticeLimiter();
export const floodDetector = new FloodDetector();
export const commandTracker = new CommandTracker();

/** Every piece of text a message carries (body, caption, poll, document name...). */
export const scanText = (message) => [message.text, message.extraText].filter(Boolean).join('\n');

/** What a message breaks by content alone, or null. Pure: config + content only. */
export const findViolation = (message, config, muted, custom = { block: [], allow: [] }) => {
    if (muted) return { kind: 'mute', action: 'delete' };
    const text = scanText(message);
    if (config.antilink !== 'off' && hasLink(text, config.linkscope)) return { kind: 'link', action: config.antilink };
    if (config.antivcard !== 'off' && hasVCard(message)) return { kind: 'vcard', action: config.antivcard };
    if (config.antibad !== 'off' && checkText(text, { level: config.badlevel, custom: custom.block, allow: custom.allow }).hit) {
        return { kind: 'badword', action: config.antibad };
    }
    return null;
};

const REASON = {
    link: 'Links are not allowed here',
    vcard: 'Contact cards are not allowed here',
    badword: 'Offensive language is not allowed here',
    flood: 'Flooding the chat',
    repeat: 'Repeating the same message',
    mentions: 'Mass tagging members',
    bomb: 'Oversized or crash text',
    bot: 'Bots are not allowed here'
};

const isExempt = async (access) => access.atLeast('moderator') || (await access.isAdmin());
/** Protection skips admins and staff unless the group turned "exemptadmins" off. */
const skipsGuard = async (access, group) => getGroupOption(group, 'exemptadmins') && (await isExempt(access));
const botAdminNotices = new NoticeLimiter(30 * 60_000);

/**
 * Anti-bot verdict, or null. Bots are judged even when they are group admins
 * (bot farms often promote each other); bot staff and allow-listed bots are skipped.
 */
const findBot = async (sock, message, who, access) => {
    const group = message.chat;
    if (isAllowedBot(group, who)) return null;
    if (isKnownBot(group, who)) return { kind: 'bot', action: getGroupOption(group, 'antibot'), known: true };
    const verdict = scoreMessage(message, commandTracker);
    if (!verdict.bot) return null;
    if (access.atLeast('moderator')) return null;
    flagBot(group, who, { jid: message.raw.key.participant || message.sender, reason: verdict.reasons.join(', ') });
    return { kind: 'bot', action: getGroupOption(group, 'antibot'), reasons: verdict.reasons };
};

const SPAM_MUTES = [0, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]; // by strike number (1st = delete only)

/** Applies an anti-spam verdict with escalation. Returns the notice lines. */
const punishSpam = async (sock, message, kind, action, who, jid, tag, personId) => {
    const strikes = floodDetector.strike(personId);
    // Remove the whole burst, not just the last message.
    const burst = kind === 'flood' || kind === 'repeat' ? floodDetector.takeRecentKeys(personId) : [];
    for (const key of burst) if (key.id !== message.raw.key.id) await deleteMessage(sock, key);
    const reason = REASON[kind];
    const group = message.chat;

    if (action === 'warn') {
        const result = await applyWarning(sock, group, who, jid, { by: 'auto', reason });
        return [`⚠️ ${tag.text} — ${reason}.`, `Warning ${result.count}/${result.limit}.`, result.kicked ? 'Limit reached: removed from the group.' : null];
    }
    if (action === 'kick' && (strikes >= 2 || kind === 'bomb')) {
        const kicked = await removeMember(sock, group, jid);
        return [`🚫 ${tag.text} — ${reason}.`, kicked ? 'Removed from the group.' : 'Could not remove them.'];
    }
    if (action === 'mute' || action === 'kick') {
        const ms = SPAM_MUTES[Math.min(strikes, SPAM_MUTES.length) - 1] || (kind === 'bomb' ? SPAM_MUTES[2] : 0);
        if (ms) {
            muteMember(group, who, { ms, by: 'auto' });
            return [`🔇 ${tag.text} — ${reason}.`, `Muted for ${Math.round(ms / 60000)} min (strike ${strikes}).`];
        }
        return [`🛑 ${tag.text} — ${reason}.`, 'Next time: mute.'];
    }
    return [`🗑️ ${tag.text} — ${reason}.`];
};

/** Content verdict (link, vCard, profanity) → lines of the notice. */
const punishContent = async (sock, message, violation, who, jid, tag) => {
    const reason = REASON[violation.kind];
    const group = message.chat;
    if (violation.action === 'kick') {
        const kicked = await removeMember(sock, group, jid);
        return [`🚫 ${tag.text} — ${reason}.`, kicked ? 'Removed from the group.' : 'Could not remove them.'];
    }
    if (violation.action === 'warn') {
        const result = await applyWarning(sock, group, who, jid, { by: 'auto', reason });
        return [`⚠️ ${tag.text} — ${reason}.`, `Warning ${result.count}/${result.limit}.`, result.kicked ? 'Limit reached: removed from the group.' : null];
    }
    return [`🗑️ ${tag.text} — ${reason}.`];
};

const botNotices = new NoticeLimiter(30 * 60_000);

/**
 * Removes a bot's message. The first catch of a bot is announced (once per bot per 30 min);
 * later messages of a known bot are removed silently, so the guard never adds noise.
 */
const punishBot = async (sock, message, bot, who, access) => {
    const group = message.chat;
    if (!(await access.isBotAdmin())) {
        if (botAdminNotices.allow(group)) await sock.sendMessage(group, { text: box('ANTI-BOT', ['A bot was detected here.', 'I cannot delete it: make the bot a group admin.']) }).catch(() => {});
        return true;
    }
    await deleteMessage(sock, message.raw.key);
    const jid = message.raw.key.participant || message.sender;
    const tag = mentionOf(message);
    const lines = [`🤖 ${tag.text} — ${REASON.bot}.`];
    if (bot.reasons) lines.push(`Detected: ${bot.reasons.join(', ')}.`);
    if (bot.action === 'kick') {
        const kicked = await removeMember(sock, group, jid);
        lines.push(kicked ? 'Removed from the group.' : 'Could not remove it (maybe a group admin). Its messages will keep being deleted.');
    } else if (bot.action === 'warn' && !bot.known) {
        const result = await applyWarning(sock, group, who, jid, { by: 'auto', reason: REASON.bot });
        lines.push(`Warning ${result.count}/${result.limit}.`);
        if (result.kicked) lines.push('Limit reached: removed from the group.');
    }
    if (!bot.known && getGroupOption(group, 'botnotice') && botNotices.allow(`${group}|${tag.jid}`)) {
        lines.push(`Not a bot? An admin can send ${config.bot.prefix}antibot allow @user`);
        await sock.sendMessage(group, { text: box('ANTI-BOT', lines), mentions: [tag.jid] }).catch(() => {});
    }
    return false;
};

/** 'message' / 'message:edit' listener. Returns false when the message was removed (stops routing). */
export const guardMessage = async ({ sock, message }) => {
    if (!message.isGroup || message.fromMe) return true;
    const group = message.chat;
    if (!hasActiveGuards(group) && !hasMutes(group)) return true;
    const who = senderOf(message);
    const config = getGroupConfig(group);
    const personId = `${group}|${personKey(who)}`;

    const antibot = config.antibot !== 'off';
    if (antibot) {
        const access = createAccess(sock, message);
        const bot = await findBot(sock, message, who, access);
        commandTracker.record(message);
        if (bot) return punishBot(sock, message, bot, who, access);
    }

    let violation = findViolation(message, config, activeMute(group, who), getCustomWords(group));
    let spamKind = null;
    // Edits are not new messages: they never count toward flood.
    if (!violation && config.antispam !== 'off' && !message.isEdit) {
        spamKind = floodDetector.record(personId, message, { limit: config.spamlimit });
        if (spamKind) violation = { kind: spamKind, action: config.antispam, spam: true };
    }
    if (!violation) return true;

    const access = createAccess(sock, message);
    if (await skipsGuard(access, group)) return true;
    if (!(await access.isBotAdmin())) {
        // Say why nothing happened, at most once per group per 30 min.
        if (violation.kind !== 'mute' && botAdminNotices.allow(group)) {
            await sock.sendMessage(group, { text: box('MODERATION', [`Protection caught: ${REASON[violation.kind] || violation.kind}.`, 'I cannot delete it: make the bot a group admin.']) }).catch(() => {});
        }
        return true;
    }

    await deleteMessage(sock, message.raw.key);
    if (violation.kind === 'mute') return false;

    const jid = message.raw.key.participant || message.sender;
    const tag = mentionOf(message);
    const lines = violation.spam
        ? await punishSpam(sock, message, violation.kind, violation.action, who, jid, tag, personId)
        : await punishContent(sock, message, violation, who, jid, tag);

    // Plain deletions are announced at most once per member per 30 s, so a raid cannot make the bot spam back.
    if (violation.action !== 'delete' || notices.allow(`${group}|${tag.jid}`)) {
        await sock.sendMessage(group, { text: box('MODERATION', lines.filter(Boolean)), mentions: [tag.jid] }).catch(() => {});
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
    bus.on('message:edit', guardMessage, { tag: TAG });
    bus.on('command:before', guardCommand, { tag: TAG });
    if (bus === events) installed = true;
};
