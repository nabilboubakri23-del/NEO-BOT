// Plugin system + event bus tests. Offline, no WhatsApp.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SESSION_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'silent';
process.env.MONGODB_URI = '';

const { EventBus } = await import('../core/events.js');
const { PluginManager } = await import('../systems/plugins/pluginManager.js');
const docStore = (await import('../systems/database/docStore.js')).default;
const { FileBackend } = await import('../systems/database/docStore.js');

class MemoryBackend extends FileBackend {
    kind = 'memory';
    store = new Map();
    async init() {}
    async read(name) { return this.store.get(name); }
    async write(name, data) { this.store.set(name, structuredClone(data)); }
}

before(async () => {
    await docStore.init(new MemoryBackend());
});

test('event bus: emit runs every listener, failures isolated', async () => {
    const bus = new EventBus();
    const seen = [];
    bus.on('x', () => seen.push('a'));
    bus.on('x', () => { throw new Error('boom'); });
    bus.on('x', () => seen.push('b'));
    await bus.emit('x', {});
    assert.deepEqual(seen, ['a', 'b']);
});

test('event bus: barrier vetoes on false', async () => {
    const bus = new EventBus();
    bus.on('g', () => true);
    assert.equal(await bus.barrier('g', {}), true);
    bus.on('g', () => false);
    assert.equal(await bus.barrier('g', {}), false);
});

test('event bus: offTag removes a whole group', () => {
    const bus = new EventBus();
    bus.on('a', () => {}, { tag: 't' });
    bus.on('b', () => {}, { tag: 't' });
    bus.on('a', () => {}, { tag: 'other' });
    assert.equal(bus.count(), 3);
    assert.equal(bus.offTag('t'), 2);
    assert.equal(bus.count(), 1);
});

test('plugin validation', () => {
    assert.deepEqual(PluginManager.validate({ name: 'ok' }), []);
    assert.ok(PluginManager.validate({ name: 'Bad!' }).length);
    assert.ok(PluginManager.validate({ name: 'x', commands: {} }).length);
    assert.ok(PluginManager.validate(null).length);
});

test('plugin security scan flags dangerous code', () => {
    assert.ok(PluginManager.scan("import cp from 'child_process'; cp.exec('ls')").length);
    assert.ok(PluginManager.scan('const k = process.env.MONGODB_URI').length);
    assert.deepEqual(PluginManager.scan('export default { name: "safe" }'), []);
});

test('plugin manager loads the example welcome plugin and its command', async () => {
    const pm = new PluginManager();
    const fakeHandler = { reload: async () => ({}) };
    pm.attach(fakeHandler);
    const result = await pm.load();
    assert.ok(result.active >= 1, 'welcome plugin should be active');
    const names = pm.pluginCommands().map((c) => c.name);
    assert.ok(names.includes('welcome'));
});

test('plugin manager disable/enable persists and toggles commands', async () => {
    const pm = new PluginManager();
    pm.attach({ reload: async () => ({}) });
    await pm.load();
    assert.equal(await pm.disable('welcome'), true);
    assert.ok(!pm.pluginCommands().some((c) => c.name === 'welcome'));
    assert.equal(await pm.enable('welcome'), true);
    assert.ok(pm.pluginCommands().some((c) => c.name === 'welcome'));
});
