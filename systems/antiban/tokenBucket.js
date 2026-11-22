/** Token bucket: `capacity` tokens, refilled at `perMs` per token. Pure apart from the clock. */
export class TokenBucket {
    constructor({ capacity, refillPerMinute, now = () => Date.now() }) {
        this.capacity = Math.max(1, capacity);
        this.msPerToken = 60_000 / Math.max(1, refillPerMinute);
        this.tokens = this.capacity;
        this.now = now;
        this.updated = now();
    }

    #refill() {
        const t = this.now();
        this.tokens = Math.min(this.capacity, this.tokens + (t - this.updated) / this.msPerToken);
        this.updated = t;
    }

    /** Milliseconds until one token is available (0 = now). */
    waitTime() {
        this.#refill();
        return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * this.msPerToken);
    }

    take() {
        this.#refill();
        this.tokens -= 1;
    }
}
