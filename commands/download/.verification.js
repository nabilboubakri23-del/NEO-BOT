import docStore from '../../systems/database/docStore.js';
import { extractMedia, fetchExtracted, resolveYtDlp } from './.extractor.js';
import { UserError } from '../../utils/errors.js';

// One campaign per adapter revision, persisted in the existing database.
// A restart reuses completed states and does not download the samples again.
export const REVISION = 'yt-dlp-2026.11.23-adapter-3';
// A failed or interrupted check is retried on the next start after this long.
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
export const isSettled = (entry, now = Date.now()) => entry?.state === 'verified' ||
 (Boolean(entry?.state) && now - Date.parse(entry.at || 0) < RETRY_AFTER_MS);
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
 // A code deploy can start once before a Blueprint build-command sync finishes.
 // Missing tooling is a setup failure, never a tested platform failure.
 if (!(await resolveYtDlp())) {
  console.log('Download verification setup pending: executable unavailable.');
  return states;
 }
 for (const [platform, url] of Object.entries(SAMPLES)) {
  // An interrupted check is unknown, not safe to repeat automatically or enable.
  if (isSettled(states[platform])) continue;
  states[platform] = { state: 'checking', at: new Date().toISOString() };
  await persist(document);
  try {
   const result = await extractMedia(url, platform);
   const file = await fetchExtracted(result, platform);
   if (file.kind !== 'video') throw new Error('not a video');
   states[platform] = { state: 'verified', bytes: file.buffer.length, at: new Date().toISOString() };
  } catch {
   states[platform] = { state: 'failed', at: new Date().toISOString() };
  }
  await persist(document);
  console.log(`Download verification ${platform}: ${states[platform].state}`);
 }
 return states;
})();

/**
 * Downloads are no longer locked by the start-up check (a failed sample used to block a
 * platform until the next release). The check is now only a health signal in the logs;
 * the real error of each download is shown to the user instead. Only a missing yt-dlp stops it.
 */
export const requireVerifiedExtractor = async () => {
 if (!(await resolveYtDlp())) throw new UserError('⚠️ The downloader (yt-dlp) is not installed on this server. Termux: pip install yt-dlp');
};

/** Last start-up check result per platform (for status messages). */
export const verificationState = async platform => {
 const document = await docStore.open('downloadVerification', () => ({}));
 return document.campaigns?.[REVISION]?.[platform]?.state || 'unknown';
};
