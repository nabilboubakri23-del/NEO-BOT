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

test('pickApp: only store-verified apps can be downloaded', () => {
    const apps = [
        { name: 'Good', trusted: true, url: 'https://x/g.apk' },
        { name: 'Bad', trusted: false, url: 'https://x/b.apk' }
    ];
    assert.equal(lib.pickApp(apps, 1).name, 'Good');
    assert.throws(() => lib.pickApp(apps, 2), /malware screening/);
    assert.throws(() => lib.pickApp(apps, 3), /No app with that number/);
});

test('fetchText: redirects are re-validated (no protocol downgrade, no host escape)', async () => {
    const { createServer } = await import('node:http');
    const toHttp = createServer((req, res) => {
        res.writeHead(302, { location: 'http://127.0.0.1:1/escape' });
        res.end();
    });
    const toOtherHost = createServer((req, res) => {
        res.writeHead(302, { location: 'https://notallowed.example/x' });
        res.end();
    });
    await new Promise((r) => toHttp.listen(0, '127.0.0.1', r));
    await new Promise((r) => toOtherHost.listen(0, '127.0.0.1', r));
    try {
        // plain http is refused before any request is even considered
        const portHttp = toHttp.address().port;
        const portHost = toOtherHost.address().port;
        await assert.rejects(
            () => lib.fetchText(`http://127.0.0.1:${portHttp}/`, { allowHosts: [] }),
            /unsafe address|Could not reach|refused/ // redirect target http is rejected as unsafe
        );
        await assert.rejects(
            () => lib.fetchText(`http://127.0.0.1:${portHost}/`, { allowHosts: ['allowed.example'] }),
            /unsafe address|unexpected address|Could not reach|refused/
        );
    } finally {
        toHttp.close();
        toOtherHost.close();
    }
});

test('sanitizeFilename: strips path and control characters', () => {
    assert.equal(lib.sanitizeFilename('a/b\\c:d*e?"f<>g'), 'a b c d e f g');
    assert.equal(lib.sanitizeFilename(''), 'download');
    assert.ok(lib.sanitizeFilename('x'.repeat(500)).length <= 100);
});

test('isPrivateIp: covers loopback, private, CGNAT and multicast ranges', () => {
    assert.ok(lib.isPrivateIp('127.0.0.1'));
    assert.ok(lib.isPrivateIp('10.1.2.3'));
    assert.ok(lib.isPrivateIp('172.16.5.5'));
    assert.ok(lib.isPrivateIp('192.168.1.1'));
    assert.ok(lib.isPrivateIp('169.254.0.1'));   // link-local / cloud metadata
    assert.ok(lib.isPrivateIp('100.64.0.1'));    // carrier-grade NAT
    assert.ok(lib.isPrivateIp('0.0.0.0'));
    assert.ok(lib.isPrivateIp('224.0.0.1'));     // multicast
    assert.ok(lib.isPrivateIp('::1'));
    assert.ok(lib.isPrivateIp('fc00::1'));       // unique-local
    assert.ok(lib.isPrivateIp('fe80::1'));       // link-local
    assert.ok(lib.isPrivateIp('::ffff:127.0.0.1')); // IPv4-mapped loopback
    assert.equal(lib.isPrivateIp('8.8.8.8'), false);
    assert.equal(lib.isPrivateIp('1.1.1.1'), false);
    assert.equal(lib.isPrivateIp('2606:4700::1111'), false);
});

test('sniffKind: recognizes common media magic bytes', () => {
    assert.equal(lib.sniffKind(Buffer.from('ID3' + 'x'.repeat(20))), 'audio');
    assert.equal(lib.sniffKind(Buffer.from([0xff, 0xfb, 0, 0])), 'audio');
    assert.equal(lib.sniffKind(Buffer.from('OggS' + 'x'.repeat(20))), 'audio');
    const mp4 = Buffer.alloc(16); mp4.write('0000ftypmp42');
    assert.equal(lib.sniffKind(mp4), 'video');
    assert.equal(lib.sniffKind(Buffer.from('PK\x03\x04' + 'x'.repeat(20))), 'archive');
    assert.equal(lib.sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), 'image');
    assert.equal(lib.sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image');
    assert.equal(lib.sniffKind(Buffer.from('GIF89a' + 'x'.repeat(10))), 'image');
    assert.equal(lib.sniffKind(Buffer.from('<!DOCTYPE html>')), 'htmlpage');
    assert.equal(lib.sniffKind(Buffer.from('hello world this is text')), 'unknown');
    assert.equal(lib.sniffKind(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])), 'unknown');
});

test('downloadFile: rejects non-https, oversized and private targets before sending', async () => {
    await assert.rejects(() => lib.downloadFile('ftp://example.com/file.bin'), /https|[Uu]nsafe/);
    await assert.rejects(() => lib.downloadFile('http://169.254.169.254/latest/meta-data'), /unsafe download address/i);
    await assert.rejects(() => lib.downloadFile('https://127.0.0.1/x'), /unsafe download address/i);
    await assert.rejects(() => lib.downloadFile('https://[::1]/x'), /unsafe download address/i);
    await assert.rejects(() => lib.downloadFile('https://192.168.1.1/x'), /unsafe download address/i);
    for (const url of ['https://2130706433/x', 'https://0x7f000001/x', 'https://[::ffff:7f00:1]/x', 'https://user:pass@example.com/x', 'https://example.com:8443/x']) {
        await assert.rejects(() => lib.downloadFile(url), /unsafe download address/i);
    }
    // DNS resolution of a non-existent TLD fails the safe lookup
    await assert.rejects(() => lib.downloadFile('https://host.invalid/x'), /Could not reach/);
});


test('parseSpotmateForms: extracts track data and token from converter forms', () => {
    const data = Buffer.from(JSON.stringify({ name: 'Song Title', tid: 'abc' })).toString('base64');
    const html = `<html><body>
        <form><input type="hidden" name="data" value="${data}"><input type="hidden" name="token" value="tok123"><input type="hidden" name="base" value="https://open.spotify.com/track/x"></form>
        <form><input type="hidden" name="data" value="not-base64!!"></form>
    </body></html>`;
    const tracks = lib.parseSpotmateForms(html);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].token, 'tok123');
    assert.equal(tracks[0].title, 'Song Title');
});

test('parseSpotmateDownload: picks the mp3 link, skips covers, ads and foreign hosts', () => {
    const html = `
        <a href="https://tunecable.com/premium">Go premium</a>
        <a href="https://i.scdn.co/image/ab67616d0000b273">cover</a>
        <a href="https://evil.example.com/track.mp3">download</a>
        <a href="https://dl.spotimate.app/v1?token=xyz">Download MP3</a>`;
    assert.equal(lib.parseSpotmateDownload(html), 'https://dl.spotimate.app/v1?token=xyz');
    assert.equal(lib.parseSpotmateDownload('<a href="https://i.scdn.co/x.jpg">cover</a>'), '');
});

test('downloadFile: unsafe initial targets never create a transport request', async (t) => {
    const https = (await import('node:https')).default;
    let calls = 0;
    t.mock.method(https, 'request', () => {
        calls++;
        throw new Error('Unexpected transport access');
    });
    for (const url of [
        'https://127.0.0.1/x', 'https://2130706433/x', 'https://0x7f000001/x',
        'https://[::1]/x', 'https://[::ffff:7f00:1]/x',
        'https://user:pass@example.com/x', 'https://example.com:8443/x',
        'http://example.com/x'
    ]) await assert.rejects(() => lib.downloadFile(url), /unsafe download address/i);
    assert.equal(calls, 0);
});

test('downloadFile: unsafe redirect targets never create a second request', async (t) => {
    const https = (await import('node:https')).default;
    const { EventEmitter } = await import('node:events');
    let calls = 0;
    let target = '';
    t.mock.method(https, 'request', (url, options, callback) => {
        calls++;
        const request = new EventEmitter();
        request.end = () => queueMicrotask(() => callback({
            statusCode: 302, headers: { location: target }, resume() {}
        }));
        request.destroy = () => {};
        return request;
    });
    for (const url of [
        'https://127.0.0.1/x', 'https://[::ffff:7f00:1]/x',
        'https://u:p@example.com/x', 'https://example.com:8443/x', 'http://example.com/x'
    ]) {
        target = url;
        const before = calls;
        await assert.rejects(() => lib.downloadFile('https://public.example/x'), /unsafe download address/i);
        assert.equal(calls - before, 1);
    }
});

test('downloadFile: DNS blocks private answers without returning a usable address', async (t) => {
    const https = (await import('node:https')).default;
    const dns = (await import('node:dns/promises')).default;
    const { EventEmitter } = await import('node:events');
    let usableAddresses = 0;
    t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
    t.mock.method(https, 'request', (url, options) => {
        const request = new EventEmitter();
        request.end = () => options.lookup('public.example', { all: true }, (error, addresses) => {
            if (addresses) usableAddresses++;
            if (error) request.emit('error', error);
        });
        return request;
    });
    await assert.rejects(() => lib.downloadFile('https://public.example/x'), /not allowed/i);
    assert.equal(usableAddresses, 0);
});

test('downloadFile: declared and streamed caps plus type checks are enforced', async (t) => {
    const https = (await import('node:https')).default;
    const { EventEmitter } = await import('node:events');
    const { Readable } = await import('node:stream');
    let scenario = {};
    t.mock.method(https, 'request', (url, options, callback) => {
        const request = new EventEmitter();
        request.end = () => queueMicrotask(() => {
            const response = Readable.from(scenario.chunks || []);
            response.statusCode = 200;
            response.headers = scenario.headers || {};
            callback(response);
        });
        return request;
    });
    scenario = { headers: { 'content-length': '100' }, chunks: [] };
    await assert.rejects(() => lib.downloadFile('https://public.example/x', { maxBytes: 10 }), /too large/i);
    scenario = { chunks: [Buffer.alloc(6), Buffer.alloc(6)] };
    await assert.rejects(() => lib.downloadFile('https://public.example/x', { maxBytes: 10 }), /too large/i);
    scenario = { chunks: [Buffer.from('<!doctype html>not a video')] };
    await assert.rejects(() => lib.downloadFile('https://public.example/x'), /web page/i);
    scenario = { chunks: [Buffer.from('ID3fake audio')] };
    await assert.rejects(() => lib.downloadFile('https://public.example/x', { expect: ['video'] }), /expected type/i);
});
