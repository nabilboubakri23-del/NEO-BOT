import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { proto } from 'baileys';
import { child } from '../../core/logger.js';

const require = createRequire(import.meta.resolve('baileys'));
const { Reader } = require('protobufjs/minimal');
const expected = {
    encode: 'c800e5f69f3ec1d4055ee1f4cb906dbd667b79fcda6c49901b644914f17725df',
    decode: '17ab824a964ee391fb39111e029cc42894d99f60dfd074fa0ee2b74d153aa65e',
    fromObject: 'bdf27c789d2e6bca8e38a15effd96a697c7774c7ed0bd79f12e795354d10e28f',
    toObject: '7447d631622667ccd1f5ec07532c193972e24820bd4382da5e0cd3626e458b61'
};
let ready = false;

// App-owned compatibility adapter for the pinned codec, not a dependency update.
// Unknown codec versions stay untouched. Only embedded sticker audio (field 26)
// is extended; no new top-level wrapper, cryptography or retry store is added.
export function installStickerAudioProtocol() {
    if (ready) return true;
    const T = proto.Message.StickerMessage;
    const A = proto.Message.AudioMessage;
    const original = Object.fromEntries(Object.keys(expected).map((k) => [k, T[k]]));
    if (!Object.keys(expected).every((k) => typeof original[k] === 'function' &&
        createHash('sha256').update(String(original[k])).digest('hex') === expected[k])) return false;
    T.encode = function (value, writer) {
        const out = original.encode.call(this, value, writer);
        if (value.audioMessage != null) A.encode(value.audioMessage, out.uint32(210).fork()).ldelim();
        return out;
    };
    T.decode = function (input, length, ...rest) {
        const reader = input instanceof Reader ? input : Reader.create(input);
        const start = reader.pos;
        const out = original.decode.call(this, reader, length, ...rest);
        const scan = Reader.create(reader.buf.subarray(start, reader.pos));
        const seen = [];
        while (scan.pos < scan.len) {
            const tag = scan.uint32();
            if (!seen.includes(tag >>> 3)) seen.push(tag >>> 3);
            if ((tag >>> 3) === 26) {
                if ((tag & 7) !== 2) throw new Error('Invalid embedded sticker audio wire type.');
                out.audioMessage = A.decode(scan, scan.uint32());
            } else scan.skipType(tag & 7);
        }
        try { Object.defineProperty(out, Symbol.for('neo.wireFields'), { value: seen, enumerable: false }); } catch { /* diagnostics only */ }
        return out;
    };
    T.fromObject = function (value) {
        const out = original.fromObject.call(this, value);
        if (value.audioMessage != null) out.audioMessage = A.fromObject(value.audioMessage);
        return out;
    };
    T.toObject = function (value, options) {
        const out = original.toObject.call(this, value, options);
        if (value.audioMessage != null) out.audioMessage = A.toObject(value.audioMessage, options);
        return out;
    };
    ready = true;
    return true;
}
export const stickerAudioReady = () => ready;
child('sound-sticker-codec').info({ ready: installStickerAudioProtocol() }, 'Sound sticker codec initialized.');
