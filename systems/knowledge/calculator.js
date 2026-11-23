/**
 * Safe math evaluator (no eval). Supports + - * / % ^ ( ), implicit-free syntax,
 * × ÷ and Arabic digits, constants pi e, functions sqrt cbrt abs round floor ceil
 * sin cos tan asin acos atan (degrees), ln log log2 exp, factorial with "!",
 * and "x% of y" style percentages via "%" after a number (50% → 0.5).
 */

const FUNCS = {
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    sin: (d) => Math.sin((d * Math.PI) / 180),
    cos: (d) => Math.cos((d * Math.PI) / 180),
    tan: (d) => Math.tan((d * Math.PI) / 180),
    asin: (x) => (Math.asin(x) * 180) / Math.PI,
    acos: (x) => (Math.acos(x) * 180) / Math.PI,
    atan: (x) => (Math.atan(x) * 180) / Math.PI,
    ln: Math.log,
    log: Math.log10,
    log2: Math.log2,
    exp: Math.exp
};
const CONSTS = { pi: Math.PI, e: Math.E };

const normalize = (input) =>
    String(input)
        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .replace(/[×xX](?=\s*[\d(.])/g, '*')
        .replace(/÷/g, '/')
        .replace(/[−–]/g, '-')
        .replace(/\*\*/g, '^')
        .replace(/π/g, 'pi')
        .replace(/,/g, '')
        .toLowerCase();

const tokenize = (src) => {
    const tokens = [];
    const re = /\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z][a-z0-9]*|[-+*/^%()!])/y;
    let m;
    let i = 0;
    while (i < src.length) {
        re.lastIndex = i;
        m = re.exec(src);
        if (!m) {
            if (/\s/.test(src.slice(i))) break;
            throw new Error(`Unexpected "${src[i]}"`);
        }
        tokens.push(m[1]);
        i = re.lastIndex;
    }
    return tokens;
};

const factorial = (n) => {
    if (!Number.isInteger(n) || n < 0) throw new Error('Factorial needs a whole number ≥ 0');
    if (n > 170) return Infinity;
    let r = 1;
    for (let k = 2; k <= n; k += 1) r *= k;
    return r;
};

/** Recursive-descent parser. */
export const evaluate = (input) => {
    const src = normalize(input).trim();
    if (!src) throw new Error('Empty expression');
    if (src.length > 200) throw new Error('Expression too long');
    const t = tokenize(src);
    let p = 0;
    const peek = () => t[p];
    const take = (v) => {
        if (v !== undefined && t[p] !== v) throw new Error(`Expected "${v}"`);
        return t[p++];
    };

    const primary = () => {
        const tok = take();
        if (tok === undefined) throw new Error('Incomplete expression');
        if (/^[\d.]/.test(tok)) return Number(tok);
        if (tok === '(') {
            const v = expr();
            take(')');
            return v;
        }
        if (Object.hasOwn(CONSTS, tok)) return CONSTS[tok];
        if (Object.hasOwn(FUNCS, tok)) {
            const hasParen = peek() === '(';
            const arg = hasParen ? primary() : unary();
            return FUNCS[tok](arg);
        }
        throw new Error(`Unknown "${tok}"`);
    };
    const postfix = () => {
        let v = primary();
        for (;;) {
            if (peek() === '!') {
                take();
                v = factorial(v);
            } else if (peek() === '%' && !/^[\d.(a-z]/.test(t[p + 1] || '')) {
                take();
                v /= 100;
            } else return v;
        }
    };
    const power = () => {
        const base = postfix();
        if (peek() === '^') {
            take();
            return base ** unary(); // right-associative
        }
        return base;
    };
    const unary = () => {
        if (peek() === '-') {
            take();
            return -unary();
        }
        if (peek() === '+') {
            take();
            return unary();
        }
        return power();
    };
    const term = () => {
        let v = unary();
        while (['*', '/', '%'].includes(peek())) {
            const op = take();
            const r = unary();
            if (op === '*') v *= r;
            else if (op === '/') {
                if (r === 0) throw new Error('Division by zero');
                v /= r;
            } else v %= r;
        }
        return v;
    };
    const expr = () => {
        let v = term();
        while (peek() === '+' || peek() === '-') v = take() === '+' ? v + term() : v - term();
        return v;
    };

    const result = expr();
    if (p < t.length) throw new Error(`Unexpected "${t[p]}"`);
    if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
    return result;
};

export const formatNumber = (n) => {
    if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toLocaleString('en-US');
    const abs = Math.abs(n);
    if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return n.toExponential(8).replace(/\.?0+e/, 'e');
    return String(Number(n.toPrecision(12)));
};
