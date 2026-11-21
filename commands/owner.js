import config from '../config/config.js';
import { child } from '../core/logger.js';
import * as owners from '../systems/owners/ownerStore.js';
import { audit } from '../systems/permissions/auditLog.js';
import { box } from '../utils/formatter.js';
import { resolveUserTarget } from '../utils/targets.js';

/**
 * .owner — manage the 🔱 Creator (main owner) and the 👑 Owners (co-owners).
 * The list lives in data/owners.json (see systems/owners/ownerStore.js).
 * Anyone may run it (permission 'public') because "claim" must work before an owner
 * exists; every other action checks the sender's rank itself.
 */

const log = child('owners');
const P = config.bot.prefix;
const CMD = `${P}owner`;

const panel = (title, lines) => box(title, lines);
const describe = (entry) => [entry.number && `+${entry.number}`, entry.lid && `LID ${entry.lid}`].filter(Boolean).join('  ') || 'not set';

const resolveTarget = resolveUserTarget;

const actions = {
    async list(sock, message) {
        const data = owners.getOwners();
        const lines = ['[ 🔱 CREATOR ]', describe(data.owner)];
        if (config.owner.numbers.length) lines.push(...config.owner.numbers.map((n) => `+${n}  (.env)`));
        lines.push('', `[ 👑 OWNERS ] ${data.admins.length}`);
        if (!data.admins.length) lines.push('None yet.');
        data.admins.forEach((a, i) => lines.push(`${i + 1}. ${describe(a)}${a.name ? `  ${a.name}` : ''}`));
        lines.push('', 'Owners have every permission below the creator.', `More ranks: ${P}rank list`);
        await message.reply(panel('OWNERS', lines));
    },

    async add(sock, message, [arg], ctx) {
        if (!ctx.access.isCreator) {
            return message.reply(panel('OWNERS', ['Only the 🔱 Creator can add owners.']));
        }
        const target = await resolveTarget(sock, message, arg);
        if (!target) {
            return message.reply(panel('OWNERS', [`Usage: ${CMD} add 2126XXXXXXXX`, `or ${CMD} add @mention`, `or reply to their message with ${CMD} add`]));
        }
        const entry = await owners.addAdmin(target);
        log.warn({ target: describe(entry) }, 'Owner added.');
        audit({ action: 'owner:add', actor: message, target: entry });
        await message.reply(panel('OWNER ADDED', [describe(entry), '', 'They now have full owner permissions.', `Remove: ${CMD} del ${entry.number || entry.lid}`]));
    },

    async del(sock, message, [arg], ctx) {
        if (!ctx.access.isCreator) {
            return message.reply(panel('OWNERS', ['Only the 🔱 Creator can remove owners.']));
        }
        const target = await resolveTarget(sock, message, arg);
        if (!target) return message.reply(panel('OWNERS', [`Usage: ${CMD} del 2126XXXXXXXX`, `or ${CMD} del @mention`]));
        const removed = await owners.removeAdmin(target.number || target.lid).catch(async (error) => {
            if (target.number && target.lid) return owners.removeAdmin(target.lid);
            throw error;
        });
        log.warn({ target: describe(removed) }, 'Owner removed.');
        audit({ action: 'owner:del', actor: message, target: removed });
        await message.reply(panel('OWNER REMOVED', [describe(removed), '', 'Owner permissions revoked.']));
    },

    async claim(sock, message, [code]) {
        if (owners.hasMainOwner()) return message.reply(panel('OWNERS', ['A main owner is already set.']));
        if (!owners.checkClaimCode(code)) {
            return message.reply(panel('OWNERS', ['Invalid claim code.', '', 'The code is printed in the bot terminal', 'when no main owner is set.']));
        }
        const main = await owners.setMainOwner({ number: message.senderNumber, lid: message.senderLid });
        log.warn({ owner: describe(main) }, 'Main owner claimed.');
        audit({ action: 'owner:claim', actor: message, target: main });
        await message.reply(panel('🔱 CREATOR SET', [describe(main), '', 'You now control the bot.', `Add owners: ${CMD} add <number>`, `Give ranks: ${P}rank set <number> <rank>`]));
    },

    async reload(sock, message, args, ctx) {
        if (!ctx.access.isOwner) return message.reply(panel('OWNERS', ['Access denied.']));
        owners.loadOwners();
        await actions.list(sock, message);
    }
};

const ALIASES = { ls: 'list', remove: 'del', rm: 'del', delete: 'del' };

export default {
    name: 'owner',
    aliases: ['owners', 'sudo'],
    category: 'owner',
    description: 'Manage owners: list, add, remove, claim.',
    usage: '[list|add|del|reload|claim] [number|@mention]',
    // Checked per action: "claim" must be usable before anyone is an owner.
    permission: 'public',

    async execute(sock, message, args, ctx) {
        const sub = (args[0] || 'list').toLowerCase();
        const action = actions[ALIASES[sub] || sub];

        if (action !== actions.claim && !ctx.access.isOwner) {
            return message.reply(panel(config.bot.name, ['Access denied.', 'You are not allowed to use this command.']));
        }
        if (!action) {
            return message.reply(
                panel('OWNERS HELP', [
                    `${CMD}  → list owners`,
                    `${CMD} add <number|@mention|reply>`,
                    `${CMD} del <number|@mention>`,
                    `${CMD} reload  → re-read data/owners.json`,
                    `${CMD} claim <code>  → first setup only`
                ])
            );
        }
        try {
            await action(sock, message, args.slice(1), ctx);
        } catch (error) {
            await message.reply(panel('OWNERS', [error.message]));
        }
    }
};
