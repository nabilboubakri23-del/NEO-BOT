/**
 * Mood detection for auto-reactions. Pure, no I/O.
 *
 * Reads a message (Arabic incl. Darija/Gulf/Levantine, Arabizi, English, emojis)
 * and returns the strongest mood with a fitting emoji:
 *   detectMood('ههههههه')            → { mood: 'laugh', score: 3 }
 *   moodEmoji('laugh', { owner })    → '😂' for everyone, an owner-only emoji for owners
 *
 * Owner emojis are EXCLUSIVE: they never appear on anyone else's messages.
 */

const B = '(?:^|[^\\p{L}\\p{N}])'; // start of a word (works for Arabic too)
const E = '(?=$|[^\\p{L}\\p{N}])'; // end of a word

const words = (list) => new RegExp(`${B}(?:${list.join('|')})${E}`, 'gu');
const raw = (pattern) => new RegExp(pattern, 'gu');

/** Arabic letter variants folded, diacritics and tatweel removed, lower case. */
export const normalizeMood = (text) =>
    String(text || '')
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي');

/**
 * Order matters on a tie (earlier wins). `public` emojis are for everyone,
 * `owner` ones only for owners and above.
 */
export const MOODS = Object.freeze({
    laugh: {
        label: '😂 Laugh',
        public: ['😂', '🤣', '😆'],
        owner: ['😹', '💀'],
        patterns: [
            raw('ه{3,}'),
            raw('خ{3,}'),
            words(['هه', 'هاها+', 'ههه+ا*', 'ضحكت+ني', 'ضحكتني', 'ضحك', 'مضحك', 'يضحك', 'ميت من الضحك', 'تموت', 'قتلتني', 'كركر']),
            words(['lo+l', 'lmf?a+o+', 'rofl', 'x+d+', '(?:h+a+){2,}h*', 'h{3,}', 'k{4,}', 'jaja+', 'mdr+']),
            raw('[😂🤣😹😆😅😁]')
        ]
    },
    love: {
        label: '❤️ Love',
        public: ['❤️', '😍', '🥰'],
        owner: ['💎', '💘'],
        patterns: [
            words(['احبك+', 'نحبك', 'بحبك', 'حبيبي', 'حبيبتي', 'حبي', 'عشقي', 'عشق', 'قلبي', 'كنبغيك', 'نبغيك', 'تبغيني', 'اموت فيك', 'روحي', 'يا عمري', 'عمري', 'حياتي', 'الحب']),
            words(['i love (?:you|u)', 'love (?:you|u|it)', 'luv', 'ily', 'my love', 'babe', 'cute', 'aww+', 'nhabek', 'n?7ebek', 'habibi', 'habibti']),
            raw('[❤💕💖💗💓💞😍🥰😘💘]')
        ]
    },
    sad: {
        label: '😢 Sad',
        public: ['😢', '🥺', '💔'],
        owner: ['🫂', '🥀'],
        patterns: [
            words(['حزين', 'حزينه', 'زعلان', 'زعلانه', 'مكتئب', 'مكتئبه', 'ابكي', 'بكيت', 'نبكي', 'تبكي', 'مقهور', 'مقهوره', 'متضايق', 'مخنوق', 'وحيد', 'للاسف', 'مسكين', 'مسكينه', 'قلبي يوجعني', 'الله يرحمه', 'الله يرحمها', 'رحمه الله', 'مريض', 'مريضه']),
            words(['sad', 'cry(?:ing)?', 'crying', 'depressed', 'sorry for', 'rip', 'miss (?:you|u)', 'heartbroken', 'lonely']),
            raw('[😢😭💔🥺😞😔😿]')
        ]
    },
    angry: {
        label: '😡 Angry',
        public: ['😤', '😠'],
        owner: ['🗿', '🌋'],
        patterns: [
            words(['معصب', 'معصبه', 'عصبت', 'عصبتني', 'غاضب', 'زعلت', 'قرفت', 'تفو', 'كرهت', 'نكرهك', 'اكرهك', 'سخفت', 'مستفز', 'استفزاز', 'طفشت', 'فقعتني']),
            words(['angry', 'mad', 'wtf', 'hate (?:you|u|it|this)', 'annoying', 'pissed']),
            raw('[😡🤬😠😤👿]')
        ]
    },
    night: {
        label: '🌙 Good night',
        public: ['🌙', '😴'],
        owner: ['🌌'],
        patterns: [
            words(['تصبح علي? خير', 'تصبحون علي? خير', 'تصبحي علي? خير', 'ليله سعيده', 'نوم الهنا', 'نعسان', 'نعسانه', 'بنام', 'غادي ننعس', 'ننعس']),
            words(['good ?night', 'gn', 'sleep(?:ing|y)?', 'nighty?']),
            raw('[😴🌙💤]')
        ]
    },
    greeting: {
        label: '👋 Greeting',
        public: ['👋', '🤗'],
        owner: ['🫡'],
        patterns: [
            words(['السلام عليكم', 'سلام عليكم', 'السلام', 'سلام', 'مرحبا', 'مرحبتين', 'اهلا', 'هلا', 'هلا والله', 'صباح الخير', 'صباح النور', 'مساء الخير', 'مساء النور', 'صباحو', 'كيفك', 'كيف حالك', 'لاباس', 'واش راك', 'شنو اخبارك', 'اش خبارك', 'شخبارك']),
            words(['hi+', 'hello+', 'hey+', 'salam', 'slm', 'good morning', 'gm', 'morning', 'yo', 'sup', 'bonjour', 'salut', 'cc']),
            raw('[👋🤗]')
        ]
    },
    thanks: {
        label: '🙏 Thanks',
        public: ['🙏', '🤝'],
        owner: ['👑'],
        patterns: [
            words(['شكرا', 'شكرن', 'شكرا لك', 'مشكور', 'مشكوره', 'تسلم', 'تسلمي', 'يسلمو', 'يعطيك العافيه', 'الله يعطيك العافيه', 'بارك الله فيك', 'جزاك الله خيرا?', 'الله يجازيك', 'الله يحفظك', 'متشكر', 'ممنون', 'بزاف شكرا', 'الله يخليك']),
            words(['thanks?', 'thank (?:you|u)', 'thx', 'ty', 'tysm', 'merci', 'shukran', 'appreciate (?:it|you|u)']),
            raw('[🙏]')
        ]
    },
    congrats: {
        label: '🎉 Congrats',
        public: ['🎉', '🥳'],
        owner: ['🏆'],
        patterns: [
            words(['مبروك', 'مبارك', 'الف مبروك', 'مبروك عليك', 'نجحت', 'نجحنا', 'فزت', 'فزنا', 'ربحت', 'تخرجت', 'عيد مبارك', 'عيد سعيد', 'كل عام وانت بخير', 'عيد ميلاد سعيد', 'سنه سعيده', 'مبروك عليكم']),
            words(['congrats?', 'congratulations', 'happy birthday', 'hbd', 'i passed', 'i won', 'we won', 'well done', 'mabrouk']),
            raw('[🎉🥳🎊🎂🏆]')
        ]
    },
    faith: {
        label: '🤲 Faith',
        public: ['🤲', '🕋'],
        owner: ['📿'],
        patterns: [
            words(['الحمد ?لله', 'ان ?شاء ?الله', 'انشالله', 'ما ?شاء ?الله', 'سبحان الله', 'الله اكبر', 'امين', 'استغفر الله', 'بسم الله', 'لا اله الا الله', 'جمعه مباركه', 'رمضان كريم', 'رمضان مبارك', 'يا رب', 'يارب', 'اللهم']),
            words(['alhamdulillah', 'hamdoulah', 'inshallah', 'insha ?allah', 'mashallah', 'subhanallah', 'allahu akbar', 'ameen', 'amen']),
            raw('[🤲📿🕋]')
        ]
    },
    wow: {
        label: '😮 Wow',
        public: ['😮', '😱'],
        owner: ['⚡'],
        patterns: [
            words(['واو+', 'وااو+', 'مستحيل', 'معقول', 'عجيب', 'صدمه', 'انصدمت', 'يا ساتر', 'جد', 'بجد', 'والله؟', 'شنو هاد', 'ايش هذا']),
            words(['wo+w', 'omg', 'no way', 'what\\?+', 'whoa', 'shocked', 'unbelievable']),
            raw('[😮😱😲🤯😳]')
        ]
    },
    praise: {
        label: '🔥 Praise',
        public: ['🔥', '👏', '💯'],
        owner: ['🔱', '⚜️'],
        patterns: [
            words(['رائع', 'رائعه', 'روعه', 'جميل', 'جميله', 'حلو', 'حلوه', 'زوين', 'زوينه', 'واعر', 'واعره', 'خطير', 'خطيره', 'ممتاز', 'ممتازه', 'قوي', 'نار', 'ابداع', 'مبدع', 'مبدعه', 'احسنت', 'برافو', 'تحفه', 'فخم', 'اسطوري', 'عظيم', 'بطل']),
            words(['nice', 'cool', 'great', 'awesome', 'amazing', 'fire', 'lit', 'goat', 'perfect', 'beautiful', 'excellent', 'wonderful', 'legend(?:ary)?', 'bravo', 'insane', 'top']),
            raw('[🔥👏💯😎🤩]')
        ]
    },
    agree: {
        label: '👍 Okay',
        public: ['👍', '👌'],
        owner: ['✅'],
        patterns: [
            words(['اوكي', 'اوك', 'تمام', 'اكيد', 'موافق', 'موافقه', 'ماشي', 'واخا', 'حاضر', 'طيب', 'زين', 'صح', 'صحيح', 'بالضبط', 'معاك حق']),
            words(['ok(?:ay)?', 'oki', 'sure', 'yes+', 'yep', 'yeah', 'deal', 'exactly', 'agreed?', 'right']),
            raw('[👍👌]')
        ]
    }
});

export const MOOD_NAMES = Object.freeze(Object.keys(MOODS));

/** Every emoji reserved for owners (mood variants + the general owner pool). */
export const DEFAULT_OWNER_EMOJIS = Object.freeze(['👑', '💎', '⚡', '🫡', '🔱', '🗿']);
export const OWNER_EXCLUSIVE = Object.freeze(new Set([...DEFAULT_OWNER_EMOJIS, ...MOOD_NAMES.flatMap((m) => MOODS[m].owner)]));

/**
 * Strongest mood in a message, or null. Score = number of matches
 * (a long "هههههههه" counts double). Ties go to the earlier mood.
 */
export const detectMood = (text) => {
    const body = normalizeMood(text);
    if (!body.trim()) return null;
    let best = null;
    for (const name of MOOD_NAMES) {
        let score = 0;
        for (const re of MOODS[name].patterns) {
            re.lastIndex = 0;
            const found = body.match(re);
            if (found) score += found.reduce((s, m) => s + (m.trim().length >= 7 ? 2 : 1), 0);
        }
        if (score && (!best || score > best.score)) best = { mood: name, score };
    }
    return best;
};

const pick = (list, random) => list[Math.floor(random() * list.length)];

/**
 * Emoji for a mood: the mood's owner-only variant for owners, a public one for everyone else.
 */
export const moodEmoji = (mood, { owner = false, random = Math.random } = {}) => {
    const spec = MOODS[mood];
    if (!spec) return null;
    if (owner) return pick(spec.owner, random);
    return pick(spec.public, random);
};
