import config from '../../config/config.js';
import { UserError } from '../../utils/errors.js';

/**
 * Minimal client for any OpenAI-compatible chat completions API
 * (OpenAI, Groq, OpenRouter, Together, a local Ollama with /v1 …).
 * The key comes from AI_API_KEY in the environment; nothing is hard-coded.
 */

const TIMEOUT_MS = 45_000;

export const isAiEnabled = () => Boolean(config.ai.apiKey);

const DEFAULT_SYSTEM = `You are ${config.bot.name}, a helpful WhatsApp assistant. Answer briefly and clearly in the user's language. Use plain text that reads well in WhatsApp.`;

/**
 * @param {{ role: 'user'|'assistant', content: string }[]} messages
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string>}
 */
export const chat = async (messages, { fetchImpl = fetch } = {}) => {
    if (!isAiEnabled()) throw new UserError('AI chat is not set up. The owner must set AI_API_KEY on the server.');
    let res;
    try {
        res = await fetchImpl(`${config.ai.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.apiKey}` },
            body: JSON.stringify({
                model: config.ai.model,
                messages: [{ role: 'system', content: config.ai.systemPrompt || DEFAULT_SYSTEM }, ...messages],
                max_tokens: 800,
                temperature: 0.7
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        throw new UserError('The AI service did not answer. Try again in a moment.');
    }
    if (res.status === 401 || res.status === 403) throw new UserError('The AI key was refused. The owner should check AI_API_KEY.');
    if (res.status === 429) throw new UserError('The AI service is busy (rate limit). Try again soon.');
    if (!res.ok) throw new UserError(`The AI service failed (HTTP ${res.status}).`);
    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new UserError('The AI returned an empty answer.');
    return text;
};
