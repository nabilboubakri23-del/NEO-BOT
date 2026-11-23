import { FlowSessions } from '../../systems/interaction/flowSessions.js';

/** Spotify menu state: one session per (chat, sender); see systems/interaction/flowSessions.js. */
export class SpotifySessions extends FlowSessions {
    constructor(now = Date.now) {
        super({ name: 'Spotify', command: 'spotify', now });
    }
}

export const spotifySessions = new SpotifySessions();
