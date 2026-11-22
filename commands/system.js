import os from 'node:os';
import config from '../config/config.js';
import { hasFfmpeg } from '../systems/media/ffmpeg.js';
import { hasImageLib } from '../systems/media/imageLib.js';
import { box, formatBytes, formatDuration, section } from '../utils/formatter.js';

/**
 * .system — server resources: memory (process and host), CPU, load, uptime and
 * which optional media tools are available. Usage statistics live in .stats.
 */

const percent = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : '?');

export default {
    name: 'system',
    aliases: ['ram', 'sysinfo', 'server'],
    category: 'system',
    description: 'Server resources: RAM, CPU, load, uptime and media tools.',
    permission: 'public',
    cooldown: 5,

    async execute(sock, message) {
        const mem = process.memoryUsage();
        const total = os.totalmem();
        const free = os.freemem();
        const cpus = os.cpus() || [];
        const [l1, l5, l15] = os.loadavg();
        const [ffmpeg, imageLib] = await Promise.all([hasFfmpeg(), hasImageLib()]);
        await message.reply(
            box('SYSTEM', [
                ...section('PROCESS', [
                    `${config.bot.name} v${config.bot.version} · Node ${process.version}`,
                    `Uptime: ${formatDuration(process.uptime() * 1000)}`,
                    `RAM (RSS): ${formatBytes(mem.rss)}`,
                    `Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`
                ]),
                '',
                ...section('HOST', [
                    `OS: ${os.platform()} ${os.arch()}`,
                    `RAM: ${formatBytes(total - free)} / ${formatBytes(total)} (${percent(total - free, total)})`,
                    `CPU: ${cpus.length} × ${(cpus[0]?.model || 'unknown').trim().slice(0, 40)}`,
                    `Load: ${l1.toFixed(2)} · ${l5.toFixed(2)} · ${l15.toFixed(2)}`,
                    `Uptime: ${formatDuration(os.uptime() * 1000)}`
                ]),
                '',
                ...section('MEDIA TOOLS', [`ffmpeg: ${ffmpeg ? 'yes' : 'no'}`, `Picture library (jimp/sharp): ${imageLib ? 'yes' : 'no'}`])
            ])
        );
    }
};
