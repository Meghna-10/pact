// CarbonLens (beta) as a PACT module, mounted at /cl.
// Own SQLite file (data/carbonlens.db). Amount is always computed server-side from the stored basket;
// a receipt exists only after PayPal reports a COMPLETED capture with the exact amount + currency.
import express from 'express';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as E from './engine.js';
import * as AI from './ai.js';
import * as paypal from '../paypal.js';

export const router = express.Router();
export const INR_PER_USD = Number(process.env.DEMO_INR_PER_USD || 83);   // ILLUSTRATIVE conversion for the sandbox charge only
const file = process.env.CL_DB || (process.env.NODE_TEST_CONTEXT ? ':memory:' : null) || new URL('../../data/carbonlens.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const db = new DatabaseSync(file);
db.exec(`
CREATE TABLE IF NOT EXISTS cl_baskets (id TEXT PRIMARY KEY, items TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cl_payments (id TEXT PRIMARY KEY, basket_id TEXT NOT NULL, paypal_order_id TEXT UNIQUE NOT NULL, paypal_capture_id TEXT,
  amount TEXT NOT NULL, currency TEXT NOT NULL, amount_inr REAL NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cl_receipts (id TEXT PRIMARY KEY, payment_id TEXT UNIQUE NOT NULL, basket_id TEXT NOT NULL, snapshot TEXT NOT NULL, generated_at TEXT NOT NULL);`);
const now = () => new Date().toISOString();
const uid = p => `${p}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
const fail = (status, m) => Object.assign(new Error(m), { status });
const items = b => { if (!Array.isArray(b?.items) || b.items.length > 50) throw fail(400, 'items must be a list of 1 to 50 entries'); return b.items; };
const toUsd = inr => Math.max(0.01, Math.round(inr / INR_PER_USD * 100) / 100).toFixed(2);
const productOut = p => ({ id: p.id, name: p.name, category: p.category, unit: p.unit, kg_per_unit: p.kg_per_unit, price_inr: p.price_inr, price_is_illustrative: true,
  image_url: null, evidence_quality: p.evidence_quality, has_estimate: !!p.evidence, factor_kg_co2e_per_kg: p.evidence?.factor_kg_co2e_per_kg ?? null, evidence: p.evidence, limitations: p.limitations || [] });
const sources = () => [{ id: E.SOURCE.id, name: E.SOURCE.name, url: E.SOURCE.url, dataset_name: E.SOURCE.dataset_name, reference_year: E.SOURCE.reference_year,
  geography: E.SOURCE.geography, lifecycle_boundary: E.SOURCE.lifecycle_boundary, methodology: E.SOURCE.methodology }];

router.get('/api/health', (_q, res) => res.json({ status: 'ok', products: E.PRODUCTS.length, paypal: paypal.isLive() ? 'sandbox' : 'not configured',
  ai: process.env.ANTHROPIC_API_KEY ? 'anthropic (validated)' : 'rule-based template', inr_per_usd_demo_rate: INR_PER_USD }));
router.get('/api/config', (_q, res) => res.json({ paypal_client_id: paypal.isLive() ? process.env.PAYPAL_CLIENT_ID : null, currency: 'USD', inr_per_usd_demo_rate: INR_PER_USD, sandbox: true }));
router.get('/api/products', (_q, res) => res.json([...E.PRODUCTS].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)).map(productOut)));
router.get('/api/products/:id', (req, res) => { const p = E.product(req.params.id); return p ? res.json(productOut(p)) : res.status(404).json({ error: 'unknown product' }); });
router.get('/api/sources', (_q, res) => res.json(sources()));

router.post('/api/basket', wrap((req, res) => {
  const calc = E.calculate(items(req.body));                    // validates before saving
  const id = uid('BSK');
  db.prepare('INSERT INTO cl_baskets VALUES (?,?,?)').run(id, JSON.stringify(calc.items.map(i => ({ product_id: i.product_id, quantity: i.quantity }))), now());
  res.json({ basket_id: id, calculation: calc });
}));
router.post('/api/basket/calculate', wrap((req, res) => res.json(E.calculate(items(req.body)))));
const budget = b => (b?.budget_inr == null ? null : (Number(b.budget_inr) > 0 ? Number(b.budget_inr) : (() => { throw fail(400, 'budget_inr must be positive'); })()));
router.post('/api/ai/explain', wrap(async (req, res) => {
  const it = items(req.body), calc = E.calculate(it), out = await AI.explain(calc);
  if (req.body.question) out.answer = AI.answer(String(req.body.question).slice(0, 300), calc, E.recommendations(it, budget(req.body)));
  res.json(out);
}));
router.post('/api/ai/recommendations', wrap((req, res) => res.json(E.recommendations(items(req.body), budget(req.body)))));

router.post('/api/paypal/create-order', wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM cl_baskets WHERE id=?').get(String(req.body?.basket_id || ''));
  if (!b) throw fail(404, 'unknown basket');
  const calc = E.calculate(JSON.parse(b.items)), amount = toUsd(calc.totals.price_inr), payId = uid('PAY');   // amount from the server's basket only
  const o = await paypal.createOrder({ amount: Number(amount), description: `CarbonLens sandbox grocery basket ${b.id}`, referenceId: payId });
  db.prepare('INSERT INTO cl_payments VALUES (?,?,?,?,?,?,?,?,?)').run(payId, b.id, o.id, null, amount, 'USD', calc.totals.price_inr, 'CREATED', now());
  res.json({ payment_id: payId, order_id: o.id, amount, currency: 'USD', amount_inr: calc.totals.price_inr, simulated: !!o.simulated });
}));
router.post('/api/paypal/capture-order', wrap(async (req, res) => {
  const p = db.prepare('SELECT * FROM cl_payments WHERE paypal_order_id=?').get(String(req.body?.order_id || ''));
  if (!p) throw fail(404, 'this order was not created by CarbonLens');
  const existing = db.prepare('SELECT id FROM cl_receipts WHERE payment_id=?').get(p.id);
  if (existing) return res.json({ receipt_id: existing.id, status: p.status, duplicate: true });   // no second charge
  const setStatus = s => db.prepare('UPDATE cl_payments SET status=? WHERE id=?').run(s, p.id);
  let c;
  try {
    const o = await paypal.getOrder(p.paypal_order_id);
    if (o.status !== 'APPROVED') throw fail(409, `PayPal order status is ${o.status}: the buyer has not approved it`);
    c = await paypal.captureOrder(p.paypal_order_id);
  } catch (e) { if (e.status !== 409) setStatus('FAILED'); throw fail(e.status || 422, e.message); }
  if (!(c.status === 'COMPLETED' && c.amount === p.amount && c.currency === p.currency)) {
    setStatus('FAILED');
    throw fail(402, `PayPal capture not verified (status ${c.status}, amount ${c.amount} ${c.currency}); no receipt issued`);
  }
  db.prepare('UPDATE cl_payments SET status=?, paypal_capture_id=? WHERE id=?').run('COMPLETED', c.captureId, p.id);
  const calc = E.calculate(JSON.parse(db.prepare('SELECT items FROM cl_baskets WHERE id=?').get(p.basket_id).items));
  const snap = { calculation: calc, explanation: await AI.explain(calc), sources: sources(), payment: { paypal_order_id: p.paypal_order_id, paypal_capture_id: c.captureId,
    amount: p.amount, currency: p.currency, amount_inr: p.amount_inr, inr_per_usd_demo_rate: INR_PER_USD, status: 'COMPLETED', environment: c.simulated ? 'Simulated (no PayPal keys)' : 'PayPal Sandbox' } };
  const rid = uid('RCP');
  db.prepare('INSERT INTO cl_receipts VALUES (?,?,?,?,?)').run(rid, p.id, p.basket_id, JSON.stringify(snap), now());
  res.json({ receipt_id: rid, status: 'COMPLETED', capture_id: c.captureId });
}));
router.get('/api/receipts/:id', wrap((req, res) => {
  const r = db.prepare('SELECT * FROM cl_receipts WHERE id=?').get(req.params.id);
  if (!r) throw fail(404, 'unknown receipt');
  const p = db.prepare('SELECT status FROM cl_payments WHERE id=?').get(r.payment_id);
  if (p.status !== 'COMPLETED') throw fail(409, 'payment not completed');
  res.json({ id: r.id, generated_at: r.generated_at, basket_id: r.basket_id, ...JSON.parse(r.snapshot),
    disclaimer: 'PayPal processed the sandbox payment only. PayPal has not verified any environmental figure. Estimates use global reference data and are not certified.' });
}));
