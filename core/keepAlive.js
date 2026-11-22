import config from '../config/config.js';
import { child } from './logger.js';

const log = child('keep-alive');
let timer = null;
let failures = 0;

/**
 * Pings the service's own public /health URL so free hosts that idle on
 * missing inbound traffic (Render free: 15 minutes) keep the bot running.
 * The interval is capped at 13 minutes (see config). A failed ping is retried
 * after one minute so a short network blip never lets the 15-minute window pass.
 * Does nothing when no public URL is configured.
 */
export const startKeepAlive = () => {
    const { url, intervalMs } = config.keepAlive;
    if (!url || timer) return;
    const target = new URL('/health', url).toString();

    const ping = async () => {
        try {
            const res = await fetch(target, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'neo-bot-keepalive' } });
            if (failures) log.info({ status: res.status }, 'Keep-alive ping recovered.');
            failures = 0;
            log.debug({ status: res.status }, 'Keep-alive ping sent.');
        } catch (error) {
            failures += 1;
            log.warn({ failures }, `Keep-alive ping failed: ${error.message}`);
            if (failures <= 3) setTimeout(ping, 60 * 1000).unref?.();
        }
    };

    setTimeout(ping, 30 * 1000).unref?.(); // first ping soon after boot
    timer = setInterval(ping, intervalMs);
    timer.unref?.();
    log.info({ target, everyMinutes: Math.round(intervalMs / 60000) }, 'Keep-alive enabled.');
};

export const stopKeepAlive = () => {
    if (timer) clearInterval(timer);
    timer = null;
};
