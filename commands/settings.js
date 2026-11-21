import config from '../config/config.js';
import { child } from '../core/logger.js';
import { getAllSettings, resetSetting, SCHEMA, setSetting } from '../systems/settings/settingsStore.js';
import { box, success } from '../utils/formatter.js';
import { UsageError } from '../utils/errors.js';

const log = child('settings');
const P = config.bot.prefix;

const show = (value) => (typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value));

const overview = () => {
    const values = getAllSettings();
    const lines = Object.entries(SCHEMA).flatMap(([key, spec]) => [
        `• ${key}: ${show(values[key])}`,
        `   ${spec.type === 'enum' ? spec.values.join(' | ') : spec.type === 'int' ? `${spec.min}-${spec.max}` : 'on | off'}`
    ]);
    return box('SETTINGS', [...lines, '', `${P}settings set <key> <value>`, `${P}settings reset <key|all>`, `${P}settings info <key>`]);
};

export default {
    name: 'settings',
    aliases: ['setting', 'config', 'set'],
    category: 'owner',
    description: 'View and change bot settings without editing code.',
    usage: '[set <key> <value> | reset <key|all> | info <key>]',
    examples: ['', 'set mode groups', 'set cooldown 5', 'reset all'],
    permissions: ['owner'],

    async execute(sock, message, args, ctx) {
        let [sub, key, ...rest] = args;
        sub = (sub || '').toLowerCase();
        // ".set mode public" works as a shortcut for ".settings set mode public".
        if (ctx.usedName === 'set' && sub && !['set', 'reset', 'info'].includes(sub)) [sub, key, rest] = ['set', args[0], args.slice(1)];

        if (!sub) return message.reply(overview());

        if (sub === 'set') {
            if (!key || !rest.length) throw new UsageError('Give a key and a value.');
            const { key: name, value } = setSetting(key, rest.join(' '));
            log.warn({ key: name, value }, 'Setting changed.');
            return message.reply(success('SETTINGS', [`${name} → ${show(value)}`]));
        }
        if (sub === 'reset') {
            if (!key) throw new UsageError('Give a key, or "all".');
            const name = resetSetting(key);
            log.warn({ key: name }, 'Setting reset.');
            return message.reply(success('SETTINGS', [name === 'all' ? 'All settings back to default.' : `${name} → ${show(getAllSettings()[name])} (default)`]));
        }
        if (sub === 'info') {
            const name = Object.keys(SCHEMA).find((k) => k.toLowerCase() === String(key).toLowerCase());
            if (!name) throw new UsageError('Unknown setting.');
            const spec = SCHEMA[name];
            return message.reply(box(name.toUpperCase(), [spec.description, '', `Current: ${show(getAllSettings()[name])}`, `Default: ${show(spec.default)}`]));
        }
        throw new UsageError();
    }
};
