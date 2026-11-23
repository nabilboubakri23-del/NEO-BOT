import config from '../../config/config.js';
import events from '../../core/events.js';

/**
 * "Tap a button, then just type": after a flow calls sessions.expect(m, token, mode),
 * the sender's next plain message (no command prefix) in that chat is handed to
 * onInput(sock, m, text, mode, session). The job runs in the background so the
 * message pipeline never waits on a slow search.
 */

export const CANCEL_WORDS = /^(cancel|stop|back|exit|close|إلغاء|الغاء|رجوع|خروج|اغلاق|إغلاق)$/i;

export const captureInput = ({ tag, sessions, onInput, onCancel, onError, maxLength = 300 }) => {
    const listener = ({ sock, message: m }) => {
        const text = String(m?.text || '').trim();
        if (!text || m.selectionId || text.startsWith(config.bot.prefix)) return undefined;
        const waiting = sessions.takeAwaiting(m);
        if (!waiting) return undefined;
        const job = CANCEL_WORDS.test(text) ? onCancel(sock, m) : onInput(sock, m, text.slice(0, maxLength), waiting.mode, waiting.session);
        Promise.resolve(job).catch((error) => onError(sock, m, error));
        return undefined;
    };
    events.offTag(tag); // hot-reload safe: exactly one listener per flow
    events.on('message', listener, { tag });
    events.on('message:self', listener, { tag });
    return listener;
};
