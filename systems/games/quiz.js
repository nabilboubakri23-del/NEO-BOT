import { COUNTRIES, flagOf } from './countries.js';

/**
 * Quiz questions generated offline (no remote datasets): flags, mental math and word scrambles.
 * A question is { kind, prompt, answers: string[] (normalised), display, points, hint }.
 */

const WORDS = [
    'planet', 'garden', 'window', 'castle', 'bridge', 'rocket', 'island', 'forest', 'orange', 'pencil',
    'dragon', 'jungle', 'silver', 'market', 'winter', 'summer', 'camera', 'school', 'doctor', 'travel',
    'mirror', 'guitar', 'butter', 'number', 'yellow', 'friend', 'family', 'animal', 'stream', 'desert',
    'thunder', 'library', 'diamond', 'monster', 'balloon', 'chicken', 'printer', 'battery', 'kitchen', 'teacher',
    'morning', 'picture', 'holiday', 'captain', 'blanket', 'compass', 'harvest', 'lantern', 'volcano', 'penguin'
];

/** Lower-case, no accents, no punctuation, single spaces. */
export const normalize = (text) =>
    String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/[\s-]+/g, ' ')
        .trim();

export const isCorrect = (question, text) => question.answers.includes(normalize(text));

const pick = (list, random) => list[Math.floor(random() * list.length)];

export const flagQuestion = (random = Math.random) => {
    const [code, name, ...alts] = pick(COUNTRIES, random);
    return {
        kind: 'flag',
        prompt: `Which country has this flag?\n\n${flagOf(code)}`,
        answers: [name, ...alts].map(normalize),
        display: name,
        points: 2,
        hint: `${name[0]}${name.slice(1).replace(/[a-z]/gi, '•')} (${name.length} letters)`
    };
};

export const mathQuestion = (random = Math.random) => {
    const int = (min, max) => min + Math.floor(random() * (max - min + 1));
    const op = pick(['+', '-', '×'], random);
    let a = int(5, 99);
    let b = int(2, op === '×' ? 12 : 99);
    if (op === '-' && b > a) [a, b] = [b, a];
    const result = op === '+' ? a + b : op === '-' ? a - b : a * b;
    return { kind: 'math', prompt: `What is ${a} ${op} ${b}?`, answers: [String(result)], display: String(result), points: 1, hint: `Between ${result - int(1, 9)} and ${result + int(1, 9)}` };
};

const shuffle = (word, random) => {
    const letters = [...word];
    for (let i = letters.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    return letters.join('');
};

export const wordQuestion = (random = Math.random) => {
    const word = pick(WORDS, random);
    let scrambled = shuffle(word, random);
    for (let i = 0; scrambled === word && i < 5; i++) scrambled = shuffle(word, random);
    return { kind: 'word', prompt: `Unscramble this word:\n\n*${scrambled.toUpperCase().split('').join(' ')}*`, answers: [word], display: word, points: 2, hint: `Starts with "${word[0].toUpperCase()}"` };
};

export const QUIZZES = Object.freeze({ flag: flagQuestion, math: mathQuestion, word: wordQuestion });
