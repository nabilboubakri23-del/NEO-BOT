/**
 * Tic-tac-toe rules and a perfect bot opponent (minimax). Pure, no I/O.
 * Board: array of 9 cells, each null | 'X' | 'O'. Cells are numbered 1–9 for players.
 */

export const LINES = Object.freeze([
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
]);

export const newBoard = () => Array(9).fill(null);

export const winner = (board) => {
    for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    return null;
};

export const isFull = (board) => board.every(Boolean);

/** 'X' | 'O' | 'draw' | null (game goes on). */
export const outcome = (board) => winner(board) || (isFull(board) ? 'draw' : null);

/**
 * Plays `mark` on cell `n` (1–9).
 * @returns {{ ok: true, board } | { ok: false, reason: 'invalid'|'taken'|'over' }}
 */
export const play = (board, n, mark) => {
    if (outcome(board)) return { ok: false, reason: 'over' };
    const i = Number(n) - 1;
    if (!Number.isInteger(i) || i < 0 || i > 8) return { ok: false, reason: 'invalid' };
    if (board[i]) return { ok: false, reason: 'taken' };
    const next = [...board];
    next[i] = mark;
    return { ok: true, board: next };
};

export const other = (mark) => (mark === 'X' ? 'O' : 'X');

const score = (board, me, turn, depth) => {
    const result = outcome(board);
    if (result === me) return 10 - depth;
    if (result === other(me)) return depth - 10;
    if (result === 'draw') return 0;
    let best = turn === me ? -Infinity : Infinity;
    for (let i = 0; i < 9; i++) {
        if (board[i]) continue;
        board[i] = turn;
        const s = score(board, me, other(turn), depth + 1);
        board[i] = null;
        best = turn === me ? Math.max(best, s) : Math.min(best, s);
    }
    return best;
};

/** Best cell (1–9) for `mark` to play; never loses. */
export const bestMove = (board, mark) => {
    const work = [...board];
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 9; i++) {
        if (work[i]) continue;
        work[i] = mark;
        const s = score(work, mark, other(mark), 1);
        work[i] = null;
        if (s > bestScore) {
            bestScore = s;
            best = i + 1;
        }
    }
    return best;
};

const CELL = { X: '❌', O: '⭕' };
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

/** The board as three emoji rows. */
export const render = (board) => [0, 3, 6].map((r) => board.slice(r, r + 3).map((c, k) => CELL[c] || NUM[r + k]).join(' ')).join('\n');
