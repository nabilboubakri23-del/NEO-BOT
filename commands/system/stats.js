import os from 'node:os';
import config from '../../config/config.js';
import connectionManager from '../../core/connection.js';
import commandHandler from '../../core/commandHandler.js';
import docStore from '../../systems/database/docStore.js';
import { getStats } from '../../systems/stats/statsStore.js';
import { userCount } from '../../systems/users/userStore.js';
import { box, formatBytes, formatDuration, section } from '../../utils/formatter.js';

export default {
    name: 'stats',
    aliases: ['status', 'info', 'botinfo'],
    category: 'system',
    description: 'Bot status, usage statistics and top commands.',
    permission: 'public',
    cooldown: 5,

    async execute(sock, message) {
        const stats = getStats();
        const uptime = connectionManager.connectedAt ? formatDuration(Date.now() - connectionManager.connectedAt) : '0s';
        const memory = process.memoryUsage();
        await message.reply(
            box('STATISTICS', [
                ...section('BOT', [
                    `Name: ${config.bot.name} v${config.bot.version}`,
                    `Status: ${connectionManager.isOpen ? 'Online' : 'Reconnecting'}`,
                    `Uptime: ${uptime}`,
                    `Commands loaded: ${commandHandler.commands.size}`,
                    `Database: ${docStore.kind}`
                ]),
                '',
                ...section('SINCE START', [`Messages: ${stats.session.messages}`, `Commands: ${stats.session.commands}`, `Errors: ${stats.session.errors}`]),
                '',
                ...section('ALL TIME', [`Users: ${userCount()}`, `Messages: ${stats.total.messages}`, `Commands: ${stats.total.commands}`]),
                '',
                ...section('TOP COMMANDS', stats.top.length ? stats.top.map(([name, n], i) => `${i + 1}. ${config.bot.prefix}${name}  (${n})`) : ['No data yet.']),
                '',
                ...section('SERVER', [`Node: ${process.version}`, `Platform: ${os.platform()} ${os.arch()}`, `Memory: ${formatBytes(memory.rss)}`])
            ])
        );
    }
};
