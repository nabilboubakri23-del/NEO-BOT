import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../../config/config.js';
import { ValidationError } from '../../utils/errors.js';
import { popHistory, recordChange } from './persistentFiles.js';

/**
 * DevTools workspace.
 * Every remote file operation goes through here, so one place decides
 * what the owner may see and change from WhatsApp.
 *
 * - Paths are always resolved inside the project root (no "../" escapes).
 * - Secrets (.env, encrypted sessions) and internals (.git, node_modules) are hidden.
 * - Every overwrite keeps a backup; every delete moves the file to the trash.
 * - Every change is also saved in the database, so it survives restarts and redeploys.
 */

const ROOT = config.rootDir;
const DEV_DIR = path.join(ROOT, 'storage', 'devtools');
export const BACKUP_DIR = path.join(DEV_DIR, 'backups');
export const TRASH_DIR = path.join(DEV_DIR, 'trash');

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 256 * 1024;

const HIDDEN_SEGMENTS = new Set(['.git', 'node_modules', 'sessions', 'devtools']);
const HIDDEN_FILES = [/^\.env(\..*)?$/i, /\.enc$/i, /\.pem$/i, /\.key$/i];
const WRITABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt']);

const isHidden = (relative) => {
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.some((part) => HIDDEN_SEGMENTS.has(part))) return true;
    const base = parts.at(-1) || '';
    return base !== '.env.example' && HIDDEN_FILES.some((re) => re.test(base));
};

/** Resolves a user-supplied path inside the project. Throws on anything outside or protected. */
export const resolveSafe = (input = '.') => {
    const cleaned = String(input).trim().replace(/^\/+/, '') || '.';
    const absolute = path.resolve(ROOT, cleaned);
    const relative = path.relative(ROOT, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ValidationError('Path is outside the bot folder.');
    }
    if (relative && isHidden(relative)) throw new ValidationError('This path is protected.');
    return { absolute, relative: relative || '.' };
};

const assertWritable = (relative) => {
    const ext = path.extname(relative).toLowerCase();
    if (!WRITABLE_EXTENSIONS.has(ext)) {
        throw new ValidationError(`Only ${[...WRITABLE_EXTENSIONS].join(' ')} files can be written.`);
    }
    if (relative === 'package-lock.json') throw new ValidationError('package-lock.json is managed by npm.');
};

const exists = (p) => stat(p).then(() => true, () => false);

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const flatName = (relative) => relative.split(path.sep).join('__');

/** Lists one directory: folders first, then files, with sizes. */
export const listDir = async (input = '.') => {
    const { absolute, relative } = resolveSafe(input);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new ValidationError(`Not found: ${relative}`);
    if (!info.isDirectory()) throw new ValidationError(`${relative} is a file. Use "cat" to read it.`);

    const entries = await readdir(absolute, { withFileTypes: true });
    const visible = entries.filter((e) => !isHidden(path.join(relative === '.' ? '' : relative, e.name)));
    const dirs = visible.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const files = await Promise.all(
        visible
            .filter((e) => e.isFile())
            .map(async (e) => ({ name: e.name, size: (await stat(path.join(absolute, e.name))).size }))
    );
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { path: relative, dirs, files };
};

/** Builds an indented tree of the project (depth limited). */
export const tree = async (input = '.', maxDepth = 3) => {
    const lines = [];
    const walk = async (rel, depth, indent) => {
        if (depth > maxDepth) return;
        const { dirs, files } = await listDir(rel);
        for (const dir of dirs) {
            lines.push(`${indent}📁 ${dir}/`);
            await walk(path.join(rel, dir), depth + 1, `${indent}  `);
        }
        for (const file of files) lines.push(`${indent}📄 ${file.name}`);
    };
    const { relative } = resolveSafe(input);
    await walk(relative, 1, '');
    return lines;
};

export const readText = async (input) => {
    const { absolute, relative } = resolveSafe(input);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new ValidationError(`File not found: ${relative}`);
    if (info.size > MAX_READ_BYTES) throw new ValidationError(`File too large to read (${info.size} bytes).`);
    return { relative, absolute, content: await readFile(absolute, 'utf8'), size: info.size };
};

export const fileExists = async (input) => exists(resolveSafe(input).absolute);

/** Copies the current version of a file into the backup folder. Returns the backup name or null. */
export const backup = async (relative) => {
    const absolute = path.join(ROOT, relative);
    if (!(await exists(absolute))) return null;
    await mkdir(BACKUP_DIR, { recursive: true });
    const name = `${flatName(relative)}@${stamp()}`;
    await copyFile(absolute, path.join(BACKUP_DIR, name));
    return name;
};

/** Writes a file (creating folders), keeping a backup of the previous version. */
export const writeText = async (input, content, by = '') => {
    const { absolute, relative } = resolveSafe(input);
    assertWritable(relative);
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ValidationError('Content is too large.');
    const previous = (await exists(absolute)) ? await readFile(absolute, 'utf8') : null;
    const backupName = await backup(relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
    const persisted = await recordChange(relative, previous, content, by);
    return { relative, backupName, created: previous === null, persisted };
};

/** Moves a file to the trash (never a hard delete). */
export const trash = async (input, by = '') => {
    const { absolute, relative } = resolveSafe(input);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new ValidationError(`File not found: ${relative}`);
    const previous = info.size <= MAX_WRITE_BYTES ? await readFile(absolute, 'utf8') : null;
    await mkdir(TRASH_DIR, { recursive: true });
    const name = `${flatName(relative)}@${stamp()}`;
    await rename(absolute, path.join(TRASH_DIR, name)).catch(async () => {
        await copyFile(absolute, path.join(TRASH_DIR, name));
        await rm(absolute);
    });
    const persisted = await recordChange(relative, previous, null, by);
    return { relative, trashName: name, persisted };
};

/** Backups (newest first) for one file. */
export const listBackups = async (input) => {
    const { relative } = resolveSafe(input);
    const prefix = `${flatName(relative)}@`;
    const names = await readdir(BACKUP_DIR).catch(() => []);
    return names.filter((n) => n.startsWith(prefix)).sort().reverse();
};

/** Restores the newest backup (or the trashed copy) of a file. */
export const restore = async (input) => {
    const { absolute, relative } = resolveSafe(input);
    assertWritable(relative);
    const prefix = `${flatName(relative)}@`;
    const [latestBackup] = await listBackups(relative);
    const trashed = latestBackup
        ? null
        : (await readdir(TRASH_DIR).catch(() => [])).filter((n) => n.startsWith(prefix)).sort().reverse()[0];

    const source = latestBackup ? path.join(BACKUP_DIR, latestBackup) : trashed ? path.join(TRASH_DIR, trashed) : null;
    const previous = (await exists(absolute)) ? await readFile(absolute, 'utf8') : null;
    if (!source) {
        // Local backups are gone after a restart on Render: use the copy kept in the database.
        const saved = await popHistory(relative);
        if (!saved) throw new ValidationError(`No backup found for ${relative}.`);
        if (saved.content === null) await rm(absolute, { force: true });
        else {
            await mkdir(path.dirname(absolute), { recursive: true });
            await writeFile(absolute, saved.content, 'utf8');
        }
        await recordChange(relative, previous, saved.content, 'restore');
        await popHistory(relative); // recordChange pushed the replaced version; keep stepping back
        return { relative, from: 'database', deleted: saved.content === null };
    }

    const content = await readFile(source, 'utf8');
    // The version being replaced goes to the trash, so repeated restores keep stepping back.
    if (await exists(absolute)) {
        await mkdir(TRASH_DIR, { recursive: true });
        await copyFile(absolute, path.join(TRASH_DIR, `${flatName(relative)}@${stamp()}`));
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
    await rm(source); // consume it so repeated restores step further back
    await recordChange(relative, previous, content, 'restore');
    return { relative, from: latestBackup ? 'backup' : 'trash' };
};
