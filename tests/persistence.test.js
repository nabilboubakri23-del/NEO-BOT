// Runtime changes (.dev files, plugin installs, owners) survive a fresh disk. Offline.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryBackend } from './helpers.js';

process.env.PERSIST_FRESH_DISK = 'true';
const config = (await import('../config/config.js')).default;
const docStore = (await import('../systems/database/docStore.js')).default;
const persist = await import('../systems/devtools/persistentFiles.js');
const ws = await import('../systems/devtools/workspace.js');
const owners = await import('../systems/owners/ownerStore.js');

const DIR = 'commands/zz_persist_test';
const FILE = `${DIR}/hello.js`;
const ABS = path.join(config.rootDir, FILE);

before(async () => {
    await docStore.init(new MemoryBackend());
});
after(async () => {
    await rm(path.join(config.rootDir, DIR), { recursive: true, force: true });
    await rm(path.join(config.rootDir, 'storage', 'devtools'), { recursive: true, force: true });
});

test('a file written from WhatsApp comes back after the disk is reset', async () => {
    const result = await ws.writeText(FILE, 'export default 1;\n', '2126');
    assert.equal(result.persisted, true);
    await rm(path.join(config.rootDir, DIR), { recursive: true, force: true }); // "redeploy"
    const applied = await persist.applySavedChanges();
    assert.deepEqual(applied.applied, [FILE]);
    assert.equal(await readFile(ABS, 'utf8'), 'export default 1;\n');
    const list = await persist.listChanges();
    assert.equal(list.find((c) => c.file === FILE).state, 'applied');
});

test('a delete is kept; restore works from the database once local backups are gone', async () => {
    await ws.writeText(FILE, 'export default 2;\n');
    await ws.trash(FILE);
    assert.equal(existsSync(ABS), false);
    await rm(path.join(config.rootDir, 'storage', 'devtools'), { recursive: true, force: true }); // backups wiped
    const restored = await ws.restore(FILE);
    assert.equal(restored.from, 'database');
    assert.equal(await readFile(ABS, 'utf8'), 'export default 2;\n');
});

test('when GitHub changes the same file, GitHub wins and the change is flagged', async () => {
    await mkdir(path.dirname(ABS), { recursive: true });
    await writeFile(ABS, 'export default "from github";\n');
    const result = await persist.applySavedChanges();
    assert.deepEqual(result.conflicts, [FILE]);
    assert.equal(await readFile(ABS, 'utf8'), 'export default "from github";\n');
    assert.equal(await persist.forget(FILE), true);
    assert.equal((await persist.listChanges()).length, 0);
});

test('pushed to GitHub: the saved copy is dropped on a fresh-disk host', async () => {
    await ws.writeText(FILE, 'export default 3;\n');
    // The deployed code now contains the same content.
    const result = await persist.applySavedChanges();
    assert.deepEqual(result.synced, [FILE]);
    assert.equal((await persist.listChanges()).length, 0);
});

test('owners are kept in the database and win over a wiped file', async () => {
    owners.loadOwners();
    await owners.initOwners();
    const number = '212699990000';
    await owners.addAdmin({ number, name: 'Test' });
    const saved = await docStore.open('owners');
    assert.ok(saved.admins.some((a) => a.number === number));
    await rm(owners.OWNERS_FILE, { force: true }); // "redeploy"
    owners.loadOwners();
    assert.equal(owners.isAdmin({ senderNumber: number }), false);
    await owners.initOwners();
    assert.equal(owners.isAdmin({ senderNumber: number }), true);
    await owners.removeAdmin(number);
});
