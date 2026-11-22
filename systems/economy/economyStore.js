import docStore from '../database/docStore.js';
import { UserError } from '../../utils/errors.js';
import { findPerson, personKey, samePerson } from '../../utils/targets.js';
import { CLAIMS, levelForXp, MESSAGE_XP, rollMessageXp } from './levels.js';

/**
 * XP, levels and coins per person (the same account in every chat).
 * { "<personKey>": { number, lid, name, xp, coins, wins, lastXpAt, claims: { daily, weekly, monthly } } }
 */

const NAME = 'economy';
const MAX_TRANSFER = 1_000_000;
let doc = null;

export const loadEconomy = async () => {
    doc = await docStore.open(NAME, () => ({}));
    return doc;
};

const ensure = () => {
    if (!doc) throw new Error('Economy not loaded.');
    return doc;
};

const blank = (who) => ({ number: who.number || '', lid: who.lid || '', name: '', xp: 0, coins: 0, wins: 0, lastXpAt: 0, claims: {} });

/** The account of a person, or null when they have none yet. */
export const getAccount = (who) => findPerson(doc, who)?.record || null;

/** The account of a person, created when missing. */
export const ensureAccount = (who, name = '') => {
    const accounts = ensure();
    const key = personKey(who);
    if (!key) throw new Error('No person given.');
    let account = findPerson(accounts, who)?.record;
    if (!account) accounts[key] = account = blank(who);
    if (who.number && !account.number) account.number = who.number;
    if (who.lid && !account.lid) account.lid = who.lid;
    if (name) account.name = name;
    docStore.touch(NAME);
    return account;
};

/** Adds XP. Returns { xp, level, levelUp } (levelUp = the new level, or 0). */
export const addXp = (who, amount, { name = '' } = {}) => {
    const account = ensureAccount(who, name);
    const before = levelForXp(account.xp);
    account.xp = Math.max(0, account.xp + Math.round(amount));
    const level = levelForXp(account.xp);
    docStore.touch(NAME);
    return { xp: account.xp, level, levelUp: level > before ? level : 0 };
};

export const addCoins = (who, amount) => {
    const account = ensureAccount(who);
    account.coins = Math.max(0, account.coins + Math.round(amount));
    docStore.touch(NAME);
    return account.coins;
};

/** A game win: coins, XP and the win counter. */
export const rewardWin = (who, { coins = 0, xp = 0, name = '' } = {}) => {
    const result = addXp(who, xp, { name });
    addCoins(who, coins);
    getAccount(who).wins += 1;
    docStore.touch(NAME);
    return result;
};

/** XP for chatting, at most once per MESSAGE_XP.cooldownMs. Returns addXp's result or null. */
export const gainMessageXp = (who, { name = '', now = Date.now(), random } = {}) => {
    if (!personKey(who)) return null;
    const account = ensureAccount(who, name);
    if (account.lastXpAt && now - account.lastXpAt < MESSAGE_XP.cooldownMs) return null;
    account.lastXpAt = now;
    return addXp(who, rollMessageXp(random));
};

/**
 * Claims a periodic reward (daily / weekly / monthly).
 * @returns {{ ok: true, reward, coins, levelUp } | { ok: false, remainingMs }}
 */
export const claimReward = (who, type, { name = '', now = Date.now() } = {}) => {
    const reward = CLAIMS[type];
    if (!reward) throw new Error(`Unknown reward "${type}".`);
    const account = ensureAccount(who, name);
    account.claims ||= {};
    const last = account.claims[type] || 0;
    if (last && now - last < reward.every) return { ok: false, remainingMs: last + reward.every - now };
    account.claims[type] = now;
    account.coins += reward.coins;
    const { levelUp } = addXp(who, reward.xp);
    docStore.touch(NAME);
    return { ok: true, reward, coins: account.coins, levelUp };
};

/** Moves coins between two people. Throws a UserError with the reason when not possible. */
export const transferCoins = (from, to, amount) => {
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_TRANSFER) throw new UserError(`Amount must be a whole number from 1 to ${MAX_TRANSFER}.`);
    if (samePerson(ensureAccount(from), to)) throw new UserError('You cannot give coins to yourself.');
    const sender = ensureAccount(from);
    if (sender.coins < amount) throw new UserError(`Not enough coins (you have ${sender.coins}).`);
    const receiver = ensureAccount(to);
    sender.coins -= amount;
    receiver.coins += amount;
    docStore.touch(NAME);
    return { from: sender.coins, to: receiver.coins };
};

/** Top accounts by "xp", "coins" or "wins". */
export const leaderboard = (by = 'xp', limit = 10) =>
    Object.values(doc || {})
        .filter((a) => a[by] > 0)
        .sort((a, b) => b[by] - a[by])
        .slice(0, limit);

/** 1-based position of a person by XP (0 when unranked). */
export const positionOf = (who) => {
    const all = leaderboard('xp', Infinity);
    return all.findIndex((a) => samePerson(a, who)) + 1;
};
