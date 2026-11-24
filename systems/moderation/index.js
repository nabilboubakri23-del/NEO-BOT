import { loadGroupConfig } from './groupConfig.js';
import { loadMutes } from './mutes.js';
import { loadWarnings } from './warnings.js';
import { loadKnownBots } from './knownBots.js';
import { loadCustomWords } from './profanity/customWords.js';

/** Loads every moderation store (group options, warnings, mutes). */
export const loadModeration = () => Promise.all([loadGroupConfig(), loadWarnings(), loadMutes(), loadCustomWords(), loadKnownBots()]);

export { installModerationGuard } from './guard.js';
