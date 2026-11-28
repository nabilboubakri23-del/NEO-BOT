import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, utimes, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.SESSION_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
delete process.env.MONGODB_URI;

const { SessionManager, entryCategory } = await import('../core/sessionManager.js');
const { FileStore } = await import('../systems/storage/fileStore.js');

test('entry categories', () => {
    assert.equal(entryCategory('creds.json'), 'creds');
    assert.equal(entryCategory('sender-key-memory-123@g.us.json'), 'sender-key-memory');
    assert.equal(entryCategory('sender-key-123@g.us--1.json'), 'sender-key');
    assert.equal(entryCategory('session-2126.0.json'), 'session');
    assert.equal(entryCategory('pre-key-5.json'), 'pre-key');
    assert.equal(entryCategory('app-state-sync-key-AAA.json'), 'app-state-sync-key');
    assert.equal(entryCategory('lid-mapping-1.json'), 'lid-mapping');
});

test('cleanup removes only stale disposable entries and keeps creds/pre-keys', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-sess-'));
    const store = new FileStore(dir);
    const sm = new SessionManager(store);
    const { state, saveCreds } = await sm.loadAuthState();
    await saveCreds();
    await state.keys.set({
        session: { 'old.0': { a: 1 }, 'fresh.0': { a: 2 } },
        'pre-key': { 1: { k: 1 } },
        'sender-key-memory': { 'g@g.us': { x: true } },
        'app-state-sync-key': { K: { keyData: 'AA==' } }
    });
    // Age every file except the fresh session by 3 days.
    const old = new Date(Date.now() - 3 * 86400000);
    const freshName = (await import('../systems/security/encryption.js')).hashName('session-fresh.0.json');
    for (const f of await readdir(dir)) {
        if (f.endsWith('.enc') && !f.startsWith(freshName)) await utimes(path.join(dir, f), old, old);
    }
    assert.equal(await sm.fileCount(), 6);
    const removed = await sm.cleanup({ minAgeMs: 86400000 });
    assert.equal(removed, 2); // old session + sender-key-memory
    assert.equal(await sm.fileCount(), 4);
    assert.ok(await sm.hasValidSession() === false); // fresh creds, never linked, but still readable
    const left = await state.keys.get('session', ['old.0', 'fresh.0']);
    assert.equal(left['old.0'], null);
    assert.deepEqual(left['fresh.0'], { a: 2 });
    assert.ok((await state.keys.get('pre-key', ['1']))['1']);
    await sm.close();
});

test('session locks are released after use (no unbounded growth)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-sess-'));
    const sm = new SessionManager(new FileStore(dir));
    const { state } = await sm.loadAuthState();
    const ids = Array.from({ length: 50 }, (_, i) => `u${i}.0`);
    await state.keys.set({ session: Object.fromEntries(ids.map((id) => [id, { a: 1 }])) });
    const read = await state.keys.get('session', [...ids, 'missing.0']);
    assert.deepEqual(read['u7.0'], { a: 1 });
    assert.equal(read['missing.0'], null);
    assert.equal(sm.locks.size, 0);
});
