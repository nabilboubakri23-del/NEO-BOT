// Download commands: URL guards, pure parsers, cobalt mapping, loader registration. Offline.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';

const lib = await import('../commands/download/.lib.js');
const docStore = (await import('../systems/database/docStore.js')).default;
const { MemoryBackend } = await import('./helpers.js');
const commandHandler = (await import('../core/commandHandler.js')).default;
const { CommandHandler } = await import('../core/commandHandler.js');

const YT = await import('../commands/download/youtube.js');
const tiktok = (await import('../commands/download/tiktok.js')).default;
const instagram = (await import('../commands/download/instagram.js')).default;
const facebook = (await import('../commands/download/facebook.js')).default;
const spotify = (await import('../commands/download/spotify.js')).default;
const mediafire = (await import('../commands/download/mediafire.js')).default;
const app = (await import('../commands/download/app.js')).default;

before(async () => {
    await docStore.init(new MemoryBackend());
});

test('download modules are valid command definitions', () => {
    const modules = [...YT.default, tiktok, instagram, facebook, spotify, mediafire, app];
    assert.equal(modules.length, 9);
    for (const mod of modules) assert.deepEqual(CommandHandler.validate(mod), [], mod.name);
    assert.equal(new Set(modules.map((m) => m.name)).size, modules.length);
    // every download command is public, rate-limited and in the download category
    for (const mod of modules) {
        assert.equal(mod.permission, 'public', mod.name);
        assert.equal(mod.category, 'download', mod.name);
        assert.ok(mod.cooldown >= 20, mod.name);
    }
});

test('loader registers download commands, skips the dotfile library, no failures', async () => {
    const result = await commandHandler.load();
    assert.deepEqual(result.failures, []);
    for (const name of ['yt', 'ytmp3', 'play', 'tiktok', 'instagram', 'facebook', 'spotify', 'mediafire', 'app']) {
        assert.ok(commandHandler.get(name), name);
    }
    // arabic aliases resolve
    for (const alias of ['يوتيوب', 'تيكتوك', 'تيك', 'انستا', 'فيسبوك', 'فيس', 'سبوتيفاي', 'ميديافاير', 'تطبيق', 'شغل']) {
        assert.ok(commandHandler.get(alias), alias);
    }
    // dotfile helper never became a command
    assert.equal(commandHandler.get('.lib'), undefined);
    assert.equal(commandHandler.get('lib'), undefined);
});

test('assertUrl: strict host allowlist, https only', () => {
    assert.equal(lib.assertUrl('https://youtu.be/abc', ['youtu.be'], 'link'), 'https://youtu.be/abc');
    assert.equal(lib.assertUrl('https://www.tiktok.com/@u/video/1', ['tiktok.com'], 'link'), 'https://www.tiktok.com/@u/video/1');
    assert.throws(() => lib.assertUrl('http://youtu.be/abc', ['youtu.be'], 'link'), /https/);
    assert.throws(() => lib.assertUrl('https://evil-youtube.com/x', ['youtube.com'], 'link'), /not a youtube\.com/);
    assert.throws(() => lib.assertUrl('https://youtube.com.evil.tld/x', ['youtube.com'], 'link'));
    assert.throws(() => lib.assertUrl('https://127.0.0.1/x', ['youtube.com'], 'link'), /not allowed/);
    assert.throws(() => lib.assertUrl('https://user:pass@youtube.com/x', ['youtube.com'], 'link'), /not allowed/);
    assert.throws(() => lib.assertUrl('https://youtube.com:8443/x', ['youtube.com'], 'link'), /not allowed/);
    assert.throws(() => lib.assertUrl('https://localhost/x', ['youtube.com'], 'link'), /not allowed/);
    assert.throws(() => lib.assertUrl('not a url', ['youtube.com'], 'link'), /not a valid URL/);
});

test('parseSsstik: no-watermark video and audio links, author', () => {
    const html = `
        <h2>Scout, Suki &amp; Stella</h2>
        <p class="maintext">original sound</p>
        <a id="hd_download" data-directurl="/abc?url=x" class="ssr-btn ssr-btn-hd">HD</a>
        <a href="https://tikcdn.io/ssstik/6718335390845095173?st=abc&e=1" class="ssr-btn ssr-btn-second download_link without_watermark vignette_active">Without watermark</a>
        <a href="https://tikcdn.io/ssstik/m/aHR0cHM6" class="ssr-btn ssr-btn-mp3 download_link music vignette_active">Music</a>`;
    const r = lib.parseSsstik(html);
    assert.equal(r.videoUrl, 'https://tikcdn.io/ssstik/6718335390845095173?st=abc&e=1');
    assert.equal(r.audioUrl, 'https://tikcdn.io/ssstik/m/aHR0cHM6');
    assert.equal(r.author, 'Scout, Suki &amp; Stella');
    assert.equal(lib.parseSsstik('<div>error</div>').videoUrl, '');
});

test('parseMediafire: download button link and filename', () => {
    const html = `
        <div class="filename">pack-v2.zip</div>
        <a id="downloadButton" class="input popsok" href="https://download1234.mediafire.com/abcd/pack-v2.zip" data-filename="pack-v2.zip">Download</a>`;
    const r = lib.parseMediafire(html);
    assert.equal(r.url, 'https://download1234.mediafire.com/abcd/pack-v2.zip');
    assert.equal(r.name, 'pack-v2.zip');
    assert.equal(lib.parseMediafire('<html>error page</html>'), null);
    // non-https button links are rejected
    assert.equal(lib.parseMediafire('<a id="downloadButton" href="http://x/y.zip">'), null);
});

test('parseYtSearch: unique video ids in order', () => {
    const html = '{"videoId":"dQw4w9WgXcQ"},{"videoId":"dQw4w9WgXcQ"},{"videoId":"abcDEF12345"}';
    assert.deepEqual(lib.parseYtSearch(html), ['dQw4w9WgXcQ', 'abcDEF12345']);
    assert.deepEqual(lib.parseYtSearch('no ids here'), []);
});

test('parseSpotifyTrack: track ids incl. intl urls; albums rejected', () => {
    assert.equal(lib.parseSpotifyTrack('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'), '4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(lib.parseSpotifyTrack('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=xyz'), '4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(lib.parseSpotifyTrack('https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC'), '4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(lib.parseSpotifyTrack('https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC'), null);
});

test('pickApps: clean fields, trusted flag, https filter', () => {
    const data = {
        datalist: {
            list: [
                { name: 'WhatsApp Messenger', package: 'com.whatsapp', size: 100, file: { vername: '2.26.45.71', filesize: 158269678, path: 'https://pool.apk.aptoide.com/x.apk', malware: { rank: 'TRUSTED' } }, stats: { downloads: 5000000000 } },
                { name: 'Sketchy Clone', package: 'com.clone', file: { vername: '1.0', path: 'https://pool.apk.aptoide.com/y.apk', malware: { rank: 'UNKNOWN' } } },
                { name: 'Bad Link', package: 'com.bad', file: { vername: '1.0', path: 'http://insecure/x.apk' } }
            ]
        }
    };
    const apps = lib.pickApps(data);
    assert.equal(apps.length, 2); // insecure link dropped
    assert.equal(apps[0].name, 'WhatsApp Messenger');
    assert.equal(apps[0].trusted, true);
    assert.equal(apps[1].trusted, false);
    assert.deepEqual(lib.pickApps({}), []);
});

test('interpretCobalt: tunnel, picker, error mapping', () => {
    const file = lib.interpretCobalt({ status: 'tunnel', url: 'https://dl.example.com/tunnel/abc', filename: 'song.mp3' });
    assert.deepEqual(file, { kind: 'file', url: 'https://dl.example.com/tunnel/abc', fileName: 'song.mp3' });

    const picker = lib.interpretCobalt({ status: 'picker', picker: [{ type: 'video', url: 'https://cdn.example.com/v.mp4' }, { type: 'photo', url: 'https://cdn.example.com/p.jpg' }, { type: 'photo', url: 'http://bad' }] });
    assert.equal(picker.kind, 'picker');
    assert.equal(picker.items.length, 2);
    assert.equal(picker.items[0].type, 'video');

    assert.throws(() => lib.interpretCobalt({ status: 'error', error: { code: 'error.api.rate_exceeded' } }), /limit reached/);
    assert.throws(() => lib.interpretCobalt({ status: 'error', error: { code: 'error.api.link.invalid' } }), /not valid/);
    assert.throws(() => lib.interpretCobalt({ status: 'unknown' }), /unexpected way/);
    assert.throws(() => lib.interpretCobalt(null), /unexpected way/);
    // never trust non-https urls from a backend answer
    assert.throws(() => lib.interpretCobalt({ status: 'tunnel', url: 'http://insecure/x' }), /unexpected way/);
});

test('cobaltDownload: honest error when the backend is not configured', async () => {
    delete process.env.DOWNLOAD_API_BASE;
    assert.equal(lib.isCobaltConfigured(), false);
    await assert.rejects(() => lib.cobaltDownload('https://youtu.be/x'), /not enabled yet/);
});

test('sanitizeFilename: strips path and control characters', () => {
    assert.equal(lib.sanitizeFilename('a/b\\c:d*e?"f<>g'), 'a b c d e f g');
    assert.equal(lib.sanitizeFilename(''), 'download');
    assert.ok(lib.sanitizeFilename('x'.repeat(500)).length <= 100);
});
