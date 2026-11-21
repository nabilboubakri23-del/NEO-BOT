import { loadAudit } from './auditLog.js';
import { loadCommandOverrides } from './commandOverrides.js';
import { loadDailyUsage } from './dailyLimit.js';
import { loadRanks } from './rankStore.js';

/** Opens every permission document (ranks, overrides, usage, audit) at startup. */
export const loadPermissions = () => Promise.all([loadAudit(), loadRanks(), loadCommandOverrides(), loadDailyUsage()]);
