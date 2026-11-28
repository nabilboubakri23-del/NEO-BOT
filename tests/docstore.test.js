import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from './helpers.js';

const { DocStore } = await import('../systems/database/docStore.js');

test('concurrent first opens of a document share one live object', async () => {
    const store = new DocStore();
    const backend = new MemoryBackend();
    backend.read = async (name) => { await new Promise((r) => setTimeout(r, 10)); return backend.store.get(name); };
    await store.init(backend);
    const [a, b] = await Promise.all([store.open('doc', () => ({ n: 0 })), store.open('doc', () => ({ n: 0 }))]);
    assert.equal(a, b);
    a.n = 5;
    store.touch('doc');
    await store.flush();
    assert.equal(backend.store.get('doc').n, 5);
    assert.equal(await store.open('doc'), a);
});

test('group metadata fetched across an invalidation is not cached', async () => {
    const { getGroup, invalidateGroup, peekGroup } = await import('../systems/groups/groupCache.js');
    const jid = '120363999999999999@g.us';
    let release;
    const sock = { groupMetadata: () => new Promise((r) => { release = r; }) };
    const first = getGroup(sock, jid);
    invalidateGroup(jid); // e.g. someone was demoted while the fetch was in flight
    release({ id: jid, participants: [] });
    await first;
    assert.equal(peekGroup(jid), undefined);
});
