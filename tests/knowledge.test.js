// Knowledge commands: offline parts only (parsers, calculator, helpers).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { evaluate, formatNumber } = await import('../systems/knowledge/calculator.js');
const { parseRef } = await import('../commands/knowledge/quran.js');
const { parseConversion } = await import('../commands/knowledge/currency.js');
const { nextPrayer } = await import('../commands/knowledge/prayer.js');
const { pickSenses } = await import('../commands/knowledge/define.js');
const { clip, isArabic } = await import('../systems/knowledge/http.js');

test('calculator: precedence, functions, Arabic digits, safety', () => {
    assert.equal(evaluate('2+3*4'), 14);
    assert.equal(evaluate('2^3^2'), 512);
    assert.equal(evaluate('-2^2'), -4);
    assert.equal(evaluate('sqrt(16)+5!'), 124);
    assert.equal(evaluate('50% * 200'), 100);
    assert.equal(evaluate('١٠ ÷ ٤'), 2.5);
    assert.equal(evaluate('3 x 4'), 12);
    assert.ok(Math.abs(evaluate('sin(30)') - 0.5) < 1e-12);
    assert.throws(() => evaluate('1/0'), /Division by zero/);
    assert.throws(() => evaluate('process.exit()'), /Unknown|Unexpected/);
    assert.throws(() => evaluate('constructor'), /Unknown/);
    assert.equal(formatNumber(1234567), '1,234,567');
});

test('quran references', () => {
    assert.equal(parseRef(['2:255']), '2:255');
    assert.equal(parseRef(['١١٢:١']), '112:1');
    assert.equal(parseRef(['36', '1']), '36:1');
    assert.throws(() => parseRef(['200:1']), /between 1 and 114/);
    assert.match(parseRef([]), /^\d+$/);
});

test('currency parsing with codes and Arabic names', () => {
    assert.deepEqual(parseConversion(['100', 'usd', 'mad']), { amount: 100, from: 'USD', targets: ['MAD'] });
    assert.deepEqual(parseConversion(['200', 'درهم', 'الى', 'دولار']), { amount: 200, from: 'MAD', targets: ['USD'] });
    assert.deepEqual(parseConversion(['50eur', 'to', 'gbp']), { amount: 50, from: 'EUR', targets: ['GBP'] });
    assert.equal(parseConversion(['usd']).amount, 1);
    assert.throws(() => parseConversion(['10', 'usd', 'zzzz']), /Unknown currency/);
});

test('next prayer and countdown', () => {
    const t = { Fajr: '05:30', Sunrise: '07:00', Dhuhr: '12:20', Asr: '15:00', Maghrib: '17:30', Isha: '18:45' };
    assert.deepEqual(nextPrayer(t, 12 * 60), { key: 'Dhuhr', ar: 'الظهر', in: 20 });
    assert.equal(nextPrayer(t, 23 * 60).key, 'Fajr');
    assert.equal(nextPrayer(t, 23 * 60).in, 60 + 330);
});

test('dictionary senses are cleaned of HTML', () => {
    const data = { en: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'A <a href="/x">book</a> &amp; more' }] }] };
    assert.deepEqual(pickSenses(data, 'en'), [{ pos: 'Noun', defs: [{ text: 'A book & more', example: '' }] }]);
});

test('helpers', () => {
    assert.equal(isArabic('المغرب'), true);
    assert.equal(isArabic('Morocco'), false);
    assert.ok(clip('word '.repeat(400), 100).length <= 101);
});
