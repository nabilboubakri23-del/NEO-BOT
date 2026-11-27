import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proto, generateWAMessageFromContent } from 'baileys';
import { CHAT_THEME_SETTING, chatThemeReady } from '../systems/security/chatThemeProtocol.js';
import { argb, darker, solidTheme, clearTheme, defaultTheme } from '../systems/groups/chatTheme.js';

test('colour helpers give opaque ARGB and a darker night shade', () => {
 assert.equal(argb('1E88E5'), 0xff1e88e5);
 assert.equal(darker('FFFFFF', 0.5), '808080');
 const t = solidTheme('1E88E5', { now: 5 });
 assert.equal(t.solidColor.backgroundLightArgb, 0xff1e88e5);
 assert.equal(t.solidColor.isDoodleEnabled, false);
 assert.equal(t.settingTimestampMs, 5);
});

test('CHAT_THEME_SETTING (34) survives Baileys encode/decode with field 30', () => {
 assert.equal(chatThemeReady(), true);
 for (const setting of [solidTheme('E53935', { doodles: true, now: 1 }), clearTheme({ now: 2 }), defaultTheme({ now: 3 })]) {
  const msg = generateWAMessageFromContent('1@s.whatsapp.net', { protocolMessage: { type: CHAT_THEME_SETTING, chatThemeSetting: setting } }, { userJid: '2@s.whatsapp.net' });
  const bytes = proto.Message.encode(msg.message).finish();
  assert.ok(bytes.includes(0xf2)); // field 30, wire type 2 → tag 242 (varint f2 01)
  const back = proto.Message.decode(bytes).protocolMessage;
  assert.equal(back.type, 34);
  assert.equal(Number(back.chatThemeSetting.settingTimestampMs), setting.settingTimestampMs);
  if (setting.clearTheme) assert.equal(back.chatThemeSetting.clearTheme, true);
  if (setting.solidColor) assert.equal(back.chatThemeSetting.solidColor.backgroundLightArgb, setting.solidColor.backgroundLightArgb);
 }
});

test('ordinary protocol messages encode exactly as before', () => {
 const plain = { protocolMessage: { type: 0, key: { id: 'ABC', remoteJid: '1@s.whatsapp.net', fromMe: true } } };
 const bytes = proto.Message.encode(proto.Message.fromObject(plain)).finish();
 assert.equal(proto.Message.decode(bytes).protocolMessage.chatThemeSetting, undefined);
});
