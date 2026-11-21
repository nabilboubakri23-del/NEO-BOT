import authentication from './authentication.js';
import { child } from './logger.js';
import { terminalFrame } from '../utils/formatter.js';
import { describeError } from '../utils/errors.js';

const log = child('pairing');

const mask = (phone) => `${phone.slice(0, 3)}${'*'.repeat(Math.max(0, phone.length - 5))}${phone.slice(-2)}`;
const formatCode = (code) => (code?.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

/**
 * Requests a pairing code. Must only be called once the socket handshake is
 * ready (first "qr" event of connection.update), never earlier.
 * @returns {Promise<boolean>} true when a code was displayed
 */
export const requestPairing = async (sock, phoneNumber) => {
    log.info({ phone: mask(phoneNumber) }, 'Requesting pairing code.');
    try {
        const code = formatCode(await sock.requestPairingCode(phoneNumber));
        log.info('Pairing code generated.'); // the code itself is never logged

        if (authentication.hasTerminal) {
            console.log('\n' + terminalFrame('PAIRING CODE', [
                `Your code:  ${code}`, '',
                '1. Open WhatsApp.',
                '2. Go to Linked Devices.',
                '3. Select Link a Device.',
                '4. Select "Link with phone',
                '   number instead".',
                '5. Enter the code above.'
            ]));
        }
        authentication.update({ state: 'pairing_code', method: 'phone', pairingCode: code, phoneMasked: mask(phoneNumber), error: null });
        return true;
    } catch (error) {
        log.error(`Pairing request failed: ${describeError(error)}`);
        authentication.update({ state: 'error', error: 'Pairing request failed. Check the number and try again.' });
        return false;
    }
};
