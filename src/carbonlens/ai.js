// CarbonLens grounded explanations. The model (if configured) only rephrases structured results; it never computes.
// Every model output is validated: numbers must exist in the calculation; banned claims are rejected.
export const BANNED = /\b(certified|certification|carbon[- ]neutral|offset(s|ting)?|net[- ]zero|eco[- ]friendly|guarantee[sd]?|healthy|healthier|nutritious|measured)\b/i;
const NUM = /(?<![\w.])\d+(?:\.\d+)?/g;
const g = v => String(Number(v.toPrecision(12)));

function allowedNumbers(calc) {
  const nums = new Set();
  const walk = x => {
    if (x == null || typeof x === 'boolean') return;
    if (typeof x === 'number') { for (const v of [x, +x.toFixed(1), +x.toFixed(2), +x.toFixed(3), +(x * 100).toFixed(1), Math.round(x * 100), Math.trunc(x)]) nums.add(g(v)); }
    else if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === 'object') Object.values(x).forEach(walk);
    else if (typeof x === 'string') (x.match(NUM) || []).forEach(n => nums.add(g(Number(n))));
  };
  walk(calc);
  return nums;
}

export function validate(text, calc) {
  const problems = [], m = (text || '').match(BANNED);
  if (m) problems.push(`banned claim: '${m[0]}'`);
  const ok = allowedNumbers(calc);
  for (const n of (text || '').match(NUM) || []) if (!ok.has(g(Number(n))) && !['1', '2', '3'].includes(n)) problems.push(`number not in the calculation: ${n}`);
  return { ok: !problems.length, problems };
}

export function templateExplanation(calc) {
  const t = calc.totals, items = calc.items, est = items.filter(i => i.status === 'estimated');
  if (!est.length) return { summary: 'Insufficient evidence to calculate a reliable estimate for any item in this basket.', points: items.map(i => `${i.name}: insufficient evidence.`) };
  const top = est[0], share = calc.top_contributors[0].share, lines = [];
  lines.push(`${top.name} contributes the most: ${top.estimated_emissions_kg_co2e} of the estimated ${t.estimated_emissions_kg_co2e} kg CO2e (${Math.round(share * 100)}% of the estimated total).`);
  if (top.evidence) lines.push(`Its value comes from '${top.evidence.source_entity}' in ${top.evidence.source_name} (${top.evidence.reference_year}), a ${top.evidence.geography.split(' (')[0].toLowerCase()} reference.`);
  const strong = est.filter(i => i.evidence_quality === 'MEDIUM').map(i => i.name), weak = est.filter(i => i.evidence_quality === 'LOW').map(i => i.name);
  const missing = items.filter(i => i.status !== 'estimated').map(i => i.name);
  if (strong.length) lines.push(`Medium evidence (reliable global data, not India-specific): ${strong.join(', ')}.`);
  if (weak.length) lines.push(`Low evidence, treat with caution: ${weak.join(', ')}.`);
  if (missing.length) lines.push(`Not estimated (insufficient evidence), so not in the total: ${missing.join(', ')}.`);
  lines.push('No item uses India-specific lifecycle data; the total is an estimate built from global reference values.');
  return { summary: `Estimated basket footprint: ${t.estimated_emissions_kg_co2e} kg CO2e for ${t.estimated_items} of ${t.estimated_items + t.unestimated_items} items.`, points: lines };
}

export function answer(question, calc, recs) {
  const q = (question || '').toLowerCase(), est = calc.items.filter(i => i.status === 'estimated');
  if (/most|biggest|highest|contribut/.test(q)) {
    if (!est.length) return 'Insufficient evidence to say: no item in the basket has an estimate.';
    return `${est[0].name} contributes the most: an estimated ${est[0].estimated_emissions_kg_co2e} kg CO2e (${est[0].evidence_quality} evidence).`;
  }
  if (/india/.test(q)) return 'None of the estimates use India-specific data. All come from global reference values (Poore & Nemecek 2018 via Our World in Data).';
  if (/missing|evidence|gap|unestimated/.test(q)) {
    const miss = calc.items.filter(i => i.status !== 'estimated').map(i => i.name), weak = est.filter(i => i.evidence_quality === 'LOW').map(i => i.name);
    return (miss.length ? `Not estimated: ${miss.join(', ')}. ` : 'Every item has an estimate. ') + (weak.length ? `Weak (LOW) evidence: ${weak.join(', ')}.` : '');
  }
  if (/alternative|lower|reduce|budget|swap/.test(q)) {
    if (!recs?.alternatives?.length) return 'No alternative in the catalogue is both comparable and meaningfully lower with supporting evidence' + (recs?.budget_inr ? ' within your budget.' : '.');
    const a = recs.alternatives[0];
    return `Swapping ${a.from.name} for ${a.to.name} (same weight) changes the estimate by ${a.emissions_difference_kg_co2e} kg CO2e and the price by ₹${a.price_difference_inr}. Evidence: ${a.evidence_quality}. ${a.caution}`;
  }
  return 'I can answer: which item contributes most, which estimates use Indian data, what evidence is missing, and whether a lower-impact alternative fits your budget.';
}

export async function explain(calc) {
  const base = templateExplanation(calc), key = process.env.ANTHROPIC_API_KEY, model = process.env.LLM_MODEL || 'claude-sonnet-5-5';
  if (!key) return { ...base, generated_by: 'rule-based template (no AI model configured)', validation: 'n/a' };
  const facts = JSON.stringify({ totals: calc.totals, items: calc.items.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, estimated_emissions_kg_co2e: i.estimated_emissions_kg_co2e, evidence_quality: i.evidence_quality, status: i.status })) });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 300, system: "Explain a grocery basket's estimated emissions in 3 short sentences using ONLY the numbers in the JSON. Do not add numbers, sources, certifications, offsets or health claims. Say 'estimated'.", messages: [{ role: 'user', content: facts }] }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = ((await r.json()).content || []).map(b => b.text || '').join('');
    const v = validate(text, calc);
    if (v.ok) return { ...base, summary: text.trim(), generated_by: `AI model ${model} (validated against the calculation)`, validation: 'passed' };
    return { ...base, generated_by: 'rule-based template (AI answer rejected)', validation: 'rejected: ' + v.problems.slice(0, 3).join('; ') };
  } catch (e) { return { ...base, generated_by: 'rule-based template (AI unavailable)', validation: `error: ${e.message}` }; }
}
