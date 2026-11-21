import config from '../config/config.js';
import { child } from './logger.js';

const log = child('keep-alive');
let timer = null;

/**
 * Pings the service's own public /health URL so free hosts that idle on
 * missing inbound traffic (Render free: 15 minutes) keep the bot running.
 * Does nothing when no public URL is configured.
 */
export const startKeepAlive = () => {
    const { url, intervalMs } = config.keepAlive;
    if (!url || timer) return;
    const target = new URL('/health', url).toString();
    const ping = async () => {
        try {
            const res = await fetch(target, { signal: AbortSignal.timeout(15000) });
            log.debug({ status: res.status }, 'Keep-alive ping sent.');
        } catch (error) {
            log.warn(`Keep-alive ping failed: ${error.message}`);
        }
    };
    timer = setInterval(ping, intervalMs);
    timer.unref();
    log.info({ everyMinutes: Math.round(intervalMs / 60000) }, 'Keep-alive enabled.');
};

export const stopKeepAlive = () => {
    if (timer) clearInterval(timer);
    timer = null;
};
