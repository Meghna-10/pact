// Agreement lifecycle: capture → confirm → observe (PayPal / verified webhook / test fixture / manual) → compare → review.
// Every step is written to the agreement's evidence and to the tamper-evident ledger.
// TermsTrace records and compares. It never charges, cancels, refunds or disputes anything.
import crypto from 'node:crypto';
import * as DB from './db.js';
import * as paypal from './paypal.js';
import { extractTerms, planToTerms, compareTerms, normInterval, fmt } from './engine.js';

export const SOURCE = { live: 'LIVE SANDBOX EVENT', api: 'LIVE SANDBOX DATA', fixture: 'TEST FIXTURE', manual: 'MANUAL DEMO DATA', customer: 'CUSTOMER', rules: 'TERMSTRACE RULES' };
const TRUSTED = new Set([SOURCE.live, SOURCE.api]);
const err = (s, m) => Object.assign(new Error(m), { status: s });
const now = () => new Date().toISOString();
const nid = p => `${p}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const FIELDS = ['merchant_name', 'subscription_name', 'currency', 'amount', 'billing_interval', 'trial_days', 'cancellation_terms', 'additional_fees'];

export function get(id) { const a = DB.loadAgreement(id); if (!a) throw err(404, 'unknown agreement'); return a; }
function log(a, type, source, data) { const e = DB.appendLedger(a.id, type, source, data); a.timeline.push({ at: e.at, type, source, data, hash: e.hash }); }
const save = a => { DB.saveAgreement(a); return a; };

export function createAgreement({ text = '', fileName = 'pasted text', mime = 'text/plain' } = {}) {
  text = String(text);
  if (!text.trim()) throw err(400, 'agreement text is required');
  if (text.length > 200000) throw err(413, 'agreement text is too long (200,000 characters max)');
  const a = { id: nid('AGR'), createdAt: now(), status: 'draft',
    document: { name: String(fileName).slice(0, 120), mime: String(mime).slice(0, 60), sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text), text },
    extracted: extractTerms(text), extractionMethod: 'rule-based extraction (no AI model configured)', confirmed: null, corrections: [],
    paypal: { planId: null, subscriptionId: null, approveUrl: null }, observations: [], comparisons: [], timeline: [], review: null };
  log(a, 'agreement_captured', SOURCE.customer, { document: a.document.name, sha256: a.document.sha256, bytes: a.document.bytes });
  log(a, 'terms_extracted', SOURCE.rules, { fields: Object.fromEntries(FIELDS.map(f => [f, a.extracted[f].value])), method: a.extractionMethod });
  return save(a);
}

export function confirmAgreement(id, terms = {}) {
  const a = get(id);
  const t = {};
  for (const f of FIELDS) {
    const extracted = a.extracted[f]?.value ?? null;
    let v = terms[f] !== undefined ? terms[f] : extracted;
    if (f === 'amount') v = v == null || v === '' ? null : Number(v);
    if (f === 'trial_days') v = v == null || v === '' ? null : Math.max(0, parseInt(v, 10));
    if (f === 'currency') v = v ? String(v).toUpperCase().slice(0, 3) : null;
    if (f === 'billing_interval') v = normInterval(v);
    if (f === 'additional_fees') v = Array.isArray(v) ? v : v == null || v === '' ? null : String(v).toLowerCase() === 'none' ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean);
    if (['merchant_name', 'subscription_name', 'cancellation_terms'].includes(f)) v = v == null || v === '' ? null : String(v).slice(0, 300);
    if (JSON.stringify(v) !== JSON.stringify(extracted)) a.corrections.push({ field: f, from: extracted, to: v, at: now() });
    t[f] = v;
  }
  if (!(t.amount > 0)) throw err(400, 'a positive price is required');
  if (!/^[A-Z]{3}$/.test(t.currency || '')) throw err(400, 'a 3-letter currency is required');
  if (!t.billing_interval) throw err(400, 'a billing interval is required');
  a.confirmed = { ...t, confirmedAt: now(), confirmedBy: 'customer' };
  a.status = 'confirmed';
  log(a, 'agreement_confirmed', SOURCE.customer, { terms: t, corrections: a.corrections.filter(c => c.at >= a.timeline.at(-1).at).length || a.corrections.length });
  return save(a);
}

export function linkPayPal(id, { planId, subscriptionId }) {
  const a = get(id);
  if (planId && !/^P-[A-Z0-9]{10,}$/.test(planId)) throw err(400, 'a PayPal plan ID looks like P-XXXXXXXXXXXX');
  if (subscriptionId && !/^I-[A-Z0-9]{8,}$/.test(subscriptionId)) throw err(400, 'a PayPal subscription ID looks like I-XXXXXXXXXX');
  if (planId) a.paypal.planId = planId;
  if (subscriptionId) a.paypal.subscriptionId = subscriptionId;
  log(a, 'paypal_linked', SOURCE.customer, { planId: a.paypal.planId, subscriptionId: a.paypal.subscriptionId });
  return save(a);
}

function observe(a, label, terms, raw, extra = {}) {
  if (!a.confirmed) throw err(409, 'confirm the agreement first: unconfirmed extraction is never treated as consent');
  const o = { id: nid('OBS'), at: now(), label, terms, raw, ...extra };
  a.observations.push(o);
  log(a, 'observed', label, { observation: o.id, eventId: o.eventId || null, eventType: o.eventType || null, verified: o.verified ?? null, terms });
  return o;
}

export function compare(a, o) {
  if (!a.confirmed) throw err(409, 'confirm the agreement first: unconfirmed extraction is never treated as consent');
  if (!o) {
    const c = { id: nid('CMP'), at: now(), observationId: null, source: null, outcome: 'NOT ENOUGH EVIDENCE', rows: [], changed: [], note: 'No observation of the actual subscription yet.' };
    a.comparisons.push(c); log(a, 'compared', SOURCE.rules, { comparison: c.id, outcome: c.outcome }); return c;
  }
  const r = compareTerms(a.confirmed, o.terms, { trusted: TRUSTED.has(o.label) });
  const c = { id: nid('CMP'), at: now(), observationId: o.id, source: o.label, ...r,
    note: o.label === SOURCE.fixture ? 'Compared against a TEST FIXTURE, not a real PayPal event.' : o.label === SOURCE.manual ? 'Compared against MANUAL DEMO DATA.' : 'Compared against data read from the PayPal sandbox.' };
  a.comparisons.push(c);
  a.status = r.outcome === 'MISMATCH' ? 'mismatch' : r.outcome === 'MATCH' ? 'match' : 'needs_review';
  log(a, 'compared', SOURCE.rules, { comparison: c.id, outcome: c.outcome, changed: c.changed, against: c.source });
  return c;
}

export async function fetchFromPayPal(id) {
  const a = get(id);
  if (!a.paypal.planId && !a.paypal.subscriptionId) throw err(409, 'link a PayPal plan or subscription first');
  let sub = null, planId = a.paypal.planId;
  if (a.paypal.subscriptionId) { sub = await paypal.getSubscription(a.paypal.subscriptionId); planId = sub.plan_id || planId; a.paypal.planId = planId; }
  const plan = await paypal.getPlan(planId);
  const lp = sub?.billing_info?.last_payment;
  const terms = { ...planToTerms(plan), subscription_status: sub?.status || null, next_billing_time: sub?.billing_info?.next_billing_time || null,
    ...(lp ? { payment: { amount: Number(lp.amount.value), currency: lp.amount.currency_code, at: lp.time, eventType: 'last_payment (subscription details)' } } : {}) };
  const o = observe(a, SOURCE.api, terms, { plan, subscription: sub }, { verified: true, planId, subscriptionId: a.paypal.subscriptionId });
  const c = compare(a, o);
  save(a);
  return { observation: o, comparison: c };
}

// Billing events (verified webhooks or labelled fixtures). Idempotent on event id.
export async function handleBillingEvent(body, { verified = false, fixture = false } = {}) {
  const r = body?.resource || {};
  const refs = [r.id, r.plan_id, r.billing_agreement_id].filter(Boolean);
  const a = DB.allAgreements().find(x => refs.includes(x.paypal.planId) || refs.includes(x.paypal.subscriptionId));
  const { inserted } = DB.insertRawEvent({ eventId: body?.id, source: fixture ? 'test-fixture' : 'paypal', type: body?.event_type, ref: refs[0], agreementId: a?.id, verified, payload: body });
  if (!inserted) return { duplicate: true, note: `event ${body?.id} was already received; ignored` };
  if (!a) return { applied: false, note: 'stored; no agreement is linked to this plan or subscription' };
  if (!verified && !fixture) return { applied: false, note: 'stored but NOT applied: the webhook signature was not verified' };
  const type = String(body.event_type);
  const terms = {};
  if (/^BILLING\.PLAN\./.test(type) && r.billing_cycles) Object.assign(terms, planToTerms(r));
  if (/^PAYMENT\.SALE\./.test(type) && r.amount) terms.payment = { amount: Number(r.amount.total ?? r.amount.value), currency: r.amount.currency ?? r.amount.currency_code, state: r.state, eventType: type };
  if (/^BILLING\.SUBSCRIPTION\./.test(type)) terms.subscription_status = r.status || null;
  const o = observe(a, fixture ? SOURCE.fixture : SOURCE.live, terms, body, { eventId: body.id, eventType: type, verified, fixture });
  save(a);
  DB.markApplied(body.id);
  // Events can be partial (a sale has no plan price): for verified events, re-read the canonical plan from PayPal.
  if (verified && paypal.isLive() && a.paypal.planId) {
    const snap = await fetchFromPayPal(a.id);
    const fresh = get(a.id); const ev = fresh.observations.find(x => x.id === o.id);
    if (ev?.terms.payment) { const merged = observe(fresh, SOURCE.live, { ...snap.observation.terms, payment: ev.terms.payment }, { event: body.id, snapshot: snap.observation.id }, { eventId: body.id + ':merged', verified: true }); const c = compare(fresh, merged); save(fresh); return { applied: true, agreementId: a.id, outcome: c.outcome }; }
    return { applied: true, agreementId: a.id, outcome: snap.comparison.outcome };
  }
  const fresh = get(a.id); const c = compare(fresh, fresh.observations.find(x => x.id === o.id)); save(fresh);
  return { applied: true, agreementId: a.id, outcome: c.outcome };
}

export function manualObservation(id, t = {}) {
  const a = get(id);
  const terms = { amount: t.amount === '' || t.amount == null ? null : Number(t.amount), currency: t.currency ? String(t.currency).toUpperCase() : null, billing_interval: normInterval(t.billing_interval),
    trial_days: t.trial_days === '' || t.trial_days == null ? null : Number(t.trial_days) };
  const o = observe(a, SOURCE.manual, terms, { entered: t }, { verified: false });
  const c = compare(a, o); save(a);
  return { observation: o, comparison: c };
}

export function review(id, note = '') {
  const a = get(id);
  a.review = { at: now(), by: 'reviewer', note: String(note).slice(0, 1000) };
  log(a, 'reviewed', 'REVIEWER', { note: a.review.note, outcomeAtReview: a.comparisons.at(-1)?.outcome || null });
  return save(a);
}

export function explain(a) {
  const c = a.comparisons.at(-1);
  if (!a.confirmed) return null;
  if (!c) return { outcome: null, whatChanged: [], agreed: agreedLine(a), latest: null, evidence: [], next: ['Link the PayPal plan or subscription, then read it from PayPal.'] };
  const o = a.observations.find(x => x.id === c.observationId);
  const diff = c.rows.filter(r => ['mismatch', 'needs_review'].includes(r.status));
  const pay = c.rows.find(r => r.field === 'payment');
  return {
    outcome: c.outcome, source: c.source,
    whatChanged: diff.map(r => `${r.label}: agreed ${fmt(r.field, r.agreed)}, latest shows ${fmt(r.field, r.observed)}${r.note ? ` (${r.note})` : ''}`),
    agreed: agreedLine(a),
    latest: o ? `${o.terms.amount != null ? `$${Number(o.terms.amount).toFixed(2)} ${o.terms.currency || ''}`.trim() : 'price not included'}${o.terms.billing_interval ? `, ${fmt('billing_interval', o.terms.billing_interval)}` : ''}${o.terms.trial_days != null ? `, ${fmt('trial_days', o.terms.trial_days)} trial` : ''}${o.terms.plan_name ? ` · plan "${o.terms.plan_name}"` : ''} [${o.label}, ${o.at.slice(0, 16).replace('T', ' ')} UTC]` : null,
    charged: pay ? (pay.status === 'match' ? `A payment of ${fmt('payment', pay.observed)} matches the agreed price.` : `A payment of ${fmt('payment', pay.observed)} was observed (${pay.note}).`)
      : 'No payment event confirms a charge at this price yet. The difference is in the plan terms, not in a charge.',
    evidence: [`Agreement document "${a.document.name}", SHA-256 ${a.document.sha256}`, `Customer confirmation ${a.confirmed.confirmedAt}${a.corrections.length ? ` (${a.corrections.length} correction${a.corrections.length > 1 ? 's' : ''})` : ''}`,
      o ? `Observation ${o.id} · ${o.label}${o.planId ? ` · plan ${o.planId}` : ''}${o.eventId ? ` · event ${o.eventId}` : ''}` : null, `Comparison ${c.id} · ${c.at}`].filter(Boolean),
    next: c.outcome === 'MISMATCH' ? ['Check whether the customer was notified of the new terms and accepted them.', 'Watch the next PAYMENT.SALE.COMPLETED to see whether a charge at the new price happens.', 'Contact the merchant if the change was not agreed. TermsTrace does not cancel, refund or dispute anything.']
      : c.outcome === 'MATCH' ? ['No action needed. TermsTrace keeps this record.']
      : ['Read the plan from PayPal (verified data), or correct the agreement fields.'],
    disclaimer: 'A record of what was observed and compared. Not legal proof and not a fraud finding.',
  };
}
const agreedLine = a => `${a.confirmed.merchant_name || 'Merchant'}${a.confirmed.subscription_name ? ` · ${a.confirmed.subscription_name}` : ''}: $${a.confirmed.amount.toFixed(2)} ${a.confirmed.currency}, ${fmt('billing_interval', a.confirmed.billing_interval)}${a.confirmed.trial_days ? `, ${a.confirmed.trial_days}-day free trial` : ''}. Confirmed ${a.confirmed.confirmedAt.slice(0, 10)}.`;

export const detail = id => { const a = get(id); return { ...a, explanation: explain(a), ledger: DB.ledgerFor(id) }; };
export const list = () => DB.allAgreements().map(a => ({ id: a.id, createdAt: a.createdAt, status: a.status, merchant: a.confirmed?.merchant_name ?? a.extracted.merchant_name.value,
  plan: a.confirmed?.subscription_name ?? a.extracted.subscription_name.value, amount: a.confirmed?.amount ?? a.extracted.amount.value, currency: a.confirmed?.currency ?? a.extracted.currency.value,
  outcome: a.comparisons.at(-1)?.outcome || null, source: a.comparisons.at(-1)?.source || null, reviewed: !!a.review, paypal: a.paypal, events: a.observations.length }));
export function exportEvidence(id) {
  const a = get(id);
  return { exportedAt: now(), product: 'TermsTrace', disclaimer: 'Record of observations and deterministic comparisons. Not legal proof and not a fraud finding.',
    agreement: { id: a.id, document: { name: a.document.name, sha256: a.document.sha256, bytes: a.document.bytes }, extractionMethod: a.extractionMethod, extracted: a.extracted, corrections: a.corrections, confirmed: a.confirmed },
    paypal: a.paypal, observations: a.observations, comparisons: a.comparisons, review: a.review, explanation: explain(a), ledger: DB.ledgerFor(id), ledgerIntegrity: DB.verifyLedger() };
}
