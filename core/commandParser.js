/**
 * Splits a command line into name, args and flags.
 *
 *   .say "hello world" --to=me -v rest
 *   → { name: 'say', args: ['hello world', 'rest'], flags: { to: 'me', v: true }, argsText: '"hello world" --to=me -v rest' }
 *
 * - Only the FIRST line is parsed into args; following lines are kept in `body`
 *   (used by commands that take code or long text).
 * - Quotes ("..." or '...') group words. Flags are --name, --name=value or -x.
 * - A bare "--" stops flag parsing.
 */
export const parseCommand = (text, prefix) => {
    if (!text || !text.startsWith(prefix)) return null;
    const withoutPrefix = text.slice(prefix.length);
    const newline = withoutPrefix.indexOf('\n');
    const header = (newline === -1 ? withoutPrefix : withoutPrefix.slice(0, newline)).trim();
    const body = newline === -1 ? '' : withoutPrefix.slice(newline + 1);

    const match = header.match(/^(\S+)\s*([\s\S]*)$/);
    if (!match) return null;
    const name = match[1].toLowerCase();
    const argsText = match[2];

    const tokens = tokenize(argsText);
    const args = [];
    const flags = {};
    let flagsDone = false;
    for (const token of tokens) {
        if (!token.quoted && !flagsDone) {
            if (token.value === '--') {
                flagsDone = true;
                continue;
            }
            const long = token.value.match(/^--([a-zA-Z][\w-]*)(?:=(.*))?$/);
            if (long) {
                flags[long[1].toLowerCase()] = long[2] ?? true;
                continue;
            }
            const short = token.value.match(/^-([a-zA-Z])$/);
            if (short) {
                flags[short[1]] = true;
                continue;
            }
        }
        args.push(token.value);
    }
    return { name, args, flags, argsText, body };
};

const tokenize = (input) => {
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(input))) {
        if (m[1] !== undefined) tokens.push({ value: m[1], quoted: true });
        else if (m[2] !== undefined) tokens.push({ value: m[2], quoted: true });
        else tokens.push({ value: m[3], quoted: false });
    }
    return tokens;
};

/** Levenshtein distance, used for "did you mean" suggestions. */
export const distance = (a, b) => {
    if (a === b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length];
};

/** Closest known name within a small edit distance, or null. */
export const suggest = (input, names) => {
    let best = null;
    let bestScore = Infinity;
    for (const name of names) {
        const score = distance(input, name);
        if (score < bestScore) {
            best = name;
            bestScore = score;
        }
    }
    const limit = input.length <= 3 ? 1 : 2;
    return bestScore <= limit ? best : null;
};
