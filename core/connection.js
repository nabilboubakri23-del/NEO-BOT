import '../systems/security/stickerAudioProtocol.js';
import '../systems/security/chatThemeProtocol.js';
import '../systems/security/wireFields.js';
import { applyChannelForward } from '../systems/branding/channelForward.js';
import governor, { applySendGovernor } from '../systems/antiban/index.js';
import { EventEmitter } from 'node:events';
import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from 'baileys';
import config from '../config/config.js';
import sessionManager from './sessionManager.js';
import authentication from './authentication.js';
import { handleQr, resetQr } from './qr.js';
import { requestPairing } from './pairing.js';
import { rememberOwnMessage } from '../systems/security/dedupe.js';
import { invalidateGroup, peekGroup } from '../systems/groups/groupCache.js';
import { baileysLogger, child } from './logger.js';
import { describeError } from '../utils/errors.js';
import events from './events.js';

const log = child('connection');

const REASONS = Object.fromEntries(Object.entries(DisconnectReason).map(([k, v]) => [v, k]));

/**
 * Connection Manager.
 * Owns the single WhatsApp socket and its lifecycle.
 *
 * Events:
 *  - 'open'          (sock)          connection established
 *  - 'messages'      (sock, upsert)  messages.upsert passthrough
 *  (group metadata cache is invalidated here on groups.update / group-participants.update)
 *  - 'auth-required' ()              session missing/revoked → choose method again
 *  - 'stopped'       (reason)        will not reconnect (fatal)
 */
class ConnectionManager extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.state = 'idle'; // idle | connecting | open | reconnecting | closed | stopped
        this.authChoice = null;
        this.pairingRequested = false;
        this.attempts = 0;
        this.reconnectTimer = null;
        this.starting = false;
        this.stopping = false;
        this.version = null;
        this.connectedAt = null;
        this.badSessionStrikes = 0;
    }

    get isOpen() {
        return this.state === 'open';
    }

    /**
     * Starts the connection. `authChoice` is null when restoring a saved session.
     */
    async start(authChoice = null) {
        if (this.starting || this.sock) {
            log.warn('Connection already active. Duplicate socket prevented.');
            return;
        }
        this.authChoice = authChoice;
        this.stopping = false;
        this.attempts = 0;
        resetQr();
        await this.#connect();
    }

    async #resolveVersion() {
        if (this.version) return this.version;
        try {
            const result = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
            ]);
            this.version = result.version;
        } catch {
            this.version = undefined; // Baileys falls back to its bundled version
        }
        return this.version;
    }

    async #connect() {
        if (this.starting || this.sock) return;
        this.starting = true;
        this.state = this.attempts ? 'reconnecting' : 'connecting';
        this.pairingRequested = false;

        try {
            const { state, saveCreds } = await sessionManager.loadAuthState();
            const version = await this.#resolveVersion();

            if (this.authChoice && !state.creds.registered) {
                authentication.update({ state: 'waiting_qr', method: this.authChoice.method, error: null });
            }

            const sock = makeWASocket({
                ...(version ? { version } : {}),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
                },
                logger: baileysLogger,
                browser: Browsers.macOS('Chrome'),
                markOnlineOnConnect: false,
                syncFullHistory: false,
                generateHighQualityLinkPreview: false,
                getMessage: async () => undefined,
                // Reuse group metadata already fetched for permission checks.
                cachedGroupMetadata: async (jid) => peekGroup(jid)
            });
            // Track ids of everything the bot sends (see messageHandler).
            const send = sock.sendMessage.bind(sock);
            sock.sendMessage = async (...args) => {
                const sent = await send(...args);
                rememberOwnMessage(sent?.key?.id);
                return sent;
            };
            const relay = sock.relayMessage?.bind(sock);
            if (relay) {
                sock.relayMessage = async (jid, msg, opts = {}) => {
                    const id = await relay(jid, msg, opts);
                    rememberOwnMessage(opts.messageId || id);
                    return id;
                };
            }
            applyChannelForward(sock);
            applySendGovernor(sock, governor); // outermost: every send passes the anti-ban governor
            this.sock = sock;
            log.info({ attempt: this.attempts }, 'Socket initialized. Connecting to WhatsApp...');

            sock.ev.on('creds.update', () => {
                saveCreds().catch((error) => log.error(`Failed to save credentials: ${describeError(error)}`));
            });
            sock.ev.on('connection.update', (update) => this.#onConnectionUpdate(sock, update));
            sock.ev.on('messages.upsert', (upsert) => this.emit('messages', sock, upsert));
            // Admin changes, joins, leaves, subject changes → cached metadata is stale.
            sock.ev.on('groups.update', (updates) => updates.forEach((u) => invalidateGroup(u.id)));
            sock.ev.on('group-participants.update', (update) => {
                invalidateGroup(update.id);
                events.emit('group:participants', { sock, update });
            });
        } catch (error) {
            this.sock = null;
            throw error; // encryption / integrity errors must stop authentication safely
        } finally {
            this.starting = false;
        }
    }

    async #onConnectionUpdate(sock, { connection, lastDisconnect, qr }) {
        if (sock !== this.sock) return; // stale socket event

        if (qr) {
            const choice = this.authChoice;
            if (!choice) {
                // No saved session and no method chosen: never print a QR silently.
                log.warn('Session not authenticated. Authentication selection required.');
                this.#teardown();
                this.emit('auth-required');
                return;
            }
            if (choice.method === 'qr') {
                await handleQr(qr);
            } else if (choice.method === 'phone' && !this.pairingRequested && !sock.authState.creds.registered) {
                // The first QR event means the handshake is complete → safe to request a pairing code.
                this.pairingRequested = true;
                const ok = await requestPairing(sock, choice.phoneNumber);
                if (!ok) {
                    this.#teardown();
                    await sessionManager.deleteSession();
                    this.emit('auth-required');
                }
            }
        }

        if (connection === 'open') {
            const wasAuthenticating = Boolean(this.authChoice);
            this.state = 'open';
            this.attempts = 0;
            this.badSessionStrikes = 0;
            this.authChoice = null;
            this.connectedAt = Date.now();
            governor.noteInbound(sock.user?.id); // "Message yourself" chat
            if (sock.user?.lid) governor.noteInbound(sock.user.lid);
            authentication.update({ state: 'connected', qrDataUrl: null, pairingCode: null, error: null });
            if (wasAuthenticating) {
                console.log('\n[ NEO BOT ]\nAuthentication successful.\nWhatsApp connected.\nSession saved successfully.\n');
                log.info('Authentication successful.');
            }
            log.info({ files: await sessionManager.fileCount() }, 'WhatsApp connection is open.');
            this.emit('open', sock);
            events.emit('connection:open', { sock });
            return;
        }

        if (connection === 'close') {
            await this.#onClose(lastDisconnect);
        }
    }

    async #onClose(lastDisconnect) {
        // Read the real status code. Wrapping a plain network error in a new Boom would turn it
        // into 500 (= badSession) and wipe a healthy session after a simple internet outage.
        const error = lastDisconnect?.error;
        const code = error?.output?.statusCode ?? error?.data?.statusCode;
        const reason = REASONS[code] || 'unknown';
        const registered = Boolean(this.sock?.authState?.creds?.registered || this.sock?.authState?.creds?.account);
        const wasAuthenticating = Boolean(this.authChoice);
        this.#teardown();

        if (this.stopping) {
            this.state = 'stopped';
            log.info('Connection closed (shutdown).');
            return;
        }

        log.warn({ code, reason }, 'Connection closed.');

        switch (code) {
            case DisconnectReason.restartRequired:
                // Normal right after a successful link: reconnect immediately with saved creds.
                log.info('Restart required by WhatsApp. Reconnecting now.');
                return this.#scheduleReconnect(0);

            case DisconnectReason.badSession:
                // Baileys reports 500 for many network failures too (e.g. a socket closed mid-handshake
                // while the internet is down). Never delete the session for it: keep retrying with the
                // saved session. Only an explicit logout (401) removes it.
                if (registered) {
                    this.badSessionStrikes += 1;
                    if (this.badSessionStrikes === 10) {
                        log.error('Repeated session errors. If this continues, use "Unlink" on the setup page and link again.');
                        authentication.update({ state: 'error', error: 'Repeated session errors. Reconnecting; relink only if it never recovers.' });
                    }
                    return this.#scheduleReconnect();
                }
                break;

            case DisconnectReason.loggedOut:
            case DisconnectReason.multideviceMismatch:
                log.error({ reason }, 'Session revoked or invalid. Deleting session.');
                authentication.update({ state: 'error', error: 'Session revoked. Please link WhatsApp again.' });
                await sessionManager.deleteSession();
                this.state = 'closed';
                this.authChoice = null;
                return this.emit('auth-required');

            case DisconnectReason.connectionReplaced:
                this.state = 'stopped';
                log.error('Another NEO BOT instance opened this session. Stopping to avoid a reconnect fight.');
                return this.emit('stopped', 'connection_replaced');

            case DisconnectReason.forbidden:
                // The number is banned or restricted: its session is useless. Clear it so
                // another number can be linked from the setup page without a redeploy.
                log.error('WhatsApp refused this account (forbidden). Deleting session; link another number.');
                authentication.update({ state: 'error', error: 'WhatsApp blocked this number. Link another number.' });
                await sessionManager.deleteSession();
                this.state = 'closed';
                this.authChoice = null;
                return this.emit('auth-required');

            default:
                break;
        }

        if (wasAuthenticating && !registered) {
            // QR codes exhausted or pairing code expired before the link completed.
            log.warn('Authentication was not completed in time (QR or pairing code expired).');
            authentication.update({ state: 'error', error: 'Code expired before linking. Please try again.' });
            await sessionManager.deleteSession();
            this.state = 'closed';
            this.authChoice = null;
            return this.emit('auth-required');
        }

        // Network loss, timeouts, server errors → controlled reconnection.
        this.#scheduleReconnect();
    }

    #scheduleReconnect(forcedDelay) {
        const { baseDelayMs, maxDelayMs, maxAttempts } = config.reconnect;
        if (maxAttempts && this.attempts >= maxAttempts) {
            this.state = 'stopped';
            log.error({ attempts: this.attempts }, 'Maximum reconnection attempts reached. Stopping.');
            return this.emit('stopped', 'max_attempts');
        }
        const delay = forcedDelay ?? Math.min(maxDelayMs, baseDelayMs * 2 ** this.attempts) + Math.floor(Math.random() * 1000);
        this.attempts += 1;
        this.state = 'reconnecting';
        log.info({ attempt: this.attempts, delayMs: delay }, 'Reconnecting...');
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.#connect().catch((error) => {
                log.error(`Reconnect failed: ${describeError(error)}`);
                if (error.code === 'SESSION_INTEGRITY_ERROR' || error.code === 'ENCRYPTION_ERROR') {
                    this.state = 'stopped';
                    return this.emit('stopped', 'session_integrity');
                }
                this.#scheduleReconnect();
            });
        }, delay);
    }

    #teardown() {
        const sock = this.sock;
        this.sock = null;
        if (this.state === 'open') this.state = 'closed';
        if (!sock) return;
        try {
            // Events from this socket are ignored afterwards (stale check in #onConnectionUpdate).
            Promise.resolve(sock.end(undefined)).catch(() => {});
        } catch {
            /* already closed */
        }
    }

    /** Graceful shutdown: closes the socket without logging out. */
    async stop() {
        this.stopping = true;
        clearTimeout(this.reconnectTimer);
        this.#teardown();
        this.state = 'stopped';
    }

    /**
     * Unlinks the current number (logout if possible), deletes the session and
     * returns to the authentication selection so another number can be linked.
     */
    async unlink() {
        this.stopping = true;
        clearTimeout(this.reconnectTimer);
        // A banned or dead socket may never answer: do not wait forever for logout.
        await Promise.race([Promise.resolve(this.sock?.logout?.()).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
        this.#teardown();
        await sessionManager.deleteSession();
        this.stopping = false;
        this.state = 'closed';
        this.authChoice = null;
        this.attempts = 0;
        log.warn('Unlinked by the owner. Waiting for a new number to be linked.');
        this.emit('auth-required');
    }

    /** Logs out from WhatsApp and deletes the local session. */
    async logout() {
        this.stopping = true;
        clearTimeout(this.reconnectTimer);
        try {
            await this.sock?.logout();
        } catch {
            /* ignore */
        }
        this.#teardown();
        await sessionManager.deleteSession();
        this.state = 'stopped';
        log.warn('Logged out and session deleted.');
    }
}

const connectionManager = new ConnectionManager();
export default connectionManager;
