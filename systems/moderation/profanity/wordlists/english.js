/**
 * English profanity. Moderation data only: entries are matched, never sent.
 * Matched after leetspeak and look-alike normalization (f4ck, ſhit, fцck).
 *  sub: also caught inside longer words (only roots that never appear in clean words)
 */

export const severe = {
    word: [
        'fuck', 'fuk', 'fuc', 'fck', 'fack', 'fak', 'fcuk', 'phuck', 'fvck', 'fking', 'fuking', 'fcking', 'mf', 'mfs', 'stfu', 'gtfo', 'kys',
        'shit', 'shits', 'shitty', 'bullshit', 'bitch', 'biatch', 'cunt', 'cunts', 'twat', 'wanker', 'wank', 'bastard', 'bastards',
        'whore', 'whores', 'slut', 'sluts', 'slutty', 'hoe', 'hoes', 'skank', 'pussy', 'pussies', 'dickhead', 'dickheads', 'cocksucker',
        'asshole', 'assholes', 'arsehole', 'dumbass', 'jackass', 'motherfucker', 'porn', 'porno', 'xxx', 'nude', 'nudes', 'blowjob', 'handjob',
        'faggot', 'fag', 'fags', 'dyke', 'tranny', 'nigger', 'nigga', 'niggas', 'chink', 'spic', 'kike', 'wetback', 'raghead', 'paki'
    ],
    sub: ['fuck', 'fuk', 'motherf', 'bitch', 'whore', 'faggot', 'nigger', 'nigga', 'cocksuck', 'asshole', 'dickhead', 'blowjob', 'bullshit', 'shithead', 'dipshit'],
    phrase: ['son of a bitch', 'kill yourself', 'go die', 'suck my dick', 'suck my', 'your mom', 'ur mom', 'f off', 'piece of shit', 'eat shit']
};

export const mild = {
    word: ['idiot', 'idiots', 'stupid', 'moron', 'morons', 'dumb', 'loser', 'losers', 'retard', 'retarded', 'ass', 'dick', 'prick', 'cock', 'damn', 'crap', 'wtf', 'sucker', 'jerk', 'scum', 'trash', 'imbecile', 'cretin', 'douche', 'douchebag', 'bollocks', 'bloody'],
    sub: [],
    phrase: ['shut up', 'screw you', 'go to hell']
};
