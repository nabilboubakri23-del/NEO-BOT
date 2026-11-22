import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'test-only-not-a-real-key';
delete process.env.AI_API_KEY;
delete process.env.AI_BASE_URL;
delete process.env.AI_MODEL;
process.env.LOG_LEVEL = 'silent';

const { chat } = await import('../systems/ai/aiClient.js');
const general = (await import('../commands/ai.js')).default;
const characters = (await import('../commands/aiCharacters.js')).default;
const { parseCommand } = await import('../core/commandParser.js');
const { CommandHandler } = await import('../core/commandHandler.js');
const response = (content = 'مرحبا') => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content, reasoning: 'PRIVATE REASONING' } }] }) });

const configFor = (overrides = {}) => {
    const env = { ...process.env };
    for (const k of ['AI_PROVIDER', 'GROQ_API_KEY', 'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL']) delete env[k];
    Object.assign(env, overrides);
    const code = "const c=(await import('./config/config.js')).default.ai;console.log(JSON.stringify({...c,apiKey:Boolean(c.apiKey)}))";
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' }));
};

test('AI config: no credential remains disabled and old defaults survive', () => {
    const c = configFor();
    assert.equal(c.apiKey, false);
    assert.equal(c.provider, 'openai');
    assert.equal(c.model, 'gpt-4o-mini');
});
test('AI config: Groq key auto-selects Groq when no legacy key exists', () => {
    const c = configFor({ GROQ_API_KEY: 'test' });
    assert.equal(c.provider, 'groq');
    assert.equal(c.model, 'openai/gpt-oss-120b');
    assert.equal(c.baseUrl, 'https://api.groq.com/openai/v1');
});
test('AI config: legacy deployment is not silently moved to Groq', () => {
    const c = configFor({ AI_API_KEY: 'test', GROQ_API_KEY: 'other', AI_MODEL: 'old-model', AI_BASE_URL: 'https://example.test/v1/' });
    assert.equal(c.provider, 'openai');
    assert.equal(c.model, 'old-model');
    assert.equal(c.baseUrl, 'https://example.test/v1');
});
test('AI config: explicit Groq can use the existing AI_API_KEY name', () => {
    assert.equal(configFor({ AI_PROVIDER: 'groq', AI_API_KEY: 'test' }).apiKey, true);
});
test('Groq request: endpoint, model, token budget, hidden reasoning and persona', async () => {
    let seen;
    const answer = await chat([{ role: 'user', content: 'سلام' }], { systemPrompt: 'Fictional roleplay.', fetchImpl: async (url, init) => { seen = { url, init }; return response(); } });
    assert.equal(answer, 'مرحبا');
    assert.equal(seen.url, 'https://api.groq.com/openai/v1/chat/completions');
    const b = JSON.parse(seen.init.body);
    assert.equal(b.model, 'openai/gpt-oss-120b');
    assert.equal(b.max_completion_tokens, 2048);
    assert.equal(b.include_reasoning, false);
    assert.equal(b.reasoning_effort, 'low');
    assert.equal(b.max_tokens, undefined);
    assert.match(b.messages[0].content, /Fictional roleplay/);
    assert.ok(seen.init.signal instanceof AbortSignal);
});
test('Groq response: malformed content and invalid JSON are clean failures', async () => {
    for (const content of [null, {}, 7, '   ']) await assert.rejects(chat([], { fetchImpl: async () => response(content) }), /empty answer/);
    await assert.rejects(chat([], { fetchImpl: async () => ({ ok: true, json: async () => { throw Error('bad JSON'); } }) }), /empty answer/);
});
test('Groq response: provider errors never leak provider body or credential', async () => {
    for (const status of [401, 403, 429, 500]) {
        await assert.rejects(chat([], { fetchImpl: async () => ({ ok: false, status, json: async () => { throw Error('DO NOT EXPOSE'); } }) }), (e) => !e.message.includes('DO NOT EXPOSE') && !e.message.includes('test-only'));
    }
    await assert.rejects(chat([], { fetchImpl: async () => { throw Error('sensitive transport details'); } }), /did not answer/);
});
test('Groq response: long output is bounded', async () => {
    assert.equal((await chat([], { fetchImpl: async () => response('x'.repeat(9000)) })).length, 6000);
});

test('all character commands validate and aliases resolve through the real loader', async () => {
    const registry = new CommandHandler();
    const loaded = await registry.load();
    assert.deepEqual(loaded.failures, []);
    for (const command of [general, ...characters]) {
        assert.deepEqual(CommandHandler.validate(command), []);
        for (const alias of [command.name, ...command.aliases]) assert.equal(registry.get(parseCommand(`.${alias} hello`, '.').name).name, command.name);
    }
    assert.equal(registry.get('bot').category, 'group');
});

let id = 0;
const conversation = (user = '212600123456', chat = 'test-group@g.us') => {
    const replies = [];
    return { replies, message: { chat, senderNumber: user, id: String(++id), reply: async (text) => { replies.push(text); } } };
};
const run = (command, c, text, extra = {}) => {
    const parsed = parseCommand(`.${command.name} ${text}`, '.');
    return command.execute({}, { ...c.message, ...extra }, parsed.args, parsed);
};

test('AI commands: quoted context, separate characters/users/chats and reset', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const requests = [];
    globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(init.body)); return response(); };
    const c = conversation();
    await run(general, c, 'first', { quoted: { text: 'quoted context' } });
    assert.match(requests.at(-1).messages.at(-1).content, /quoted context/);
    await run(general, c, 'second');
    assert.equal(requests.at(-1).messages.length, 4);
    await run(characters[0], c, 'character');
    assert.equal(requests.at(-1).messages.length, 2);
    assert.match(requests.at(-1).messages[0].content, /Eren/);
    await run(general, conversation('212600123457'), 'other user');
    assert.equal(requests.at(-1).messages.length, 2);
    await run(general, conversation('212600123456', 'other-group@g.us'), 'other chat');
    assert.equal(requests.at(-1).messages.length, 2);
    await run(general, c, 'reset');
    await run(general, c, 'after reset');
    assert.equal(requests.at(-1).messages.length, 2);
    await run(characters[0], c, 'same character');
    assert.equal(requests.at(-1).messages.length, 4);
});
test('AI commands: empty input and input bounds', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let payload;
    globalThis.fetch = async (_url, init) => { payload = JSON.parse(init.body); return response(); };
    const c = conversation('212600123458');
    await assert.rejects(run(general, c, ''), (e) => e.name === 'UsageError');
    await run(general, c, 'q'.repeat(10000), { quoted: { text: 'c'.repeat(10000) } });
    assert.ok(payload.messages.at(-1).content.length <= 4000);
});
test('AI commands: cross-character concurrent request is rejected and failures release lock', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let finish;
    globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
    const c = conversation('212600123459');
    const first = run(general, c, 'hello');
    await new Promise((r) => setImmediate(r));
    await assert.rejects(run(characters[1], c, 'hello'), /wait for your current AI answer/i);
    finish(response());
    await first;
    globalThis.fetch = async () => { throw Error('offline'); };
    await assert.rejects(run(general, c, 'failure'), /did not answer/);
    globalThis.fetch = async () => response();
    await run(general, c, 'recovered');
});
