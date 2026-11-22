import config from '../../config/config.js';
import { invalidateGroup, getGroup } from '../../systems/groups/groupCache.js';
import { requireImageLib } from '../../systems/media/imageLib.js';
import { downloadMedia, findMedia } from '../../utils/media.js';
import { box, success } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';

/**
 * Group settings (group admins; the bot must be a group admin):
 *   .open / .close            everyone can send / only admins can send
 *   .editinfo <admins|all>    who can change the group name, picture and description
 *   .setname <text>           group name
 *   .setdesc <text>           group description (empty = remove)
 *   .setpp                    group picture (send or reply to an image)
 *   .link / .revoke           invite link / reset the invite link
 *   .requests [approve|reject] [all|n]   pending join requests
 */

const P = config.bot.prefix;

const groupCommand = (def) => ({
    category: 'group',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin', 'botAdmin'],
    ...def
});

const whatsapp = (action) => (error) => {
    throw new UserError(`WhatsApp refused to ${action}: ${error?.message || 'unknown error'}`);
};

const setting = (name, aliases, value, description, done) =>
    groupCommand({
        name,
        aliases,
        description,
        async execute(sock, message) {
            await sock.groupSettingUpdate(message.chat, value).catch(whatsapp('change the setting'));
            invalidateGroup(message.chat);
            await message.reply(success('GROUP', [done]));
        }
    });

export const open = setting('open', ['unlockchat', 'opengroup'], 'not_announcement', 'Let every member send messages.', '🔓 Everyone can send messages.');
export const close = setting('close', ['lockchat', 'closegroup'], 'announcement', 'Only admins can send messages.', '🔒 Only admins can send messages.');

export const editinfo = groupCommand({
    name: 'editinfo',
    aliases: ['lockinfo'],
    description: 'Choose who can edit the group name, picture and description.',
    usage: '<admins|all>',
    minArgs: 1,
    async execute(sock, message, [who]) {
        const choice = String(who).toLowerCase();
        const value = { admins: 'locked', admin: 'locked', all: 'unlocked', everyone: 'unlocked' }[choice];
        if (!value) throw new UsageError();
        await sock.groupSettingUpdate(message.chat, value).catch(whatsapp('change the setting'));
        invalidateGroup(message.chat);
        await message.reply(success('GROUP', [value === 'locked' ? 'Only admins can edit the group info.' : 'Every member can edit the group info.']));
    }
});

export const setname = groupCommand({
    name: 'setname',
    aliases: ['gname', 'setsubject'],
    description: 'Change the group name.',
    usage: '<new name>',
    minArgs: 1,
    async execute(sock, message, args, ctx) {
        const name = (ctx.argsText || args.join(' ')).trim();
        if (name.length > 100) throw new UserError('Group names are at most 100 characters.');
        await sock.groupUpdateSubject(message.chat, name).catch(whatsapp('rename the group'));
        invalidateGroup(message.chat);
        await message.reply(success('GROUP', [`Name: ${name}`]));
    }
});

export const setdesc = groupCommand({
    name: 'setdesc',
    aliases: ['gdesc', 'setdescription'],
    description: 'Change the group description (no text removes it).',
    usage: '[new description]',
    async execute(sock, message, args, ctx) {
        const text = [ctx.argsText, ctx.body].filter(Boolean).join('\n').trim() || message.quoted?.text || '';
        if (text.length > 2048) throw new UserError('Descriptions are at most 2048 characters.');
        await sock.groupUpdateDescription(message.chat, text || undefined).catch(whatsapp('change the description'));
        invalidateGroup(message.chat);
        await message.reply(success('GROUP', [text ? 'Description updated.' : 'Description removed.']));
    }
});

export const setpp = groupCommand({
    name: 'setpp',
    aliases: ['gpp', 'setgrouppic'],
    description: 'Change the group picture (send or reply to an image).',
    async execute(sock, message) {
        const media = findMedia(message, ['image']);
        if (!media) throw new UsageError('Send an image with the command or reply to one.');
        await requireImageLib();
        const buffer = await downloadMedia(sock, media, { maxBytes: 5 * 1024 * 1024 });
        await sock.updateProfilePicture(message.chat, buffer).catch(whatsapp('change the picture'));
        await message.reply(success('GROUP', ['Group picture updated.']));
    }
});

export const link = groupCommand({
    name: 'link',
    aliases: ['invite', 'grouplink'],
    description: 'Get the group invite link.',
    cooldown: 10,
    async execute(sock, message) {
        const code = await sock.groupInviteCode(message.chat).catch(whatsapp('share the link'));
        const meta = await getGroup(sock, message.chat);
        await message.reply(box(meta?.subject || 'GROUP LINK', [`https://chat.whatsapp.com/${code}`, '', `Reset it: ${P}revoke`]));
    }
});

export const revoke = groupCommand({
    name: 'revoke',
    aliases: ['resetlink', 'newlink'],
    description: 'Reset the invite link (the old one stops working).',
    cooldown: 10,
    async execute(sock, message) {
        const code = await sock.groupRevokeInvite(message.chat).catch(whatsapp('reset the link'));
        await message.reply(success('GROUP LINK', ['Old link disabled.', code ? `New: https://chat.whatsapp.com/${code}` : null]));
    }
});

const requestJid = (r) => r.phone_number || r.jid;

export const requests = groupCommand({
    name: 'requests',
    aliases: ['joinrequests', 'pending'],
    description: 'List pending join requests, or approve / reject them.',
    usage: '[approve|reject] [all|n]',
    examples: ['', 'approve all', 'reject 2'],
    cooldown: 5,
    async execute(sock, message, args) {
        const pending = (await sock.groupRequestParticipantsList(message.chat).catch(whatsapp('list join requests'))) || [];
        const action = String(args[0] || '').toLowerCase();
        if (!action || action === 'list') {
            const jids = pending.map(requestJid);
            return sock.sendMessage(
                message.chat,
                {
                    text: box('JOIN REQUESTS', pending.length ? [...jids.map((j, i) => `${i + 1}. @${j.split('@')[0]}`), '', `${P}requests approve all · ${P}requests reject 1`] : ['No pending requests.']),
                    mentions: jids
                },
                { quoted: message.raw }
            );
        }
        if (!['approve', 'reject'].includes(action)) throw new UsageError();
        if (!pending.length) return message.reply(box('JOIN REQUESTS', ['No pending requests.']));
        const which = String(args[1] || 'all').toLowerCase();
        let chosen;
        if (which === 'all') chosen = pending;
        else {
            const n = Number.parseInt(which, 10);
            if (!(n >= 1 && n <= pending.length)) throw new UsageError(`Pick a number from 1 to ${pending.length}, or "all".`);
            chosen = [pending[n - 1]];
        }
        const result = await sock.groupRequestParticipantsUpdate(message.chat, chosen.map((r) => r.jid), action).catch(whatsapp(`${action} requests`));
        invalidateGroup(message.chat);
        const ok = (result || []).filter((r) => String(r.status) === '200').length;
        await message.reply(success('JOIN REQUESTS', [`${action === 'approve' ? 'Approved' : 'Rejected'}: ${ok}/${chosen.length}`]));
    }
});

export default [open, close, editinfo, setname, setdesc, setpp, link, revoke, requests];
