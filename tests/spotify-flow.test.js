import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpotifySessions} from '../commands/download/.spotify-session.js';
import {parseSpotifySearch,spotifySearch} from '../commands/download/.lib.js';
import spotify from '../commands/download/spotify.js';
const message={chat:'group',sender:'alice',senderNumber:'1'};
const row=(tid,extra={})=>({data:Buffer.from(JSON.stringify({tid,name:'Song',artist:'Singer',album:'Album',duration:'3:33',...extra})).toString('base64')});
test('Spotify search rows validate ids, deduplicate and cap five choices',()=>{
 const rows=[{data:'bad'},row('https://evil.example'),...Array.from({length:8},(_,i)=>row(String(i).repeat(22))),row('0'.repeat(22))];
 const hits=parseSpotifySearch(rows);assert.equal(hits.length,5);assert.equal(hits[0].artist,'Singer');assert.equal(hits[0].url,'https://open.spotify.com/track/'+'0'.repeat(22));
 assert.equal(parseSpotifySearch([row('x'.repeat(22),{name:''})]).length,0);
});
test('Spotify name validation rejects links and oversized or empty text before networking',async()=>{
 for(const q of ['','a','x'.repeat(161),'https://evil.example'])await assert.rejects(()=>spotifySearch(q));
});
test('Spotify sessions are bound to sender and chat, expire, invalidate old menus',()=>{
 let now=1;const s=new SpotifySessions(()=>now);const a=s.create(message,[{title:'song'}]);
 assert.throws(()=>s.get({...message,chat:'elsewhere'},a.token));assert.throws(()=>s.get({...message,senderNumber:'2'},a.token));
 assert.equal(s.get(message,a.token).tracks[0].title,'song');s.create(message);assert.throws(()=>s.get(message,a.token));
 const b=s.create(message);now+=300001;assert.throws(()=>s.get(message,b.token));assert.equal(s.sessions.size,0);
});
test('Spotify cancellation and per-action limits do not bypass active request lock',async()=>{
 let now=1;const s=new SpotifySessions(()=>now);let finish;const waiting=new Promise(r=>finish=r);
 const run=s.run(message,'download',30000,()=>waiting);s.cancel(message);
 await assert.rejects(()=>s.run(message,'download',30000,async()=>{}),/still running/);
 finish();await run;assert.equal(s.active.size,0);
 await assert.rejects(()=>s.run(message,'download',30000,async()=>{}),/Slow down/);
 now+=30001;await assert.rejects(()=>s.run(message,'download',30000,async()=>{throw new Error('source failed')}));assert.equal(s.active.size,0);
});
test('Spotify stale interactive and invalid fallback selections never start download',async()=>{
 const m={...message,reply:async()=>{}};
 await assert.rejects(()=>spotify.onSelect({},m,['pick','invalid','0']),/expired/);
 await assert.rejects(()=>spotify.execute({},m,['choose','invalid','999']),/expired/);
 assert.equal(spotify.minArgs,0);assert.equal(typeof spotify.onSelect,'function');
});

test('Spotify home and input menu build real native reply buttons in English with text fallback',async()=>{
 const {fakeSock,msg}=await import('./helpers.js');const sock=fakeSock();const m=msg(sock,'.spotify');
 await spotify.execute(sock,m,[]);
 const native=sock.sent.find(x=>x.relay)?.relay?.interactiveMessage;
 assert.ok(native);assert.match(native.body.text,/Example|spotify Shape/);
 const buttons=native.nativeFlowMessage.buttons.map(b=>JSON.parse(b.buttonParamsJson));
 assert.equal(buttons.length,3);assert.deepEqual(buttons.map(b=>b.display_text),['🔎 Search by name','🔗 Download by link','↩️ Back / Cancel']);
 const parts=buttons[0].id.split(':').slice(1);await spotify.onSelect(sock,m,parts);
 const prompt=sock.sent.at(-1).relay.interactiveMessage;assert.match(prompt.body.text,/Type the song name/);
 assert.equal(prompt.nativeFlowMessage.buttons.length,2);
 await spotify.onSelect(sock,m,['cancel',parts[1]]);await assert.rejects(()=>spotify.onSelect(sock,m,parts),/expired/);
});

test('Spotify carousel builds image cards, metadata and sender-bound download/cancel buttons',async()=>{
 const {spotifyCarousel}=await import('../commands/download/.spotify-cards.js');
 const tracks=[{title:'Track one',artist:'Singer',album:'Album',duration:'3:33',url:'https://open.spotify.com/track/'+'a'.repeat(22)},{title:'Track two',artist:'Other',album:'EP',duration:'2:30',url:'https://open.spotify.com/track/'+'b'.repeat(22)}];
 const built=spotifyCarousel({}, {token:'session',tracks},[{mimetype:'image/jpeg'},{mimetype:'image/jpeg'}]).build('123@s.whatsapp.net');
 const cards=built.message.interactiveMessage.carouselMessage.cards;
 assert.equal(cards.length,2);
 for(const [i,c]of cards.entries()){
  assert.equal(c.header.hasMediaAttachment,true);assert.ok(c.header.imageMessage);
  assert.match(c.body.text,new RegExp(tracks[i].artist));assert.match(c.body.text,new RegExp(tracks[i].album));
  const b=c.nativeFlowMessage.buttons.map(x=>JSON.parse(x.buttonParamsJson));
  assert.equal(b[0].id,`spotify:pick:session:${i}`);assert.equal(b[1].id,`spotify:file:session:${i}`);assert.equal(b[2].id,'spotify:cancel:session');
 }
});

test('Spotify artwork only accepts HTTPS i.scdn.co, never arbitrary provider URLs',()=>{
 for(const cover of ['http://i.scdn.co/image/a','https://evil.example/x','https://127.0.0.1/x','https://i.scdn.co.evil.example/x'])assert.equal(parseSpotifySearch([row('a'.repeat(22),{cover})])[0].cover,'');
 assert.equal(parseSpotifySearch([row('a'.repeat(22),{cover:'https://i.scdn.co/image/a'})])[0].cover,'https://i.scdn.co/image/a');
});

test('Spotify input classifier accepts track links, URIs, short links; rejects albums and foreign hosts',async()=>{
 const {classifyInput}=await import('../commands/download/.spotify-core.js');
 const id='4PTG3Z6ehGkBFwjybzWkR8';
 assert.equal(classifyInput(`https://open.spotify.com/track/${id}?si=abc`).url,`https://open.spotify.com/track/${id}`);
 assert.equal(classifyInput(`https://open.spotify.com/intl-fr/track/${id}`).kind,'track');
 assert.equal(classifyInput(`spotify:track:${id}`).kind,'track');
 assert.equal(classifyInput(`listen https://open.spotify.com/track/${id}`).kind,'track');
 assert.equal(classifyInput('https://spotify.link/abc123').kind,'short');
 assert.equal(classifyInput(`https://open.spotify.com/album/${id}`).kind,'unsupported');
 assert.equal(classifyInput('https://evil.example/track/'+id).kind,'invalid');
 assert.equal(classifyInput('Shape of You').kind,'name');
});

test('Spotify audio falls back to the next source and stops when cancelled',async()=>{
 const {acquireAudio}=await import('../commands/download/.spotify-core.js');
 const track={title:'Song',artist:'Singer',url:'https://open.spotify.com/track/'+'a'.repeat(22)};
 const mp3=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(64)]);
 const calls=[];
 const sources={spotimate:async()=>{calls.push('s');throw new Error('down')},youtube:async()=>{calls.push('y');return{buffer:mp3,mimetype:'audio/mp4',ext:'m4a'}},cobalt:async()=>{calls.push('c')}};
 const out=await acquireAudio(track,{sources});
 assert.deepEqual(calls,['s','s','y']);assert.equal(out.fileName,'Song - Singer.m4a');
 await assert.rejects(()=>acquireAudio(track,{sources,isCancelled:()=>true}),/cancelled/);
 const dead={spotimate:async()=>{throw new Error('x')},youtube:async()=>{throw new Error('x')},cobalt:async()=>{throw new Error('x')}};
 await assert.rejects(()=>acquireAudio(track,{sources:dead}),/any source/);
});

test('Spotify typed input after "Search by name" is consumed once and never blocks the pipeline',async()=>{
 const {fakeSock,msg}=await import('./helpers.js');const sock=fakeSock();const {onPlainMessage}=await import('../commands/download/spotify.js');
 const m=msg(sock,'.spotify');await spotify.execute(sock,m,[]);
 const id=JSON.parse(sock.sent.find(x=>x.relay).relay.interactiveMessage.nativeFlowMessage.buttons[1].buttonParamsJson).id;
 await spotify.onSelect(sock,m,id.split(':').slice(1));
 const typed=msg(sock,'cancel');assert.equal(onPlainMessage({sock,message:typed}),undefined);
 await new Promise(r=>setTimeout(r,10));assert.match(sock.sent.at(-1).content.text,/cancelled/);
 const again=msg(sock,'hello');assert.equal(onPlainMessage({sock,message:again}),undefined);
 await new Promise(r=>setTimeout(r,10));assert.match(sock.sent.at(-1).content.text,/cancelled/); // nothing new sent
});
