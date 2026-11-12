// Judge Mode acceptance tests. No live PayPal / AI: PayPal keys are blanked so the client uses its in-process simulator.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PACT_DB = ':memory:'; process.env.TT_DB = ':memory:'; process.env.CL_DB = ':memory:';
process.env.ANTHROPIC_API_KEY = ''; process.env.GEMINI_API_KEY = ''; process.env.PAYPAL_CLIENT_ID = ''; process.env.PAYPAL_CLIENT_SECRET = ''; process.env.PAYPAL_PAYEE_EMAIL = ''; process.env.PAYPAL_WEBHOOK_ID = '';
const T = await import('../src/trust.js');
const { app } = await import('../src/server.js');

const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const call = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
test.after(() => srv.close());

let run;
test('A: a run issues a dedicated passport and never sends the signed credential', async () => {
  const r = await call('/api/judge/runs', 'POST');
  assert.equal(r.status, 200); run = r.body;
  assert.equal(run.passport.authorized, true);
  assert.equal(run.passport.limits.maxPerTxn, 500);
  assert.deepEqual(run.passport.limits.allowedMerchants, ['officeworks']);
  const a = T.agents.get(run.passport.agentId);
  assert.ok(!JSON.stringify(run).includes(a.credential), 'credential not in the response');
  assert.ok(!JSON.stringify(run).includes(a.credential.split('.')[1]), 'signature not in the response');
});

test('1/2: malicious listing → agent follows it → blocked by intent fidelity and limits', async () => {
  const r = (await call(`/api/judge/runs/${run.id}/attack`, 'POST')).body.stages.attack;
  assert.equal(r.scan.injection, true);
  assert.equal(r.decision, 'block');
  assert.ok(r.failed.some(f => f.startsWith('intent_fidelity')));
  assert.ok(r.failed.some(f => f.startsWith('max_per_txn')), 'over-limit blocked');
  assert.equal(T.intents.get(r.intentId).status, 'blocked');
});

test('3: unauthorized merchant is blocked', () => {
  const a = T.agents.get(run.passport.agentId), p = T.product('p9');
  const pf = T.preflight(a.credential, { productId: p.id, quantity: 1, amount: p.price, currency: 'USD', merchant: p.merchant, category: p.category }, { record: false });
  assert.equal(pf.decision, 'block');
  assert.ok(pf.failed.some(f => f.startsWith('merchant_allowlist')));
});

test('4/5: changed checkout price invalidates the approval and capture is refused', async () => {
  const s = (await call(`/api/judge/runs/${run.id}/tamper`, 'POST')).body.stages.tamper;
  assert.equal(s.approved.amount, 420);
  assert.equal(s.checkoutAmount, 489);
  assert.equal(T.intents.get(s.intentId).status, 'invalidated');
  assert.equal(s.capture.refused, true);
  assert.equal(s.capture.status, 409);
  assert.equal((await call(`/api/intents/${s.intentId}/order`, 'POST')).status, 409, 'no PayPal order for an invalidated intent');
});

let intentId;
test('6/7/8: buyer approval required, live mode refused without keys, amount set server-side, duplicate capture rejected', async () => {
  const v = (await call(`/api/judge/runs/${run.id}/purchase`, 'POST')).body;
  intentId = v.stages.purchase.intentId;
  assert.equal(v.stages.purchase.intent.status, 'pending_approval');
  assert.equal((await call(`/api/judge/runs/${run.id}/order`, 'POST', { mode: 'simulator' })).status, 409, 'no order before buyer approval');
  await call(`/api/judge/runs/${run.id}/approve`, 'POST');
  const live = await call(`/api/judge/runs/${run.id}/order`, 'POST', { mode: 'live' });
  assert.equal(live.status, 409); assert.match(live.body.error, /PAYPAL_CLIENT_ID/);
  const o = await call(`/api/judge/runs/${run.id}/order`, 'POST', { mode: 'simulator', amount: 1 });
  assert.equal(o.body.amount, 420, 'client amount ignored'); assert.equal(o.body.source, 'PAYPAL SIMULATOR');
  assert.equal((await call(`/api/judge/runs/${run.id}/order`, 'POST', { mode: 'live' })).status, 409, 'no silent switch between modes');
  assert.equal((await call(`/api/intents/${intentId}/capture`, 'POST')).status, 200);
  assert.equal((await call(`/api/intents/${intentId}/capture`, 'POST')).status, 409, 'duplicate capture rejected');
  assert.equal(T.intents.get(intentId).payment.simulated, true);
});

test('9/10: duplicate and unverified webhooks never become trusted evidence', async () => {
  const it = T.intents.get(intentId), before = T.intentAudit(intentId).length;
  const ev = { id: 'WH-JUDGE-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-FAKE', amount: { value: '999.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: it.orderId } } } };
  assert.equal((await fetch(`${base}/api/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) })).status, 200);
  await fetch(`${base}/api/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) });
  const raw = (await call(`/api/events/raw`)).body.filter(e => e.event_id === 'WH-JUDGE-1' || e.eventId === 'WH-JUDGE-1');
  assert.equal(raw.length, 1, 'stored once');
  const t = (await call(`/api/intel/${intentId}/truth`)).body;
  assert.equal(t.contradictions.length, 0, 'unverified $999 event did not change the truth');
  assert.equal(T.intentAudit(intentId).length, before);
});

test('11/12: digital twin replays never mutate the original and label simulated steps', async () => {
  const snap = JSON.stringify(T.intents.get(intentId)), ledgerLen = T.ledger.length;
  for (const sc of ['price_changed', 'duplicate_capture', 'late_delivery', 'missing_payment']) {
    const r = (await call(`/api/intel/${intentId}/simulate`, 'POST', { scenario: sc })).body;
    assert.ok(r.steps.some(s => s.simulated), `${sc} has simulated steps`);
    assert.ok(r.steps.filter(s => s.simulated).every(s => s.label.startsWith('SIMULATED')), `${sc} simulated steps labelled`);
    assert.notEqual(r.finalStatus, undefined);
  }
  assert.equal(JSON.stringify(T.intents.get(intentId)), snap);
  assert.equal(T.ledger.length, ledgerLen);
});

test('13/14: evidence export carries sources and real ledger verification; tampering is detected', async () => {
  const r = await fetch(`${base}/api/judge/runs/${run.id}/evidence.json`);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const ev = await r.json();
  assert.equal(ev.paypal.source, 'PAYPAL SIMULATOR');
  assert.equal(ev.buyerApproval.amount, 420);
  assert.ok(ev.chronology.some(e => e.event === 'payment_captured' && e.source === 'PAYPAL SIMULATOR'));
  assert.ok(ev.chronology.every(e => e.source));
  assert.equal(ev.ledger.ok, true);
  assert.match(ev.ledger.meaning, /Tamper-evident/);
  const e = T.ledger[2], keep = e.data; e.data = { forged: true };
  assert.equal(T.verifyLedger().ok, false, 'edit detected');
  e.data = keep;
  assert.equal(T.verifyLedger().ok, true);
});

test('revoked agent: passport shows not authorized and new runs are unaffected', async () => {
  await call(`/api/agents/${run.passport.agentId}/revoke`, 'POST');
  assert.equal((await call(`/api/judge/runs/${run.id}`)).body.passport.authorized, false);
  assert.equal((await call('/api/judge/runs', 'POST')).body.passport.authorized, true);
  assert.ok(T.intents.has(intentId), 'a new run deletes nothing');
});
