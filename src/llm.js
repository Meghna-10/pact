// Thin Claude Messages API wrapper. Returns null when no key is set so every
// agent has a deterministic fallback and the demo never hard-depends on the LLM.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

export const llmEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

export async function ask(system, user, { json = false, maxTokens = 600 } = {}) {
  if (!llmEnabled()) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: system + (json ? '\nRespond with ONLY a JSON object, no prose, no code fences.' : ''),
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) { console.warn('LLM error', r.status, await r.text()); return null; }
    const j = await r.json();
    const text = j.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
    if (!json) return text.trim();
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.warn('LLM failed', e.message);
    return null;
  }
}
