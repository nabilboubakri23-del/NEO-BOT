import config from '../../config/config.js';
import sessionManager from '../../core/sessionManager.js';
import { child } from '../../core/logger.js';
import { describeError } from '../../utils/errors.js';

const log = child('session-cleaner');
let timer = null;
let running = null;

/**
 * Keeps the stored session small. When it grows past the threshold, stale disposable
 * entries (old Signal sessions, group sender keys, device caches) are removed.
 * creds.json, pre-keys, app-state keys and LID mappings are never touched.
 *
 * @param {{ force?: boolean }} options force = run even below the threshold (owner command)
 * @returns {Promise<{ before: number, removed: number, after: number, skipped: boolean }>}
 */
export const cleanSession = async ({ force = false } = {}) => {
    if (running) return running;
    running = (async () => {
        const { threshold, minAgeMs } = config.sessionCleanup;
        const before = await sessionManager.fileCount();
        if (!force && before <= threshold) return { before, removed: 0, after: before, skipped: true };
        const removed = await sessionManager.cleanup({ minAgeMs });
        const after = await sessionManager.fileCount();
        log.info({ before, removed, after }, 'Session cleanup finished.');
        return { before, removed, after, skipped: false };
    })().finally(() => {
        running = null;
    });
    return running;
};

/** Checks the session size periodically (and shortly after start). */
export const startSessionCleaner = () => {
    const { enabled, intervalMs, threshold } = config.sessionCleanup;
    if (!enabled || timer) return;
    const tick = () => cleanSession().catch((error) => log.warn(`Session cleanup failed: ${describeError(error)}`));
    setTimeout(tick, 2 * 60 * 1000).unref?.();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    log.info({ threshold, everyMinutes: Math.round(intervalMs / 60000) }, 'Session cleaner enabled.');
};

export const stopSessionCleaner = () => {
    if (timer) clearInterval(timer);
    timer = null;
};
