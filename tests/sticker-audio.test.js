import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {proto} from 'baileys';
import '../systems/security/stickerAudioProtocol.js';
import {generateForwardMessageContent} from 'baileys';
const require=createRequire(import.meta.url),pb=require('protobufjs');
const New=pb.parse(`syntax = "proto3"; message Audio { string mimetype=2; uint32 seconds=5; bool ptt=6; bytes mediaKey=7; string directPath=9; } message Sticker { string mimetype=5; uint32 height=6; uint32 width=7; string directPath=8; Audio audioMessage=26; } message Message { Sticker stickerMessage=26; }`).root.lookupType('Message');
const base={stickerMessage:{mimetype:'image/webp',width:512,height:512,directPath:'/synthetic/image'}};
const original=Buffer.from('d201242a0a696d6167652f7765627030800438800442102f73796e7468657469632f696d616765','hex');
const restore=()=>{};
const fixture=()=>({...base,stickerMessage:{...base.stickerMessage,audioMessage:{mimetype:'audio/ogg; codecs=opus',seconds:1,ptt:true,mediaKey:Buffer.alloc(32,7),directPath:'/synthetic/audio'}}});
test('ordinary sticker serialization unchanged',()=>assert.deepEqual(Buffer.from(proto.Message.encode(proto.Message.fromObject(base)).finish()),original));
test('embedded audio survives fromObject encode decode toObject and independent decode',()=>{
 const value=proto.Message.fromObject(fixture());const bytes=proto.Message.encode(value).finish();
 const out=proto.Message.toObject(proto.Message.decode(bytes));
 assert.equal(out.stickerMessage.audioMessage.seconds,1);assert.deepEqual(Object.keys(out),['stickerMessage']);
 assert.equal(New.decode(bytes).stickerMessage.audioMessage.directPath,'/synthetic/audio');
});
test('new-schema incoming payload survives current decode and re-encode',()=>{
 const modern=New.encode(New.fromObject(fixture())).finish();
 const current=proto.Message.decode(modern);
 assert.equal(current.stickerMessage.audioMessage.seconds,1);
 assert.equal(New.decode(proto.Message.encode(current).finish()).stickerMessage.audioMessage.seconds,1);
});
test('viewOnce nesting preserves embedded audio',()=>{
 const value={viewOnceMessage:{message:fixture()}};
 const out=proto.Message.decode(proto.Message.encode(proto.Message.fromObject(value)).finish());
 assert.equal(out.viewOnceMessage.message.stickerMessage.audioMessage.seconds,1);
});
test('WebMessageInfo envelope save/restore preserves embedded audio',()=>{
 const value=proto.WebMessageInfo.fromObject({key:{id:'SYNTHETIC',fromMe:true,remoteJid:'synthetic@s.whatsapp.net'},message:fixture()});
 const out=proto.WebMessageInfo.decode(proto.WebMessageInfo.encode(value).finish());
 assert.equal(out.message.stickerMessage.audioMessage.seconds,1);
 const json=proto.WebMessageInfo.toObject(out,{bytes:String,longs:String});
 assert.equal(proto.WebMessageInfo.fromObject(json).message.stickerMessage.audioMessage.mediaKey.length,32);
});
test('truncated embedded audio rejected',()=>{
 const bytes=New.encode(New.fromObject(fixture())).finish();
 assert.throws(()=>proto.Message.decode(bytes.subarray(0,bytes.length-3)));
});
test('ordinary text and audio unaffected',()=>{
 for(const v of [{conversation:'synthetic'}, {audioMessage:{seconds:1,mimetype:'audio/ogg'}}])assert.deepEqual(proto.Message.toObject(proto.Message.decode(proto.Message.encode(proto.Message.fromObject(v)).finish())),v);
});
test('current forwarding helper preserves embedded audio',()=>{
 const out=generateForwardMessageContent({key:{fromMe:false},message:proto.Message.fromObject(fixture())},true);
 assert.equal(out.stickerMessage.audioMessage.seconds,1);
 assert.equal(out.stickerMessage.contextInfo.isForwarded,true);
});
process.on('exit',restore);

const {allowedDiagnosticChat}=await import('../commands/sticker/soundstickertest.js');
test('diagnostic accepts main-owner incoming and linked-account self-chat only',()=>{
 const sock={user:{id:'100:2@s.whatsapp.net',lid:'200@lid'}};
 const main={number:'300',lid:'400'};
 const msg=(chat,extra={})=>({chat,sender:chat,raw:{key:{remoteJid:chat}},senderNumber:'300',fromMe:false,isGroup:false,...extra});
 assert.equal(allowedDiagnosticChat(sock,msg('300@s.whatsapp.net'),main),true);
 assert.equal(allowedDiagnosticChat(sock,msg('400@lid',{senderNumber:'',senderLid:'400'}),main),true);
 assert.equal(allowedDiagnosticChat(sock,msg('100@s.whatsapp.net',{fromMe:true}),main),true);
 assert.equal(allowedDiagnosticChat(sock,msg('200@lid',{fromMe:true}),main),true);
 assert.equal(allowedDiagnosticChat(sock,msg('999@s.whatsapp.net',{fromMe:true}),main),false);
 assert.equal(allowedDiagnosticChat(sock,msg('999@s.whatsapp.net',{senderNumber:'999'}),main),false);
 assert.equal(allowedDiagnosticChat(sock,msg('100@newsletter',{fromMe:true}),main),false);
 assert.equal(allowedDiagnosticChat(sock,msg('100@g.us',{isGroup:true,fromMe:true}),main),false);
 assert.equal(allowedDiagnosticChat(sock,msg('400@lid',{senderNumber:'',senderLid:''}),main),false);
 assert.equal(allowedDiagnosticChat(sock,msg('300@s.whatsapp.net',{sender:'999@s.whatsapp.net'}),main),false);
});
