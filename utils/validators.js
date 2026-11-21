import { ValidationError } from './errors.js';

/**
 * Normalizes and validates an international phone number.
 * Accepts "+212 6XX-XXX XXX", "00212...", "212..." and returns digits only.
 */
export const normalizePhoneNumber = (input) => {
    if (typeof input !== 'string' || !input.trim()) {
        throw new ValidationError('Phone number is required.');
    }

    let digits = input.trim().replace(/[\s\-().]/g, '');
    if (digits.startsWith('+')) digits = digits.slice(1);
    else if (digits.startsWith('00')) digits = digits.slice(2);

    if (!/^\d+$/.test(digits)) {
        throw new ValidationError('Phone number must contain digits only.');
    }
    if (digits.startsWith('0')) {
        throw new ValidationError('Include your country code. Example: 212XXXXXXXXX');
    }
    // E.164: max 15 digits; realistic minimum with country code: 10
    if (digits.length < 10 || digits.length > 15) {
        throw new ValidationError('Invalid phone number length. Include your country code.');
    }
    return digits;
};

export const isValidAuthChoice = (value) => ['1', '2'].includes(String(value).trim());

export const isHexKey = (value, bytes = 32) =>
    typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value);
