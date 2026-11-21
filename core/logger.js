import pino from 'pino';
import config from '../config/config.js';

// Paths that must never reach the logs.
const REDACT = [
    'qr', '*.qr',
    'pairingCode', '*.pairingCode', 'code', '*.code',
    'creds', '*.creds', 'keys', '*.keys',
    'key.encryptionKey', 'encryptionKey', '*.encryptionKey',
    'token', '*.token', 'text', '*.text', 'body', '*.body'
];

const transport = config.logging.pretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined;

const buildLogger = () => {
    const options = { level: config.logging.level, base: { app: 'neo-bot' }, redact: { paths: REDACT, censor: '[REDACTED]' } };
    try {
        return pino({ ...options, transport });
    } catch {
        // pino-pretty is optional; fall back to JSON logs.
        return pino(options);
    }
};

const logger = buildLogger();

/** Silent/limited logger passed to Baileys so it cannot leak session data. */
export const baileysLogger = pino({ level: config.logging.baileysLevel, redact: { paths: REDACT, censor: '[REDACTED]' } });

export const child = (module) => logger.child({ module });

export default logger;
