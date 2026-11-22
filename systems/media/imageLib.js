import { UserError } from '../../utils/errors.js';

/**
 * Profile / group pictures go through Baileys' generateProfilePicture, which needs
 * the optional "jimp" (pure JS) or "sharp" package. They are not bundled to keep the
 * install small; this check turns their absence into a clear message.
 */

let available = null;

export const hasImageLib = async () => {
    if (available !== null) return available;
    const found = await Promise.all([import('jimp').then(() => true, () => false), import('sharp').then(() => true, () => false)]);
    available = found.some(Boolean);
    return available;
};

export const requireImageLib = async () => {
    if (!(await hasImageLib())) throw new UserError('Changing pictures needs the optional "jimp" package on the server: run npm install jimp, then restart.');
};
