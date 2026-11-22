import { loadGroupConfig } from './groupConfig.js';
import { loadMutes } from './mutes.js';
import { loadWarnings } from './warnings.js';

/** Loads every moderation store (group options, warnings, mutes). */
export const loadModeration = () => Promise.all([loadGroupConfig(), loadWarnings(), loadMutes()]);

export { installModerationGuard } from './guard.js';
