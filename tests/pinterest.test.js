import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSock, msg } from './helpers.js';

const rankMod = await import('../commands/download/.pinterest-rank.js');
const api = await import('../commands/download/.pinterest-api.js');
const media = await import('../commands/download/.pinterest-media.js');
const carousel = await import('../systems/menus/carousel.js');
const pinterest = (await import('../commands/download/pinterest.js')).default;

const pin = (over = {}) => {
    const id = over.id || Math.random().toString(36).slice(2, 12);
    return {
    id,
    url: 'https://www.pinterest.com/pin/x/', kind: 'image', title: '', description: '', alt: '', board: '', author: '',
    hashtags: [], reactions: 10, saves: 0, width: 1080, height: 1920, signature: '', image: { preview: `https://i.pinimg.com/736x/${id}.jpg`, full: `https://i.pinimg.com/originals/${id}.jpg` },
    ...over
    };
};
const video = (over = {}) => pin({ kind: 'video', video: { hls: 'https://v1.pinimg.com/videos/iht/hls/a.m3u8', duration: 20, width: 720, height: 1280, thumbnail: '' }, ...over });

test('Pinterest normalize turns fancy unicode, accents and Arabic variants into plain search text', () => {
    assert.equal(rankMod.normalize('𝐍𝐚𝐫𝐮𝐭𝐨 𝑼𝒛𝒖𝒎𝒂𝒌𝒊'), 'naruto uzumaki');
    assert.equal(rankMod.normalize('Pokémon!'), 'pokemon');
    assert.equal(rankMod.normalize('أنمي'), 'انمي');
    assert.deepEqual(rankMod.subjectTerms('naruto edit wallpaper'), ['naruto']);
});

test('Pinterest relevance finds the subject in titles, hashtags and prefixes; flags off-topic pins', () => {
    assert.equal(rankMod.relevance(pin({ title: '𝐘𝐨𝐮𝐧𝐠 𝐍𝐚𝐫𝐮𝐭𝐨' }), 'naruto'), 1);
    assert.equal(rankMod.relevance(pin({ hashtags: ['narutouzumaki'] }), 'naruto'), 1);
    assert.equal(rankMod.relevance(pin({ title: 'chocolate cake recipe' }), 'naruto'), 0);
    assert.equal(rankMod.relevance(pin({ title: 'gojo satoru' }), 'غوجو'), 0.5); // cross-script: Pinterest decides
});

test('Pinterest classify separates edits from ordinary videos and images', () => {
    assert.equal(rankMod.classify(pin()).type, 'image');
    assert.equal(rankMod.classify(video({ title: 'Gojo', description: '#animeedit #edit', hashtags: ['animeedit', 'edit'] })).type, 'edit');
    assert.equal(rankMod.classify(video({ title: 'Easy pasta recipe tutorial', video: { hls: 'x', duration: 300 } })).type, 'video');
    assert.equal(rankMod.classify(video({ title: 'gojo amv velocity' })).type, 'edit');
});

test('Pinterest rank: mode filter, dedupe, popularity and relevance order, off-topic only as filler', () => {
    const pins = [
        pin({ id: 'a', title: 'cake', reactions: 9999 }),
        pin({ id: 'b', title: 'naruto', reactions: 5 }),
        pin({ id: 'c', title: 'naruto hokage', reactions: 5000 }),
        pin({ id: 'c', title: 'naruto hokage', reactions: 5000 }),
        pin({ id: 'd', title: 'naruto tiny', width: 200 }),
        video({ id: 'e', title: 'naruto edit', hashtags: ['edit'] }),
        pin({ id: 'f', title: 'naruto again', reactions: 3 })
    ];
    const images = rankMod.rank(pins, 'naruto', 'image', { want: 3 });
    assert.deepEqual(images.map((r) => r.pin.id), ['c', 'b', 'f']); // cake dropped, tiny dropped, video excluded
    const edits = rankMod.rank(pins, 'naruto', 'edit');
    assert.deepEqual(edits.map((r) => r.pin.id), ['e']);
    const few = rankMod.rank([pin({ id: 'x', title: 'cake' })], 'naruto', 'image');
    assert.equal(few[0].offTopic, true); // kept only because nothing better exists
    assert.equal(rankMod.searchQueryFor('gojo', 'edit'), 'gojo edit');
    assert.equal(rankMod.searchQueryFor('gojo amv', 'edit'), 'gojo amv');
});

test('Pinterest normalizePin keeps only safe pinimg URLs and finds story-pin videos', () => {
    const raw = {
        type: 'pin', id: '123456', title: 'Hi #edit', images: { orig: { url: 'https://i.pinimg.com/originals/a.jpg', width: 800, height: 600 }, '736x': { url: 'https://evil.example/x.jpg' } },
        story_pin_data: { pages: [{ blocks: [{ video: { video_list: { V_HLSV4: { url: 'https://v1.pinimg.com/videos/iht/hls/a.m3u8', duration: 12000, width: 720, height: 1280 } } } }] }] },
        reaction_counts: { 1: 5, 5: 2 }
    };
    const p = api.normalizePin(raw);
    assert.equal(p.kind, 'video');
    assert.equal(p.video.duration, 12);
    assert.equal(p.reactions, 7);
    assert.equal(p.image.preview, 'https://i.pinimg.com/originals/a.jpg');
    assert.deepEqual(p.hashtags, ['edit']);
    assert.equal(api.normalizePin({ ...raw, is_promoted: true }), null);
    assert.equal(api.normalizePin({ type: 'pin', id: '9', images: { orig: { url: 'http://i.pinimg.com/a.jpg' } } }), null);
});

test('Pinterest pin links: full, localized, slugged and short links; foreign hosts rejected', () => {
    assert.deepEqual(api.parsePinLink('look https://www.pinterest.com/pin/1001417667115104150/'), { id: '1001417667115104150' });
    assert.deepEqual(api.parsePinLink('https://fr.pinterest.com/pin/naruto-art--1001417667115104150/'), { id: '1001417667115104150' });
    assert.deepEqual(api.parsePinLink('https://pinterest.co.uk/pin/123456789/'), { id: '123456789' });
    assert.ok(api.parsePinLink('https://pin.it/4mXrJvq').short);
    assert.equal(api.parsePinLink('https://pinterest.evil.com/pin/123456/'), null);
    assert.equal(api.parsePinLink('naruto'), null);
});

test('Pinterest HLS parsing: variants sorted with labels, audio found, byte-range files deduped, foreign hosts refused', () => {
    const base = 'https://v1.pinimg.com/videos/iht/hls/ab/x.m3u8';
    const master = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="1",URI="x_audio.m3u8",CHANNELS="2"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=720x1280,AUDIO="audio"', 'x_720w.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=340000,RESOLUTION=240x426,AUDIO="audio"', 'x_240w.m3u8'
    ].join('\n');
    const parsed = media.parseMaster(master, base);
    assert.deepEqual(parsed.variants.map((v) => v.label), ['240p', '720p']);
    assert.equal(parsed.audio, 'https://v1.pinimg.com/videos/iht/hls/ab/x_audio.m3u8');
    const playlist = ['#EXTM3U', '#EXT-X-MAP:URI="x_720w.cmfv",BYTERANGE="1023@0"', '#EXTINF:2', '#EXT-X-BYTERANGE:100@1207', 'x_720w.cmfv', '#EXTINF:2', 'x_720w.cmfv'].join('\n');
    assert.deepEqual(media.parseMedia(playlist, base), ['https://v1.pinimg.com/videos/iht/hls/ab/x_720w.cmfv']);
    assert.throws(() => media.parseMedia('https://evil.example/a.ts', base), /unexpected/);
    assert.equal(media.previewVariant(parsed.variants).label, '720p');
    assert.equal(media.formatDuration(75), '1:15');
});

test('Carousel is relayed with the native_flow biz node (WhatsApp drops it otherwise)', async () => {
    const calls = [];
    const sock = { user: { id: '1@s.whatsapp.net' }, relayMessage: async (jid, message, opts) => { calls.push({ jid, message, opts }); return 'id'; } };
    await carousel.sendCarousel(sock, '2@s.whatsapp.net', {
        body: 'b', cards: [{ header: { hasMediaAttachment: true, imageMessage: { mimetype: 'image/jpeg' } }, body: 'x', buttons: [carousel.cardButton.reply('Go', 'pinterest:get:t:0'), carousel.cardButton.copy('Copy', 'https://p')] }]
    });
    assert.equal(calls[0].opts.additionalNodes[0].tag, 'biz');
    const card = calls[0].message.interactiveMessage.carouselMessage.cards[0];
    assert.equal(JSON.parse(card.nativeFlowMessage.buttons[1].buttonParamsJson).copy_code, 'https://p');
});

test('Pinterest home shows Images / Edits / Cancel; mode button waits for typed input; cancel invalidates', async () => {
    const sock = fakeSock();
    const m = msg(sock, '.pinterest');
    await pinterest.execute(sock, m, []);
    const buttons = sock.sent.at(-1).relay.interactiveMessage.nativeFlowMessage.buttons.map((b) => JSON.parse(b.buttonParamsJson));
    assert.deepEqual(buttons.map((b) => b.display_text), ['🖼️ Images', '🎬 Edits', '↩️ Back / Cancel']);
    const parts = buttons[1].id.split(':').slice(1);
    await pinterest.onSelect(sock, m, parts);
    assert.match(sock.sent.at(-1).relay.interactiveMessage.body.text, /Type the character/);
    await pinterest.onSelect(sock, m, ['cancel', parts[1]]);
    assert.match(sock.sent.at(-1).content.text, /closed/);
    await assert.rejects(() => pinterest.onSelect(sock, m, ['get', parts[1], '0']), /expired/);
    await assert.rejects(() => pinterest.execute(sock, m, ['x'], { argsText: 'x' }), /2 to 100/);
});
