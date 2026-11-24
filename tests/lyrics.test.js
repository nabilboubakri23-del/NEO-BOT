import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBest, plainFromSynced, scoreRow, toSeconds } from '../commands/download/.lyrics-api.js';
import { cardLyrics } from '../commands/download/lyrics.js';

const track = { title: 'Zahri', artist: 'Inkonnu', duration: '3:21' };

test('lyrics rows are matched by title, artist and length', () => {
    assert.equal(toSeconds('3:21'), 201);
    const right = { trackName: 'Zahri', artistName: 'Inkonnu', duration: 201, plainLyrics: 'a', syncedLyrics: '[00:01.00] a' };
    const cover = { trackName: 'Zahri (Cover)', artistName: 'Someone', duration: 150, plainLyrics: 'b' };
    const other = { trackName: 'Another song', artistName: 'Inkonnu', duration: 201, plainLyrics: 'c' };
    const empty = { trackName: 'Zahri', artistName: 'Inkonnu', instrumental: true };
    assert.equal(scoreRow(other, track), null);
    assert.equal(scoreRow(empty, track), null);
    assert.equal(pickBest([cover, other, right], track), right);
    assert.equal(pickBest([other], track), null);
});

test('synced lyrics become plain text and the card keeps the first verses', () => {
    assert.equal(plainFromSynced('[00:01.00] One\n[00:02.50][00:09.00] Two\n\n\n\n[00:03.00] Three'), 'One\nTwo\n\nThree');
    const short = cardLyrics('line one\nline two');
    assert.deepEqual(short, { text: 'line one\nline two', cut: false });
    const long = cardLyrics(Array.from({ length: 100 }, (_, i) => `line number ${i}`).join('\n'), 200);
    assert.equal(long.cut, true);
    assert.ok(long.text.length <= 205);
    assert.ok(long.text.endsWith('\n…'));
    assert.ok(!long.text.includes('line number 99'));
});
