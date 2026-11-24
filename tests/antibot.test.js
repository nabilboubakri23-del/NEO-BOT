import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandTracker, idSignal, scoreMessage } from '../systems/moderation/botDetector.js';

const msg = (over = {}) => ({ chat: 'g@g.us', id: 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6', senderNumber: '111', type: 'conversation', text: 'hi', raw: { message: {} }, ...over });

test('message ids: bot-library shapes score high, web-style ids never flag alone', () => {
    assert.equal(idSignal('BAE5ABCDEF012345').points, 3);
    assert.equal(idSignal('3EB0' + 'A'.repeat(36)).points, 3);
    assert.equal(idSignal('3EB0' + 'B'.repeat(18)).points, 1);
    assert.equal(idSignal('3A1F2E3D4C5B6A7980').points, 0);
    assert.equal(scoreMessage(msg({ id: '3EB0' + 'B'.repeat(18) })).bot, false);
});

test('buttons / interactive cards are bot-only', () => {
    assert.equal(scoreMessage(msg({ type: 'interactiveMessage' })).bot, true);
    assert.equal(scoreMessage(msg({ raw: { message: { viewOnceMessage: { message: { interactiveMessage: {} } } } } })).bot, true);
    assert.equal(scoreMessage(msg()).bot, false);
});

test('an instant reply to someone else\'s command plus a web id flags a bot', () => {
    const tracker = new CommandTracker();
    const now = 1_000_000;
    tracker.record(msg({ id: 'CMD1', text: '.menu', senderNumber: '222' }), now);
    const reply = msg({ id: '3EB0' + 'C'.repeat(18), quoted: { id: 'CMD1' } });
    assert.equal(scoreMessage(reply, tracker, now + 1500).bot, true);
    assert.equal(scoreMessage(reply, tracker, now + 9000).bot, false);
    // The person who typed the command replying to themselves is not a bot.
    assert.equal(scoreMessage({ ...reply, senderNumber: '222' }, tracker, now + 1500).bot, false);
    // A human (phone id) answering fast is not enough alone.
    assert.equal(scoreMessage(msg({ quoted: { id: 'CMD1' } }), tracker, now + 1500).bot, false);
});
