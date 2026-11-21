import { EventEmitter } from 'node:events';
import readline from 'node:readline/promises';
import config from '../config/config.js';
import { ConfigError, ValidationError } from '../utils/errors.js';
import { terminalFrame } from '../utils/formatter.js';
import { isValidAuthChoice, normalizePhoneNumber } from '../utils/validators.js';
import { child } from './logger.js';

const log = child('auth');

/**
 * Authentication coordinator.
 *  - Decides which method to use (env, terminal, or browser setup page).
 *  - Holds the live authentication status shown by the setup page.
 * It never logs QR strings or pairing codes.
 */
class Authentication extends EventEmitter {
    constructor() {
        super();
        this.status = {
            state: 'idle', // idle | awaiting_choice | waiting_qr | qr_ready | pairing_code | connected | error
            method: null,
            qrDataUrl: null,
            pairingCode: null,
            phoneMasked: null,
            error: null,
            updatedAt: Date.now()
        };
    }

    update(patch) {
        Object.assign(this.status, patch, { updatedAt: Date.now() });
        this.emit('status', this.status);
    }

    reset(state = 'idle') {
        this.update({ state, method: null, qrDataUrl: null, pairingCode: null, phoneMasked: null, error: null });
    }

    get hasTerminal() {
        return Boolean(process.stdin.isTTY && process.stdout.isTTY);
    }

    /**
     * Resolves the authentication method.
     * @returns {Promise<{ method: 'qr' } | { method: 'phone', phoneNumber: string }>}
     */
    async chooseMethod({ allowEnv = true } = {}) {
        this.reset('awaiting_choice');
        log.info('Authentication required. Waiting for connection method selection.');

        if (allowEnv && config.auth.method) {
            const choice = this.#fromEnv();
            if (choice) return choice;
        }
        if (this.hasTerminal) return this.#fromTerminal();
        if (config.setupServer.enabled) {
            log.info({ port: config.setupServer.port }, 'Open the web setup page to link WhatsApp.');
            return new Promise((resolve) => this.once('choice', resolve));
        }
        throw new ConfigError(
            'No way to authenticate: no terminal, AUTH_METHOD not set and WEB_SETUP_ENABLED is false.'
        );
    }

    /** Called by the web setup page. Validates and resolves a pending chooseMethod(). */
    submitChoice(method, phoneInput) {
        if (this.status.state !== 'awaiting_choice') {
            throw new ValidationError('Authentication is not waiting for a selection.');
        }
        const choice = method === 'phone'
            ? { method: 'phone', phoneNumber: normalizePhoneNumber(phoneInput) }
            : method === 'qr' ? { method: 'qr' } : null;
        if (!choice) throw new ValidationError('Invalid connection method.');
        log.info({ method: choice.method, source: 'web' }, 'Authentication method selected.');
        this.emit('choice', choice);
        return choice;
    }

    #fromEnv() {
        if (config.auth.method === 'qr') {
            log.info({ method: 'qr', source: 'env' }, 'Authentication method selected.');
            return { method: 'qr' };
        }
        if (config.auth.method === 'phone') {
            try {
                const phoneNumber = normalizePhoneNumber(config.auth.phoneNumber);
                log.info({ method: 'phone', source: 'env' }, 'Authentication method selected.');
                return { method: 'phone', phoneNumber };
            } catch (error) {
                log.error(`PAIRING_NUMBER is invalid: ${error.message}`);
                return null;
            }
        }
        log.warn('AUTH_METHOD must be "qr" or "phone". Ignoring it.');
        return null;
    }

    async #fromTerminal() {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            for (;;) {
                console.log('\n' + terminalFrame(['NEO BOT', 'AUTHENTICATION'], [
                    'Select connection method:', '', '[1] Phone Number', '[2] QR Code', '', 'Enter your choice:'
                ]));
                const answer = (await rl.question('> ')).trim();
                if (!isValidAuthChoice(answer)) {
                    console.log('\n[ NEO BOT ] Invalid selection. Please enter 1 or 2.');
                    continue;
                }
                if (answer === '2') {
                    log.info({ method: 'qr', source: 'terminal' }, 'Authentication method selected.');
                    return { method: 'qr' };
                }
                const phoneNumber = await this.#askPhone(rl);
                if (phoneNumber) {
                    log.info({ method: 'phone', source: 'terminal' }, 'Authentication method selected.');
                    return { method: 'phone', phoneNumber };
                }
            }
        } finally {
            rl.close();
        }
    }

    async #askPhone(rl) {
        console.log('\n' + terminalFrame('PHONE PAIRING', [
            'Enter your WhatsApp number.', '', 'Include your country code.', 'Example: 212XXXXXXXXX', '', 'Type "back" to return.'
        ]));
        for (;;) {
            const input = (await rl.question('> ')).trim();
            if (input.toLowerCase() === 'back') return null;
            try {
                return normalizePhoneNumber(input);
            } catch (error) {
                console.log(`\n[ NEO BOT ] ${error.message}`);
            }
        }
    }
}

const authentication = new Authentication();
export default authentication;
