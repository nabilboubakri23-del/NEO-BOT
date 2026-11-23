/** Races a promise against a deadline; the loser is ignored. Rejects with { timeout: true }. */
export const withTimeout = (promise, ms, message = 'timed out') => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(message), { timeout: true })), ms); })
    ]).finally(() => clearTimeout(timer));
};
