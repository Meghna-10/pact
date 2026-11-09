// The five scenarios the demo must prove, plus the bonus resolution scenario.
// Deterministic: run after a reset. Each result shows the source records, PACT's finding,
// why it flagged it, and the recommended action. All results come from running the engine.
//
// Data sources in this runner: payments = PayPal SIMULATOR; webhook and merchant events are
// SIMULATED and go through the same ingestion path (idempotency + raw store) as real ones.
import crypto from 'node:crypto';
import * as T from './trust.js';
import * as A from './assurance.js';
import * as I from './incidents.js';
import { ingest } from './events.js';
import { payIntent } from './simulate.js';
import { negotiate } from './agents.js';

const DAY = 864e5;
const iso = t => new Date(t).toISOString();
const evid = () => 'WH-SIM-' + crypto.randomBytes(5).toString('hex').toUpperCase();
const SIM_PP = 'PayPal webhook (simulated for demo)';
const SIM_M = 'merchant (simulated)';

async function buy(agent, productId, request) {
  const p = T.product(productId);
  const r = T.createIntent(agent.credential, { productId, quantity: 1, amount: negotiate(p, 1).finalPrice, currency: 'USD', merchant: p.merchant, category: p.category }, request);
  if (r.intent.status === 'pending_approval') T.approveIntent(r.intent.id, 'buyer');
  T.merchantCheckout(r.intent.id, { amount: r.intent.amount });
  const it = await payIntent(r.intent, true);
  ingest({ eventId: evid(), source: 'paypal', type: 'PAYMENT.CAPTURE.COMPLETED', transactionRef: it.orderId, label: SIM_PP,
    payload: { amount: Number(it.payment.amount), currency: 'USD', captureId: it.payment.captureId } });
  return it;
}
const records = c => c.reconciliation.rows.filter(r => r.value != null).map(r => `${r.label}: $${r.value} [${r.source}]`);
const incFor = (id, kind) => [...I.incidents.values()].find(i => i.intentId === id && (!kind || i.kind === kind));

export async function runScenarios() {
  const human = T.registerAgent({ name: 'Direct checkout (human buyer)', human: true, permissions: { maxPerTxn: 2000, dailyBudget: 5000, approvalAbove: 0 } });
  const agent = T.registerAgent({ name: 'Office Procurement Agent', permissions: { maxPerTxn: 500, dailyBudget: 3000, approvalAbove: 300, allowedCategories: 'electronics' } });
  const out = [];
  const push = (n, name, it, extra) => { const c = A.chain(it.id); out.push({ n, name, intentId: it.id, initiator: c.initiator, txnStatus: c.txnStatus, health: c.health, sourceRecords: records(c), ...extra(c) }); };

  // 1 — Successful purchase (human checkout): everything agrees
  const s1 = await buy(human, 'p6', 'Buy a wireless keyboard (human checkout)');
  ingest({ eventId: evid(), source: 'merchant', type: 'shipped', transactionRef: s1.id, label: SIM_M, payload: { tracking: 'SIM-TRK-1001', carrier: 'DemoPost' } });
  ingest({ eventId: evid(), source: 'merchant', type: 'delivered', transactionRef: s1.id, label: SIM_M, payload: { tracking: 'SIM-TRK-1001', carrier: 'DemoPost' } });
  push(1, 'Successful purchase', s1, c => ({ expected: 'verified', passed: c.txnStatus === 'verified' && !c.reconciliation.mismatches.length,
    finding: c.statusReasons.join('; '), why: 'Merchant order, buyer approval and PayPal gross capture are equal; fee shown but not compared.', action: 'None.' }));

  // 2 — Amount mismatch: PayPal capture event reports less than the order
  const s2 = await buy(human, 'p25', 'Buy a 4K monitor');
  ingest({ eventId: evid(), source: 'paypal', type: 'PAYMENT.CAPTURE.COMPLETED', transactionRef: s2.orderId, label: SIM_PP, payload: { amount: 378, currency: 'USD', captureId: s2.payment.captureId } });
  push(2, 'Amount mismatch', s2, c => ({ expected: 'mismatch', passed: c.txnStatus === 'mismatch',
    finding: c.reconciliation.mismatches.join('; '), why: 'Gross capture reported by PayPal differs from the buyer-approved order total.', action: I.ROUTING && 'Verify order modifications and capture records with the merchant.' }));

  // 3 — Duplicate capture vs duplicate delivery
  const s3 = await buy(agent, 'p24', 'Buy a smart speaker for the meeting room');
  const redeliverId = evid();
  const first = ingest({ eventId: redeliverId, source: 'paypal', type: 'PAYMENT.CAPTURE.COMPLETED', transactionRef: s3.orderId, label: SIM_PP, payload: { amount: s3.amount, currency: 'USD', captureId: s3.payment.captureId } });
  const again = ingest({ eventId: redeliverId, source: 'paypal', type: 'PAYMENT.CAPTURE.COMPLETED', transactionRef: s3.orderId, label: SIM_PP, payload: { amount: s3.amount, currency: 'USD', captureId: s3.payment.captureId } });
  const beforeDup = A.chain(s3.id).txnStatus;
  ingest({ eventId: evid(), source: 'paypal', type: 'PAYMENT.CAPTURE.COMPLETED', transactionRef: s3.orderId, label: SIM_PP, payload: { amount: s3.amount, currency: 'USD', captureId: 'SIMCAP-SECOND' } });
  push(3, 'Duplicate capture', s3, c => ({ expected: 'redelivery ignored; second capture flagged',
    passed: first.applied && again.duplicate && beforeDup === 'verified' && c.reconciliation.mismatches.some(m => /DUPLICATE CAPTURE/.test(m)),
    finding: `Webhook ${redeliverId} delivered twice → second copy ignored (status stayed "${beforeDup}"). Then a second, different capture (SIMCAP-SECOND) arrived → ${c.reconciliation.mismatches.find(m => /DUPLICATE/.test(m))}`,
    why: 'Same event id = redelivery, not money. Two capture ids on one order = money captured twice.', action: 'Merchant confirms one fulfilment and refunds the extra capture through PayPal.' }));

  // 4 — Refund pending → overdue → escalated
  const s4 = await buy(human, 'p17', 'Buy an air fryer');
  const promisedAt = Date.now();
  ingest({ eventId: evid(), source: 'merchant', type: 'cancelled', transactionRef: s4.id, label: SIM_M, occurredAt: iso(promisedAt) });
  const pending = A.chain(s4.id).txnStatus;
  const later = promisedAt + 9 * DAY;   // 9 days later, deadline was 7
  await I.scan(later, s4.id);
  const inc4 = incFor(s4.id, 'refund_missing');
  if (inc4) await I.escalate(inc4.id, 'pact-ops');
  push(4, 'Refund pending', s4, () => { const c = A.chain(s4.id, later); return { expected: 'pending → overdue → escalated',
    passed: pending === 'pending' && c.txnStatus === 'missing' && !!inc4?.escalated,
    finding: `Day 0: status "${pending}" (refund due in 7 days). Day 9: ${c.commitment.issues.map(i => i.msg).join('; ')}. Incident ${inc4?.id} escalated.`,
    txnStatus: c.txnStatus, why: 'Refund was owed by its deadline and no PayPal REFUNDED event arrived.', action: inc4?.recommendedAction,
    paypalNotice: inc4?.notifications.find(n => n.party === 'paypal')?.status }; });

  // 5 — Agent purchase with delayed delivery
  const s5 = await buy(agent, 'p7', 'Buy a mechanical keyboard for the new hire, under $100');
  const by = new Date(s5.commitment.deliveryBy).getTime();
  ingest({ eventId: evid(), source: 'merchant', type: 'shipped', transactionRef: s5.id, label: SIM_M, payload: { tracking: 'SIM-TRK-5005', carrier: 'DemoPost' } });
  ingest({ eventId: evid(), source: 'merchant', type: 'delivery_date_changed', transactionRef: s5.id, label: SIM_M, payload: { estimatedDelivery: iso(by + 5 * DAY) } });
  push(5, 'Agent purchase with delayed delivery', s5, c => ({ expected: 'authorization + payment + commitment connected; delay flagged',
    passed: c.initiator === 'AI agent' && !!s5.approval && c.commitment.issues.some(i => i.kind === 'delivery_date_changed'),
    finding: `${s5.agentId} → firewall ${s5.preflight.decision} → consent ${s5.approval.by} → PayPal ${s5.payment.captureId} → ${c.commitment.issues.map(i => i.msg).join('; ')}`,
    why: 'Merchant committed to deliver by ' + s5.commitment.deliveryBy.slice(0, 10) + ' at purchase time.', action: 'Merchant confirms the new date; buyer is told before opening a claim.' }));

  await I.scan();

  // Bonus — merchant resolves the amount-mismatch incident with verified evidence
  const inc2 = incFor(s2.id, 'amount_mismatch');
  I.respond(inc2.id, { party: 'merchant', message: 'Order was edited: one item removed; capture of $378 is correct. Revised invoice attached.', evidence: 'invoice INV-2042 (revised), order edit log' });
  const stageBefore = I.stage(inc2);
  I.setStatus(inc2.id, 'resolved', 'merchant', 'Discrepancy explained by an order edit; buyer approval to be refreshed for the new total.');
  out.push({ n: 6, name: 'Bonus: merchant resolves with evidence', intentId: s2.id, incidentId: inc2.id, expected: 'evidence collected → resolved',
    passed: stageBefore === 'evidence_collected' && I.detail(inc2.id).status === 'resolved', finding: `Incident ${inc2.id}: ${stageBefore} → resolved`,
    why: 'Merchant supplied a revised invoice explaining the lower capture.', action: 'None. Case closed with an auditable timeline.' });

  return { scenarios: out, passed: out.filter(s => s.passed).length, total: out.length, incidents: I.list().length,
    note: 'Payments use the PayPal simulator; webhook and merchant events are simulated and labelled, but go through the same ingestion + idempotency path as real events.' };
}
