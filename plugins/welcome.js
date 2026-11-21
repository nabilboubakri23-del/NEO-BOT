import { box } from '../utils/formatter.js';

/**
 * Example plugin: greets members who join a group and says goodbye when
 * someone leaves. Shows the whole plugin surface — a command, a hook and
 * per-plugin storage — without touching any core file.
 *
 * Toggle greetings per group:  .welcome on | off   (group admins, owners)
 * Disable the whole plugin:    .plugins disable welcome
 */

const DOC = 'groups'; // { "<groupJid>": true }  → greetings enabled here

export default {
    name: 'welcome',
    version: '1.0.0',
    author: 'NEO BOT',
    description: 'Welcome and goodbye messages for group members.',

    commands: [
        {
            name: 'welcome',
            category: 'group',
            description: 'Turn join/leave greetings on or off in this group.',
            usage: 'on | off',
            permission: 'public',
            scope: 'group',
            requires: ['groupAdmin'],
            async execute(sock, message, args, ctx) {
                const store = await ctx.api.store.open(DOC, () => ({}));
                const on = ['on', 'true', 'yes', 'enable'].includes((args[0] || '').toLowerCase());
                const off = ['off', 'false', 'no', 'disable'].includes((args[0] || '').toLowerCase());
                if (!on && !off) {
                    return message.reply(box('WELCOME', [`Greetings here: ${store[message.chat] ? 'ON' : 'OFF'}`, 'Use: .welcome on | off']));
                }
                if (on) store[message.chat] = true;
                else delete store[message.chat];
                ctx.api.store.touch(DOC);
                await message.reply(box('WELCOME', [`Greetings are now ${on ? 'ON' : 'OFF'} in this group.`]));
            }
        }
    ],

    hooks: {
        async 'group:participants'({ sock, update }, api) {
            const store = await api.store.open(DOC, () => ({}));
            if (!store[update.id]) return; // greetings off here
            const verb = update.action === 'add' ? 'joined' : update.action === 'remove' ? 'left' : null;
            if (!verb) return;
            // v7 may give participants as JIDs or as { id, phoneNumber } objects.
            const mentions = update.participants.map((p) => (typeof p === 'string' ? p : p.phoneNumber || p.id)).filter(Boolean);
            const names = mentions.map((j) => `@${j.split('@')[0]}`).join(' ');
            await sock.sendMessage(update.id, {
                text: box(verb === 'joined' ? 'WELCOME' : 'GOODBYE', [verb === 'joined' ? `Welcome ${names} 👋` : `${names} left the group.`]),
                mentions
            }).catch(() => {});
        }
    }
};
