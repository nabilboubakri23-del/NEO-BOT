import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const toInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback = false) => {
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const resolveDir = (value, fallback) => path.resolve(ROOT_DIR, value || fallback);

// Existing AI_API_KEY deployments retain their OpenAI-compatible settings.
const aiProvider = (process.env.AI_PROVIDER || (process.env.GROQ_API_KEY && !process.env.AI_API_KEY ? 'groq' : 'openai')).toLowerCase();
const useGroq = aiProvider === 'groq';

const config = Object.freeze({
    rootDir: ROOT_DIR,

    channel: Object.freeze({
        jid: process.env.NEWSLETTER_JID ?? '120363432107113191@newsletter',
        name: process.env.NEWSLETTER_NAME || process.env.BOT_NAME || 'NEO BOT'
    }),
    bot: Object.freeze({
        name: process.env.BOT_NAME || 'NEO BOT',
        version: '1.4.0',
        prefix: process.env.BOT_PREFIX || '.',
        footer: 'Advanced WhatsApp Assistant',
        website: process.env.BOT_WEBSITE || 'https://github.com'
    }),

    owner: Object.freeze({
        // Main owner written into data/owners.json on first run (international, no "+").
        main: (process.env.MAIN_OWNER || '212721063675').replace(/\D/g, ''),
        // Comma separated international numbers without "+" (e.g. 2126XXXXXXXX)
        numbers: (process.env.OWNER_NUMBERS || '')
            .split(',')
            .map((n) => n.replace(/\D/g, ''))
            .filter(Boolean)
    }),

    auth: Object.freeze({
        // "qr" | "phone" | "" (empty = ask in terminal or web setup)
        method: (process.env.AUTH_METHOD || '').toLowerCase(),
        phoneNumber: process.env.PAIRING_NUMBER || ''
    }),

    session: Object.freeze({
        dir: resolveDir(process.env.SESSION_DIR, 'storage/sessions'),
        // When set, the encrypted session is kept in MongoDB instead of local files.
        mongoUri: process.env.MONGODB_URI || '',
        mongoDb: process.env.MONGODB_DB || 'neobot',
        encryptionKey: process.env.SESSION_ENCRYPTION_KEY || ''
    }),

    sessionCleanup: Object.freeze({
        // Cleanup runs only when the session holds more entries than this.
        threshold: toInt(process.env.SESSION_CLEAN_THRESHOLD, 500),
        // Only entries untouched for this long are removed (active chats stay intact).
        minAgeMs: toInt(process.env.SESSION_CLEAN_MIN_AGE_HOURS, 24) * 60 * 60 * 1000,
        intervalMs: toInt(process.env.SESSION_CLEAN_INTERVAL_MS, 60 * 60 * 1000),
        enabled: process.env.SESSION_CLEAN_ENABLED !== 'false'
    }),

    reconnect: Object.freeze({
        baseDelayMs: toInt(process.env.RECONNECT_BASE_DELAY_MS, 2000),
        maxDelayMs: toInt(process.env.RECONNECT_MAX_DELAY_MS, 60000),
        maxAttempts: toInt(process.env.RECONNECT_MAX_ATTEMPTS, 0) // 0 = unlimited
    }),

    setupServer: Object.freeze({
        // Browser based authentication for cloud hosting
        enabled: toBool(process.env.WEB_SETUP_ENABLED, !process.stdin.isTTY),
        port: toInt(process.env.PORT || process.env.WEB_SETUP_PORT, 3000),
        token: process.env.WEB_SETUP_TOKEN || ''
    }),

    antiban: Object.freeze({
        // Outgoing-message governor that keeps the bot's sending pattern human-like.
        enabled: process.env.ANTIBAN_ENABLED !== 'false',
        perMinute: toInt(process.env.ANTIBAN_PER_MINUTE, 20),
        perHour: toInt(process.env.ANTIBAN_PER_HOUR, 400),
        burst: toInt(process.env.ANTIBAN_BURST, 5),
        chatGapMs: toInt(process.env.ANTIBAN_CHAT_GAP_MS, 700),
        // Never start a private chat with someone who has not written to the bot first.
        blockColdDm: process.env.ANTIBAN_BLOCK_COLD_DM !== 'false'
    }),

    keepAlive: Object.freeze({
        // Public URL pinged to stop free hosts from idling the service.
        // Render sets RENDER_EXTERNAL_URL automatically.
        url: process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '',
        // Render free idles after 15 minutes without inbound traffic: never ping less often than every 13.
        intervalMs: Math.min(toInt(process.env.KEEP_ALIVE_INTERVAL_MS, 10 * 60 * 1000), 13 * 60 * 1000)
    }),

    media: Object.freeze({
        // ffmpeg binary used by sticker / convert commands (feature-detected; optional).
        ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
        stickerPack: process.env.STICKER_PACK || process.env.BOT_NAME || 'NEO BOT',
        stickerAuthor: process.env.STICKER_AUTHOR || ''
    }),

    ai: Object.freeze({
        provider: aiProvider,
        apiKey: useGroq ? (process.env.GROQ_API_KEY || process.env.AI_API_KEY || '') : (process.env.AI_API_KEY || ''),
        baseUrl: (process.env.AI_BASE_URL || (useGroq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, ''),
        model: process.env.AI_MODEL || (useGroq ? 'openai/gpt-oss-120b' : 'gpt-4o-mini'),
        systemPrompt: process.env.AI_SYSTEM_PROMPT || ''
    }),

    devtools: Object.freeze({
        // Owner-only remote code console (.dev). Set DEVTOOLS_ENABLED=false to disable it.
        enabled: toBool(process.env.DEVTOOLS_ENABLED, true)
    }),

    logging: Object.freeze({
        level: process.env.LOG_LEVEL || 'info',
        baileysLevel: process.env.BAILEYS_LOG_LEVEL || 'silent',
        pretty: toBool(process.env.LOG_PRETTY, process.stdout.isTTY)
    })
});

export default config;
