/**
 * Pinterest result intelligence (pure functions, fully unit-tested):
 *   classify()   image | edit | video   (edit = stylised fan edit / AMV / velocity / phonk clip)
 *   relevance()  how well a pin matches the query (title, description, alt text, board, hashtags)
 *   rank()       relevance + popularity + quality + Pinterest's own order, deduplicated,
 *                off-topic pins dropped unless there would not be enough results.
 */

const EDIT_TAGS = new Set([
    'edit', 'edits', 'amv', 'mmv', 'gmv', 'animeedit', 'animeedits', 'aftereffects', 'ae', 'velocity', 'velocityedit',
    'capcut', 'capcutedit', 'twixtor', 'phonk', 'phonkedit', 'sigmaedit', 'editaudio', 'edittiktok', 'fanedit', 'aesthetic edit',
    'footballedit', 'carsedit', 'mangaedit', 'filmedit', 'movieedit', 'kpopedit', 'flowedit', 'smoothedit', '4kedit', 'alightmotion', 'vfx'
]);
const EDIT_WORDS = /\b(edits?|amv|mmv|gmv|after ?effects|velocity|capcut|twixtor|phonk|alight ?motion|transitions?|vfx|fan ?edit)\b/i;
const NOT_EDIT = /\b(tutorial|how to|recipe|diy|step by step|review|unboxing|vlog|interview|podcast|lesson|course|workout)\b/i;

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'for', 'to', 'with', 'from', 'by', 'de', 'la', 'le', 'el',
    'في', 'من', 'على', 'و', 'ال', 'عن', 'مع']);
const MODE_WORDS = new Set(['edit', 'edits', 'video', 'videos', 'image', 'images', 'photo', 'photos', 'pic', 'pics', 'picture',
    'wallpaper', 'wallpapers', 'hd', '4k', 'pfp', 'icon', 'icons', 'aesthetic', 'ايديت', 'صور', 'صورة', 'خلفية', 'خلفيات', 'فيديو']);

/** Lowercase, NFKC (turns 𝐍𝐚𝐫𝐮𝐭𝐨 into naruto), strips accents/tashkeel and punctuation. */
export const normalize = (text) => String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim();

export const tokens = (text) => normalize(text).split(/\s+/).map((t) => t.replace(/^#/, '')).filter((t) => t.length > 1 && !STOP.has(t));

/** Query terms that carry the subject (mode words like "edit" or "wallpaper" are removed). */
export const subjectTerms = (query) => {
    const all = tokens(query);
    const subject = all.filter((t) => !MODE_WORDS.has(t));
    return subject.length ? subject : all;
};

const haystackOf = (pin) => normalize([pin.title, pin.description, pin.alt, pin.board, pin.author, ...(pin.hashtags || [])].join(' '));

const isLatin = (t) => /^[\p{Script=Latin}\p{N}]+$/u.test(t);

/**
 * 0..1: share of subject terms found in the pin text. Terms match whole words,
 * prefixes (naruto → narutouzumaki) or inside hashtags. A query in a script the
 * pin text does not use (Arabic query, English pin) returns 0.5: we cannot judge,
 * so Pinterest's own relevance decides.
 */
export const relevance = (pin, query) => {
    const terms = subjectTerms(query);
    if (!terms.length) return 0.5;
    const hay = haystackOf(pin);
    if (!hay) return 0.2;
    const words = hay.split(' ');
    const latinHay = /[a-z]/.test(hay);
    let judged = 0;
    let found = 0;
    for (const term of terms) {
        if (!isLatin(term) && latinHay && !words.some((w) => !isLatin(w))) continue; // cross-script: skip
        judged += 1;
        if (words.some((w) => w === term || (term.length >= 4 && (w.startsWith(term) || w.includes(term))))) found += 1;
    }
    return judged ? found / judged : 0.5;
};

/** 'edit' | 'video' | 'image' with a confidence score (0..1) for edits. */
export const classify = (pin) => {
    if (pin.kind !== 'video' || !pin.video) return { type: 'image', editScore: 0 };
    const text = `${pin.title} ${pin.description} ${pin.board}`;
    let score = 0;
    const tags = pin.hashtags || [];
    if (tags.some((t) => EDIT_TAGS.has(t) || /edit$/.test(t))) score += 0.5;
    if (EDIT_WORDS.test(text)) score += 0.35;
    if (/@\w+ on tik ?tok|tiktok/i.test(text)) score += 0.1;
    const d = pin.video.duration || 0;
    if (d >= 5 && d <= 75) score += 0.15;
    else if (d > 180) score -= 0.3;
    if (NOT_EDIT.test(text)) score -= 0.5;
    score = Math.max(0, Math.min(1, score));
    return { type: score >= 0.45 ? 'edit' : 'video', editScore: score };
};

const popularity = (pin) => Math.log10(1 + (pin.reactions || 0) + (pin.saves || 0) * 0.5);

const quality = (pin, type) => {
    if (type === 'image') {
        const w = pin.width || 0;
        if (!w) return 0.4;
        if (w < 400) return 0;
        return Math.min(w, 1200) / 1200;
    }
    const h = Math.max(pin.video?.height || 0, pin.video?.width || 0);
    return h ? Math.min(h, 1080) / 1080 : 0.5;
};

/**
 * Ranks pins for a mode ('image' | 'edit' | 'video').
 * Returns [{ pin, type, score, relevance, editScore, offTopic }] best first.
 */
export const rank = (pins, query, mode, { want = 8 } = {}) => {
    const seen = new Set();
    const scored = [];
    pins.forEach((pin, index) => {
        const sig = pin.signature || pin.image?.full || pin.id;
        if (seen.has(pin.id) || seen.has(sig)) return;
        seen.add(pin.id);
        seen.add(sig);
        const { type, editScore } = classify(pin);
        if (mode === 'image' && type !== 'image') return;
        if (mode !== 'image' && type === 'image') return;
        if (mode === 'image' && pin.width && pin.width < 300) return;
        if (pin.video && (pin.video.duration > 600)) return;
        const rel = relevance(pin, query);
        const order = 1 - index / Math.max(pins.length, 1);
        let score = rel * 3 + popularity(pin) * 0.8 + quality(pin, type) * 0.7 + order * 1.2;
        if (mode === 'edit') score += type === 'edit' ? 1.5 + editScore : -1;
        if (mode === 'video') score += type === 'video' ? 0.8 : 0;
        scored.push({ pin, type, score, relevance: rel, editScore, offTopic: rel < 0.34 });
    });
    scored.sort((a, b) => b.score - a.score);
    const onTopic = scored.filter((r) => !r.offTopic);
    // Keep off-topic pins only as filler when the query found too few good ones.
    return onTopic.length >= Math.min(want, 3) ? onTopic : [...onTopic, ...scored.filter((r) => r.offTopic)];
};

/** Adds " edit" to an edit search when the user did not say it (better Pinterest results). */
export const searchQueryFor = (query, mode) => {
    const q = String(query || '').trim();
    if (mode === 'edit' && !/\b(edit|edits|amv)\b|ايديت|إيديت/i.test(q)) return `${q} edit`;
    return q;
};
