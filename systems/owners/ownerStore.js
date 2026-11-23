import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import config from '../../config/config.js';
import docStore from '../database/docStore.js';

/**
 * Owner registry, kept in its own file: data/owners.json
 *
 * {
 *   "owner":  { "number": "2126XXXXXXXX", "lid": "1234567890" },   ← main owner
 *   "admins": [ { "number": "...", "lid": "...", "name": "...", "addedAt": "..." } ]
 * }
 *
 * - The main owner and every admin have full owner permissions.
 * - Only the main owner can add or remove admins.
 * - OWNER_NUMBERS from .env still works as extra main owners.
 * - Numbers are digits only (international, no "+"). A LID is used when WhatsApp hides the number.
 * - The list is also kept in the database (document "owners", MongoDB on Render), which wins
 *   at startup: Render wipes data/ on every deploy, so the file alone would forget new owners.
 */

export const OWNERS_FILE = path.join(config.rootDir, 'data', 'owners.json');

const digits = (value) => String(value || '').replace(/\D/g, '');
const EMPTY = () => ({ owner: { number: '', lid: '' }, admins: [] });

let state = EMPTY();
let claimCode = '';

const normalize = (raw) => {
    const data = EMPTY();
    data.owner.number = digits(raw?.owner?.number);
    data.owner.lid = digits(raw?.owner?.lid);
    data.admins = (Array.isArray(raw?.admins) ? raw.admins : [])
        .map((a) => ({ number: digits(a.number), lid: digits(a.lid), name: String(a.name || ''), addedAt: a.addedAt || '' }))
        .filter((a) => a.number || a.lid);
    return data;
};

const DOC = 'owners';
let doc = null; // live database document once initOwners() ran

const hasData = (data) => Boolean(data?.owner?.number || data?.owner?.lid || data?.admins?.length);

const saveFile = async () => {
    await mkdir(path.dirname(OWNERS_FILE), { recursive: true });
    const tmp = `${OWNERS_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 4)}\n`, 'utf8');
    await rename(tmp, OWNERS_FILE); // atomic replace
};

const save = async () => {
    if (doc) {
        doc.owner = structuredClone(state.owner);
        doc.admins = structuredClone(state.admins);
        await docStore.saveNow(DOC); // at once: a redeploy may stop the process any second
    }
    await saveFile().catch(() => {}); // local copy (read-only or wiped disks are fine)
};

/**
 * Loads the owners from the database (after docStore.init()). The database wins;
 * an existing data/owners.json is migrated into it the first time.
 */
export const initOwners = async () => {
    doc = await docStore.open(DOC, () => ({ owner: { number: '', lid: '' }, admins: [] }));
    if (hasData(doc)) {
        const fromDb = normalize(doc);
        // Keep anyone only the local file knows (e.g. added before this version), then save both.
        for (const admin of state.admins) {
            const list = [admin.number, admin.lid].filter(Boolean);
            if (!fromDb.admins.some((a) => matches(a, list)) && !matches(fromDb.owner, list)) fromDb.admins.push(admin);
        }
        if (!fromDb.owner.number && !fromDb.owner.lid) fromDb.owner = state.owner;
        state = fromDb;
    }
    if (!state.owner.number && !state.owner.lid && config.owner.main) state.owner.number = config.owner.main;
    if (hasData(state)) await save();
    return state;
};

/** Loads (or reloads) the file. Called at startup and whenever the file may have changed. */
export const loadOwners = () => {
    state = existsSync(OWNERS_FILE) ? normalize(JSON.parse(readFileSync(OWNERS_FILE, 'utf8'))) : EMPTY();
    // Seed the configured main owner when the file has none yet.
    if (!state.owner.number && !state.owner.lid && config.owner.main) {
        state.owner.number = config.owner.main;
        saveFile().catch(() => {}); // the database copy is merged by initOwners()
    }
    return state;
};

const ids = (who) => [digits(who.senderNumber), digits(who.senderLid)].filter(Boolean);
const matches = (entry, list) => Boolean((entry.number && list.includes(entry.number)) || (entry.lid && list.includes(entry.lid)));

export const hasMainOwner = () => Boolean(state.owner.number || state.owner.lid || config.owner.numbers.length);

export const isMainOwner = (message) => {
    const list = ids(message);
    return matches(state.owner, list) || config.owner.numbers.some((n) => list.includes(n));
};

export const isAdmin = (message) => {
    const list = ids(message);
    return state.admins.some((a) => matches(a, list));
};

/** Full owner permissions: main owner, admins, or the linked bot account itself. */
export const isOwner = (message) => Boolean(message.fromMe) || isMainOwner(message) || isAdmin(message);

export const getOwners = () => structuredClone(state);

/**
 * Keeps the missing half (number or LID) of a known owner/admin up to date,
 * so they are recognised both in private chats and in groups.
 */
export const learnIdentity = async (message) => {
    const number = digits(message.senderNumber);
    const lid = digits(message.senderLid);
    if (!number || !lid || number === lid) return;
    let changed = false;
    for (const entry of [state.owner, ...state.admins]) {
        if (entry.number === number && entry.lid !== lid) {
            entry.lid = lid;
            changed = true;
        } else if (entry.lid === lid && entry.number !== number) {
            entry.number = number;
            changed = true;
        }
    }
    if (changed) await save();
};

export const addAdmin = async ({ number = '', lid = '', name = '' }) => {
    const entry = { number: digits(number), lid: digits(lid), name, addedAt: new Date().toISOString() };
    if (!entry.number && !entry.lid) throw new Error('No number given.');
    const list = [entry.number, entry.lid].filter(Boolean);
    if (matches(state.owner, list)) throw new Error('This is already the main owner.');
    if (state.admins.some((a) => matches(a, list))) throw new Error('Already an owner.');
    state.admins.push(entry);
    await save();
    return entry;
};

export const removeAdmin = async (value) => {
    const key = digits(value);
    const index = state.admins.findIndex((a) => a.number === key || a.lid === key);
    if (index === -1) throw new Error('Not in the owners list.');
    const [removed] = state.admins.splice(index, 1);
    await save();
    return removed;
};

/** Sets the main owner (used by the one-time claim, or by the current main owner). */
export const setMainOwner = async ({ number = '', lid = '' }) => {
    state.owner = { number: digits(number), lid: digits(lid) };
    const list = [state.owner.number, state.owner.lid].filter(Boolean);
    state.admins = state.admins.filter((a) => !matches(a, list));
    claimCode = '';
    await save();
    return state.owner;
};

/**
 * When no main owner exists, a one-time claim code is printed in the terminal.
 * Whoever sends ".owner claim <code>" from WhatsApp becomes the main owner.
 */
export const createClaimCode = () => {
    if (hasMainOwner()) return '';
    claimCode ||= crypto.randomInt(100000, 999999).toString();
    return claimCode;
};

export const checkClaimCode = (code) => {
    if (!claimCode || !code) return false;
    const a = Buffer.from(String(code).trim());
    const b = Buffer.from(claimCode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};
