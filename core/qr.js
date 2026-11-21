import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import authentication from './authentication.js';
import { child } from './logger.js';

const log = child('qr');

/**
 * Renders QR codes received from connection.update.
 * Terminal: qrcode-terminal. Cloud: PNG data URL exposed to the setup page.
 */
let qrCount = 0;

export const handleQr = async (qr) => {
    qrCount += 1;
    log.info({ attempt: qrCount }, qrCount === 1 ? 'QR code generated.' : 'QR code refreshed (previous one expired).');

    if (authentication.hasTerminal) {
        console.log('\n[ NEO BOT ] Scan this QR code:');
        console.log('Open WhatsApp → Settings → Linked Devices → Link a Device.\n');
        qrcodeTerminal.generate(qr, { small: true });
    }

    try {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
        authentication.update({ state: 'qr_ready', method: 'qr', qrDataUrl, error: null });
    } catch (error) {
        log.error('Failed to render QR image.');
        authentication.update({ state: 'error', error: 'Failed to render QR image.' });
    }
};

export const resetQr = () => {
    qrCount = 0;
};
