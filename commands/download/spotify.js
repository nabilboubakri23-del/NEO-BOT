import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { sendButtons } from '../../systems/menus/interactiveMenu.js';
import { sendSpotifyCarousel } from './.spotify-cards.js';
import { spotifySessions as sessions } from './.spotify-session.js';
import { assertUrl, cobaltDownload, deliverMedia, downloadFile, isCobaltConfigured, MAX_MEDIA_BYTES, parseSpotifyTrack, sanitizeFilename, sendFile, spotifyDownload, spotifyInfo, youtubeSearch, spotifySearch } from './.lib.js';

const SPOTIFY_HOSTS=['open.spotify.com'];
const validTrack = input => {
 const url=assertUrl(input,SPOTIFY_HOSTS,'Spotify link');
 if(!/^[A-Za-z0-9]{22}$/.test(parseSpotifyTrack(url)||''))throw new UserError('Send a Spotify track link, not an album or playlist.');
 return url;
};
const audio = async(sock,message,url,session) => {
        const check=()=>{if(session?.cancelled)throw new UserError('تم إلغاء طلب Spotify.');};
        await message.react?.('⏳');

        let converted;
        try {
            const track = await spotifyDownload(url);
            const file = await downloadFile(track.url, { allowHosts: ['spotimate.app'], maxBytes: MAX_MEDIA_BYTES, expect: ['audio'] });
            converted={track,file};
        } catch (error) {
            check();
            if (!isCobaltConfigured()) throw error?.expose ? error : new UserError('⚠️ Could not download that Spotify track right now. Try again later.');
        }
        if(converted){
            check();
            return sendFile(sock,message,{kind:'audio',buffer:converted.file.buffer,mimetype:'audio/mpeg',fileName:`${sanitizeFilename(converted.track.title || 'spotify')}.mp3`});
        }

        const info = await spotifyInfo(url);
        const title = info.title || 'Unknown track';
        const ids = await youtubeSearch(`${title} audio`);
        if (!ids.length) throw new UserError('⚠️ Could not find matching audio for that track.');
        const result = await cobaltDownload(`https://www.youtube.com/watch?v=${ids[0]}`, { audio: true });
        result.fileName = sanitizeFilename(title);
        check();
        await deliverMedia(sock, message, result, { audio: true });
};
const prefix=()=>config.bot.prefix;
const home=async(sock,m)=>{
 const s=sessions.create(m);
 const body=box('SPOTIFY',['ابحث باسم الأغنية والفنان أو أرسل رابط أغنية Spotify.','اختر النتيجة الصحيحة قبل التحميل.','مثال: '+prefix()+'spotify Rick Astley Never Gonna Give You Up','التحويل عبر طرف ثالث، وليس تحميلا رسميا من Spotify.','القائمة تنتهي بعد 5 دقائق.']);
 return sendButtons(sock,m.chat,{title:'Spotify',body,buttons:[{type:'reply',text:'تحميل بالاسم',id:`spotify:name:${s.token}`},{type:'reply',text:'تحميل بالرابط',id:`spotify:link:${s.token}`},{type:'reply',text:'العودة / إلغاء',id:`spotify:cancel:${s.token}`}]},{quoted:m.raw,fallbackText:body+'\n'+prefix()+'spotify cancel'});
};
const resultPage=async(sock,m,s,index)=>{
 const t=s.tracks[index];
 if(!t)throw new UserError('نتيجة غير صالحة. افتح .spotify من جديد.');
 const body=box('SPOTIFY',[
  `النتيجة ${index+1}/${s.tracks.length}`,
  `الأغنية: ${t.title}`,`الفنان: ${t.artist || 'غير متاح'}`,
  `الألبوم: ${t.album || 'غير متاح'}`,`المدة: ${t.duration || 'غير متاحة'}`,
  'اضغط اسم الأغنية للتحميل. تنتهي النتائج بعد 5 دقائق.',
  `${prefix()}spotify cancel للإلغاء`
 ]);
 const label=`${t.title} - ${t.artist}`;
 const buttons=[{type:'reply',text:label.slice(0,20),id:`spotify:pick:${s.token}:${index}`}];
 if(s.tracks.length>1)buttons.push({type:'reply',text:'النتيجة التالية',id:`spotify:page:${s.token}:${(index+1)%s.tracks.length}`});
 buttons.push({type:'reply',text:'رجوع / إلغاء',id:`spotify:cancel:${s.token}`});
 return sendButtons(sock,m.chat,{title:'Spotify',body,buttons},{quoted:m.raw,fallbackText:body+'\n'+prefix()+`spotify choose ${s.token} ${index+1}`});
};
const search=async(sock,m,query)=>sessions.run(m,'search',15_000,async()=>{
 const pending=sessions.create(m);
 const tracks=await spotifySearch(query);
 sessions.get(m,pending.token);
 if(!tracks.length)throw new UserError('لم أجد نتيجة. جرّب اسم الأغنية مع اسم الفنان.');
 const s=sessions.create(m,tracks);
 try{return await sendSpotifyCarousel(sock,m,s)}catch{
  sessions.get(m,s.token);
  await m.reply('تعذر إرسال بطاقات التمرير. سأعرض النتائج بأزرار التالي بدلا منها.');
  return resultPage(sock,m,s,0);
 }

});
const select=async(sock,m,token,index)=>{
 const s=sessions.get(m,token);
 if(!/^\d+$/.test(String(index))||!s.tracks[Number(index)])throw new UserError('اختيار غير صالح. افتح .spotify من جديد.');
 if(s.used)throw new UserError('هذا الاختيار استعمل بالفعل. افتح .spotify من جديد.');
 const track=s.tracks[Number(index)];
 return sessions.run(m,'download',30_000,async()=>{s.used=true;try{return await audio(sock,m,validTrack(track.url),s)}finally{if(sessions.sessions.get(sessions.key(m))===s)sessions.cancel(m);}});
};
export default {
 name:'spotify',aliases:['سبوتيفاي'],category:'download',permission:'public',
 description:'Search by song name, choose a track, or download a Spotify track link via a third-party converter.',
 usage:'[song name | track link | cancel]',examples:['spotify','spotify Rick Astley Never Gonna Give You Up'],
 cooldown:2,minArgs:0,
 async execute(sock,m,args,ctx={}){
  const input=(ctx.argsText||args.join(' ')).trim();
  if(!input)return home(sock,m);
  if(/^(cancel|back|إلغاء|الغاء|رجوع)$/i.test(input)){sessions.cancel(m);return m.reply('تم إلغاء طلب Spotify. إذا بدأ إرسال الملف بالفعل فلا يمكن سحبه.');}
  if(args[0]==='choose')return select(sock,m,args[1],/^\d+$/.test(args[2]||'')?Number(args[2])-1:'invalid');
  if(/^https?:|www\./i.test(input)){const url=validTrack(input);return sessions.run(m,'download',30_000,async()=>{const s=sessions.create(m);try{return await audio(sock,m,url,s)}finally{if(sessions.sessions.get(sessions.key(m))===s)sessions.cancel(m);}});}
  return search(sock,m,input);
 },
 async onSelect(sock,m,parts){
  const[action,token,index]=parts;const session=sessions.get(m,token);
  if(action==='page'){sessions.rate(m,'page',1000);if(!/^\d+$/.test(index||''))throw new UserError('اختيار غير صالح.');return resultPage(sock,m,session,Number(index));}
  if(action==='cancel'){sessions.cancel(m);return m.reply('تم إلغاء طلب Spotify. إذا بدأ إرسال الملف بالفعل فلا يمكن سحبه.');}
  if(action==='home')return home(sock,m);
  if(action==='pick')return select(sock,m,token,index);
  if(action==='name'||action==='link')return sendButtons(sock,m.chat,{title:'Spotify',body:action==='name'?`أرسل اسم الأغنية مع الأمر:\n${prefix()}spotify اسم الأغنية - الفنان`:`أرسل رابط الأغنية مع الأمر:\n${prefix()}spotify https://open.spotify.com/track/...`,buttons:[{type:'reply',text:'رجوع',id:`spotify:home:${token}`},{type:'reply',text:'إلغاء',id:`spotify:cancel:${token}`}]},{quoted:m.raw});
  throw new UserError('اختيار غير صالح. افتح .spotify من جديد.');
 }
};
