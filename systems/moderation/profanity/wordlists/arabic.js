/**
 * Arabic profanity, by dialect. Moderation data only: entries are matched, never sent.
 * Written in plain spelling; the matcher normalizes them exactly like message text
 * (أ/إ/آ → ا, ة → ه, ى → ي, گ → ك, no tashkeel).
 *
 *  word: the whole word (common prefixes و/ف/ب/ال/يا and suffixes ك/ه/ها/كم/ات… are tried)
 *  stem: any word starting with it (only for long, unambiguous roots)
 *  phrase: entries with a space, matched across words
 *
 * severe = sexual insults, insults to family or religion, slurs → blocked at every level.
 * mild   = everyday insults (حمار، غبي) → blocked only when a group chooses "strict".
 * Words that are also ordinary words in Standard Arabic are kept in mild to avoid false hits.
 */

export const severe = {
    word: [
        // Shared / Levantine / Egyptian / Gulf
        'كس', 'كسم', 'كسمك', 'كسامك', 'كسختك', 'كسخت', 'كسها', 'كسعرضك', 'كسكم',
        'طيز', 'طيزك', 'طيزها', 'زب', 'زبي', 'زبر', 'زوبر', 'اير', 'ايري', 'ايرك', 'عير', 'عيري', 'عيرك',
        'نيك', 'نيكك', 'انيكك', 'انيكها', 'نايك', 'ينيك', 'ينيكك', 'تنيك', 'منيك', 'منايك', 'انتاك', 'تنتاك', 'ينتاك',
        'عرص', 'معرص', 'معرصين', 'ديوث', 'ديوس', 'ديايث', 'كواد', 'قواويد', 'مومس', 'زانيه', 'داعر', 'داعره', 'عاهر', 'عاهره', 'عواهر',
        'لوطي', 'لواط', 'مخنث', 'خنيث', 'سكس', 'بورن', 'نيج', 'منيوج',
        // Iraqi
        'كحبه', 'كحاب', 'كواويد', 'مكود',
        // Maghrebi (Moroccan, Algerian, Tunisian, Libyan)
        'زامل', 'زوامل', 'زامله', 'طبون', 'طبونك', 'طبونمك', 'نيكمك', 'نيكماك', 'زك', 'زكك', 'ميبون', 'مبون', 'قلاوي', 'حتشون',
        // Sudanese / Yemeni / Libyan
        'شرموطه', 'قحبه', 'قحاب'
    ],
    stem: ['شرموط', 'شراميط', 'قحب', 'منيوك', 'متناك', 'متناكه', 'منتاك', 'معرص', 'مخنث', 'عاهر', 'ديوث', 'طبونم', 'زامل', 'لبوات', 'سحاق', 'مومسات', 'كسمك', 'كسامك', 'كسختك', 'مزامل'],
    phrase: [
        'كس امك', 'كس اختك', 'كس عرضك', 'كس ربك', 'كس دينك', 'كس ابوك',
        'ابن الكلب', 'ابن كلب', 'بنت الكلب', 'ولاد الكلب', 'ابن الحرام', 'بنت الحرام', 'ولد الحرام', 'اولاد الحرام', 'ابن الزنا', 'ولد الزنا',
        'ابن القحبه', 'ولد القحبه', 'بنت القحبه', 'ابن الشرموطه', 'ابن المتناكه', 'ابن العاهره', 'ابن الزانيه', 'ابن المومس',
        'يلعن ابوك', 'يلعن امك', 'يلعن اختك', 'يلعن دينك', 'يلعن ربك', 'يلعن شرفك', 'يلعن عرضك', 'يلعن والديك', 'يلعن ابو', 'يلعن دين',
        'انيك امك', 'انيك اختك', 'انيك عرضك', 'انيك دينك', 'نيك امك', 'نيك ماك', 'نيك يماك', 'نعل دينك', 'نعل ربك', 'نعل بوك', 'نعل والديك',
        'طبون امك', 'طبون مك', 'زب امك', 'ير امك', 'زبي فيك', 'كول زبي', 'مص زبي', 'الحس طيزي', 'في طيزك',
        'سب الدين', 'يخرب دينك', 'دين امك', 'دين ربك', 'دين ابوك', 'تفو عليك', 'الله يلعن ابوك', 'الله ينعل', 'ينعل دين', 'ينعل بو'
    ]
};

export const mild = {
    word: [
        'حمار', 'حماره', 'حمير', 'كلب', 'كلبه', 'كلاب', 'حيوان', 'حيوانه', 'بهيم', 'بهيمه', 'جحش', 'خنزير', 'خنازير', 'مطي', 'زمال', 'بغل',
        'غبي', 'غبيه', 'اغبياء', 'اهبل', 'هبله', 'هبيله', 'تافه', 'تافهه', 'حقير', 'حقيره', 'سافل', 'سافله', 'منحط', 'واطي', 'وضيع',
        'وسخ', 'وسخه', 'وسخين', 'زباله', 'زبالة', 'معفن', 'معفنه', 'قذر', 'قذره', 'نجس', 'خرا', 'خره', 'زق', 'تفو',
        'خول', 'قواد', 'لبوه', 'طحان', 'احا', 'كلخ', 'مكلخ', 'بوزبال', 'شكام', 'حمق', 'مسطي', 'بخوش', 'حلوف', 'شلاكه', 'زبل',
        'غبيين', 'متخلف', 'متخلفه', 'شاذ', 'معاق', 'معاقه', 'انقلع', 'انطم', 'خايس', 'بايخ', 'ملعون', 'لعين'
    ],
    stem: [],
    phrase: ['الله يلعنك', 'يلعنك', 'ينعلك', 'الله ينعلك', 'روح تنقلع', 'وجه زق', 'وجه الخرا', 'يا ورع']
};

/** Arabizi (Arabic written with Latin letters and digits: 3 = ع, 7 = ح, 9 = ق, 5 = خ, 2 = ء). */
export const arabizi = {
    severe: {
        word: [
            'kos', 'kus', 'koss', 'kuss', 'kss', 'kosomak', 'kosomk', 'kosemak', 'kosomok', 'kesomak', 'ksomk', 'kosmk', 'kosokhtak', 'kosekhtak',
            'sharmota', 'sharmouta', 'sharmoota', 'charmouta', 'charmota', 'sharmot', 'sharameet',
            '9a7ba', 'q7ba', 'qa7ba', 'qahba', 'kahba', 'gahba', '9ahba', '9a7b', 'qa7b', 'k7ba',
            'zamel', 'zaml', 'zwamel', 'zebi', 'zbi', 'zeb', 'zib', 'zob', 'zbr', 'zobr', 'ayri', 'ayre', '3ayri', '3iri', '3ir', 'airi',
            'teez', 'tiz', 'tizak', 'teezak', 'neek', 'nik', 'nikmok', 'nikomok', 'nayek', 'nayk', 'manyak', 'manyouk', 'manyok', 'mnayek', 'mnyk',
            'metnak', 'mitnak', 'mtnak', 'metnaka', 'entak', 'tntak', '3ars', '3rs', 'm3aras', 'm3ars', 'mo3ares', 'khawal', '5awal', 'khwal',
            'dayouth', 'dayous', 'dayooth', 'tabboun', 'tbon', 'tabon', 'tboun', 'tbonmok', 'zok', 'zokk', 'mibon', 'miboun', 'zamla', 'lou6i', 'loti'
        ],
        phrase: ['kos omak', 'kos ommak', 'kos okhtak', 'kus ummak', 'kus emak', 'ibn el kalb', 'ibn al kalb', 'ebn el kalb', 'ibn el sharmouta', 'ibn el 9a7ba', 'wld l9a7ba', 'weld l9ahba', 'yel3an abok', 'yel3an dinak', 'yel3an omak', 'nik mok', 'nik mmok', 'tbon mok', 'zebi fik', 'n3al dinek', 'n3al bok']
    },
    mild: {
        word: ['7mar', 'hmar', '7ayawan', 'hayawan', 'kalb', 'ghabi', 'gabi', '8abi', 'khanzir', '5anzir', 'wes5', 'wis5', 'zbel', 'zbala', 'm9awed', 'mklakh', '7aywan', 'tafeh', '7a9ir', 'sakhif'],
        phrase: []
    }
};
