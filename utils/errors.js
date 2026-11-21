export class NeoError extends Error {
    constructor(message, code = 'NEO_ERROR') {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
    }
}

export class ConfigError extends NeoError {
    constructor(message) {
        super(message, 'CONFIG_ERROR');
    }
}

export class EncryptionError extends NeoError {
    constructor(message) {
        super(message, 'ENCRYPTION_ERROR');
    }
}

export class SessionIntegrityError extends NeoError {
    constructor(message) {
        super(message, 'SESSION_INTEGRITY_ERROR');
    }
}

export class AuthenticationError extends NeoError {
    constructor(message) {
        super(message, 'AUTHENTICATION_ERROR');
    }
}

export class ValidationError extends NeoError {
    constructor(message) {
        super(message, 'VALIDATION_ERROR');
    }
}

/**
 * Errors a command throws on purpose. Their message is safe to show to the user.
 * The command engine turns them into a clean reply instead of a generic failure.
 */
export class UserError extends NeoError {
    constructor(message, code = 'USER_ERROR') {
        super(message, code);
        this.expose = true;
    }
}

/** Wrong or missing arguments: the engine replies with the command's usage. */
export class UsageError extends UserError {
    constructor(message = '') {
        super(message, 'USAGE_ERROR');
    }
}

/** Returns a short, safe description of any error (never dumps objects). */
export const describeError = (error) => {
    if (!error) return 'Unknown error';
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
};
