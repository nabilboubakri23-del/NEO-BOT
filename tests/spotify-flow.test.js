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
 await assert.rejects(()=>s.run(message,'download',30000,async()=>{}),/already running/);
 finish();await run;assert.equal(s.active.size,0);
 await assert.rejects(()=>s.run(message,'download',30000,async()=>{}),/wait/);
 now+=30001;await assert.rejects(()=>s.run(message,'download',30000,async()=>{throw new Error('source failed')}));assert.equal(s.active.size,0);
});
test('Spotify stale interactive and invalid fallback selections never start download',async()=>{
 const m={...message,reply:async()=>{}};
 await assert.rejects(()=>spotify.onSelect({},m,['pick','invalid','0']),/expired/);
 await assert.rejects(()=>spotify.execute({},m,['choose','invalid','999']),/expired/);
 assert.equal(spotify.minArgs,0);assert.equal(typeof spotify.onSelect,'function');
});

test('Spotify home and input menu build real native reply buttons with text fallback',async()=>{
 const {fakeSock,msg}=await import('./helpers.js');const sock=fakeSock();const m=msg(sock,'.spotify');
 await spotify.execute(sock,m,[]);
 const native=sock.sent.find(x=>x.relay)?.relay?.interactiveMessage;
 assert.ok(native);assert.match(native.body.text,/مثال/);
 const buttons=native.nativeFlowMessage.buttons.map(b=>JSON.parse(b.buttonParamsJson));
 assert.equal(buttons.length,3);assert.deepEqual(buttons.map(b=>b.display_text),['تحميل بالاسم','تحميل بالرابط','العودة / إلغاء']);
 const parts=buttons[0].id.split(':').slice(1);await spotify.onSelect(sock,m,parts);
 const prompt=sock.sent.at(-1).relay.interactiveMessage;assert.match(prompt.body.text,/spotify اسم/);
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
  assert.equal(b[0].id,`spotify:pick:session:${i}`);assert.equal(b[1].url,tracks[i].url);assert.equal(b[2].id,'spotify:cancel:session');
 }
});

test('Spotify artwork only accepts HTTPS i.scdn.co, never arbitrary provider URLs',()=>{
 for(const cover of ['http://i.scdn.co/image/a','https://evil.example/x','https://127.0.0.1/x','https://i.scdn.co.evil.example/x'])assert.equal(parseSpotifySearch([row('a'.repeat(22),{cover})])[0].cover,'');
 assert.equal(parseSpotifySearch([row('a'.repeat(22),{cover:'https://i.scdn.co/image/a'})])[0].cover,'https://i.scdn.co/image/a');
});
