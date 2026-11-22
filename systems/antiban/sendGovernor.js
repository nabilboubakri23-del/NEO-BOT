import { isJidGroup, isJidNewsletter, jidNormalizedUser } from 'baileys';
import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import { TokenBucket } from './tokenBucket.js';

/**
 * Anti-ban send governor. Every outgoing message goes through it, whatever code sends it.
 *
 * WhatsApp bans numbers that behave like machines: bursts of messages, identical
 * texts, messages to people who never wrote first, and ignoring rate-limit errors.
 * The governor prevents all of these, and cannot be bypassed from chat:
 *  - global token bucket (burst + per-minute) and an hourly ceiling
 *  - one message at a time per chat with a minimum gap and small random jitter
 *  - a capped queue per chat: a flood of commands never turns into a flood of replies
 *  - the same text to the same chat more than twice in 10 s is dropped (loop guard)
 *  - no cold DMs: private chats only with people who wrote to the bot (or owners)
 *  - WhatsApp "rate-overlimit" errors pause all sending with growing back-off
 * Reactions, deletes and edits use a separate, larger bucket so moderation stays fast.
 */

const log = child('antiban');

const MAX_QUEUE_PER_CHAT = 12;
const MAX_WAIT_MS = 45_000;
const LOOP_WINDOW_MS = 10_000;
const KNOWN_LIMIT = 20_000;

export class SendDroppedError extends Error {
    constructor(reason) {
        super(`Send dropped by anti-ban: ${reason}`);
        this.code = 'SEND_DROPPED';
        this.reason = reason;
        this.expose = false;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAction = (content) => Boolean(content && ('react' in content || 'delete' in content || 'edit' in content));
const textOf = (content) => (content && (content.text || content.caption)) || '';

export class SendGovernor {
    constructor(options = config.antiban, { now = () => Date.now(), wait = sleep, isTrusted = () => false } = {}) {
        this.opts = options;
        this.now = now;
        this.wait = wait;
        this.isTrusted = isTrusted;
        this.messages = new TokenBucket({ capacity: options.burst, refillPerMinute: options.perMinute, now });
        this.actions = new TokenBucket({ capacity: 15, refillPerMinute: 90, now });
        this.hour = [];
        this.chains = new Map(); // jid → { tail: Promise, size: number, last: number }
        this.recent = new Map(); // jid|text → [timestamps]
        this.known = new Set();
        this.pausedUntil = 0;
        this.pauseLevel = 0;
        this.stats = { sent: 0, dropped: 0, delayedMs: 0, rateLimited: 0 };
    }

    /** Called for every incoming message: this chat may now receive replies. */
    noteInbound(jid) {
        if (!jid) return;
        this.known.add(jidNormalizedUser(jid));
        if (this.known.size > KNOWN_LIMIT) this.known.delete(this.known.values().next().value);
    }

    #allowedTarget(jid) {
        if (!this.opts.blockColdDm) return true;
        if (isJidGroup(jid) || isJidNewsletter(jid) || jid === 'status@broadcast') return true;
        const id = jidNormalizedUser(jid);
        return this.known.has(id) || this.isTrusted(id);
    }

    #loopCheck(jid, content) {
        const text = textOf(content);
        if (!text) return true;
        const key = `${jid}|${text}`;
        const now = this.now();
        const hits = (this.recent.get(key) || []).filter((t) => now - t < LOOP_WINDOW_MS);
        if (hits.length >= 2) return false;
        hits.push(now);
        this.recent.set(key, hits);
        if (this.recent.size > 2000) this.recent.delete(this.recent.keys().next().value);
        return true;
    }

    #hourCount() {
        const cutoff = this.now() - 3_600_000;
        while (this.hour.length && this.hour[0] < cutoff) this.hour.shift();
        return this.hour.length;
    }

    #drop(reason, jid) {
        this.stats.dropped += 1;
        log.warn({ reason, jid }, 'Outgoing message dropped (anti-ban).');
        throw new SendDroppedError(reason);
    }

    /** Waits for its turn, then runs `send`. */
    async run(jid, content, send) {
        if (!this.opts.enabled) return send();
        const action = isAction(content);
        if (!action) {
            if (!this.#allowedTarget(jid)) this.#drop('cold_dm', jid);
            if (!this.#loopCheck(jid, content)) this.#drop('repeated_text', jid);
            if (this.#hourCount() >= this.opts.perHour) this.#drop('hourly_limit', jid);
        }

        const chain = this.chains.get(jid) || { tail: Promise.resolve(), size: 0, last: 0 };
        if (chain.size >= MAX_QUEUE_PER_CHAT) this.#drop('queue_full', jid);
        chain.size += 1;
        this.chains.set(jid, chain);

        const job = chain.tail.then(async () => {
            const started = this.now();
            try {
                // Global pause after a WhatsApp rate-limit error.
                if (this.pausedUntil > this.now()) await this.wait(this.pausedUntil - this.now());
                const bucket = action ? this.actions : this.messages;
                let w = bucket.waitTime();
                if (!action) {
                    const gap = chain.last + this.opts.chatGapMs - this.now();
                    w = Math.max(w, gap, 0) + Math.floor(Math.random() * 250); // human-like jitter
                }
                if (w > MAX_WAIT_MS) this.#drop('overloaded', jid);
                if (w > 0) await this.wait(w);
                bucket.take();
                const result = await send();
                if (!action) {
                    chain.last = this.now();
                    this.hour.push(chain.last);
                }
                this.stats.sent += 1;
                this.stats.delayedMs += this.now() - started;
                if (this.pauseLevel && this.now() > this.pausedUntil + 300_000) this.pauseLevel = 0;
                return result;
            } catch (error) {
                if (this.#isRateLimit(error)) this.#pause();
                throw error;
            }
        });
        chain.tail = job.catch(() => {}).finally(() => {
            chain.size -= 1;
            if (chain.size <= 0 && this.chains.get(jid) === chain) this.chains.delete(jid);
        });
        return job;
    }

    #isRateLimit(error) {
        const code = error?.output?.statusCode ?? error?.data?.statusCode;
        return code === 429 || /rate-overlimit|rate overlimit|too many/i.test(String(error?.message || ''));
    }

    #pause() {
        this.pauseLevel = Math.min(this.pauseLevel + 1, 5);
        const ms = 30_000 * 2 ** (this.pauseLevel - 1); // 30s, 1m, 2m, 4m, 8m
        this.pausedUntil = this.now() + ms;
        this.stats.rateLimited += 1;
        log.error({ pauseMs: ms }, 'WhatsApp rate limit hit. All sending paused.');
    }

    status() {
        return {
            enabled: this.opts.enabled,
            lastHour: this.#hourCount(),
            perHour: this.opts.perHour,
            perMinute: this.opts.perMinute,
            queued: [...this.chains.values()].reduce((n, c) => n + c.size, 0),
            pausedMs: Math.max(0, this.pausedUntil - this.now()),
            ...this.stats
        };
    }
}

/**
 * Installs the governor as the outermost layer of sendMessage / relayMessage.
 * Baileys' sendMessage calls its internal relay directly, so nothing is counted twice.
 */
export const applySendGovernor = (sock, governor) => {
    if (sock.__governor) return sock;
    const send = sock.sendMessage.bind(sock);
    const relay = sock.relayMessage?.bind(sock);
    sock.sendMessage = (jid, content, options) => governor.run(jid, content, () => send(jid, content, options));
    if (relay) sock.relayMessage = (jid, msg, opts) => governor.run(jid, null, () => relay(jid, msg, opts));
    sock.__governor = governor;
    return sock;
};
