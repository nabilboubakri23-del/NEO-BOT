import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import docStore from '../database/docStore.js';
import { describeError } from '../../utils/errors.js';

const log = child('persist');

/**
 * Keeps code changes made from WhatsApp (.dev, .plugins install) across restarts.
 *
 * Hosts like Render reset the disk to the GitHub version on every deploy or restart,
 * so a file written at runtime disappears. Every change is therefore also saved in the
 * database (MongoDB when configured) and re-applied on boot, before commands load.
 *
 * Document "devFiles": { files: { "<relative path>": {
 *     content: string|null,   // null = the file was deleted
 *     base: string|null,      // hash of the repo version it replaced (null = did not exist)
 *     history: [{ content, at }], // up to 5 earlier versions, newest first (for restore)
 *     at, by
 * } } }
 *
 * On boot, for each entry:
 *   disk == content        → already there (on Render: pushed to GitHub, entry removed)
 *   disk == base           → repo unchanged: the change is applied again
 *   otherwise              → the repo changed that file since: repo wins, entry marked "conflict"
 */

const DOC = 'devFiles';
const MAX_FILES = 200;
const MAX_HISTORY = 5;
const ROOT = config.rootDir;
// Hosts whose disk is rebuilt from GitHub on every start. PERSIST_FRESH_DISK=true forces it.
const FRESH_DISK = process.env.PERSIST_FRESH_DISK ? process.env.PERSIST_FRESH_DISK === 'true' : Boolean(process.env.RENDER);

export const hashOf = (content) => (content === null || content === undefined ? null : crypto.createHash('sha256').update(content).digest('hex').slice(0, 16));

const absolute = (relative) => {
    const abs = path.resolve(ROOT, relative);
    const rel = path.relative(ROOT, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Unsafe path: ${relative}`);
    return abs;
};

const diskContent = async (relative) => {
    const abs = absolute(relative);
    return existsSync(abs) ? readFile(abs, 'utf8') : null;
};

const open = () => docStore.open(DOC, () => ({ files: {} }));

const persist = async () => {
    docStore.touch(DOC);
    await docStore.saveNow(DOC); // right away: a deploy may stop the process any second
};

/**
 * Records a change. Call with the content BEFORE the change (`previous`, null if the file
 * did not exist) and AFTER it (`content`, null for a delete).
 */
export const recordChange = async (relative, previous, content, by = '') => {
    try {
        const doc = await open();
        const key = relative.split(path.sep).join('/');
        const entry = doc.files[key];
        if (!entry && Object.keys(doc.files).length >= MAX_FILES) throw new Error(`More than ${MAX_FILES} changed files; push them to GitHub first.`);
        const history = [{ content: previous, at: new Date().toISOString() }, ...(entry?.history || [])].slice(0, MAX_HISTORY);
        doc.files[key] = {
            content,
            base: entry ? entry.base : hashOf(previous),
            history,
            at: new Date().toISOString(),
            by: String(by || '')
        };
        await persist();
        return true;
    } catch (error) {
        log.error(`Could not save ${relative} to the database: ${describeError(error)}`);
        return false;
    }
};

/** Takes the newest saved earlier version of a file (for restore after a restart), or undefined. */
export const popHistory = async (relative) => {
    const doc = await open();
    const entry = doc.files[relative.split(path.sep).join('/')];
    const last = entry?.history?.shift();
    if (last) await persist();
    return last;
};

/** Forgets a saved change: the GitHub version comes back on the next restart. */
export const forget = async (relative) => {
    const doc = await open();
    const key = relative.split(path.sep).join('/');
    if (!doc.files[key]) return false;
    delete doc.files[key];
    await persist();
    return true;
};

/** Saved changes with their state on this disk: applied | conflict | pending. */
export const listChanges = async () => {
    const doc = await open();
    const out = [];
    for (const [file, entry] of Object.entries(doc.files)) {
        const disk = await diskContent(file).catch(() => null);
        const state = hashOf(entry.content) === entry.base ? 'original' : hashOf(disk) === hashOf(entry.content) ? 'applied' : entry.conflict ? 'conflict' : 'pending';
        out.push({ file, state, deleted: entry.content === null, at: entry.at, by: entry.by });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
};

/** Saved content of one file (for .dev export / diff), or undefined. */
export const savedContent = async (relative) => (await open()).files[relative.split(path.sep).join('/')]?.content;

/** Re-applies every saved change to the disk. Run once at startup, before commands load. */
export const applySavedChanges = async () => {
    const doc = await open();
    const result = { applied: [], synced: [], conflicts: [] };
    let changed = false;
    for (const [file, entry] of Object.entries(doc.files)) {
        try {
            const abs = absolute(file);
            const disk = await diskContent(file);
            const diskHash = hashOf(disk);
            if (diskHash === hashOf(entry.content)) {
                // On a fresh-disk host (Render) this means the change was pushed to GitHub and
                // deployed: the saved copy is no longer needed. On a host that keeps its disk
                // (Termux, VPS) the file is simply still there, so the copy is kept for the others.
                if (FRESH_DISK) delete doc.files[file];
                else delete entry.conflict;
                changed = true;
                result.synced.push(file);
                continue;
            }
            if (diskHash !== entry.base) {
                if (!entry.conflict) changed = true;
                entry.conflict = true;
                result.conflicts.push(file);
                continue;
            }
            if (entry.content === null) await rm(abs, { force: true });
            else {
                await mkdir(path.dirname(abs), { recursive: true });
                await writeFile(abs, entry.content, 'utf8');
            }
            delete entry.conflict;
            result.applied.push(file);
        } catch (error) {
            log.error(`Could not re-apply ${file}: ${describeError(error)}`);
        }
    }
    if (changed) await persist();
    if (result.applied.length || result.conflicts.length) log.info(result, 'Saved code changes re-applied.');
    return result;
};
