process.env.CL_DB = ':memory:';
process.env.TT_DB = ':memory:';
process.env.PACT_DB = ':memory:';
for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'ANTHROPIC_API_KEY']) process.env[k] = '';
import test from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('../src/server.js');
const E = await import('../src/carbonlens/engine.js');
const AI = await import('../src/carbonlens/ai.js');

const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}/cl`;
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
test.after(() => srv.close());

test('factors come from the OWID CSV; products without a source get no number', () => {
  assert.equal(E.PRODUCTS.length, 25);
  const none = E.PRODUCTS.filter(p => !p.evidence).map(p => p.id);
  assert.equal(none.length, 6);
  assert.ok(!E.PRODUCTS.some(p => p.evidence_quality === 'HIGH'));
  for (const p of E.PRODUCTS.filter(p => p.evidence)) assert.equal(p.evidence.factor_kg_co2e_per_kg, E.OWID[p.evidence.source_entity].total);
});

test('calculation excludes unestimated items and warns', () => {
  const noEst = E.PRODUCTS.find(p => !p.evidence), est = E.PRODUCTS.find(p => p.evidence);
  const c = E.calculate([{ product_id: est.id, quantity: 2 }, { product_id: noEst.id, quantity: 1 }]);
  assert.equal(c.totals.unestimated_items, 1);
  assert.equal(c.totals.estimated_emissions_kg_co2e, Math.round(2 * est.kg_per_unit * est.evidence.factor_kg_co2e_per_kg * 1000) / 1000);
  assert.ok(c.warnings.some(w => w.includes('India-specific')));
  assert.throws(() => E.calculate([{ product_id: est.id, quantity: -1 }]));
  assert.throws(() => E.calculate([{ product_id: 'nope', quantity: 1 }]));
});

test('AI validator rejects invented numbers and banned claims', () => {
  const c = E.calculate([{ product_id: E.PRODUCTS.find(p => p.evidence).id, quantity: 1 }]);
  assert.equal(AI.validate(`Estimated ${c.totals.estimated_emissions_kg_co2e} kg CO2e.`, c).ok, true);
  assert.equal(AI.validate('This basket is 999.7 kg CO2e.', c).ok, false);
  assert.equal(AI.validate('A carbon-neutral, healthy choice.', c).ok, false);
});

test('checkout: server-side amount, receipt only after capture, idempotent', async () => {
  const p = E.PRODUCTS.find(x => x.evidence);
  const b = await post('/api/basket', { items: [{ product_id: p.id, quantity: 3 }] });
  assert.equal(b.status, 200);
  const o = await post('/api/paypal/create-order', { basket_id: b.body.basket_id, amount: '0.01' });   // client amount ignored
  assert.equal(o.body.amount, Math.max(0.01, Math.round(3 * p.price_inr / 83 * 100) / 100).toFixed(2));
  assert.equal((await post('/api/paypal/capture-order', { order_id: 'NOT-OURS' })).status, 404);
  const c1 = await post('/api/paypal/capture-order', { order_id: o.body.order_id });
  assert.equal(c1.status, 200);
  const c2 = await post('/api/paypal/capture-order', { order_id: o.body.order_id });
  assert.equal(c2.body.receipt_id, c1.body.receipt_id);
  assert.equal(c2.body.duplicate, true);
  const r = await fetch(`${base}/api/receipts/${c1.body.receipt_id}`).then(x => x.json());
  assert.equal(r.payment.status, 'COMPLETED');
  assert.match(r.disclaimer, /not verified any environmental figure/);
});
