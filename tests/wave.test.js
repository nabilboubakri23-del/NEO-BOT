import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BARS, SHAPE_NAMES, drawDigits, drawShape, drawUnits, morseUnits, synth } from '../systems/media/waveArt.js';

test('every shape is 64 bars between 0 and 100', () => {
    for (const name of SHAPE_NAMES) {
        const bars = drawShape(name);
        assert.equal(bars.length, BARS, name);
        assert.ok([...bars].every((v) => v >= 0 && v <= 100), name);
    }
    assert.throws(() => drawShape('nope'), /Unknown shape/);
});

test('morse: dots, dashes and gaps, and too-long text is refused', () => {
    assert.deepEqual(morseUnits('et'), [1, 0, 0, 0, 1, 1, 1]);
    assert.equal(drawUnits(morseUnits('sos')).length, BARS);
    assert.throws(() => morseUnits('this is far too long for morse art'), /Too long/);
    assert.throws(() => morseUnits('مرحبا'), /English letters/);
});

test('custom digits stretch to 64 bars; synth makes the right length', () => {
    const bars = drawDigits('1 9');
    assert.ok(bars[0] < 20 && bars[63] > 90);
    assert.equal(synth(bars, 2).length, 2 * 48000 * 2);
});
