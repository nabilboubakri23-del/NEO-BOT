import { jidNormalizedUser } from 'baileys';
import { SendGovernor, applySendGovernor, SendDroppedError } from './sendGovernor.js';
import { isOwner } from '../owners/ownerStore.js';
import { getUser } from '../users/userStore.js';
import { getSetting } from '../settings/settingsStore.js';

/** The bot's single send governor. People the bot already knows may get private messages. */
const governor = new SendGovernor(undefined, {
    // ANTIBAN_ENABLED=false turns it off for good; the "antiban" setting switches it from WhatsApp.
    isEnabled: () => getSetting('antiban') !== false,
    isTrusted: (jid) => {
        const id = jidNormalizedUser(jid).split('@')[0];
        const who = jid.endsWith('@lid') ? { lid: id } : { number: id };
        return Boolean(getUser(who)) || isOwner({ senderNumber: who.number || '', senderLid: who.lid || '' });
    }
});

export default governor;
export { applySendGovernor, SendDroppedError };
