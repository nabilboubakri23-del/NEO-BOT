import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {proto,normalizeMessageContent} from 'baileys';
import {buildTextAudioCard,sendTextAudioCard} from '../commands/media/.text-audio-card.js';
import command,{TEST_TEXT,textAudioDecision} from '../commands/media/textaudiotest.js';
const user={id:'100@s.whatsapp.net'};
const audio={mimetype:'audio/ogg; codecs=opus',seconds:1,ptt:false,directPath:'/synthetic/audio',mediaKey:Buffer.alloc(32,7)};
test('card serializes native text and embedded footer audio as one message',()=>{
 const built=buildTextAudioCard({user},'200@s.whatsapp.net',TEST_TEXT,audio);
 const decoded=proto.WebMessageInfo.decode(proto.WebMessageInfo.encode(built).finish());
 const msg=normalizeMessageContent(decoded.message);
 assert.deepEqual(Object.keys(msg),['interactiveMessage']);
 assert.equal(msg.interactiveMessage.body.text,TEST_TEXT);
 assert.equal(msg.interactiveMessage.footer.audioMessage.seconds,1);
 assert.equal(msg.interactiveMessage.footer.hasMediaAttachment,true);
 assert.equal(msg.interactiveMessage.footer.audioMessage.ptt,false);
 assert.equal(msg.interactiveMessage.nativeFlowMessage.buttons.length,0);
 assert.ok(msg.stickerMessage == null);assert.ok(msg.audioMessage == null);
});
test('decision supports group/private and rejects arguments and spam',()=>{
 for(const jid of ['100@s.whatsapp.net','100@lid','100@g.us','100-200@g.us'])assert.equal(textAudioDecision(jid,[],false,undefined,0),'ready');
 for(const jid of ['status@broadcast','100@newsletter','bad'])assert.equal(textAudioDecision(jid,[],false,undefined,0),'unsupported_chat');
 assert.equal(textAudioDecision('100@lid',['x'],false,undefined,0),'invalid_input');
 assert.equal(textAudioDecision('100@lid',[],true,undefined,0),'busy');
 assert.equal(textAudioDecision('100@lid',[],false,0,1),'cooldown');
 assert.equal(textAudioDecision('100@lid',[],false,0,60000),'ready');
});
test('local encryption and mock upload create one relay, no separate voice note',async()=>{
 const uploads=[],relays=[];
 const sock={user,waUploadToServer:async(path,meta)=>{uploads.push({type:meta.mediaType,size:readFileSync(path).length});return {mediaUrl:'https://example.invalid/local',directPath:'/synthetic/audio'}},relayMessage:async(...args)=>relays.push(args)};
 await sendTextAudioCard(sock,'200@s.whatsapp.net',TEST_TEXT,readFileSync(new URL('../commands/media/.text-audio-test.ogg',import.meta.url)));
 assert.equal(uploads.length,1);assert.equal(uploads[0].type,'audio');assert.ok(uploads[0].size>0);
 assert.equal(relays.length,1);assert.equal(relays[0][1].interactiveMessage.body.text,TEST_TEXT);
 assert.equal(relays[0][2].additionalNodes,undefined);
});
test('relay failure does not fall back or automatically retry',async()=>{
 let calls=0;
 const sock={user,waUploadToServer:async()=>({mediaUrl:'https://example.invalid/local',directPath:'/synthetic/audio'}),relayMessage:async()=>{calls++;throw new Error('synthetic failure')}};
 await assert.rejects(sendTextAudioCard(sock,'200@s.whatsapp.net',TEST_TEXT,readFileSync(new URL('../commands/media/.text-audio-test.ogg',import.meta.url))),/synthetic failure/);
 assert.equal(calls,1);
});
test('invalid input produces clear text and no media',async()=>{
 let text='',sends=0;
 await command.execute({relayMessage:async()=>sends++},{chat:'200@s.whatsapp.net',reply:async value=>{text=value}},['x']);
 assert.match(text,/without arguments/);assert.equal(sends,0);
});

test('command lock rejects overlap and cooldown includes failed attempts',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve});let uploads=0;let relays=0;const replies=[];
 const sock={user,waUploadToServer:async()=>{uploads++;await pending;return {mediaUrl:'https://example.invalid/local',directPath:'/synthetic/audio'}},relayMessage:async()=>{relays++;throw new Error('synthetic relay failure')}};
 const message={chat:'555@lid',reply:async text=>replies.push(text)};
 const first=command.execute(sock,message,[]);
 await new Promise(resolve=>setImmediate(resolve));
 await command.execute(sock,{chat:'666@lid',reply:async text=>replies.push(text)},[]);
 assert.match(replies[0],/already running/);
 release();await assert.rejects(first,/synthetic relay failure/);
 await command.execute(sock,message,[]);
 assert.match(replies[1],/60 seconds/);assert.equal(uploads,1);assert.equal(relays,1);
});
