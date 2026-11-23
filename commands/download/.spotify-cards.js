import {Carousel, prepareWAMessageMedia} from 'baileys';
import {downloadFile} from './.lib.js';

export const spotifyCarousel = (sock,session,images) => new Carousel(sock)
 .setBody('نتائج Spotify: مرر يمينا أو يسارا واختر الأغنية. التحويل عبر طرف ثالث، وليس تحميلا رسميا. تنتهي النتائج بعد 5 دقائق.')
 .setFooter('Spotify • اختر الأغنية الصحيحة')
 .addCard(session.tracks.map((t,i)=>({
  header:{title:t.title,hasMediaAttachment:true,imageMessage:images[i]},
  body:{text:`${t.title}\nالفنان: ${t.artist || 'غير متاح'}\nالألبوم: ${t.album || 'غير متاح'}\nالمدة: ${t.duration || 'غير متاحة'}`},
  nativeFlowMessage:{buttons:[
   {name:'quick_reply',buttonParamsJson:JSON.stringify({display_text:'تحميل',id:`spotify:pick:${session.token}:${i}`})},
   {name:'cta_url',buttonParamsJson:JSON.stringify({display_text:'فتح في Spotify',url:t.url,merchant_url:t.url})},
   {name:'quick_reply',buttonParamsJson:JSON.stringify({display_text:'رجوع / إلغاء',id:`spotify:cancel:${session.token}`})}
  ]}
 })));

const uploadCover=async(buffer,upload)=>{
 let timer;
 try{return await Promise.race([prepareWAMessageMedia({image:buffer},{upload}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cover upload timed out')),20_000)})]);}
 finally{clearTimeout(timer);}
};

export const sendSpotifyCarousel=async(sock,message,session)=>{
 const images=[];
 // Sequential cover retrieval keeps peak memory and upload pressure bounded.
 for(const track of session.tracks){
  if(session.cancelled)throw new Error('Session cancelled');
  const cover=await downloadFile(track.cover,{allowHosts:['i.scdn.co'],maxBytes:1024*1024,expect:['image']});
  const uploaded=await uploadCover(cover.buffer,sock.waUploadToServer);
  if(!uploaded.imageMessage)throw new Error('Cover upload failed');
  images.push(uploaded.imageMessage);
 }
 if(session.cancelled)throw new Error('Session cancelled');
 const builder=spotifyCarousel(sock,session,images);
 const msg=builder.build(message.chat,{quoted:message.raw,userJid:sock.user?.id});
 // As in existing menu helper, relay directly to avoid duplicate biz nodes.
 await sock.relayMessage(msg.key.remoteJid,msg.message,{messageId:msg.key.id});
 return msg;
};
