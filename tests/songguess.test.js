import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseTitle, buildOptions, cleanTracks, normalize, scoreAnswer, titleMatches } from '../systems/games/songGuess.js';

const row = (id, title, artist) => ({ id, title, readable: true, preview: 'https://cdnt-preview.dzcdn.net/x.mp3', artist: { name: artist }, album: { title: 'A' } });

test('titles: base title, Arabic kept, small typos accepted', () => {
    assert.equal(baseTitle('Dracula (with JENNIE)'), 'Dracula');
    assert.equal(baseTitle('Song - Radio Edit'), 'Song');
    assert.equal(normalize('بحلم بلقاك!'), 'بحلم بلقاك');
    assert.ok(titleMatches('paranoiaque', 'PARANOÏAQUE'));
    assert.ok(titleMatches('dracla', 'Dracula (with JENNIE)'));
    assert.ok(!titleMatches('hello', 'Dracula'));
    assert.ok(!titleMatches('13', '12'));
});

test('tracks without preview and duplicates are dropped', () => {
    const tracks = cleanTracks([row(1, 'A', 'x'), row(2, 'A (Remix)', 'x'), { ...row(3, 'B', 'y'), preview: '' }, row(4, 'C', 'z')]);
    assert.deepEqual(tracks.map((t) => t.id), ['1', '4']);
});

test('options: 4 different titles including the answer', () => {
    const pool = cleanTracks([row(1, 'One', 'a'), row(2, 'Two', 'b'), row(3, 'Three', 'c'), row(4, 'Four', 'd'), row(5, 'Five', 'e')]);
    const { options, correct } = buildOptions(pool[0], pool);
    assert.equal(options.length, 4);
    assert.equal(options[correct].id, '1');
    assert.equal(new Set(options.map((t) => t.title)).size, 4);
    assert.throws(() => buildOptions(pool[0], pool.slice(0, 3)), /Not enough/);
});

test('score: speed, streak and first bonus, scaled', () => {
    assert.equal(scoreAnswer({ elapsedMs: 0, windowMs: 20000 }), 200);
    assert.equal(scoreAnswer({ elapsedMs: 20000, windowMs: 20000 }), 100);
    assert.equal(scoreAnswer({ elapsedMs: 10000, windowMs: 20000, streak: 3, first: true }), 100 + 50 + 40 + 25);
    assert.equal(scoreAnswer({ elapsedMs: 0, windowMs: 20000, streak: 10, multiplier: 1.5 }), Math.round((200 + 80) * 1.5));
});
