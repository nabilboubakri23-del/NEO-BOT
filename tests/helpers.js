// Shared offline test doubles: an in-memory database backend, a fake socket and message factory.
import crypto from 'node:crypto';

process.env.SESSION_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'silent';
process.env.MONGODB_URI = '';

const { FileBackend } = await import('../systems/database/docStore.js');

export class MemoryBackend extends FileBackend {
    kind = 'memory';
    store = new Map();
    async init() {}
    async read(name) { return this.store.get(name); }
    async write(name, data) { this.store.set(name, structuredClone(data)); }
}

export const OWNER = '212721063675';
export const GROUP = '120363000000000000@g.us';
export const ADMIN = '212611111111';
export const MEMBER = '212622222222';

/** Fake socket: records sends and WhatsApp calls. `admins` lists numbers (and 'bot'). */
export const fakeSock = ({ admins = [], pending = [] } = {}) => {
    const sent = [];
    const calls = [];
    const record = (name) => async (...args) => { calls.push({ name, args }); return name === 'groupParticipantsUpdate' ? args[1].map((jid) => ({ jid, status: '200' })) : undefined; };
    return {
        sent,
        calls,
        user: { id: '212700000000:5@s.whatsapp.net', lid: '99999:5@lid' },
        sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: crypto.randomUUID() } }; },
        relayMessage: async (jid, msg) => { sent.push({ jid, relay: msg }); return 'id'; },
        sendPresenceUpdate: async () => {},
        waUploadToServer: async () => ({}),
        groupMetadata: async (jid) => ({
            id: jid,
            subject: 'Test Group',
            participants: [
                { id: '11111@lid', phoneNumber: `${ADMIN}@s.whatsapp.net`, admin: admins.includes(ADMIN) ? 'admin' : null },
                { id: '22222@lid', phoneNumber: `${MEMBER}@s.whatsapp.net`, admin: null },
                { id: '33333@lid', phoneNumber: '212633333333@s.whatsapp.net', admin: null },
                { id: '99999@lid', phoneNumber: '212700000000@s.whatsapp.net', admin: admins.includes('bot') ? 'admin' : null }
            ]
        }),
        groupParticipantsUpdate: record('groupParticipantsUpdate'),
        groupSettingUpdate: record('groupSettingUpdate'),
        groupUpdateSubject: record('groupUpdateSubject'),
        groupUpdateDescription: record('groupUpdateDescription'),
        groupInviteCode: async () => 'ABCDEFGHIJKL',
        groupRevokeInvite: async () => 'NEWCODE12345',
        groupRequestParticipantsList: async () => pending,
        groupRequestParticipantsUpdate: async (jid, list, action) => { calls.push({ name: 'groupRequestParticipantsUpdate', args: [jid, list, action] }); return list.map((j) => ({ jid: j, status: '200' })); }
    };
};

/** Serialized NEO message as core/messageHandler.js would build it. */
export const msg = (sock, text, { number = MEMBER, lid = '', group = false, mentions = [], quoted = null, type = 'conversation', selectionId = null } = {}) => {
    const chat = group ? GROUP : `${number}@s.whatsapp.net`;
    const key = { id: crypto.randomUUID(), remoteJid: chat, fromMe: false, ...(group ? { participant: `${number}@s.whatsapp.net` } : {}) };
    return {
        raw: { key, message: { conversation: text } },
        id: key.id,
        chat,
        isGroup: group,
        sender: `${number}@s.whatsapp.net`,
        fromMe: false,
        senderNumber: number,
        senderLid: lid,
        pushName: 'Tester',
        type,
        text,
        selectionId,
        mentions,
        quoted,
        receivedAt: Date.now(),
        reply: (p) => sock.sendMessage(chat, typeof p === 'string' ? { text: p } : p),
        react: async () => {}
    };
};

export const lastText = (sock) => sock.sent.at(-1)?.content?.text || '';
export const allText = (sock) => sock.sent.map((s) => s.content?.text || JSON.stringify(s.relay || '')).join('\n');
