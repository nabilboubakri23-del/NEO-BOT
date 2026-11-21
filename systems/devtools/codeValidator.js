import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Code validation for remote edits.
 * Nothing reaches the real file until it passes these checks, so a typo
 * sent from WhatsApp can never break the running bot.
 */

const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const isValidCommandName = (name) => COMMAND_NAME.test(String(name || ''));

/** Writes code next to its final location (so relative imports resolve) under a temporary .mjs name. */
const stage = async (targetAbsolute, code) => {
    const staged = path.join(path.dirname(targetAbsolute), `.staging-${crypto.randomBytes(4).toString('hex')}.mjs`);
    await writeFile(staged, code, 'utf8');
    return staged;
};

/** Syntax check with the real Node parser. Returns { ok, error }. */
export const checkSyntax = async (targetAbsolute, code) => {
    const ext = path.extname(targetAbsolute).toLowerCase();
    if (ext === '.json') {
        try {
            JSON.parse(code);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    }
    if (!['.js', '.mjs', '.cjs'].includes(ext)) return { ok: true };

    const staged = await stage(targetAbsolute, code);
    try {
        await run(process.execPath, ['--check', staged], { timeout: 15000 });
        return { ok: true };
    } catch (error) {
        const detail = String(error.stderr || error.message)
            .split('\n')
            .filter((line) => line.trim() && !line.includes('.staging-') && !line.startsWith('Node.js') && !/^\s+at /.test(line))
            .slice(0, 6)
            .join('\n');
        return { ok: false, error: detail || 'Syntax error.' };
    } finally {
        await rm(staged, { force: true });
    }
};

/**
 * Imports a command module from a staged copy and checks its shape.
 * Returns { ok, error, command } where command = { name, aliases, category, permissions }.
 */
export const checkCommandModule = async (targetAbsolute, code) => {
    const syntax = await checkSyntax(targetAbsolute, code);
    if (!syntax.ok) return syntax;

    const staged = await stage(targetAbsolute, code);
    try {
        const mod = (await import(`${pathToFileURL(staged).href}?v=${Date.now()}`)).default;
        if (!mod || typeof mod !== 'object') return { ok: false, error: 'The file must have "export default { ... }".' };
        if (!isValidCommandName(mod.name)) return { ok: false, error: 'Missing or invalid "name" (a-z, 0-9, _ or -).' };
        if (typeof mod.execute !== 'function') return { ok: false, error: 'Missing "async execute(sock, message, args)".' };
        if (mod.aliases && !Array.isArray(mod.aliases)) return { ok: false, error: '"aliases" must be an array.' };
        if (mod.permissions && !Array.isArray(mod.permissions)) return { ok: false, error: '"permissions" must be an array.' };
        return {
            ok: true,
            command: {
                name: mod.name.toLowerCase(),
                aliases: (mod.aliases || []).map((a) => String(a).toLowerCase()),
                category: mod.category || 'general',
                permissions: mod.permissions || ['user']
            }
        };
    } catch (error) {
        return { ok: false, error: `Import failed: ${error.message}` };
    } finally {
        await rm(staged, { force: true });
    }
};
