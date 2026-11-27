import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dns from 'node:dns/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { allowedHost, extractorArgs, startExtractorProxy } from '../commands/download/.extractor.js';

test('extractor args disable ambient code/config and terminate flags before input', () => {
 const a=extractorArgs('https://youtube.com/watch?v=x','youtube','http://127.0.0.1:1234');
 for(const flag of ['--ignore-config','--no-plugin-dirs','--no-remote-components','--no-cache-dir','--skip-download']) assert.ok(a.includes(flag));
 assert.equal(a.at(-2),'--');assert.equal(a.at(-1),'https://youtube.com/watch?v=x');
 assert.equal(allowedHost('evilgooglevideo.com',['googlevideo.com']),false);
});
const connect = (proxy, target) => new Promise((resolve,reject)=>{
 const u=new URL(proxy);const s=net.connect(Number(u.port),'127.0.0.1',()=>s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
 let text='';s.on('data',d=>{text+=d;if(text.includes('\r\n\r\n')){s.destroy();resolve(text)}});s.on('error',reject);
});
test('extractor proxy rejects literals, wrong hosts, ports and private DNS',async t=>{
 const proxy=await startExtractorProxy(['allowed.example']);
 let lookups=0;t.mock.method(dns,'lookup',async()=>{lookups++;return [{address:'127.0.0.1',family:4}]});
 try{
 for(const target of ['127.0.0.1:443','evil.example:443','allowed.example:80','[::1]:443']) assert.match(await connect(proxy.url,target),/403/);
 assert.equal(lookups,0);
 assert.match(await connect(proxy.url,'allowed.example:443'),/403/);assert.equal(lookups,1);
 }finally{await proxy.close()}
});

test('verification gate stays closed for unknown, checking and failed states', async () => {
 const store=(await import('../systems/database/docStore.js')).default;
 const {MemoryBackend}=await import('./helpers.js');
 await store.init(new MemoryBackend());
 const {requireVerifiedExtractor}=await import('../commands/download/.verification.js');
 const temporary=await mkdtemp(path.join(os.tmpdir(),'download-preflight-'));
 try {
  const source=new URL('../commands/download/.verification.js',import.meta.url).href;
  const db=new URL('../systems/database/docStore.js',import.meta.url).href;
  const helpers=new URL('./helpers.js',import.meta.url).href;
  const script=`import assert from 'node:assert/strict';
   const store=(await import(${JSON.stringify(db)})).default;
   const {MemoryBackend}=await import(${JSON.stringify(helpers)});
   await store.init(new MemoryBackend());
   const {verifyExtractorOnce}=await import(${JSON.stringify(source)});
   assert.deepEqual(await verifyExtractorOnce(),{});
   const pending=await store.open('downloadVerification');
   assert.deepEqual(pending.campaigns['yt-dlp-2026.11.23-adapter-3'],{});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:temporary,encoding:'utf8',timeout:5000,env:{PATH:'/nonexistent-bin'}});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/setup pending/);
 }finally{await rm(temporary,{recursive:true,force:true});}
 await assert.rejects(()=>requireVerifiedExtractor('youtube'),/not enabled/);
 const doc=await store.open('downloadVerification');
 doc.campaigns={'yt-dlp-2026.11.23-adapter-3':{youtube:{state:'checking'}}};
 await assert.rejects(()=>requireVerifiedExtractor('youtube'),/not enabled/);
 doc.campaigns['yt-dlp-2026.11.23-adapter-3'].youtube.state='failed';
 await assert.rejects(()=>requireVerifiedExtractor('youtube'),/failed/);
 doc.campaigns['yt-dlp-2026.11.23-adapter-3'].youtube.state='verified';
 await requireVerifiedExtractor('youtube');
});

test('youtube video picks split H.264 + m4a with smaller fallbacks; audio picks m4a', async () => {
 const { formatFor } = await import('../commands/download/.extractor.js');
 const video = formatFor('youtube', false);
 assert.match(video, /^bv\*\[ext=mp4\]\[vcodec\^=avc1\]\[height<=720\]/);
 assert.match(video, /height<=360\]\+ba\[ext=m4a\]/);
 assert.match(formatFor('youtube', true), /^ba\[ext=m4a\]/);
 assert.equal(formatFor('instagram', false), 'best[ext=mp4][height<=720]/best[ext=mp4]/best');
});

test('extracted results keep both tracks, check every host and refuse oversized media', async () => {
 const { toExtracted } = await import('../commands/download/.extractor.js');
 const ok = toExtracted({ title: 'x', ext: 'mp4', requested_formats: [
  { url: 'https://rr1---sn.googlevideo.com/videoplayback?a=1', ext: 'mp4', vcodec: 'avc1', acodec: 'none', filesize: 1000 },
  { url: 'https://rr1---sn.googlevideo.com/videoplayback?a=2', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 500 }] }, 'youtube');
 assert.equal(ok.parts.length, 2); assert.equal(ok.parts[0].video, true); assert.equal(ok.parts[1].audio, true);
 assert.throws(() => toExtracted({ url: 'https://evil.example/v.mp4' }, 'youtube'));
 assert.throws(() => toExtracted({ url: 'https://rr1.googlevideo.com/v', filesize: 200 * 1024 * 1024 }, 'youtube'), /Too large/);
 assert.throws(() => toExtracted({ _type: 'playlist' }, 'youtube'));
});

test('failed checks are retried after the retry window; verified stays', async () => {
 const { isSettled, RETRY_AFTER_MS } = await import('../commands/download/.verification.js');
 const now = Date.now();
 assert.equal(isSettled(undefined, now), false);
 assert.equal(isSettled({ state: 'verified', at: new Date(0).toISOString() }, now), true);
 assert.equal(isSettled({ state: 'failed', at: new Date(now - 1000).toISOString() }, now), true);
 assert.equal(isSettled({ state: 'failed', at: new Date(now - RETRY_AFTER_MS - 1).toISOString() }, now), false);
 assert.equal(isSettled({ state: 'checking', at: new Date(now - RETRY_AFTER_MS - 1).toISOString() }, now), false);
});

test('.dl detects platforms by host only', async () => {
 const { detectPlatform } = await import('../commands/download/dl.js');
 assert.equal(detectPlatform('https://youtu.be/abc'), 'youtube');
 assert.equal(detectPlatform('https://music.youtube.com/watch?v=a'), 'youtube');
 assert.equal(detectPlatform('https://vt.tiktok.com/x'), 'tiktok');
 assert.equal(detectPlatform('https://fb.watch/x'), 'facebook');
 assert.equal(detectPlatform('https://pin.it/x'), 'pinterest');
 assert.equal(detectPlatform('https://evil.example/youtube.com'), null);
 assert.equal(detectPlatform('not a link'), null);
});
