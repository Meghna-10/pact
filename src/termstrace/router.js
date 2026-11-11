// Agreement Mirror (TermsTrace) as a PACT module, mounted at /tt.
// Own SQLite file (data/termstrace.db) so its tables never collide with PACT's.
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as DB from './db.js';
import * as S from './service.js';
import * as paypal from './paypal.js';

export const router = express.Router();
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
const PORT = process.env.PORT || 5200;
export const handleBillingEvent = S.handleBillingEvent;

router.get('/api/status', (_q, res) => res.json({
  paypal: paypal.isLive() ? 'sandbox' : 'not configured', webhooks: process.env.PAYPAL_WEBHOOK_ID ? 'configured' : 'not configured',
  live: false, database: { file: DB.dbFile, ledger: DB.verifyLedger() }, counts: DB.counts(), demo: DB.kvGet('demoPlans'),
}));
router.get('/api/agreements', (_q, res) => res.json(S.list()));
router.post('/api/agreements', wrap((req, res) => res.json(S.createAgreement(req.body || {}))));
router.get('/api/agreements/:id', wrap((req, res) => res.json(S.detail(req.params.id))));
router.post('/api/agreements/:id/confirm', wrap((req, res) => res.json(S.confirmAgreement(req.params.id, req.body || {}))));
router.post('/api/agreements/:id/link', wrap((req, res) => res.json(S.linkPayPal(req.params.id, req.body || {}))));
router.post('/api/agreements/:id/fetch', wrap(async (req, res) => res.json(await S.fetchFromPayPal(req.params.id))));
router.post('/api/agreements/:id/manual', wrap((req, res) => res.json(S.manualObservation(req.params.id, req.body || {}))));
router.post('/api/agreements/:id/review', wrap((req, res) => res.json(S.review(req.params.id, req.body?.note))));
router.get('/api/agreements/:id/export.json', wrap((req, res) => res.set('Content-Disposition', `attachment; filename="agreement-${req.params.id}.json"`).json(S.exportEvidence(req.params.id))));
router.get('/api/sample', (_q, res) => res.type('text/plain; charset=utf-8').send(fs.readFileSync(new URL('../../data/samples/streambox-agreement.txt', import.meta.url), 'utf8')));
router.get('/api/events', (_q, res) => res.json(DB.rawEvents()));

// Real sandbox demo plans: $9.99 as advertised, $19.99 as the checkout uses now.
router.post('/api/demo/plans', wrap(async (_q, res) => {
  let d = DB.kvGet('demoPlans');
  if (!d) {
    const prod = await paypal.createProduct('StreamBox Demo', 'PACT Agreement Mirror demo product (sandbox)');
    const shown = await paypal.createPlan({ productId: prod.id, name: 'Premium Monthly (as advertised)', amount: 9.99, trialDays: 7 });
    const current = await paypal.createPlan({ productId: prod.id, name: 'Premium Monthly', amount: 19.99, trialDays: 7 });
    d = { productId: prod.id, advertisedPlanId: shown.id, currentPlanId: current.id, createdAt: new Date().toISOString() };
    DB.kvSet('demoPlans', d);
  }
  res.json(d);
}));
router.post('/api/agreements/:id/subscribe', wrap(async (req, res) => {
  const a = S.get(req.params.id);
  if (!a.paypal.planId) return res.status(409).json({ error: 'link a PayPal plan first' });
  const s = await paypal.createSubscription(a.paypal.planId, `http://localhost:${PORT}/tt/app.html#/agreement/${a.id}`);
  S.linkPayPal(a.id, { subscriptionId: s.id });
  res.json({ subscriptionId: s.id, status: s.status, approveUrl: (s.links || []).find(l => l.rel === 'approve')?.href || null });
}));
router.post('/api/agreements/:id/try-price-change', wrap(async (req, res) => {
  const a = S.get(req.params.id);
  if (!a.paypal.planId) return res.status(409).json({ error: 'link a PayPal plan first' });
  const plan = await paypal.getPlan(a.paypal.planId);
  const seq = (plan.billing_cycles || []).find(c => c.tenure_type === 'REGULAR')?.sequence || 1;
  try { await paypal.updatePlanPricing(a.paypal.planId, seq, Number(req.body?.amount) || 19.99); res.json({ ok: true }); }
  catch (e) { res.status(422).json({ ok: false, error: e.message, note: 'PayPal refused the pricing update for this plan. Use the second (current) plan or a labelled test fixture instead.' }); }
}));
router.post('/api/agreements/:id/fixture', wrap(async (req, res) => {
  const a = S.get(req.params.id), b = req.body || {};
  const types = ['BILLING.PLAN.PRICING-CHANGE.ACTIVATED', 'PAYMENT.SALE.COMPLETED', 'BILLING.SUBSCRIPTION.UPDATED'];
  const type = types.includes(b.eventType) ? b.eventType : types[0];
  const amt = (Number(b.amount) > 0 ? Number(b.amount) : 19.99).toFixed(2);
  if (!a.paypal.planId && !a.paypal.subscriptionId) return res.status(409).json({ error: 'link a PayPal plan first, or enter manual demo data' });
  const ref = a.paypal.subscriptionId || a.paypal.planId;
  const resource = type.startsWith('BILLING.PLAN') ? { id: a.paypal.planId || ref, status: 'ACTIVE', billing_cycles: [{ tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, frequency: { interval_unit: 'MONTH', interval_count: 1 }, pricing_scheme: { fixed_price: { value: amt, currency_code: 'USD' } } }] }
    : type.startsWith('PAYMENT.SALE') ? { id: 'SALE-FIXTURE', billing_agreement_id: ref, state: 'completed', amount: { total: amt, currency: 'USD' } }
    : { id: ref, plan_id: a.paypal.planId, status: 'ACTIVE' };
  const body = { id: b.eventId || `WH-FIXTURE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, event_type: type, create_time: new Date().toISOString(), resource };
  res.json({ eventId: body.id, ...(await S.handleBillingEvent(body, { fixture: true })) });
}));
