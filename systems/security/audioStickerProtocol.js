import { createRequire } from 'node:module';
import { proto } from 'baileys';
import { child } from '../../core/logger.js';

/**
 * Sound stickers sent from the WhatsApp app arrive wrapped as
 * Message.audioStickerMessage (field 134, a FutureProofMessage holding the
 * stickerMessage with its audio, field 26). The pinned Baileys codec predates
 * field 134 and silently drops it, so such stickers looked empty.
 * This app-owned adapter adds that one field to Message encode/decode/fromObject/toObject.
 * Schema: wppconnect-team/wa-proto (2026-11-27). Nothing changes when the codec knows it.
 */

const require = createRequire(import.meta.resolve('baileys'));
const { Reader } = require('protobufjs/minimal');
const FIELD = 134;
const TAG = (FIELD << 3) | 2; // 1074
const MARK = Symbol.for('neo.audioStickerField');
let ready = false;

export function installAudioStickerProtocol() {
    if (ready) return true;
    const M = proto.Message;
    const F = proto.Message.FutureProofMessage;
    if (typeof M?.decode !== 'function' || typeof F?.decode !== 'function') return false;
    if (M.decode[MARK]) return (ready = true);
    // Already supported by the codec: leave it alone.
    if (M.fromObject({ audioStickerMessage: { message: {} } }).audioStickerMessage) return (ready = true);
    const original = { encode: M.encode, decode: M.decode, fromObject: M.fromObject, toObject: M.toObject };

    M.encode = function (value, writer) {
        const out = original.encode.call(this, value, writer);
        if (value?.audioStickerMessage != null) F.encode(value.audioStickerMessage, out.uint32(TAG).fork()).ldelim();
        return out;
    };
    const decode = function (input, length, ...rest) {
        const reader = input instanceof Reader ? input : Reader.create(input);
        const start = reader.pos;
        const out = original.decode.call(this, reader, length, ...rest);
        const scan = Reader.create(reader.buf.subarray(start, reader.pos));
        while (scan.pos < scan.len) {
            const tag = scan.uint32();
            if (tag === TAG) out.audioStickerMessage = F.decode(scan, scan.uint32());
            else scan.skipType(tag & 7);
        }
        return out;
    };
    decode[MARK] = true;
    M.decode = decode;
    M.fromObject = function (value) {
        const out = original.fromObject.call(this, value);
        if (value?.audioStickerMessage != null) out.audioStickerMessage = F.fromObject(value.audioStickerMessage);
        return out;
    };
    M.toObject = function (value, options) {
        const out = original.toObject.call(this, value, options);
        if (value?.audioStickerMessage != null) out.audioStickerMessage = F.toObject(value.audioStickerMessage, options);
        return out;
    };
    return (ready = true);
}

export const audioStickerReady = () => ready;
child('audio-sticker-codec').info({ ready: installAudioStickerProtocol() }, 'Audio sticker wrapper codec initialized.');
