import config from '../../config/config.js';
import pluginManager from '../../systems/plugins/pluginManager.js';
import { box } from '../../utils/formatter.js';
import { describeError, UsageError } from '../../utils/errors.js';

/**
 * .plugins — owner-only plugin manager.
 *
 *   .plugins              list installed plugins
 *   .plugins info <name>  details of one plugin
 *   .plugins enable <name>
 *   .plugins disable <name>
 *   .plugins install <https url> [--force]
 *   .plugins remove <name>
 *   .plugins reload       reload every plugin file
 */

const P = config.bot.prefix;
const CMD = `${P}plugins`;

const list = async (message) => {
    const plugins = pluginManager.list();
    const lines = [`Installed: ${plugins.length}`];
    if (!plugins.length) {
        lines.push('', 'No plugins yet.', `Add one: ${CMD} install <https url>`);
    } else {
        for (const p of plugins) {
            lines.push('', `${p.active ? '🟢' : '⚪'} ${p.name} v${p.version}`, p.description ? `   ${p.description}` : null);
            if (p.commands.length) lines.push(`   Commands: ${p.commands.map((c) => P + c).join(', ')}`);
        }
    }
    if (pluginManager.failures.length) {
        lines.push('', '[ FAILED ]', ...pluginManager.failures.map((f) => `• ${f.file}: ${f.error}`));
    }
    lines.push('', `${CMD} info|enable|disable|install|remove|reload`);
    await message.reply(box('PLUGINS', lines.filter((l) => l !== null)));
};

const info = async (message, name) => {
    if (!name) throw new UsageError();
    const p = pluginManager.list().find((x) => x.name === name.toLowerCase());
    if (!p) return message.reply(box('PLUGINS', [`No plugin named "${name}".`]));
    await message.reply(
        box(`PLUGIN ${p.name.toUpperCase()}`, [
            `Version: ${p.version}`,
            p.author ? `Author: ${p.author}` : null,
            p.description ? `About: ${p.description}` : null,
            `Status: ${p.active ? 'enabled' : 'disabled'}`,
            `Commands: ${p.commands.length ? p.commands.map((c) => P + c).join(', ') : 'none'}`,
            `Hooks: ${p.hooks.length ? p.hooks.join(', ') : 'none'}`
        ].filter((l) => l !== null))
    );
};

const actions = {
    async info(message, args) {
        await info(message, args[0]);
    },
    async enable(message, args) {
        if (!args[0]) throw new UsageError();
        const ok = await pluginManager.enable(args[0]);
        await message.reply(box('PLUGINS', [ok ? `🟢 ${args[0]} enabled.` : `Could not enable "${args[0]}".`]));
    },
    async disable(message, args) {
        if (!args[0]) throw new UsageError();
        const ok = await pluginManager.disable(args[0]);
        await message.reply(box('PLUGINS', [ok ? `⚪ ${args[0]} disabled.` : `No plugin named "${args[0]}".`]));
    },
    async install(message, args, ctx) {
        const url = args.find((a) => /^https:\/\//i.test(a));
        if (!url) throw new UsageError('Give an https URL to the plugin file.');
        await message.reply(box('PLUGINS', ['Downloading and checking the plugin...']));
        const result = await pluginManager.install(url, { force: Boolean(ctx.flags.force) });
        const lines = [`🟢 Installed ${result.name}.`, `File: plugins/${result.file}`];
        if (result.risks.length) lines.push('', '⚠️ Uses: ' + result.risks.join(', '));
        await message.reply(box('PLUGINS', lines));
    },
    async remove(message, args) {
        if (!args[0]) throw new UsageError();
        await pluginManager.remove(args[0]);
        await message.reply(box('PLUGINS', [`🗑️ Removed ${args[0]}.`]));
    },
    async reload(message) {
        const result = await pluginManager.load();
        const lines = [`Plugins: ${result.plugins}`, `Active: ${result.active}`];
        if (result.failures.length) lines.push('', 'Failed:', ...result.failures.map((f) => `• ${f.file}: ${f.error}`));
        await message.reply(box('PLUGINS', lines));
    }
};

export default {
    name: 'plugins',
    aliases: ['plugin', 'plug'],
    category: 'owner',
    description: 'Install, enable, disable and reload plugins.',
    usage: '[info|enable|disable|install|remove|reload] ...',
    examples: ['', 'install https://example.com/welcome.js', 'disable welcome'],
    permission: 'owner',

    async execute(sock, message, args, ctx) {
        const sub = (args[0] || '').toLowerCase();
        const action = actions[sub];
        try {
            if (!action) return list(message);
            await action(message, args.slice(1), ctx);
        } catch (error) {
            if (error instanceof UsageError) throw error;
            await message.reply(box('PLUGINS', ['⚠️ ' + describeError(error).replace(/^\w*Error: /, '')]));
        }
    }
};
