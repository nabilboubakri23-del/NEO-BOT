import docStore from '../../systems/database/docStore.js';
import { extractMedia, EXTRACTOR_HOSTS } from './.extractor.js';
import { downloadFile, MAX_MEDIA_BYTES } from './.lib.js';
import { UserError } from '../../utils/errors.js';

// One campaign per adapter revision, persisted in the existing database.
// A restart reuses completed states and does not download the samples again.
const REVISION = 'yt-dlp-2026.10.26-adapter-1';
const SAMPLES = {
 youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
 instagram: 'https://www.instagram.com/reel/CDUMkliABpa/',
 facebook: 'https://www.facebook.com/cnn/videos/10155529876156509/'
};
const persist = async document => {
 // docStore.saveNow logs write failures instead of throwing. Confirm durable writes
 // directly so a failed persistence step cannot cause repeated sample retrievals.
 await docStore.backend.write('downloadVerification', document);
};
let running;
export const verifyExtractorOnce = () => running ||= (async () => {
 const document = await docStore.open('downloadVerification', () => ({}));
 if (process.env.RENDER && docStore.kind !== 'mongodb') {
  console.log('Download verification unknown: durable database unavailable.');
  return {};
 }
 document.campaigns ||= {};
 const states = document.campaigns[REVISION] ||= {};
 for (const [platform, url] of Object.entries(SAMPLES)) {
  // An interrupted check is unknown, not safe to repeat automatically or enable.
  if (states[platform]) continue;
  states[platform] = { state: 'checking', at: new Date().toISOString() };
  await persist(document);
  try {
   const result = await extractMedia(url, platform);
   const file = await downloadFile(result.url, { allowHosts: EXTRACTOR_HOSTS[platform], maxBytes: MAX_MEDIA_BYTES, expect: ['video'] });
   states[platform] = { state: 'verified', bytes: file.size, at: new Date().toISOString() };
  } catch {
   states[platform] = { state: 'failed', at: new Date().toISOString() };
  }
  await persist(document);
  console.log(`Download verification ${platform}: ${states[platform].state}`);
 }
 return states;
})();

export const requireVerifiedExtractor = async platform => {
 const document = await docStore.open('downloadVerification', () => ({}));
 if (process.env.RENDER && docStore.kind !== 'mongodb') throw new UserError('Server verification is unknown: durable storage unavailable.');
 const state = document.campaigns?.[REVISION]?.[platform]?.state;
 if (state !== 'verified') throw new UserError(`This platform is not enabled: server verification ${state === 'failed' ? 'failed' : 'is pending or unknown'}.`);
};
