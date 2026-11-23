import { verifyExtractorOnce } from './commands/download/.verification.js';
import config from './config/config.js';
import logger from './core/logger.js';
import connectionManager from './core/connection.js';
import authentication from './core/authentication.js';
import sessionManager from './core/sessionManager.js';
import commandHandler from './core/commandHandler.js';
import { handleUpsert } from './core/messageHandler.js';
import { setUnlinkHandler, startSetupServer, stopSetupServer } from './core/setupServer.js';
import { startKeepAlive, stopKeepAlive } from './core/keepAlive.js';
import { startSessionCleaner, stopSessionCleaner } from './systems/session/sessionCleaner.js';
import { assertEncryptionReady } from './systems/security/encryption.js';
import { describeError } from './utils/errors.js';
import { terminalFrame } from './utils/formatter.js';
import { createClaimCode, initOwners, loadOwners } from './systems/owners/ownerStore.js';
import { applySavedChanges } from './systems/devtools/persistentFiles.js';
import docStore from './systems/database/docStore.js';
import { loadSettings } from './systems/settings/settingsStore.js';
import { loadUsers } from './systems/users/userStore.js';
import { loadStats } from './systems/stats/statsStore.js';
import pluginManager from './systems/plugins/pluginManager.js';
import { loadPermissions } from './systems/permissions/index.js';
import { installModerationGuard, loadModeration } from './systems/moderation/index.js';
import { loadEconomy } from './systems/economy/economyStore.js';

const log = logger.child({ module: 'main' });

/** Chooses an auth method (when needed) and starts the connection. */
const authenticateAndConnect = async ({ allowEnv = true } = {}) => {
    if (await sessionManager.hasValidSession()) {
        log.info('Saved session found. Restoring authentication.');
        return connectionManager.start(null);
    }
    log.info('No valid session found.');
    await sessionManager.deleteSession(); // clear partial/unfinished links
    const choice = await authentication.chooseMethod({ allowEnv });
    return connectionManager.start(choice);
};

const fatal = async (message, error) => {
    log.fatal(`${message}${error ? `: ${describeError(error)}` : ''}`);
    stopKeepAlive();
    stopSessionCleaner();
    await connectionManager.stop();
    await stopSetupServer();
    await sessionManager.close();
    await docStore.close().catch(() => {});
    process.exit(1);
};

const main = async () => {
    log.info({ version: config.bot.version }, `Starting ${config.bot.name}...`);

    if (process.argv.includes('--reset-session')) {
        assertEncryptionReady();
        await sessionManager.deleteSession();
        log.warn('Session reset requested. You will be asked to link WhatsApp again.');
    }

    assertEncryptionReady();
    loadOwners();
    await docStore.init();
    await initOwners(); // owners live in the database: survive redeploys
    await applySavedChanges().catch((error) => log.error(`Saved code changes not applied: ${describeError(error)}`)); // before commands load
    await Promise.all([loadSettings(), loadUsers(), loadStats(), loadPermissions(), loadModeration(), loadEconomy()]);
    installModerationGuard(); // before plugins, so removed messages never reach plugin hooks
    pluginManager.attach(commandHandler);
    await pluginManager.load(); // also (re)loads commands, merging plugin commands in
    setUnlinkHandler(() => connectionManager.unlink());
    startSetupServer();
    startKeepAlive();
    startSessionCleaner();
    verifyExtractorOnce().catch(() => log.error('Download verification is unknown; affected platforms remain disabled.'));

    connectionManager.on('messages', (sock, upsert) => {
        handleUpsert(sock, upsert).catch((error) => log.error(`Upsert failed: ${describeError(error)}`));
    });

    let authAttempts = 0;
    connectionManager.on('open', () => {
        authAttempts = 0;
        const claim = createClaimCode();
        if (claim) {
            // Printed only to the terminal, never to WhatsApp: proves the claimer controls the server.
            console.log(terminalFrame('NO MAIN OWNER SET', ['From your own WhatsApp send:', '', `${config.bot.prefix}owner claim ${claim}`, '', 'to the bot (private chat or group).']));
        }
    });
    connectionManager.on('auth-required', () => {
        authAttempts += 1;
        log.warn('Returning to authentication selection.');
        // Env-based method is retried at most 3 times, then the user is asked interactively.
        authenticateAndConnect({ allowEnv: authAttempts < 3 }).catch((error) => fatal('Authentication failed', error));
    });
    connectionManager.on('stopped', (reason) => {
        log.error({ reason }, 'Connection stopped permanently.');
        if (reason === 'session_integrity') fatal('Session data could not be verified');
    });

    await authenticateAndConnect();
};

const shutdown = async (signal) => {
    log.info({ signal }, 'Shutting down gracefully.');
    stopKeepAlive();
    await connectionManager.stop();
    await stopSetupServer();
    await sessionManager.close();
    await docStore.close().catch(() => {});
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error(`Unhandled rejection: ${describeError(reason)}`));
process.on('uncaughtException', (error) => log.error(`Uncaught exception: ${describeError(error)}`));

main().catch((error) => fatal('Startup failed', error));
