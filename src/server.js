import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import express from 'express';
import crypto from 'node:crypto';
import { normalizePolicy, round2 } from './policy.js';
import { runPipeline, applyPolicy, explain, answerAboutTransactions } from './agents.js';
import * as paypal from './paypal.js';
import { llmEnabled } from './llm.js';
import * as T from './trust.js';
import { runSimulation, payIntent } from './simulate.js';
import * as A from './assurance.js';
import { runLifecycleDemos } from './lifecycle.js';
import * as I from './incidents.js';
import * as E from './events.js';
import * as S from './state.js';
import * as DB from './db.js';
import { impact } from './impact.js';
import { runScenarios } from './scenarios.js';
import * as X from './intel.js';
import * as F from './forensics.js';
import * as Fin from './finance.js';

export const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

const sessions = new Map();
const webhookLog = [];
const wrap = fn => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
// Payment routes: a thrown error is also recorded for Payment Failure Recovery (real errors only).
const wrapPay = (stage, fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    const s = sessions.get(req.params.id);
    const intentId = req.params.id?.startsWith('INT-') ? req.params.id : s?.intentIds?.at(-1);
    try { Fin.recordFailure({ intentId, stage, message: e.message, source: paypal.isLive() ? 'paypal-sandbox' : 'paypal-simulator' }); } catch { /* recording must never break the response */ }
    res.status(e.status || 500).json({ error: e.message });
  }
};

// Restore persisted state, then make sure the default demo agent exists.
const restored = S.restoreAll();
E.restoreStats(DB.loadState('eventStats'));
let demo;
function ensureDemoAgent() {
  demo = [...T.agents.values()].find(a => a.name === 'Personal Shopping Agent' && a.status === 'active')
    || T.registerAgent({ name: 'Personal Shopping Agent', permissions: { maxPerTxn: 200, dailyBudget: 500, approvalAbove: 100, ttlHours: 24 * 7 } });
  if (!T.verifyCredential(demo.credential).ok) T.setPermissions(demo.id, { ttlHours: 24 * 7 }); // expired → re-issue
}
ensureDemoAgent();

// Persist after every state-changing request.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/intel')) return next(); // read-only: replay never persists
  if (req.method !== 'GET') res.on('finish', () => { try { S.persistAll(); DB.saveState('eventStats', E.stats); } catch (e) { console.error('persist failed', e.message); } });
  next();
});

app.get('/api/config', (_q, res) => res.json({ paypalLive: paypal.isLive(), paypalClientId: process.env.PAYPAL_CLIENT_ID || null, llm: llmEnabled(), demoAgent: demo.id,
  storage: { file: DB.dbFile, restored }, webhooks: !!process.env.PAYPAL_WEBHOOK_ID }));

// ---------- Agent Passport ----------
const agentView = a => ({ ...a, spentToday: round2(T.spentToday(a)), history: a.history.slice(-20) });
app.get('/api/agents', (_q, res) => res.json([...T.agents.values()].map(agentView)));
app.post('/api/agents/register', wrap((req, res) => res.json(agentView(T.registerAgent(req.body || {})))));
app.post('/api/agents/:id/permissions', wrap((req, res) => res.json(agentView(T.setPermissions(req.params.id, req.body || {})))));
app.post('/api/agents/:id/revoke', wrap((req, res) => res.json(agentView(T.revokeAgent(req.params.id)))));

// ---------- Intent Firewall API (for external agents) ----------
app.post('/api/transactions/preflight', wrap((req, res) => res.json(T.preflight(req.body.credential, req.body.proposal, { record: false }))));
app.post('/api/intents', wrap((req, res) => {
  const r = T.createIntent(req.body.credential, req.body.proposal || {}, req.body.userRequest);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.status(r.intent.status === 'blocked' ? 403 : 200).json(r.intent);
}));
app.get('/api/intents', (_q, res) => res.json([...T.intents.values()].reverse()));
app.post('/api/intents/:id/approve', wrap((req, res) => res.json(T.approveIntent(req.params.id, 'buyer'))));
app.post('/api/intents/:id/checkout', wrap((req, res) => { const r = T.merchantCheckout(req.params.id, req.body || {}); res.status(r.ok ? 200 : 409).json(r); }));
app.post('/api/intents/:id/order', wrapPay('create order', async (req, res) => {
  const it = T.intents.get(req.params.id);
  if (!it) return res.status(404).json({ error: 'unknown intent' });
  if (it.status !== 'approved') return res.status(409).json({ error: `intent is ${it.status}` });
  if (it.orderId) return res.json({ orderId: it.orderId, amount: it.amount, simulated: it.orderId.startsWith('SIM-') });
  const o = await paypal.createOrder({ amount: it.amount, description: `PACT: ${it.title}`, referenceId: it.id });
  it.orderId = o.id;
  T.audit('paypal', 'order_created', it.id, { orderId: o.id, amount: it.amount, simulated: !!o.simulated });
  res.json({ orderId: o.id, amount: it.amount, simulated: !!o.simulated });
}));
app.post('/api/intents/:id/capture', wrapPay('capture', async (req, res) => {
  const it = T.intents.get(req.params.id);
  if (!it) return res.status(404).json({ error: 'unknown intent' });
  if (!it.orderId) return res.status(409).json({ error: 'no PayPal order for this intent' });
  const remote = await paypal.getOrder(it.orderId);
  if (remote.status !== 'APPROVED' && it.status !== 'captured') return res.status(409).json({ error: `PayPal status ${remote.status}: buyer has not approved` });
  if (remote.referenceId && remote.referenceId !== it.id) return res.status(409).json({ error: 'order identity mismatch' });
  T.captureGate(it.id, remote);
  try {
    const cap = await paypal.captureOrder(it.orderId);
    if (cap.status !== 'COMPLETED') throw Object.assign(new Error(`capture status ${cap.status}`), { status: 502 });
    T.recordCapture(it.id, { orderId: cap.id, captureId: cap.captureId, amount: cap.amount, status: cap.status, currency: cap.currency, fee: cap.fee, net: cap.net, simulated: !!cap.simulated });
  } catch (e) { T.releaseCapture(it.id); throw e; }
  const s = [...sessions.values()].find(x => x.intentIds?.includes(it.id));
  if (s) { s.spent = round2(s.spent + it.amount); emitter(s)('payment', `Captured $${it.amount} — ${it.payment.captureId}`); }
  res.json(txnView(it));
}));
app.get('/api/transactions/:id/audit', (req, res) => res.json({ events: T.intentAudit(req.params.id), ledger: T.verifyLedger() }));

// ---------- Trust Ops ----------
app.post('/api/security/simulate', wrap(async (_q, res) => { const r = await runSimulation(); r.incidents = (await I.scan()).map(i => i.id); res.json(r); }));
app.get('/api/security/events', (_q, res) => res.json({ events: T.securityEvents.slice(-100).reverse(), ledger: T.verifyLedger() }));
app.get('/api/ledger', (_q, res) => res.json({ events: T.ledger.slice(-200).reverse(), integrity: T.verifyLedger() }));

// ---------- PACT: transaction assurance ----------
const asOf = q => (q.asOf ? new Date(q.asOf).getTime() : Date.now());
app.get('/api/assurance', (_q, res) => res.json(A.assuranceList()));
// Every change in the world triggers a detection scan → incidents → notifications.
app.post('/api/assurance/simulate', wrap(async (_q, res) => { const r = await runLifecycleDemos(); r.incidents = (await I.scan()).map(i => i.id); res.json(r); }));
app.get('/api/assurance/:id', wrap((req, res) => res.json(A.chain(req.params.id, asOf(req.query)))));
app.post('/api/assurance/:id/merchant-event', wrap(async (req, res) => { A.merchantEvent(req.params.id, req.body || {}); await I.scan(); res.json(A.chain(req.params.id)); }));
app.post('/api/assurance/:id/agent-report', wrap(async (req, res) => { A.agentReport(req.params.id, req.body || {}); await I.scan(); res.json(A.chain(req.params.id)); }));
app.post('/api/assurance/:id/paypal-event-sim', wrap(async (req, res) => { A.paypalEvent(req.params.id, req.body || {}, 'PayPal event (simulated for demo)'); await I.scan(); res.json(A.chain(req.params.id)); }));

// ---------- Incident & Resolution Center ----------
app.get('/api/incidents', (_q, res) => res.json({ incidents: I.list(), routing: I.ROUTING,
  channels: { email: !!(process.env.RESEND_API_KEY && process.env.PACT_FROM_EMAIL), buyerEmail: !!process.env.BUYER_EMAIL, paypalReporting: !!process.env.PAYPAL_REPORTING_WEBHOOK_URL } }));
app.post('/api/incidents/scan', wrap(async (req, res) => res.json((await I.scan(asOf(req.body || {}))).map(i => i.id))));
app.get('/api/incidents/:id', wrap((req, res) => res.json(I.detail(req.params.id))));
app.post('/api/incidents/:id/respond', wrap((req, res) => res.json(I.respond(req.params.id, req.body || {}))));
app.post('/api/incidents/:id/status', wrap((req, res) => res.json(I.setStatus(req.params.id, req.body?.status, req.body?.by || 'buyer', req.body?.note))));
app.post('/api/incidents/:id/escalate', wrap(async (req, res) => res.json(await I.escalate(req.params.id, req.body?.by || 'buyer'))));
app.post('/api/assurance/:id/dispute', wrap((req, res) => res.json(A.disputePackage(req.params.id, req.body?.claim, asOf(req.body || {})))));

// ---------- Merchant & disputes ----------
app.get('/api/merchants', (_q, res) => res.json(T.merchantProfiles()));
app.post('/api/disputes/prepare-evidence', wrap((req, res) => res.json(T.prepareEvidence(req.body.intentId, req.body.claim))));

// ---------- Buyer shopping sessions (multi-agent research) ----------
function emitter(s) {
  return (agent, msg, data) => {
    const ev = { t: Date.now(), agent, msg, data };
    s.events.push(ev);
    for (const r of s.listeners) r.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
}
const view = s => ({ id: s.id, text: s.text, agentId: s.agentId, policy: s.policy, spent: s.spent, intent: s.intent, candidates: s.candidates, recommendation: s.recommendation, status: s.status });
const getS = (req, res) => { const s = sessions.get(req.params.id); if (!s) res.status(404).json({ error: 'session not found' }); return s; };

app.post('/api/sessions', async (req, res) => {
  const { text, policy, agentId } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const a = T.agents.get(agentId || demo.id);
  if (!a) return res.status(400).json({ error: 'unknown agent' });
  // Session policy mirrors the agent passport, and the buyer can tighten it further.
  const pol = normalizePolicy({ maxPerItem: Math.min(policy?.maxPerItem ?? Infinity, a.permissions.maxPerTxn), totalBudget: Math.min(policy?.totalBudget ?? Infinity, a.permissions.dailyBudget),
    ...policy, allowedCategories: policy?.allowedCategories || a.permissions.allowedCategories, blockedMerchants: [...T.agents.get(a.id).permissions.blockedMerchants, ...String(policy?.blockedMerchants || '').split(',')] });
  pol.maxPerItem = Math.min(pol.maxPerItem, a.permissions.maxPerTxn);
  const s = { id: crypto.randomUUID(), text: text.trim(), agentId: a.id, policy: pol, spent: 0, events: [], listeners: new Set(), candidates: [], status: 'running', intentIds: [] };
  sessions.set(s.id, s);
  res.json({ id: s.id });
  const emit = emitter(s);
  emit('passport', `Acting as ${a.id} "${a.name}" · limit $${a.permissions.maxPerTxn}/txn · $${a.permissions.dailyBudget}/day · approval above $${a.permissions.approvalAbove}`);
  try { await runPipeline(s, emit); s.status = 'ready'; } catch (e) { s.status = 'error'; emit('system', 'Pipeline error: ' + e.message); }
  emit('system', 'done', view(s));
});
app.get('/api/sessions/:id', (req, res) => { const s = getS(req, res); if (s) res.json(view(s)); });
app.get('/api/sessions/:id/events', (req, res) => {
  const s = getS(req, res); if (!s) return;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  for (const ev of s.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  s.listeners.add(res);
  req.on('close', () => s.listeners.delete(res));
});
app.put('/api/sessions/:id/policy', wrap(async (req, res) => {
  const s = getS(req, res); if (!s) return;
  const before = new Map(s.candidates.map(c => [c.id, c.policy.allowed]));
  const prev = s.recommendation?.id;
  s.policy = normalizePolicy({ ...s.policy, ...req.body });
  const emit = emitter(s);
  emit('policy', `Policy updated: per-item ≤ $${s.policy.maxPerItem}, max risk ${s.policy.maxRiskScore}`);
  s.candidates = applyPolicy(s.candidates, s.policy, s.spent, s.intent || {});
  for (const c of s.candidates) {
    const was = before.get(c.id);
    if (was && !c.policy.allowed) emit('policy', `NOW BLOCKED ${c.title}: ${c.policy.violations.map(v => v.msg).join('; ')}`);
    if (was === false && c.policy.allowed) emit('policy', `NOW ALLOWED ${c.title} ($${c.finalPrice})`);
  }
  for (const id of s.intentIds) {
    const it = T.intents.get(id);
    if (['approved', 'pending_approval'].includes(it.status) && it.amount > s.policy.maxPerItem) {
      it.status = 'revoked'; T.audit('buyer', 'intent_revoked', id, { reason: 'buyer tightened policy' });
      emit('payment', `Revoked unpaid intent ${id}: $${it.amount} is over the new limit`);
    }
  }
  await explain(s, emit);
  if (prev && prev !== s.recommendation?.id) emit('decision', 'Recommendation changed because of your new policy.');
  emit('system', 'done', view(s));
  res.json(view(s));
}));

// Buyer clicks "Approve" on a candidate → firewall preflight → approval binding → PayPal order.
app.post('/api/sessions/:id/approve', wrapPay('approve & create order', async (req, res) => {
  const s = getS(req, res); if (!s) return;
  const c = s.candidates.find(x => x.id === req.body?.candidateId);
  if (!c) return res.status(400).json({ error: 'unknown candidate' });
  if (!c.policy.allowed) return res.status(403).json({ error: 'blocked by your session policy', failed: c.policy.violations.map(v => v.msg) });
  const a = T.agents.get(s.agentId);
  const r = T.createIntent(a.credential, { productId: c.id, quantity: s.intent?.quantity || 1, amount: c.finalPrice, currency: 'USD', merchant: c.merchant, category: c.category }, s.text);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const it = r.intent; s.intentIds.push(it.id);
  const emit = emitter(s);
  emit('firewall', `Preflight ${it.id}: ${it.preflight.decision.toUpperCase()} · agent health ${it.preflight.scores.agentHealth} · anomaly ${it.preflight.scores.behaviorAnomaly} · txn risk ${it.preflight.scores.transactionRisk}`);
  if (it.status === 'blocked' || it.status === 'held') return res.status(403).json({ error: `Intent Firewall: ${it.status}`, failed: it.preflight.failed.length ? it.preflight.failed : it.preflight.reasons.behavior, intent: it });
  if (it.status === 'pending_approval') T.approveIntent(it.id, 'buyer');
  T.merchantCheckout(it.id, { amount: it.amount });
  const o = await paypal.createOrder({ amount: it.amount, description: `PACT: ${it.title}`, referenceId: it.id });
  it.orderId = o.id;
  T.audit('paypal', 'order_created', it.id, { orderId: o.id, amount: it.amount, simulated: !!o.simulated });
  emit('payment', `Buyer approved. PayPal order ${o.id} for $${it.amount.toFixed(2)}${o.simulated ? ' (simulated)' : ' (sandbox)'}`);
  res.json({ intentId: it.id, orderId: o.id, amount: it.amount, simulated: !!o.simulated, preflight: it.preflight });
}));

// ---------- Transactions & PayPal webhooks ----------
const txnView = it => ({ intentId: it.id, agentId: it.agentId, title: it.title, merchant: it.merchant, amount: it.amount, status: it.status, orderId: it.orderId, captureId: it.payment?.captureId, at: it.createdAt, simulated: it.payment?.simulated, decision: it.preflight.decision, scores: it.preflight.scores });
app.get('/api/transactions', (_q, res) => res.json({ transactions: [...T.intents.values()].filter(i => i.status === 'captured').map(txnView).reverse(), webhooks: webhookLog.slice(-20) }));
app.post('/api/assistant', wrap(async (req, res) => {
  const tx = [...T.intents.values()].filter(i => i.status === 'captured').map(i => ({ ...txnView(i), returns: T.product(i.proposal.productId)?.returns }));
  res.json({ answer: await answerAboutTransactions(req.body?.question || '', tx) });
}));
// Real PayPal webhooks: verify signature → store raw (event id = idempotency key) → apply only if verified.
// Always answer 200 quickly so PayPal does not keep retrying; retries are deduplicated anyway.
app.post('/api/webhooks/paypal', async (req, res) => {
  const v = await paypal.verifyWebhook(req.headers, req.body).catch(e => ({ verified: false, reason: e.message }));
  const r = E.fromPayPalWebhook(req.body, v.verified);
  webhookLog.push({ at: new Date().toISOString(), id: req.body?.id, type: req.body?.event_type, verified: v.verified, result: r.duplicate ? 'duplicate' : r.applied ? 'applied' : r.note || r.error });
  if (r.applied) await I.scan();
  res.sendStatus(200);
});

// Generic event ingestion for merchant systems (and simulated events). Same idempotency path.
app.post('/api/events', wrap(async (req, res) => {
  const b = req.body || {};
  const isSim = b.simulated !== false;
  const r = E.ingest({ eventId: b.eventId, source: b.source, type: b.type, transactionRef: b.transactionRef, occurredAt: b.occurredAt, payload: b.payload,
    verified: false, label: b.source === 'paypal' ? 'PayPal event (simulated for demo)' : (isSim ? 'merchant (simulated)' : 'merchant API (unverified)') });
  if (r.applied) await I.scan();
  res.status(r.ok ? 200 : r.status).json(r);
}));
app.get('/api/events/raw', (req, res) => res.json(DB.rawEvents(req.query.txn)));

// ---------- Transaction intelligence: graph, investigation, replay (read-only) ----------
app.get('/api/intel/:id/graph', wrap((req, res) => res.json(X.graph(X.getIntent(req.params.id)))));
app.get('/api/intel/:id/investigate', wrap(async (req, res) => res.json(await X.investigate(X.getIntent(req.params.id)))));
app.post('/api/intel/:id/replay', wrap((req, res) => res.json(X.replay(req.params.id, req.body?.inject || []))));
app.get('/api/intel-injections', (_q, res) => res.json(X.INJECTIONS));
// TrustGraph: truth engine, forensics, digital twin, accountability, settings (all read-only)
app.get('/api/intel/:id/truth', wrap((req, res) => res.json(F.truth(X.getIntent(req.params.id)))));
app.get('/api/intel/:id/forensics', wrap(async (req, res) => res.json(await F.forensics(X.getIntent(req.params.id)))));
app.get('/api/intel/:id/report.md', wrap(async (req, res) => {
  const md = F.reportMarkdown(await F.forensics(X.getIntent(req.params.id)));
  res.set({ 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="PACT-investigation-${req.params.id}.md"` }).send(md);
}));
app.get('/api/intel-scenarios', (_q, res) => res.json(F.SCENARIOS));
app.post('/api/intel/:id/simulate', wrap((req, res) => res.json(F.simulate(req.params.id, req.body?.scenario))));
app.get('/api/intel-accountability', (_q, res) => res.json(F.accountability()));
app.get('/api/settings', (_q, res) => res.json(F.settingsStatus()));

// ---------- Financial intelligence (one shared engine, six modules) ----------
app.get('/api/fin/refunds', (_q, res) => res.json(Fin.refunds()));
app.get('/api/fin/failures', (_q, res) => res.json(Fin.failures()));
app.get('/api/fin/holds', (_q, res) => res.json(Fin.holds()));
app.post('/api/fin/holds', wrap((req, res) => res.json(Fin.addHold(req.body || {}, 'user'))));
app.post('/api/fin/holds/:id', wrap((req, res) => res.json(Fin.updateHold(req.params.id, req.body || {}))));
app.get('/api/fin/subscriptions', (_q, res) => res.json(Fin.subscriptions()));
app.post('/api/fin/subscriptions', wrap((req, res) => res.json(Fin.addSubscription(req.body || {}, 'user'))));
app.post('/api/fin/subscriptions/:id/cancel', wrap((req, res) => res.json(Fin.cancelSubscription(req.params.id))));
app.get('/api/fin/disputes', wrap((_q, res) => res.json(Fin.disputes())));
app.post('/api/fin/disputes', wrap((req, res) => res.json(Fin.addDispute(req.body || {}, 'user'))));
app.get('/api/fin/cashflow', (_q, res) => res.json(Fin.cashflow()));
app.get('/api/fin/links/:id', (req, res) => res.json(Fin.linksFor(req.params.id)));
app.post('/api/fin/sample', wrap((_q, res) => res.json(Fin.loadSample())));
app.delete('/api/fin/sample', wrap((_q, res) => { Fin.clearSample(); res.json({ ok: true }); }));
app.post('/api/incidents/:id/assign', wrap((req, res) => res.json(I.assign(req.params.id, req.body?.owner))));

// ---------- Merchant dashboard data ----------
app.get('/api/impact', (_q, res) => res.json(impact()));
app.get('/api/refunds', (_q, res) => res.json(A.refundTracker()));

// ---------- Demo: deterministic reset + seed ----------
app.post('/api/demo/reset', wrap(async (_q, res) => { S.resetAll(); for (const s of sessions.values()) s.listeners.clear(); sessions.clear(); ensureDemoAgent(); res.json({ ok: true }); }));
app.post('/api/demo/seed', wrap(async (_q, res) => { S.resetAll(); sessions.clear(); ensureDemoAgent(); const r = await runScenarios(); res.json(r); }));

export { payIntent };
if (process.argv[1]?.endsWith('server.js')) {
  const port = process.env.PORT || 5200;
  app.listen(port, () => console.log(`PACT on http://localhost:${port}  (PayPal ${paypal.isLive() ? 'SANDBOX' : 'SIMULATED'}, LLM ${llmEnabled() ? 'on' : 'off'})`));
}
