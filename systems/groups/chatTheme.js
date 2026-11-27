import { generateWAMessageFromContent, prepareWAMessageMedia } from 'baileys';
import { CHAT_THEME_SETTING, chatThemeReady } from '../security/chatThemeProtocol.js';
import { UserError } from '../../utils/errors.js';

/**
 * Shared chat theme for everyone in a chat or group (WhatsApp 2.26.46.x feature):
 * the same wallpaper on every member's screen. Only clients that already have the
 * feature apply it; older apps ignore the message.
 */

/** "RRGGBB" → ARGB uint32 (opaque). */
export const argb = (hex) => (0xff000000 | parseInt(hex, 16)) >>> 0;

/** A darker shade for dark mode, so the same colour stays readable at night. */
export const darker = (hex, factor = 0.45) => [0, 2, 4]
    .map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * factor).toString(16).padStart(2, '0'))
    .join('').toUpperCase();

export const solidTheme = (hex, { doodles = false, now = Date.now() } = {}) => ({
    settingTimestampMs: now,
    solidColor: {
        backgroundLightArgb: argb(hex),
        backgroundDarkArgb: argb(darker(hex)),
        isDoodleEnabled: doodles,
        ...(doodles ? { doodleLightArgb: argb(darker(hex, 0.8)), doodleDarkArgb: argb(darker(hex, 0.3)) } : {})
    }
});
export const defaultTheme = ({ now = Date.now() } = {}) => ({ settingTimestampMs: now, defaultWallpaper: { isDoodleEnabled: true } });
export const clearTheme = ({ now = Date.now() } = {}) => ({ settingTimestampMs: now, clearTheme: true });

/** Upload an image as an encrypted wallpaper (image media keys) → customImage theme. */
export const imageTheme = async (sock, buffer, { dim = 0, now = Date.now() } = {}) => {
    const media = await prepareWAMessageMedia({ image: buffer }, { upload: sock.waUploadToServer });
    const img = media?.imageMessage;
    if (!img?.directPath || !img.mediaKey) throw new UserError('⚠️ Could not upload the wallpaper. Try again.');
    return {
        settingTimestampMs: now,
        customImage: { directPath: img.directPath, mediaKey: img.mediaKey, fileEncSha256: img.fileEncSha256, fileSha256: img.fileSha256, dimLevel: dim }
    };
};

/** Send the theme to the chat as a CHAT_THEME_SETTING protocol message. */
export const sendChatTheme = async (sock, chat, setting) => {
    if (!chatThemeReady()) throw new UserError('⚠️ Chat themes are not supported by this bot build.');
    const content = { protocolMessage: { type: CHAT_THEME_SETTING, chatThemeSetting: setting } };
    const msg = generateWAMessageFromContent(chat, content, { userJid: sock.user?.id });
    await sock.relayMessage(chat, msg.message, { messageId: msg.key.id });
    return msg;
};
