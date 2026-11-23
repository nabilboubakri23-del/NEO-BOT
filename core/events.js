import { child } from './logger.js';
import { describeError } from '../utils/errors.js';

const log = child('events');

/**
 * Central event bus (hook system).
 *
 * Decouples the core from everything that wants to react to it: plugins,
 * future systems, metrics. Core modules emit named lifecycle events and any
 * number of listeners handle them without the core knowing they exist.
 *
 * Known events (payload in parentheses):
 *   'message'            ({ sock, message })        every incoming message, before routing
 *   'message:self'       ({ sock, message })        the linked account's own non-command message
 *   'command:before'     ({ sock, message, command, ctx })  a command is about to run (barrier)
 *   'command:after'      ({ sock, message, command, ctx, ok, ms })  a command finished
 *   'command:error'      ({ sock, message, command, error })  a command threw
 *   'group:participants' ({ sock, update })         add / remove / promote / demote
 *   'connection:open'    ({ sock })                 WhatsApp connection established
 *   'plugins:reloaded'   ({ loaded, failed })       plugin set (re)loaded
 *
 * Listeners may be async; the bus awaits them and isolates failures so one bad
 * listener never breaks the core or the other listeners. Each listener may be
 * tagged, so a whole group (e.g. all plugin hooks) can be removed at once on
 * reload with offTag().
 */
class EventBus {
    constructor() {
        this.listeners = new Map(); // event → Set<{ fn, tag }>
    }

    on(event, fn, { tag = null } = {}) {
        if (typeof fn !== 'function') throw new TypeError('Event listener must be a function.');
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        const entry = { fn, tag };
        this.listeners.get(event).add(entry);
        return () => this.listeners.get(event)?.delete(entry);
    }

    off(event, fn) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const entry of set) if (entry.fn === fn) set.delete(entry);
    }

    /** Removes every listener added with this tag, across all events. */
    offTag(tag) {
        let removed = 0;
        for (const set of this.listeners.values()) {
            for (const entry of set) {
                if (entry.tag === tag) {
                    set.delete(entry);
                    removed += 1;
                }
            }
        }
        return removed;
    }

    /** Runs every listener for an event. Failures are logged, never thrown. */
    async emit(event, payload) {
        const set = this.listeners.get(event);
        if (!set || !set.size) return [];
        const results = [];
        for (const { fn, tag } of [...set]) {
            try {
                results.push(await fn(payload));
            } catch (error) {
                log.error({ event, tag }, `Listener failed: ${describeError(error)}`);
            }
        }
        return results;
    }

    /**
     * Like emit, but any listener returning exactly false vetoes the action.
     * Used for 'command:before' so a plugin can block a command from running.
     */
    async barrier(event, payload) {
        const set = this.listeners.get(event);
        if (!set || !set.size) return true;
        for (const { fn, tag } of [...set]) {
            try {
                if ((await fn(payload)) === false) return false;
            } catch (error) {
                log.error({ event, tag }, `Barrier listener failed: ${describeError(error)}`);
            }
        }
        return true;
    }

    count(event) {
        return event ? this.listeners.get(event)?.size || 0 : [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
    }
}

const events = new EventBus();
export default events;
export { EventBus };
