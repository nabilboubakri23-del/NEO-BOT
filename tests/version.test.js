import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import config from '../config/config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('one bot version everywhere', async () => {
    assert.equal(config.bot.version, pkg.version);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    for (const file of readdirSync(new URL('../plugins/', import.meta.url)).filter((f) => f.endsWith('.js') && !f.startsWith('.'))) {
        const plugin = (await import(`../plugins/${file}`)).default;
        assert.equal(plugin.version, pkg.version, `plugins/${file}`);
    }
});
