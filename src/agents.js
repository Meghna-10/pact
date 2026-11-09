// Multi-agent purchase pipeline: Research → Trust → Negotiation → Policy → Decision.
// Agents PROPOSE. The policy engine (policy.js) DECIDES what is payable.
import fs from 'node:fs';
import { ask } from './llm.js';
import { evaluate, round2 } from './policy.js';

const CATALOG = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));
const STOP = new Set('i want need buy get a an the for me my some to under below less than with and of in on please find good best cheap budget around about'.split(' '));

// ---------- Research Agent ----------
export async function parseIntent(text) {
  const llm = await ask(
    'You are the Research Agent of a shopping assistant. Extract the purchase intent.',
    `User request: "${text}"\nReturn {"keywords":[short product nouns/attributes],"category":one of electronics|sports|apparel|home|books|giftcards|null,"maxPrice":number|null,"quantity":integer,"priorities":[e.g. "price","quality","fast shipping"]}`,
    { json: true, maxTokens: 300 });
  if (llm?.keywords?.length) return { ...llm, quantity: Math.max(1, parseInt(llm.quantity) || 1), source: 'llm' };
  const lower = text.toLowerCase();
  const price = lower.match(/(?:under|below|less than|max|<)\s*\$?\s*(\d+(?:\.\d+)?)/);
  const qty = lower.match(/\b(\d+)\s*(?:x|pcs|pieces|units)\b/);
  return {
    keywords: lower.replace(/\$?\d+(\.\d+)?/g, ' ').split(/[^a-z]+/).filter(w => w.length > 2 && !STOP.has(w)),
    category: null,
    maxPrice: price ? Number(price[1]) : null,
    quantity: qty ? Number(qty[1]) : 1,
    priorities: /fast|quick|asap/.test(lower) ? ['fast shipping'] : ['value'],
    source: 'rules',
  };
}

export function search(intent) {
  const kws = intent.keywords.map(k => k.toLowerCase());
  return CATALOG.map(p => {
    const hay = (p.title + ' ' + p.tags.join(' ')).toLowerCase();
    const hits = kws.filter(k => hay.includes(k) || k.split(' ').every(w => hay.includes(w))).length;
    return { p, hits };
  }).filter(x => x.hits > 0 && (!intent.category || x.p.category === intent.category))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 8).map(x => ({ ...x.p, relevance: x.hits }));
}

// ---------- Trust Agent (deterministic scoring) ----------
export function riskOf(p) {
  const reasons = [];
  let s = 0;
  if (p.merchantRating < 3.5) { s += 30; reasons.push(`low merchant rating (${p.merchantRating})`); }
  if (p.merchantAgeDays < 90) { s += 30; reasons.push(`merchant only ${p.merchantAgeDays} days old`); }
  if (!p.returns) { s += 15; reasons.push('no returns accepted'); }
  if (p.shippingDays > 14) { s += 10; reasons.push(`slow shipping (${p.shippingDays} days)`); }
  if (p.category === 'giftcards') { s += 20; reasons.push('gift cards are a common fraud vector'); }
  return { riskScore: Math.min(100, s), riskReasons: reasons.length ? reasons : ['established merchant, returns accepted'] };
}

// ---------- Negotiation Agent ----------
export function negotiate(p, qty = 1) {
  const eligible = p.offers.filter(o => qty >= o.minQty);
  const best = eligible.sort((a, b) => b.pct - a.pct)[0];
  const unit = best ? round2(p.price * (1 - best.pct / 100)) : p.price;
  const nearMiss = p.offers.find(o => o.minQty > qty);
  return {
    appliedOffer: best?.code || null,
    savings: round2((p.price - unit) * qty),
    finalPrice: round2(unit * qty),
    note: best ? `Applied ${best.code} (-${best.pct}%)`
      : nearMiss ? `${nearMiss.code} gives -${nearMiss.pct}% at qty ${nearMiss.minQty}; not applied`
      : 'No discount available',
  };
}

function valueScore(c, intent) {
  // quality per dollar, nudged by priorities; penalise risk
  let s = (c.merchantRating * 20) - c.finalPrice / 5 - c.riskScore / 2 + c.relevance * 8;
  if (intent.priorities?.some(x => /ship|fast/.test(x))) s -= c.shippingDays * 3;
  if (intent.priorities?.some(x => /quality|premium/.test(x))) s += c.merchantRating * 10;
  if (intent.maxPrice && c.finalPrice > intent.maxPrice) s -= 40; // user's stated preference
  return round2(s);
}

// ---------- Policy re-evaluation (also used when the budget changes live) ----------
export function applyPolicy(candidates, policy, spent, intent) {
  const out = candidates.map(c => ({ ...c, policy: evaluate(c, policy, spent), score: valueScore(c, intent) }));
  out.sort((a, b) => (b.policy.allowed - a.policy.allowed) || (b.score - a.score));
  return out;
}

// ---------- Full pipeline ----------
export async function runPipeline(session, emit) {
  const { text, policy } = session;
  emit('research', 'Parsing intent…');
  const intent = await parseIntent(text);
  session.intent = intent;
  emit('research', `Intent: ${intent.keywords.join(', ')}${intent.maxPrice ? ` · prefers ≤ $${intent.maxPrice}` : ''} · qty ${intent.quantity} (${intent.source})`);

  const found = search(intent);
  if (!found.length) { emit('research', 'No matching products found.'); session.candidates = []; return; }
  emit('research', `Found ${found.length} options: ${found.map(f => `${f.title} ($${f.price})`).join('; ')}`);

  const withRisk = found.map(p => ({ ...p, ...riskOf(p) }));
  for (const c of withRisk) emit('trust', `${c.merchant}: risk ${c.riskScore}/100 — ${c.riskReasons.join(', ')}`);

  const negotiated = withRisk.map(c => ({ ...c, ...negotiate(c, intent.quantity) }));
  for (const c of negotiated.filter(c => c.appliedOffer || c.note.includes('qty'))) emit('negotiation', `${c.title}: ${c.note} → $${c.finalPrice}`);

  const ranked = applyPolicy(negotiated, policy, session.spent, intent);
  for (const c of ranked.filter(c => !c.policy.allowed)) emit('policy', `BLOCKED ${c.title}: ${c.policy.violations.map(v => v.msg).join('; ')}`);

  // Negotiation agent challenges the top pick against the runner-up
  const allowed = ranked.filter(c => c.policy.allowed);
  if (allowed.length >= 2) {
    const [a, b] = allowed;
    const diff = round2(a.finalPrice - b.finalPrice);
    emit('negotiation', diff > 0
      ? `Challenge: ${b.title} is $${diff} cheaper. Keeping ${a.title} because score ${a.score} vs ${b.score} (rating ${a.merchantRating} vs ${b.merchantRating}, risk ${a.riskScore} vs ${b.riskScore}).`
      : `Challenge: ${a.title} is both cheaper and higher-scored than ${b.title}. No objection.`);
  }
  session.candidates = ranked;
  await explain(session, emit);
}

export async function explain(session, emit) {
  const top = session.candidates.find(c => c.policy.allowed);
  if (!top) { session.recommendation = null; emit('decision', 'No option satisfies your policy. Adjust limits or the request.'); return; }
  const blocked = session.candidates.filter(c => !c.policy.allowed).length;
  const fallback = `Recommend ${top.title} from ${top.merchant} at $${top.finalPrice}${top.savings ? ` (saved $${top.savings} with ${top.appliedOffer})` : ''}. ` +
    `Merchant rating ${top.merchantRating}, risk ${top.riskScore}/100, ships in ${top.shippingDays} days. ${blocked} option(s) were blocked by your policy.`;
  const llm = await ask('You are the Decision Agent. Explain a purchase recommendation in 2-3 plain sentences. Never invent facts; use only provided data.',
    JSON.stringify({ request: session.text, pick: pickFields(top), alternatives: session.candidates.slice(0, 4).map(pickFields) }), { maxTokens: 250 });
  session.recommendation = { id: top.id, explanation: llm || fallback };
  emit('decision', session.recommendation.explanation);
}

const pickFields = c => ({ title: c.title, merchant: c.merchant, finalPrice: c.finalPrice, rating: c.merchantRating, risk: c.riskScore, shippingDays: c.shippingDays, allowed: c.policy.allowed, violations: c.policy.violations.map(v => v.msg) });

// ---------- Transaction Intelligence ----------
export async function answerAboutTransactions(question, txns) {
  const llm = await ask('You answer questions about the user\'s purchase history. Use only the given data. Be concise.',
    `Transactions: ${JSON.stringify(txns)}\nQuestion: ${question}`, { maxTokens: 300 });
  if (llm) return llm;
  const total = round2(txns.reduce((s, t) => s + Number(t.amount), 0));
  const q = question.toLowerCase();
  if (!txns.length) return 'You have no completed transactions yet.';
  if (/total|spent|how much/.test(q)) return `You've spent $${total} across ${txns.length} purchase(s).`;
  if (/refund|return/.test(q)) return txns.map(t => `${t.title}: ${t.returns ? 'returns accepted' : 'NO returns'} — contact ${t.merchant} with capture ${t.captureId}`).join('\n');
  if (/last|recent/.test(q)) { const t = txns[txns.length - 1]; return `Last purchase: ${t.title} for $${t.amount} from ${t.merchant} (PayPal order ${t.orderId}, ${t.status}).`; }
  return txns.map(t => `${t.title} — $${t.amount} — ${t.merchant} — ${t.status}`).join('\n') + `\nTotal: $${total}`;
}
