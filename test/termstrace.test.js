// Unit tests for the engine + integration tests for the API and webhook handling.
// Tests never call PayPal: keys are blanked so dotenv cannot refill them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.TT_DB = ':memory:'; process.env.PACT_DB = ':memory:';
process.env.PAYPAL_CLIENT_ID = ''; process.env.PAYPAL_CLIENT_SECRET = ''; process.env.PAYPAL_WEBHOOK_ID = ''; process.env.PAYPAL_PAYEE_EMAIL = ''; process.env.ANTHROPIC_API_KEY = '';
const E = await import('../src/termstrace/engine.js');
const DB = await import('../src/termstrace/db.js');
const { app } = await import('../src/server.js');
const SAMPLE = fs.readFileSync(new URL('../data/samples/streambox-agreement.txt', import.meta.url), 'utf8');
const AGREED = { amount: 9.99, currency: 'USD', billing_interval: 'MONTH', trial_days: 7, additional_fees: [] };

// ---------------- engine ----------------
test('extraction returns structured fields with the evidence each came from', () => {
  const x = E.extractTerms(SAMPLE);
  assert.equal(x.merchant_name.value, 'StreamBox Demo');
  assert.equal(x.subscription_name.value, 'Premium Monthly');
  assert.equal(x.amount.value, 9.99);
  assert.equal(x.currency.value, 'USD');
  assert.equal(x.billing_interval.value, 'MONTH');
  assert.equal(x.trial_days.value, 7);
  assert.deepEqual(x.additional_fees.value, []);
  for (const f of Object.values(x)) if (f.value != null) assert.ok(f.evidence, 'every found value carries its source text');
  assert.equal(E.extractTerms('Pay what you want').amount.confidence, 'not found');
});

test('a PayPal plan maps to comparable terms (trial from TRIAL cycles, price from REGULAR)', () => {
  const plan = { id: 'P-1', billing_cycles: [{ tenure_type: 'TRIAL', sequence: 1, total_cycles: 1, frequency: { interval_unit: 'DAY', interval_count: 7 } },
    { tenure_type: 'REGULAR', sequence: 2, total_cycles: 0, frequency: { interval_unit: 'MONTH', interval_count: 1 }, pricing_scheme: { fixed_price: { value: '19.99', currency_code: 'USD' } } }] };
  assert.deepEqual({ ...E.planToTerms(plan), plan_id: undefined, plan_name: undefined, plan_status: undefined, plan_updated: undefined },
    { amount: 19.99, currency: 'USD', billing_interval: 'MONTH', trial_days: 7, additional_fees: null, plan_id: undefined, plan_name: undefined, plan_status: undefined, plan_updated: undefined });
});

test('MATCH, MISMATCH, NEEDS REVIEW, NOT ENOUGH EVIDENCE', () => {
  assert.equal(E.compareTerms(AGREED, { ...AGREED }).outcome, 'MATCH');
  const m = E.compareTerms(AGREED, { ...AGREED, amount: 19.99 });
  assert.equal(m.outcome, 'MISMATCH'); assert.deepEqual(m.changed, ['amount']);
  assert.equal(E.compareTerms(AGREED, { ...AGREED, billing_interval: 'YEAR' }).outcome, 'MISMATCH');
  assert.equal(E.compareTerms(AGREED, { ...AGREED, trial_days: 0 }).outcome, 'MISMATCH');
  assert.equal(E.compareTerms(AGREED, { ...AGREED, amount: 19.99 }, { trusted: false }).outcome, 'NEEDS REVIEW', 'unverified differences are never a mismatch');
  assert.equal(E.compareTerms(AGREED, { amount: null, currency: null, billing_interval: null }).outcome, 'NOT ENOUGH EVIDENCE');
  assert.equal(E.compareTerms(AGREED, { ...AGREED, payment: { amount: 19.99, currency: 'USD', eventType: 'PAYMENT.SALE.COMPLETED' } }).rows.find(r => r.field === 'payment').status, 'mismatch');
  assert.equal(E.compareTerms(AGREED, { ...AGREED, amount: 9.990000001 }).outcome, 'MATCH', 'money compared in cents');
});

// ---------------- API + webhooks ----------------
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const j = (p, method = 'GET', body) => fetch(base + (p.startsWith('/api/webhooks') ? p : '/tt' + p), { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async r => ({ s: r.status, b: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));
test.after(() => srv.close());

test('upload → editable extraction → confirm (with a correction) → fixtures → export', async () => {
  const up = await j('/api/agreements', 'POST', { text: SAMPLE, fileName: 'streambox-agreement.txt' });
  assert.equal(up.s, 200);
  const id = up.b.id;
  assert.equal(up.b.status, 'draft');
  assert.equal(up.b.document.sha256.length, 64);
  // unconfirmed extraction is never consent
  assert.equal((await j(`/api/agreements/${id}/manual`, 'POST', { amount: 9.99 })).s, 409);
  // the customer corrects the trial to 7 (same) and the plan name (a correction is recorded)
  const c = await j(`/api/agreements/${id}/confirm`, 'POST', { subscription_name: 'Premium Monthly Plan' });
  assert.equal(c.s, 200); assert.equal(c.b.confirmed.amount, 9.99);
  assert.ok(c.b.corrections.some(x => x.field === 'subscription_name'));
  assert.equal((await j(`/api/agreements/${id}/confirm`, 'POST', { amount: -1 })).s, 400, 'invalid input rejected');
  // fixtures need a link
  assert.equal((await j(`/api/agreements/${id}/fixture`, 'POST', {})).s, 409);
  assert.equal((await j(`/api/agreements/${id}/link`, 'POST', { planId: 'bad' })).s, 400);
  await j(`/api/agreements/${id}/link`, 'POST', { planId: 'P-ABCDEFGHIJ12' });
  // fixture price change → compared, but labelled TEST FIXTURE and so NEEDS REVIEW, never MISMATCH
  const f = await j(`/api/agreements/${id}/fixture`, 'POST', { eventType: 'BILLING.PLAN.PRICING-CHANGE.ACTIVATED', amount: 19.99, eventId: 'WH-FIX-1' });
  assert.equal(f.b.applied, true); assert.equal(f.b.outcome, 'NEEDS REVIEW');
  // duplicate delivery of the same event id creates no new evidence
  const before = (await j(`/api/agreements/${id}`)).b.observations.length;
  const dup = await j(`/api/agreements/${id}/fixture`, 'POST', { eventType: 'BILLING.PLAN.PRICING-CHANGE.ACTIVATED', amount: 19.99, eventId: 'WH-FIX-1' });
  assert.equal(dup.b.duplicate, true);
  assert.equal((await j(`/api/agreements/${id}`)).b.observations.length, before);
  // manual demo data that matches → MATCH, labelled
  const man = await j(`/api/agreements/${id}/manual`, 'POST', { amount: 9.99, currency: 'USD', billing_interval: 'monthly', trial_days: 7 });
  assert.equal(man.b.comparison.outcome, 'MATCH'); assert.equal(man.b.observation.label, 'MANUAL DEMO DATA');
  // timeline preserves the source of every entry; ledger chain intact
  const d = (await j(`/api/agreements/${id}`)).b;
  assert.ok(d.timeline.every(t => t.source && t.at && t.hash));
  assert.ok(d.timeline.some(t => t.source === 'TEST FIXTURE') && d.timeline.some(t => t.source === 'MANUAL DEMO DATA') && d.timeline.some(t => t.source === 'CUSTOMER'));
  assert.equal(d.ledger.length, d.timeline.length);
  // review + export
  assert.equal((await j(`/api/agreements/${id}/review`, 'POST', { note: 'checked with merchant' })).b.review.note, 'checked with merchant');
  const ex = await j(`/api/agreements/${id}/export.json`);
  assert.equal(ex.s, 200); assert.equal(ex.b.agreement.document.sha256, up.b.document.sha256); assert.equal(ex.b.ledgerIntegrity.ok, true);
  assert.ok(ex.b.observations.length >= 2 && ex.b.comparisons.length >= 2);
});

test('webhook: unverified events are stored but not applied; redelivery is ignored', async () => {
  const up = await j('/api/agreements', 'POST', { text: SAMPLE });
  await j(`/api/agreements/${up.b.id}/confirm`, 'POST', {});
  await j(`/api/agreements/${up.b.id}/link`, 'POST', { planId: 'P-WEBHOOKTEST01' });
  const ev = { id: 'WH-REAL-1', event_type: 'BILLING.PLAN.PRICING-CHANGE.ACTIVATED', resource: { id: 'P-WEBHOOKTEST01', billing_cycles: [] } };
  for (let i = 0; i < 2; i++) assert.equal((await fetch(base + '/api/webhooks/paypal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) })).status, 200);
  const raw = DB.rawEvents().filter(r => r.event_id === 'WH-REAL-1');
  assert.equal(raw.length, 1, 'stored once');
  assert.equal(raw[0].verified, false); assert.equal(raw[0].applied, false);
  assert.equal((await j(`/api/agreements/${up.b.id}`)).b.observations.length, 0, 'not applied without a verified signature');
  const st = (await j('/api/status')).b;
  assert.equal(st.live, false); assert.ok(!JSON.stringify(st).includes('SECRET'));
});

test('an agreement with no observation reports NOT ENOUGH EVIDENCE in its explanation', async () => {
  const up = await j('/api/agreements', 'POST', { text: SAMPLE });
  const d = (await j(`/api/agreements/${up.b.id}/confirm`, 'POST', {})).b;
  const det = (await j(`/api/agreements/${d.id}`)).b;
  assert.equal(det.explanation.outcome, null);
  assert.match(det.explanation.next[0], /Link the PayPal plan/);
});
