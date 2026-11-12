import test from 'node:test';
import assert from 'node:assert/strict';
process.env.PACT_DB = ':memory:';
process.env.ANTHROPIC_API_KEY = ''; process.env.GEMINI_API_KEY = '';  // empty (not deleted) so dotenv cannot refill it from .env
process.env.PAYPAL_CLIENT_ID = ''; process.env.PAYPAL_CLIENT_SECRET = ''; process.env.PAYPAL_PAYEE_EMAIL = '';
const { evaluate, normalizePolicy } = await import('../src/policy.js');
const { negotiate, riskOf } = await import('../src/agents.js');
const T = await import('../src/trust.js');
const { runSimulation } = await import('../src/simulate.js');
const { app } = await import('../src/server.js');

const P = normalizePolicy({ maxPerItem: 100, totalBudget: 150, minMerchantRating: 4, maxRiskScore: 50 });
const prop = (id, extra = {}) => { const p = T.product(id); return { productId: id, quantity: 1, amount: negotiate(p, 1).finalPrice, currency: 'USD', merchant: p.merchant, category: p.category, ...extra }; };

test('session policy rules', () => {
  assert.equal(evaluate({ price: 99, merchantRating: 4.5, riskScore: 0 }, P).allowed, true);
  assert.ok(evaluate({ price: 101, merchantRating: 4.5 }, P).violations.some(v => v.rule === 'maxPerItem'));
  assert.ok(evaluate({ price: 90, merchantRating: 4.5 }, P, 70).violations.some(v => v.rule === 'totalBudget'));
  assert.equal(normalizePolicy({ requireApproval: false }).requireApproval, true);
  assert.equal(negotiate({ price: 100, offers: [{ code: 'B', pct: 20, minQty: 2 }] }, 2).finalPrice, 160);
  assert.ok(riskOf({ merchantRating: 2.9, merchantAgeDays: 20, returns: false, shippingDays: 20 }).riskScore >= 60);
});

test('passport: forged, expired-policy and revoked credentials are rejected', () => {
  const a = T.registerAgent({ name: 't', permissions: { maxPerTxn: 500 } });
  const old = a.credential;
  assert.equal(T.verifyCredential(old).ok, true);
  assert.equal(T.verifyCredential(old.slice(0, -2) + 'xx').reason, 'invalid signature');
  T.setPermissions(a.id, { maxPerTxn: 100 });
  assert.match(T.verifyCredential(old).reason, /old policy version/);
  T.revokeAgent(a.id);
  assert.match(T.verifyCredential(a.credential).reason, /revoked/);
});

test('firewall: price tampering, merchant spoofing, category scope', () => {
  const a = T.registerAgent({ permissions: { maxPerTxn: 1000, dailyBudget: 2000, allowedCategories: 'electronics' } });
  const c = a.credential;
  assert.equal(T.preflight(c, prop('p25'), { record: false }).failed.length, 0);
  assert.ok(T.preflight(c, prop('p25', { amount: 1 }), { record: false }).failed.some(f => f.startsWith('price_integrity')));
  assert.ok(T.preflight(c, prop('p25', { merchant: 'TechDepot' }), { record: false }).failed.some(f => f.startsWith('merchant_identity')));
  assert.ok(T.preflight(c, prop('p13'), { record: false }).failed.some(f => f.startsWith('category_scope')));
});

test('behavior: burst of attempts gets held', () => {
  const a = T.registerAgent({ permissions: { maxPerTxn: 1000, dailyBudget: 5000 } });
  let d; for (let i = 0; i < 7; i++) d = T.preflight(a.credential, prop('p20')).decision;
  assert.equal(d, 'hold');
});

test('attack simulation: 5/5 blocked, legit payment captured, ledger intact', async () => {
  const r = await runSimulation();
  assert.equal(r.summary.attackAttempts, 5);
  assert.equal(r.summary.blockedAttacks, 5, JSON.stringify(r.attacks.filter(a => !a.blocked)));
  assert.equal(r.summary.legitimatePayment, 'captured');
  assert.equal(r.summary.legitimate.amount, 420);
  assert.equal(r.metrics.ledgerIntact, true);
  const ev = T.prepareEvidence(r.summary.legitimate.intentId, 'not_received');
  assert.equal(ev.strength, 'insufficient');                     // no tracking → never claims proof
  assert.ok(ev.missing.some(m => /delivery/.test(m.label)));
  assert.equal(T.prepareEvidence(r.summary.legitimate.intentId, 'unauthorized').strength, 'strong');
});

test('end-to-end buyer flow over HTTP', async () => {
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const j = (path, method = 'GET', body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    const { body: { id } } = await j('/api/sessions', 'POST', { text: 'noise cancelling headphones under $100', policy: { maxPerItem: 150 } });
    let s; for (let i = 0; i < 50; i++) { s = (await j(`/api/sessions/${id}`)).body; if (s.status !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(s.status, 'ready');
    assert.ok(!s.candidates.find(c => c.merchant === 'MegaDealz247').policy.allowed);
    const pick = s.candidates.find(c => c.id === s.recommendation.id);

    // approve, then tighten below the pick → unpaid intent revoked, capture refused
    const o1 = (await j(`/api/sessions/${id}/approve`, 'POST', { candidateId: pick.id })).body;
    await j(`/api/sessions/${id}/policy`, 'PUT', { maxPerItem: pick.finalPrice - 1 });
    assert.equal((await j(`/api/intents/${o1.intentId}/capture`, 'POST')).status, 409);
    assert.equal((await j(`/api/sessions/${id}/approve`, 'POST', { candidateId: pick.id })).status, 403);

    await j(`/api/sessions/${id}/policy`, 'PUT', { maxPerItem: 150 });
    const o2 = (await j(`/api/sessions/${id}/approve`, 'POST', { candidateId: pick.id })).body;
    const cap = await j(`/api/intents/${o2.intentId}/capture`, 'POST');
    assert.equal(cap.status, 200); assert.equal(cap.body.amount, pick.finalPrice);
    const dup = await j(`/api/intents/${o2.intentId}/capture`, 'POST');
    assert.equal(dup.status, 409); assert.match(dup.body.error, /duplicate/);
    assert.equal((await j('/api/intents/NOPE/capture', 'POST')).status, 404);

    const audit = (await j(`/api/transactions/${o2.intentId}/audit`)).body;
    assert.deepEqual(['intent_created', 'checkout_confirmed', 'order_created', 'payment_captured'].filter(t => !audit.events.some(e => e.type === t)), []);
    assert.ok(audit.events.some(e => /intent_(auto_)?approved/.test(e.type)));
    assert.equal(audit.ledger.ok, true);
    assert.match((await j('/api/assistant', 'POST', { question: 'how much have I spent?' })).body.answer, /spent \$[0-9.]+ across [0-9]+ purchase/);
    assert.ok((await j('/api/merchants')).body.find(m => m.merchant === 'MegaDealz247').gaps.length >= 3);
  } finally { srv.close(); }
});

const A = await import('../src/assurance.js');
const { runLifecycleDemos } = await import('../src/lifecycle.js');

test('PACT lifecycle demos: 3/3 problems detected, simulated sources labelled', async () => {
  const r = await runLifecycleDemos();
  assert.equal(r.passed, 3, JSON.stringify(r.demos.filter(d => !d.detected)));
  const tl = A.timeline(r.demos[0].intentId);
  assert.ok(tl.some(e => /simulat/i.test(e.source)), 'simulated PayPal event is labelled');
  assert.ok(A.timeline(r.demos[1].intentId).filter(e => e.type.startsWith('merchant_') && e.type !== 'merchant_commitment_recorded').every(e => /simulated/.test(e.source)));
});

test('PACT reconciliation: clean payment reconciles; agent lying is caught', async () => {
  const { payIntent } = await import('../src/simulate.js');
  const a = T.registerAgent({ permissions: { maxPerTxn: 500, dailyBudget: 2000, approvalAbove: 1000 } });
  const r = T.createIntent(a.credential, prop('p21'), 'water bottle');
  T.merchantCheckout(r.intent.id, { amount: r.intent.amount });
  const it = await payIntent(r.intent, true);
  assert.equal(A.reconcile(it).reconciled, true);
  assert.equal(A.commitmentCheck(it).status, 'in progress');
  A.agentReport(it.id, { amount: it.amount + 10, status: 'paid' });
  assert.ok(A.reconcile(it).mismatches.some(m => /Agent-reported/.test(m)));
  // cancelled with no refund → refund_missing, high dispute risk
  A.merchantEvent(it.id, { type: 'cancelled' });
  const d8 = Date.now() + 8 * 864e5;
  assert.equal(A.refundStatus(it).state, 'awaiting');
  assert.ok(A.commitmentCheck(it, d8).issues.some(i => i.kind === 'refund_missing'));
  assert.equal(A.disputeRisk(it, A.reconcile(it), A.commitmentCheck(it, d8)).level, 'high');
  // no delivery past the promised date → not_delivered; package refuses to contest "not received"
  const later = new Date(it.commitment.deliveryBy).getTime() + 864e5;
  assert.equal(A.disputePackage(it.id, 'not_received', later).canContest, false);
});

const I = await import('../src/incidents.js');
const partiesOf = inc => inc.notifications.map(n => n.party).sort().join(',');

test('incidents: routing matrix decides who is notified', async () => {
  const { payIntent } = await import('../src/simulate.js');
  const a = T.registerAgent({ permissions: { maxPerTxn: 500, dailyBudget: 5000, approvalAbove: 1000 } });
  const buy = async id => { const r = T.createIntent(a.credential, prop(id), 'test'); T.merchantCheckout(r.intent.id, { amount: r.intent.amount }); return payIntent(r.intent, true); };

  const m = await buy('p25');                                     // OfficeWorks, verified contact
  A.agentReport(m.id, { amount: m.amount + 30, status: 'paid' });
  const inc = (await I.scan()).find(i => i.intentId === m.id && i.kind === 'amount_mismatch');
  assert.equal(partiesOf(inc), 'buyer,merchant');                 // agent-vs-records: PayPal not involved
  A.paypalEvent(m.id, { event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: 1 }, 'PayPal event (simulated for demo)');
  const pp = await I.openIncident(m.id, 'amount_mismatch', 'x', { relevantToPayPal: true });
  assert.equal(pp.id, inc.id, 'same open problem is not duplicated');

  const d = await buy('p24');
  A.merchantEvent(d.id, { type: 'delivery_date_changed', estimatedDelivery: new Date(Date.now() + 30 * 864e5).toISOString() });
  const late = (await I.scan()).find(i => i.intentId === d.id);
  assert.equal(late.kind, 'delivery_delayed');
  assert.equal(partiesOf(late), 'buyer,merchant');                // never PayPal for delivery delays
  await assert.rejects(I.escalate(late.id), /not escalated to PayPal/);

  const dup = await I.openIncident(d.id, 'duplicate_capture', 'second capture attempted');
  assert.equal(partiesOf(dup), 'buyer,merchant,paypal');
  assert.equal(dup.notifications.find(n => n.party === 'paypal').status, 'draft'); // no authorized integration → not sent
  assert.ok(dup.notifications.every(n => n.status !== 'sent'));   // no email provider configured → outbox
  assert.ok(dup.notifications.every(n => /not an accusation/.test(n.body)));
});

test('incidents: unverified merchant is not contacted; workflow Open → Under Review → Resolved', async () => {
  const it = [...T.intents.values()].find(i => i.merchant === 'MegaDealz247') || T.createIntent(T.registerAgent({ permissions: { maxPerTxn: 500 } }).credential, prop('p28'), 'x').intent;
  const inc = await I.openIncident(it.id, 'missing_evidence', 'Tracking missing.');
  assert.equal(inc.notifications.find(n => n.party === 'merchant').status, 'skipped');
  assert.throws(() => I.setStatus(inc.id, 'resolved', 'buyer', ''), /resolution note/);
  I.respond(inc.id, { party: 'buyer', message: 'I recognise it' });
  assert.equal(I.detail(inc.id).status, 'under_review');
  I.setStatus(inc.id, 'resolved', 'buyer', 'buyer confirmed');
  assert.throws(() => I.setStatus(inc.id, 'open'), /cannot go back/);
  assert.equal(await I.escalate(inc.id).then(x => x.notifications.at(-1).party), 'paypal');
  assert.ok(T.verifyLedger().ok);
});

const E = await import('../src/events.js');
const { runScenarios } = await import('../src/scenarios.js');
const S = await import('../src/state.js');

test('event ingestion: idempotent, unverified PayPal events are stored but not applied', async () => {
  const { payIntent } = await import('../src/simulate.js');
  const a = T.registerAgent({ permissions: { maxPerTxn: 500, dailyBudget: 5000, approvalAbove: 1000 } });
  const r = T.createIntent(a.credential, prop('p21'), 'bottle'); T.merchantCheckout(r.intent.id, { amount: r.intent.amount });
  const it = await payIntent(r.intent, true);
  const ev = { eventId: 'WH-T-1', source: 'paypal', type: 'PAYMENT.CAPTURE.COMPLETED', transactionRef: it.orderId, payload: { amount: 1, captureId: it.payment.captureId } };
  assert.equal(E.ingest(ev).applied, false, 'unverified real-PayPal event is not applied');
  assert.equal(E.ingest(ev).duplicate, true, 'same event id is a duplicate');
  assert.equal(A.reconcile(it).reconciled, true, 'state unchanged by unverified event');
  assert.equal(E.ingest({ ...ev, eventId: 'WH-T-2', type: 'PAYMENT.BOGUS' }).ok, false);
  assert.equal(E.ingest({ eventId: 'WH-T-3', source: 'paypal', type: 'PAYMENT.CAPTURE.COMPLETED', transactionRef: 'UNKNOWN' }).applied, false, 'out-of-order event kept raw');
  // fee is shown but never compared
  assert.ok(it.payment.fee > 0);
  assert.ok(A.reconcile(it).rows.some(x => /fee/.test(x.label)));
});

test('five demo scenarios + bonus pass from a clean reset; state survives persist/restore', async () => {
  S.resetAll();
  const r = await runScenarios();
  assert.equal(r.passed, r.total, JSON.stringify(r.scenarios.filter(s => !s.passed).map(s => [s.name, s.finding])));
  assert.equal(r.total, 6);
  S.persistAll();
  const before = { intents: T.intents.size, incidents: I.incidents.size, ledger: T.ledger.length };
  for (const m of [T.intents, I.incidents]) m.clear();
  S.restoreAll();
  assert.deepEqual({ intents: T.intents.size, incidents: I.incidents.size, ledger: T.ledger.length }, before);
  assert.ok(T.verifyLedger().ok);
});

const X = await import('../src/intel.js');
test('intelligence: graph links every step to ledger proof; replay never changes the real transaction', async () => {
  S.resetAll();
  const r = await runScenarios();
  const ok = T.intents.get(r.scenarios[0].intentId), bad = T.intents.get(r.scenarios[1].intentId);
  const g = X.graph(ok);
  assert.equal(g.status, 'verified');
  for (const n of g.nodes.filter(n => n.id !== 'verdict')) assert.ok(n.evidence.length > 0, `${n.id} has ledger proof`);
  const gb = X.graph(bad);
  assert.equal(gb.nodes.find(n => n.id === 'capture').status, 'conflict');
  const inv = await X.investigate(bad);
  assert.ok(inv.sections.disagreements.length > 0);
  for (const s of Object.values(inv.sections).flat()) assert.ok(Array.isArray(s.evidence), 'every statement carries citations');
  assert.ok(inv.sections.disagreements.every(s => s.evidence.length > 0), 'disagreements always cite records');
  assert.ok(!/fraud/i.test(JSON.stringify(inv.sections)) || /does not determine fraud/.test(inv.guardrail));
  const before = JSON.stringify(ok), ledgerLen = T.ledger.length;
  const rp = X.replay(ok.id, ['delivery_delayed', 'duplicate_capture']);
  assert.equal(rp.final.status, 'mismatch');
  assert.match(rp.trigger, /delivery/);
  assert.equal(JSON.stringify(ok), before, 'real transaction unchanged');
  assert.equal(T.ledger.length, ledgerLen, 'nothing written to the ledger');
  assert.equal(X.replay(ok.id, ['refund_never_arrived']).final.status, 'missing');
});

const Fz = await import('../src/forensics.js');
test('truth engine + forensics: parties compared, hypotheses labelled, report exports', async () => {
  S.resetAll();
  const r = await runScenarios();
  const bad = T.intents.get(r.scenarios[1].intentId);
  const t = Fz.truth(bad);
  assert.equal(t.parties.find(p => p.party === 'PayPal').says, 378);
  assert.equal(t.headline.difference, -42);
  assert.equal(t.headline.party, 'PayPal');
  const f = await Fz.forensics(bad);
  assert.ok(f.report.hypotheses.length > 0 && f.report.hypotheses.every(h => /Hypothesis/.test(h.label)));
  assert.ok(f.chronology.length > 0);
  const md = Fz.reportMarkdown(f);
  assert.match(md, /Possible explanations \(hypotheses, not verified\)/);
  assert.ok(!/\bfraudulent\b/i.test(md));
});

test('digital twin: 10 scenarios on a copy, each detects what it should, nothing saved', async () => {
  S.resetAll();
  const r = await runScenarios();
  const ok = r.scenarios[0].intentId, agentTx = r.scenarios[4].intentId;
  const snapshot = JSON.stringify([...T.intents.values()]), ledgerLen = T.ledger.length, incCount = I.incidents.size;
  const expect = { successful: 'verified', price_changed: 'mismatch', duplicate_capture: 'mismatch', missing_payment: 'unverified', late_delivery: 'mismatch',
    refund_overdue: 'missing', currency_changed: 'mismatch', agent_over_limit: 'blocked', order_differs: 'mismatch', missing_fulfilment: 'missing' };
  for (const [k, st] of Object.entries(expect)) {
    const s = Fz.simulate(k === 'agent_over_limit' ? agentTx : ok, k);
    assert.equal(s.finalStatus, st, k);
    if (k === 'successful') assert.equal(s.detection, null);
    else assert.ok(s.detection?.trigger, `${k} names its trigger`);
    assert.ok(s.steps.filter(x => x.simulated).every(x => /SIMULATED/.test(x.label)), `${k} labels simulated events`);
  }
  assert.equal(JSON.stringify([...T.intents.values()]), snapshot, 'no transaction changed');
  assert.equal(T.ledger.length, ledgerLen, 'ledger untouched');
  assert.equal(I.incidents.size, incCount, 'no incident created');
  const acc = Fz.accountability();
  assert.ok(acc.every(a => a.formula && a.confidence));
  const st = Fz.settingsStatus();
  assert.ok(!JSON.stringify(st).includes(process.env.PAYPAL_CLIENT_SECRET || '__none__'));
  assert.equal(st.live, false);
});

const Fn = await import('../src/finance.js');
test('financial intelligence: six modules on one engine, every record labelled by source', async () => {
  S.resetAll(); Fn.clearSample();
  await runScenarios();
  // real data alone: refund radar sees the cancelled order from scenario 4; nothing sample yet
  assert.ok(Fn.refunds().refunds.length >= 1);
  assert.equal(Fn.holds().holds.length, 0);
  // real PayPal messages are classified
  assert.equal(Fn.classifyError('To comply with international regulations, this transaction has been declined'), 'COMPLIANCE_VIOLATION');
  assert.equal(Fn.classifyError('duplicate payment rejected: intent already paid'), 'ORDER_ALREADY_CAPTURED');
  assert.equal(Fn.FAILURE_CODES.ORDER_ALREADY_CAPTURED.retry, 'never');
  assert.equal(Fn.FAILURE_CODES.NETWORK.retry, 'safe');
  // sample data is labelled and removable
  Fn.loadSample();
  for (const m of Object.values(Fn.fin)) for (const v of m.values()) assert.ok(['sample', 'user', 'paypal-sandbox', 'paypal-simulator'].includes(v.source));
  const subs = Fn.subscriptions();
  assert.ok(subs.flagged.some(s => s.issues.some(i => i.kind === 'duplicate')));
  assert.ok(subs.flagged.some(s => s.issues.some(i => i.kind === 'amount_change')));
  const h = Fn.holds(); assert.ok(h.held > 0 && h.holds.every(x => x.nextStep));
  const d = Fn.disputes(); assert.ok(d.length === 2 && d.every(x => x.draft && typeof x.canContest === 'boolean'));
  assert.ok(d.some(x => !x.canContest), 'insufficient evidence is said plainly');
  const c = Fn.cashflow();
  assert.equal(c.balances.available, Math.round((c.balances.gross - c.balances.fees - c.balances.refunded - c.balances.held) * 100) / 100);
  assert.ok(c.projections.every(p => p.worst <= p.expected && p.expected <= p.best));
  Fn.clearSample();
  assert.equal(Fn.holds().holds.length, 0);
});

const Hl = await import('../src/health.js');
test('financial health engine: six answers, every line labelled and linked to records', async () => {
  S.resetAll(); Fn.clearSample();
  await runScenarios();
  Fn.loadSample();
  const h = Hl.health();
  assert.deepEqual(Object.keys(h.answers).sort(), ['cashflow', 'next', 'recoverable', 'refunds', 'subscriptions', 'unavailable']);
  const allowed = ['live', 'calculated', 'estimated', 'simulated', 'user'];
  for (const [k, a] of Object.entries(h.answers)) {
    assert.ok(a.answer, `${k} has an answer`);
    for (const l of a.lines || []) assert.ok(allowed.includes(l.label), `${k} line labelled: ${l.label}`);
    for (const x of a.actions || []) assert.ok(allowed.includes(x.label) && x.evidence, `${k} action has label + evidence`);
  }
  // money unavailable cites the held amount and links the sample hold's transaction
  assert.ok(h.answers.unavailable.lines.some(l => /on hold/.test(l.text) && l.label === 'simulated' && l.links.some(k => k.kind === 'transaction')));
  // the cancelled order from the scenarios is a refund that needs attention, linked to its transaction
  assert.ok(h.answers.refunds.lines.length >= 1 && h.answers.refunds.lines.every(l => l.links.some(k => k.kind === 'transaction')));
  // recoverable vs never-retry is split correctly
  const rec = h.answers.recoverable.lines;
  assert.ok(rec.some(l => l.recoverable === true) && rec.some(l => l.recoverable === false));
  assert.ok(rec.filter(l => /Do not retry/.test(l.text)).every(l => l.recoverable === false));
  // subscriptions: duplicate + price change surfaced
  assert.ok(h.answers.subscriptions.lines.some(l => /twice/.test(l.text)) && h.answers.subscriptions.lines.some(l => /changed/.test(l.text)));
  // next actions are sorted urgent first
  const sev = h.answers.next.actions.map(a => a.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a] - ({ high: 0, medium: 1, low: 2 })[b]));
  assert.equal(Hl.routeQuestion('why is my money on hold?'), 'unavailable');
  assert.equal(Hl.routeQuestion('which payment failed and can I retry'), 'recoverable');
  assert.equal(Hl.routeQuestion('what now?'), 'next');
  Fn.clearSample();
});

test('read-only views never write to the audit ledger', async () => {
  S.resetAll(); Fn.clearSample();
  await runScenarios(); Fn.loadSample();
  const n = T.ledger.length;
  Hl.health(); Fn.disputes(); Fn.cashflow(); Fn.refunds(); Fn.holds(); Fn.failures(); Fn.subscriptions();
  for (const it of T.intents.values()) if (it.payment) { A.chain(it.id); X.graph(it); await X.investigate(it); Fz.truth(it); }
  assert.equal(T.ledger.length, n, 'viewing data added ledger entries');
  Fn.clearSample();
});
