import { createRequire } from 'node:module';
import { proto } from 'baileys';
import { child } from '../../core/logger.js';

const require = createRequire(import.meta.resolve('baileys'));
const protobuf = require('protobufjs');

/**
 * Shared chat themes (WhatsApp 2.26.46.x): ProtocolMessage type CHAT_THEME_SETTING (34)
 * carrying chatThemeSetting (field 30). The pinned Baileys codec predates it, so this
 * app-owned adapter adds that one field to ProtocolMessage encode/decode/fromObject.
 * Schema from the WhatsApp web proto (wppconnect-team/wa-proto, 2026-11-27).
 * Nothing changes when the codec already knows the field.
 */
export const CHAT_THEME_SETTING = 34;
const FIELD = 30;

const root = protobuf.Root.fromJSON({
    nested: {
        ChatDefaultWallpaper: { fields: { isDoodleEnabled: { type: 'bool', id: 1 } } },
        ChatSolidColorWallpaper: { fields: {
            backgroundLightArgb: { type: 'fixed32', id: 1 }, backgroundDarkArgb: { type: 'fixed32', id: 2 },
            isDoodleEnabled: { type: 'bool', id: 3 }, doodleLightArgb: { type: 'fixed32', id: 4 }, doodleDarkArgb: { type: 'fixed32', id: 5 }
        } },
        ChatStockImageWallpaper: { fields: { stockImageId: { type: 'string', id: 1 }, dimLevel: { type: 'float', id: 2 } } },
        ChatCustomImageWallpaper: { fields: {
            directPath: { type: 'string', id: 1 }, mediaKey: { type: 'bytes', id: 2 }, fileEncSha256: { type: 'bytes', id: 3 },
            fileSha256: { type: 'bytes', id: 4 }, dimLevel: { type: 'float', id: 5 }
        } },
        ChatAnimatedWallpaper: { fields: { animatedWallpaperId: { type: 'string', id: 1 }, dimLevel: { type: 'float', id: 2 } } },
        ChatThemeSetting: {
            oneofs: { wallpaper: { oneof: ['defaultWallpaper', 'solidColor', 'stockImage', 'customImage', 'animatedWallpaper'] } },
            fields: {
                settingTimestampMs: { type: 'int64', id: 1 }, clearTheme: { type: 'bool', id: 2 }, colorSchemeId: { type: 'string', id: 3 },
                defaultWallpaper: { type: 'ChatDefaultWallpaper', id: 10 }, solidColor: { type: 'ChatSolidColorWallpaper', id: 11 },
                stockImage: { type: 'ChatStockImageWallpaper', id: 12 }, customImage: { type: 'ChatCustomImageWallpaper', id: 13 },
                animatedWallpaper: { type: 'ChatAnimatedWallpaper', id: 14 }
            }
        }
    }
});
export const ChatThemeSetting = root.lookupType('ChatThemeSetting');

let ready = false;
export function installChatThemeProtocol() {
    if (ready) return true;
    const P = proto.Message.ProtocolMessage;
    if (String(P.encode).includes('chatThemeSetting')) return (ready = true); // codec already supports it
    const { encode, decode, fromObject, toObject } = P;
    if (![encode, decode, fromObject, toObject].every((f) => typeof f === 'function')) return false;
    P.encode = function (value, writer) {
        const out = encode.call(this, value, writer);
        if (value?.chatThemeSetting != null) ChatThemeSetting.encode(ChatThemeSetting.fromObject(value.chatThemeSetting), out.uint32((FIELD << 3) | 2).fork()).ldelim();
        return out;
    };
    P.decode = function (input, length, ...rest) {
        const reader = input instanceof protobuf.Reader ? input : protobuf.Reader.create(input);
        const start = reader.pos;
        const out = decode.call(this, reader, length, ...rest);
        const scan = protobuf.Reader.create(reader.buf.subarray(start, reader.pos));
        while (scan.pos < scan.len) {
            const tag = scan.uint32();
            if ((tag >>> 3) === FIELD && (tag & 7) === 2) out.chatThemeSetting = ChatThemeSetting.decode(scan, scan.uint32());
            else scan.skipType(tag & 7);
        }
        return out;
    };
    P.fromObject = function (value) {
        const out = fromObject.call(this, value);
        if (value?.chatThemeSetting != null) out.chatThemeSetting = ChatThemeSetting.fromObject(value.chatThemeSetting);
        return out;
    };
    P.toObject = function (value, options) {
        const out = toObject.call(this, value, options);
        if (value?.chatThemeSetting != null) out.chatThemeSetting = ChatThemeSetting.toObject(value.chatThemeSetting, options);
        return out;
    };
    ready = true;
    return true;
}
export const chatThemeReady = () => ready;
child('chat-theme-codec').info({ ready: installChatThemeProtocol() }, 'Chat theme codec initialized.');
