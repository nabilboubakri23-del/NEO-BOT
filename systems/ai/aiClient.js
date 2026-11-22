import config from '../../config/config.js';
import { UserError } from '../../utils/errors.js';

const TIMEOUT_MS = 45_000;
export const isAiEnabled = () => Boolean(config.ai.apiKey);
const DEFAULT_SYSTEM = `You are ${config.bot.name}, a helpful WhatsApp assistant. Answer briefly and clearly in the user's language. Use plain text that reads well in WhatsApp.`;

/** Text-only completion. Keys and raw provider errors must never reach replies or logs. */
export const chat = async (messages, { fetchImpl = fetch, systemPrompt = '' } = {}) => {
    if (!isAiEnabled()) throw new UserError('AI chat is not set up. The owner must set GROQ_API_KEY (Groq) or AI_API_KEY on the server.');
    const body = {
        model: config.ai.model,
        messages: [{ role: 'system', content: [config.ai.systemPrompt || DEFAULT_SYSTEM, systemPrompt].filter(Boolean).join('\n\n') }, ...messages],
        temperature: 0.7
    };
    if (config.ai.provider === 'groq') {
        body.max_completion_tokens = 2048;
        if (/^openai\/gpt-oss-(20|120)b$/.test(config.ai.model)) {
            body.reasoning_effort = 'low';
            body.include_reasoning = false;
        }
    } else {
        body.max_tokens = 800;
    }
    let res;
    try {
        res = await fetchImpl(`${config.ai.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.apiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        throw new UserError('The AI service did not answer. Try again in a moment.');
    }
    if (res.status === 401 || res.status === 403) throw new UserError('The AI key was refused. The owner should check the AI API key on the server.');
    if (res.status === 429) throw new UserError('The AI service is busy (rate limit). Try again soon.');
    if (!res.ok) throw new UserError(`The AI service failed (HTTP ${res.status}).`);
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new UserError('The AI returned an empty answer.');
    // Never return a separate reasoning field. Bound replies and stored history.
    return content.trim().slice(0, 6000);
};
