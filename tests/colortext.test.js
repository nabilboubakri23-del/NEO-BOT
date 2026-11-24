import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, contrastText, layout, parseColor, pickFont } from '../systems/media/colorText.js';
import { parseOptions } from '../commands/media/colortext.js';

test('colours: names, Arabic names and hex', () => {
    assert.equal(parseColor('red'), 'E53935');
    assert.equal(parseColor('أحمر'), 'E53935');
    assert.equal(parseColor('#f80'), 'FF8800');
    assert.equal(parseColor('hello'), null);
    assert.equal(contrastText('FFFFFF'), '111111');
    assert.equal(contrastText('111111'), 'FFFFFF');
});

test('options are read only from the front', () => {
    assert.deepEqual(parseOptions('navy/gold 3 s Red alert 2'), { bg: '1A237E', fg: 'C9A227', font: 3, sticker: true, text: 'Red alert 2' });
    assert.equal(parseOptions('hello red').bg, null);
    assert.equal(parseOptions('hello red').text, 'hello red');
});

test('Arabic never uses a Latin-only font; emoji are dropped', () => {
    assert.equal(pickFont(5, 'مرحبا').font.arabic, true);
    assert.equal(pickFont(5, 'hello').font.id, 5);
    assert.deepEqual(cleanText('hi 🎨'), { text: 'hi', droppedEmoji: true });
});

test('layout fits the square and shrinks for long text', () => {
    const short = layout('Hi');
    const long = layout('word '.repeat(60).trim());
    assert.ok(long.size < short.size);
    assert.ok(long.lines.length * long.size * 1.4 <= 1080);
});
