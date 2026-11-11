// TermsTrace engine: pure functions, no I/O.
//  extractTerms(text)    → fields, each with the snippet it came from and a confidence
//  planToTerms(plan)     → comparable fields from a canonical PayPal plan
//  compareTerms(a, o)    → deterministic field-by-field result
// The comparison is plain code. No model decides MATCH or MISMATCH.

export const INTERVALS = { day: 'DAY', daily: 'DAY', week: 'WEEK', weekly: 'WEEK', month: 'MONTH', monthly: 'MONTH', mo: 'MONTH', year: 'YEAR', yearly: 'YEAR', annual: 'YEAR', annually: 'YEAR', yr: 'YEAR', annum: 'YEAR' };
export const normInterval = v => (v == null || v === '' ? null : INTERVALS[String(v).toLowerCase()] || String(v).toUpperCase());

export function extractTerms(text = '') {
  const t = String(text);
  const snip = m => (m ? t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ').trim() : null);
  const field = (value, m, confidence) => ({ value, evidence: value == null ? null : snip(m), confidence: value == null ? 'not found' : confidence });
  const merchantM = /(?:merchant|company|provided by|sold by|seller)[ \t]*[:\-][ \t]*([A-Za-z0-9][\w&.' -]{1,40}?)[ \t]*(?:[,.(]|\r?\n|$)/im.exec(t);
  const planM = /(?:plan|subscription|tier)\s*(?:name)?\s*[:\-]\s*([^\n,.]{2,40})/i.exec(t);
  const priceM = /(US\$|\$|USD\s?|€|EUR\s?|£|GBP\s?|₹|INR\s?)\s?(\d{1,5}(?:[.,]\d{2})?)\s*(?:USD|EUR|GBP|INR)?\s*(?:\/|per|a|each)?\s*(day|week|month|year|mo|yr|annum)?/i.exec(t);
  const intervalM = /\b(?:billed|renews?|charged|payable)\s+(daily|weekly|monthly|yearly|annually)\b|\b(?:per|every|each|\/)\s*(day|week|month|year|mo|yr)\b/i.exec(t);
  const trialM = /(\d{1,3})[\s-]*(day|week|month)s?\s+(?:free\s+)?trial/i.exec(t) || /free trial\s+(?:of|for)\s+(\d{1,3})\s*(day|week|month)s?/i.exec(t);
  const noTrialM = /\bno (?:free )?trial\b/i.exec(t);
  const cancelM = /(cancel[^.\n]{0,160}[.;\n])/i.exec(t);
  const noFeeM = /\bno (?:additional|extra|hidden|setup) fees?\b/i.exec(t);
  const feeM = /\b((?:setup|activation|service|processing|installation) fee[^.\n]{0,60})/i.exec(t);
  const symbol = priceM?.[1].trim().toUpperCase();
  const cur = !priceM ? null : ({ '$': 'USD', 'US$': 'USD', USD: 'USD', '€': 'EUR', EUR: 'EUR', '£': 'GBP', GBP: 'GBP', '₹': 'INR', INR: 'INR' })[symbol] || null;
  const curExplicit = /\b(USD|EUR|GBP|INR)\b/.exec(t);
  const intervalWord = (intervalM && (intervalM[1] || intervalM[2])) || priceM?.[3];
  const unitDays = { day: 1, week: 7, month: 30 };
  return {
    merchant_name: field(merchantM ? merchantM[1].trim() : null, merchantM, 'medium'),
    subscription_name: field(planM ? planM[1].trim() : null, planM, 'medium'),
    currency: field(curExplicit ? curExplicit[1] : cur, curExplicit || priceM, curExplicit ? 'high' : 'medium'),
    amount: field(priceM ? Number(priceM[2].replace(',', '.')) : null, priceM, 'high'),
    billing_interval: field(intervalWord ? normInterval(intervalWord) : null, intervalM || priceM, 'high'),
    trial_days: noTrialM ? field(0, noTrialM, 'high') : field(trialM ? Number(trialM[1]) * unitDays[trialM[2].toLowerCase()] : null, trialM, 'high'),
    cancellation_terms: field(cancelM ? cancelM[1].trim() : null, cancelM, 'medium'),
    additional_fees: noFeeM ? field([], noFeeM, 'high') : field(feeM ? [feeM[1].trim()] : null, feeM, 'medium'),
  };
}

// Canonical PayPal plan → comparable fields. Trial = TRIAL cycles in days; price/interval = first REGULAR cycle.
export function planToTerms(plan) {
  const cycles = plan?.billing_cycles || [];
  const days = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };
  const trial = cycles.filter(c => c.tenure_type === 'TRIAL').reduce((s, c) => s + (days[c.frequency?.interval_unit] || 0) * (c.frequency?.interval_count || 1) * (c.total_cycles || 1), 0);
  const reg = cycles.find(c => c.tenure_type === 'REGULAR');
  const fp = reg?.pricing_scheme?.fixed_price;
  const setup = plan?.payment_preferences?.setup_fee;
  return {
    amount: fp ? Number(fp.value) : null,
    currency: fp?.currency_code || null,
    billing_interval: reg ? (reg.frequency.interval_count > 1 ? `${reg.frequency.interval_count}x${reg.frequency.interval_unit}` : reg.frequency.interval_unit) : null,
    trial_days: cycles.length ? trial : null,
    additional_fees: setup ? (Number(setup.value) > 0 ? [`setup fee ${setup.value} ${setup.currency_code}`] : []) : null,
    plan_id: plan?.id || null, plan_name: plan?.name || null, plan_status: plan?.status || null, plan_updated: plan?.update_time || null,
  };
}

// trusted = the observation comes from PayPal itself (API read or verified webhook).
// A difference from an untrusted source is NEEDS REVIEW, never MISMATCH.
export function compareTerms(agreed, observed, { trusted = true } = {}) {
  const rows = [];
  const add = (field, label, a, o, status, note = '') => rows.push({ field, label, agreed: a, observed: o, status, note });
  const eqMoney = (x, y) => Math.round(Number(x) * 100) === Math.round(Number(y) * 100);
  const cmp = (field, label, a, o, eq = (x, y) => x === y) => {
    if (a == null) return add(field, label, a, o, 'not_enough_evidence', 'not in the confirmed agreement');
    if (o == null) return add(field, label, a, o, 'not_enough_evidence', 'not in the observed data');
    if (eq(a, o)) return add(field, label, a, o, 'match');
    return add(field, label, a, o, trusted ? 'mismatch' : 'needs_review', trusted ? '' : 'differs, but this source is not verified PayPal data');
  };
  cmp('amount', 'Price', agreed.amount, observed.amount, eqMoney);
  cmp('currency', 'Currency', agreed.currency, observed.currency);
  cmp('billing_interval', 'Billing interval', agreed.billing_interval, observed.billing_interval);
  cmp('trial_days', 'Free trial', agreed.trial_days, observed.trial_days);
  if (agreed.additional_fees != null && observed.additional_fees != null) cmp('additional_fees', 'Additional fees', (agreed.additional_fees || []).length, (observed.additional_fees || []).length);
  else add('additional_fees', 'Additional fees', agreed.additional_fees, observed.additional_fees, 'not_enough_evidence', 'fee information not available from this source');
  if (observed.payment) {
    const p = observed.payment;
    const ok = eqMoney(agreed.amount, p.amount) && (!p.currency || p.currency === agreed.currency);
    add('payment', 'Amount actually charged', agreed.amount, p.amount, agreed.amount == null ? 'not_enough_evidence' : ok ? 'match' : trusted ? 'mismatch' : 'needs_review', `${p.eventType}${p.state ? ' · ' + p.state : ''}`);
  }
  const core = rows.filter(r => ['amount', 'currency', 'billing_interval'].includes(r.field));
  const outcome = rows.some(r => r.status === 'mismatch') ? 'MISMATCH'
    : rows.some(r => r.status === 'needs_review') ? 'NEEDS REVIEW'
    : core.some(r => r.status === 'not_enough_evidence') ? 'NOT ENOUGH EVIDENCE'
    : core.every(r => r.status === 'match') ? 'MATCH' : 'NEEDS REVIEW';
  return { outcome, rows, changed: rows.filter(r => r.status === 'mismatch').map(r => r.field) };
}

export const fmt = (field, v) => v == null ? 'not stated'
  : ['amount', 'payment'].includes(field) ? `$${Number(v).toFixed(2)}`
  : field === 'trial_days' ? `${v} day${v === 1 ? '' : 's'}`
  : field === 'billing_interval' ? ({ MONTH: 'monthly', YEAR: 'yearly', WEEK: 'weekly', DAY: 'daily' })[v] || String(v).toLowerCase()
  : Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : field === 'additional_fees' ? (v === 0 ? 'none' : `${v} fee(s)`) : String(v);
