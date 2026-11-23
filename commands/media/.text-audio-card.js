import { generateWAMessageFromContent, prepareWAMessageMedia, proto } from 'baileys';

// One interactive card, not an ordinary text bubble or a button that sends
// another audio message. Client rendering/playback still needs verification.
export function buildTextAudioCard(sock, jid, text, audioMessage) {
    const content = proto.Message.fromObject({
        interactiveMessage: {
            body: { text },
            footer: { audioMessage, hasMediaAttachment: true },
            nativeFlowMessage: { buttons: [], messageParamsJson: '{}' }
        }
    });
    return generateWAMessageFromContent(jid, content, { userJid: sock.user.id });
}

export async function sendTextAudioCard(sock, jid, text, audio) {
    const prepared = await prepareWAMessageMedia({
        audio, mimetype: 'audio/ogg; codecs=opus', seconds: 1,
        ptt: false, waveform: Buffer.alloc(64)
    }, { upload: sock.waUploadToServer, mediaUploadTimeoutMs: 20000 });
    if (!prepared.audioMessage) throw new Error('Audio preparation returned no audio message.');
    const built = buildTextAudioCard(sock, jid, text, prepared.audioMessage);
    // Current pinned relay adds the native_flow business node itself. Do not
    // append a second copy, and do not fall back to a separate audio message.
    await sock.relayMessage(jid, built.message, { messageId: built.key.id });
    return built;
}
