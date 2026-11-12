// Thin LLM wrapper. Provider: Claude (ANTHROPIC_API_KEY) or Google Gemini (GEMINI_API_KEY, has a free tier).
// Returns null when no key is set, so every agent has a deterministic fallback and the demo never
// hard-depends on an LLM. The AI only words explanations; it never approves, blocks or pays.
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

export const llmProvider = () => (process.env.ANTHROPIC_API_KEY ? 'claude' : process.env.GEMINI_API_KEY ? 'gemini' : null);
export const llmEnabled = () => Boolean(llmProvider());
export const llmLabel = () => ({ claude: `Claude (${CLAUDE_MODEL})`, gemini: `Google Gemini (${GEMINI_MODEL})` }[llmProvider()] || 'none');

async function callClaude(system, user, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, signal: AbortSignal.timeout(+process.env.LLM_TIMEOUT_MS || 45000),
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

async function callGemini(system, user, maxTokens) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' }, signal: AbortSignal.timeout(+process.env.LLM_TIMEOUT_MS || 45000),
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: Math.max(maxTokens * 6, 4096) } }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}

export async function ask(system, user, { json = false, maxTokens = 600 } = {}) {
  const p = llmProvider();
  if (!p) return null;
  const sys = system + (json ? '\nRespond with ONLY a JSON object, no prose, no code fences.' : '');
  try {
    const text = await (p === 'claude' ? callClaude : callGemini)(sys, user, maxTokens);
    if (!json) return text.trim() || null;
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.warn('LLM failed', e.message);
    return null;
  }
}
