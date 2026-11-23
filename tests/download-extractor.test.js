import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dns from 'node:dns/promises';
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
 await assert.rejects(()=>requireVerifiedExtractor('youtube'),/not enabled/);
 const doc=await store.open('downloadVerification');
 doc.campaigns={'yt-dlp-2026.10.26-adapter-1':{youtube:{state:'checking'}}};
 await assert.rejects(()=>requireVerifiedExtractor('youtube'),/not enabled/);
 doc.campaigns['yt-dlp-2026.10.26-adapter-1'].youtube.state='failed';
 await assert.rejects(()=>requireVerifiedExtractor('youtube'),/failed/);
 doc.campaigns['yt-dlp-2026.10.26-adapter-1'].youtube.state='verified';
 await requireVerifiedExtractor('youtube');
});
