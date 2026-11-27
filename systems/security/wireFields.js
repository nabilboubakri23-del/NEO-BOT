import { createRequire } from 'node:module';
import { proto } from 'baileys';

/**
 * Diagnostics only: remembers which top-level protobuf field numbers a decoded
 * WhatsApp Message carried on the wire, including fields this library version does
 * not know (protobufjs drops those silently). Stored as a hidden property, so it
 * never changes encoding, logging or saved data.
 */

const require = createRequire(import.meta.resolve('baileys'));
const { Reader } = require('protobufjs/minimal');
const KEY = Symbol.for('neo.wireFields');

export const wireFields = (obj) => (obj && obj[KEY]) || null;

export const scanFields = (buf) => {
    const fields = [];
    const scan = Reader.create(buf);
    while (scan.pos < scan.len) {
        const tag = scan.uint32();
        const n = tag >>> 3;
        if (!fields.includes(n)) fields.push(n);
        scan.skipType(tag & 7);
    }
    return fields;
};

const M = proto.Message;
if (!M.decode[KEY]) {
    const original = M.decode;
    const wrapped = function (input, length, ...rest) {
        const out = original.call(this, input, length, ...rest);
        if (input instanceof Uint8Array && length === undefined && out && typeof out === 'object') {
            try { Object.defineProperty(out, KEY, { value: scanFields(input), enumerable: false }); } catch { /* diagnostics only */ }
        }
        return out;
    };
    wrapped[KEY] = true;
    M.decode = wrapped;
}
