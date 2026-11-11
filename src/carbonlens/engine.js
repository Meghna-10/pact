// CarbonLens (PACT module): deterministic grocery emissions engine. No AI here.
// emissions (kg CO2e) = quantity (unit) × kg_per_unit × factor (kg CO2e per kg)
// Factors are computed at load time from the downloaded OWID CSV (Poore & Nemecek 2018) — never typed in.
// Products without a defensible source get NO number.
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const CAT = JSON.parse(fs.readFileSync(new URL('data/carbonlens/catalogue.json', ROOT), 'utf8'));
export const SOURCE = CAT.sources[0];
export const MAX_QTY = 100;
export const LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT'];
const MIN_REDUCTION = 0.10;   // an alternative must cut the estimate by at least 10% to be called lower
export class InvalidBasket extends Error { constructor(m) { super(m); this.status = 400; } }
const r = (x, n = 3) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

// OWID CSV → entity: { total, year, stages }. Total = sum of the eight stage columns.
export const OWID = (() => {
  const [head, ...rows] = fs.readFileSync(new URL(SOURCE.downloaded_file, ROOT), 'utf8').trim().split(/\r?\n/).map(l => l.split(','));
  const out = {};
  for (const row of rows) {
    const stages = {};
    head.forEach((h, i) => { if (h.startsWith('food_emissions_')) stages[h.replace('food_emissions_', '')] = Number(row[i] || 0); });
    out[row[0]] = { total: r(Object.values(stages).reduce((a, b) => a + b, 0), 4), year: Number(row[1]), stages };
  }
  return out;
})();

export const PRODUCTS = CAT.products.map(p => {
  if (p.owid_entity && !OWID[p.owid_entity]) throw new Error(`${p.id}: OWID entity ${p.owid_entity} not in the dataset`);   // never guess
  const o = p.owid_entity ? OWID[p.owid_entity] : null;
  return { id: p.id, name: p.name, category: p.category, unit: p.unit, kg_per_unit: p.kg_per_unit ?? 1, price_inr: p.price_inr, limitations: p.limitations,
    evidence_quality: o ? p.evidence : 'INSUFFICIENT',
    evidence: o ? { factor_kg_co2e_per_kg: o.total, unit: 'kg CO2e per kg', source_entity: p.owid_entity, source_id: SOURCE.id, source_name: SOURCE.name, source_url: SOURCE.url,
      dataset: SOURCE.dataset_name, geography: SOURCE.geography, reference_year: o.year, lifecycle_boundary: SOURCE.lifecycle_boundary, methodology: SOURCE.methodology,
      evidence_quality: p.evidence, limitations: p.limitations, stages: o.stages } : null };
});
export const product = id => PRODUCTS.find(p => p.id === id);
export const ALTERNATIVES = CAT.alternatives;

export function calculate(items) {
  if (!Array.isArray(items) || !items.length) throw new InvalidBasket('the basket is empty');
  const merged = new Map();
  for (const it of items) {
    const q = it?.quantity;
    if (typeof q !== 'number' || !Number.isFinite(q)) throw new InvalidBasket(`${it?.product_id}: quantity must be a number`);
    if (q <= 0 || q > MAX_QTY) throw new InvalidBasket(`${it.product_id}: quantity must be between 0 and ${MAX_QTY}`);
    merged.set(it.product_id, (merged.get(it.product_id) || 0) + q);
  }
  const rows = [], dist = Object.fromEntries(LEVELS.map(l => [l, 0])), cat = {};
  let est = 0, price = 0;
  for (const [pid, q] of merged) {
    const p = product(pid);
    if (!p) throw new InvalidBasket(`unknown product ${pid}`);
    if (q > MAX_QTY) throw new InvalidBasket(`${pid}: total quantity above ${MAX_QTY}`);
    const kg = q * p.kg_per_unit, emis = p.evidence ? kg * p.evidence.factor_kg_co2e_per_kg : null, sub = Math.round(q * p.price_inr * 100) / 100;
    price += sub; dist[p.evidence_quality]++;
    const c = (cat[p.category] ||= { emissions_kg_co2e: 0, price_inr: 0, items: 0, unestimated_items: 0 });
    c.items++; c.price_inr += sub;
    if (emis == null) c.unestimated_items++; else { est += emis; c.emissions_kg_co2e += emis; }
    rows.push({ product_id: p.id, name: p.name, category: p.category, quantity: r(q), unit: p.unit, kg: r(kg), price_inr: p.price_inr, subtotal_inr: sub,
      estimated_emissions_kg_co2e: r(emis), evidence_quality: p.evidence_quality, evidence: p.evidence, limitations: p.limitations,
      status: emis != null ? 'estimated' : 'insufficient_evidence', message: emis != null ? null : 'Insufficient evidence to calculate a reliable estimate.' });
  }
  rows.sort((a, b) => (b.estimated_emissions_kg_co2e || 0) - (a.estimated_emissions_kg_co2e || 0));
  const estimated = rows.filter(x => x.status === 'estimated');
  const totalKg = rows.reduce((s, x) => s + x.kg, 0), estKg = estimated.reduce((s, x) => s + x.kg, 0);
  const warnings = rows.filter(x => x.status !== 'estimated').map(x => `${x.name}: insufficient evidence; not included in the total.`)
    .concat(estimated.filter(x => x.evidence_quality === 'LOW').map(x => `${x.name}: LOW evidence; treat its estimate with caution.`));
  if (!estimated.some(x => String(x.evidence?.geography || '').toLowerCase().startsWith('india')))   // "Global (... not India-specific)" must not count
    warnings.push('No item in this basket uses India-specific emissions data; all estimates are global reference values.');
  return {
    items: rows,
    totals: { price_inr: Math.round(price * 100) / 100, estimated_emissions_kg_co2e: r(est), estimated_items: estimated.length, unestimated_items: rows.length - estimated.length,
      coverage_by_items: r(estimated.length / rows.length), coverage_by_weight: totalKg ? r(estKg / totalKg) : null },
    evidence_distribution: dist,
    categories: Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, { ...v, emissions_kg_co2e: r(v.emissions_kg_co2e), price_inr: Math.round(v.price_inr * 100) / 100 }])),
    top_contributors: estimated.slice(0, 3).map(x => ({ product_id: x.product_id, name: x.name, estimated_emissions_kg_co2e: x.estimated_emissions_kg_co2e, share: est ? r(x.estimated_emissions_kg_co2e / est) : null })),
    warnings,
    notes: ['Estimates, not measurements. Evidence levels describe data quality, not statistical confidence intervals.',
      'Total covers only items with evidence; unestimated items are excluded, not set to zero.', 'Prices are illustrative demo prices, not live retail prices.'],
  };
}

export function recommendations(items, budgetInr) {
  const base = calculate(items), total = base.totals.price_inr, out = [], rejected = [];
  const order = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
  for (const row of base.items) for (const a of ALTERNATIVES.filter(x => x.from === row.product_id)) {
    const alt = product(a.to);
    let why = null;
    if (a.comparable === false) why = 'not a comparable food (different purpose)';
    else if (row.status !== 'estimated') why = `${row.name} has no estimate to compare against`;
    else if (!alt?.evidence) why = `${alt ? alt.name : a.to} has insufficient evidence`;
    if (why) { rejected.push({ from: row.name, to: alt ? alt.name : a.to, reason: why }); continue; }
    const altEmis = row.kg * alt.evidence.factor_kg_co2e_per_kg, diff = altEmis - row.estimated_emissions_kg_co2e;   // same weight
    if (diff > -MIN_REDUCTION * row.estimated_emissions_kg_co2e) { rejected.push({ from: row.name, to: alt.name, reason: `not meaningfully lower (${r(row.estimated_emissions_kg_co2e)} vs ${r(altEmis)} kg CO2e)` }); continue; }
    const units = row.kg / alt.kg_per_unit, cost = Math.round(units * alt.price_inr * 100) / 100, pdiff = Math.round((cost - row.subtotal_inr) * 100) / 100;
    if (budgetInr != null && total + pdiff > budgetInr) { rejected.push({ from: row.name, to: alt.name, reason: `would exceed the ₹${budgetInr} budget (basket ₹${Math.round((total + pdiff) * 100) / 100})` }); continue; }
    const weakest = [row.evidence_quality, alt.evidence_quality].sort((x, y) => order[y] - order[x])[0];
    out.push({ from: { product_id: row.product_id, name: row.name, quantity: row.quantity, unit: row.unit, estimated_emissions_kg_co2e: row.estimated_emissions_kg_co2e, subtotal_inr: row.subtotal_inr, evidence_quality: row.evidence_quality },
      to: { product_id: alt.id, name: alt.name, quantity: r(units), unit: alt.unit, estimated_emissions_kg_co2e: r(altEmis), subtotal_inr: cost, evidence_quality: alt.evidence_quality },
      price_difference_inr: pdiff, emissions_difference_kg_co2e: r(diff), evidence_quality: weakest, purpose: a.purpose,
      reason: `Same weight of a ${a.purpose}; estimated ${r(-diff)} kg CO2e lower. ${a.note}`,
      caution: weakest === 'LOW' ? 'Based on weak (LOW) evidence for at least one item.' : 'Global reference data, not India-specific.' });
  }
  return { budget_inr: budgetInr ?? null, basket_price_inr: total, alternatives: out, rejected, note: 'Alternatives compare estimated emissions per kg of food. They are not nutritional or dietary advice.' };
}
