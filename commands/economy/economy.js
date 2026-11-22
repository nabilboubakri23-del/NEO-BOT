import config from '../../config/config.js';
import { claimReward, getAccount, leaderboard, positionOf, transferCoins } from '../../systems/economy/economyStore.js';
import { bar, CLAIMS, progress, titleFor } from '../../systems/economy/levels.js';
import { formatRemaining } from '../../utils/duration.js';
import { mentionTarget } from '../../utils/mentions.js';
import { box } from '../../utils/formatter.js';
import { UsageError } from '../../utils/errors.js';
import { isTargetArg, resolveUserTarget, senderOf } from '../../utils/targets.js';

/**
 * Levels and coins. XP comes from chatting (the "levels" plugin), games and rewards.
 *   .profile [user]            level, XP, coins, wins, position
 *   .daily / .weekly / .monthly   periodic rewards
 *   .leaderboard [xp|coins|wins]
 *   .give <user> <amount>      give coins
 */

const P = config.bot.prefix;
const send = (sock, message, title, lines, mentions = []) => sock.sendMessage(message.chat, { text: box(title, lines), mentions }, { quoted: message.raw });

export const profile = {
    name: 'profile',
    aliases: ['level', 'xp', 'me'],
    category: 'games',
    description: 'Your (or someone\'s) level, XP, coins and wins.',
    usage: '[number|@mention|reply]',
    permission: 'public',
    cooldown: 5,
    async execute(sock, message, args) {
        const who = (await resolveUserTarget(sock, message, args[0])) || senderOf(message);
        const account = getAccount(who) || { xp: 0, coins: 0, wins: 0, name: '' };
        const p = progress(account.xp);
        const tag = mentionTarget(who);
        const position = positionOf(who);
        await send(
            sock,
            message,
            'PROFILE',
            [
                `${tag.text}${account.name ? ` (${account.name})` : ''}`,
                `Title: ${titleFor(p.level)}`,
                `Level: ${p.level}`,
                `XP: ${account.xp}  ${bar(p.percent)} ${p.percent}%`,
                `Next level in: ${p.needed - p.into} XP`,
                `Coins: 🪙 ${account.coins}`,
                `Game wins: ${account.wins || 0}`,
                position ? `Leaderboard: #${position}` : null
            ],
            [tag.jid]
        );
    }
};

export const daily = {
    name: 'daily',
    aliases: ['weekly', 'monthly'],
    category: 'games',
    description: 'Claim your daily, weekly or monthly coins and XP.',
    permission: 'public',
    async execute(sock, message, args, ctx) {
        const type = ['weekly', 'monthly'].includes(ctx.usedName) ? ctx.usedName : 'daily';
        const result = claimReward(senderOf(message), type, { name: message.pushName });
        if (!result.ok) return send(sock, message, 'REWARDS', [`⏳ Your ${type} reward is ready in ${formatRemaining(result.remainingMs)}.`]);
        await send(sock, message, 'REWARDS', [
            `🎁 ${type[0].toUpperCase()}${type.slice(1)} reward claimed!`,
            `+🪙 ${result.reward.coins} coins · +${result.reward.xp} XP`,
            `Balance: 🪙 ${result.coins}`,
            result.levelUp ? `⬆️ Level up! You are now level ${result.levelUp}.` : null,
            '',
            `Others: ${Object.keys(CLAIMS).filter((k) => k !== type).map((k) => P + k).join(' · ')}`
        ]);
    }
};

const BOARDS = { xp: 'XP', coins: 'COINS', wins: 'WINS' };

export const leaderboardCommand = {
    name: 'leaderboard',
    aliases: ['lb', 'top'],
    category: 'games',
    description: 'Top 10 by XP, coins or game wins.',
    usage: '[xp|coins|wins]',
    permission: 'public',
    cooldown: 10,
    async execute(sock, message, args) {
        const by = BOARDS[String(args[0] || 'xp').toLowerCase()] ? String(args[0] || 'xp').toLowerCase() : 'xp';
        const list = leaderboard(by, 10);
        const tags = list.map(mentionTarget);
        const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        await send(
            sock,
            message,
            `TOP ${BOARDS[by]}`,
            list.length ? list.map((a, i) => `${medal(i)} ${tags[i].text} — ${by === 'xp' ? `${a.xp} XP (lvl ${progress(a.xp).level})` : a[by]}`) : ['Nobody yet. Chat, play games and claim rewards!'],
            tags.map((t) => t.jid)
        );
    }
};

export const give = {
    name: 'give',
    aliases: ['pay', 'transfer'],
    category: 'games',
    description: 'Give some of your coins to someone.',
    usage: '<number|@mention|reply> <amount>',
    examples: ['@user 50'],
    permission: 'public',
    minArgs: 1,
    cooldown: 5,
    async execute(sock, message, args) {
        const to = await resolveUserTarget(sock, message, args[0]);
        if (!to) throw new UsageError('Who? Give a number, a @mention, or reply to their message.');
        const amount = Number((isTargetArg(args[0]) ? args[1] : args[0]) ?? NaN);
        if (!Number.isInteger(amount)) throw new UsageError('How many coins?');
        const balances = transferCoins(senderOf(message), to, amount);
        const tag = mentionTarget(to);
        await send(sock, message, 'COINS', [`✅ Sent 🪙 ${amount} to ${tag.text}.`, `Your balance: 🪙 ${balances.from}`], [tag.jid]);
    }
};

export default [profile, daily, leaderboardCommand, give];
