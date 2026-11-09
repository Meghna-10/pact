// PACT lifecycle demos. Each one runs the real engine; results are not hard-coded.
// Merchant fulfilment and the "different PayPal amount" event are SIMULATED and labelled so.
import * as T from './trust.js';
import * as A from './assurance.js';
import { payIntent } from './simulate.js';
import { negotiate } from './agents.js';

const DAY = 864e5;
const iso = t => new Date(t).toISOString();

async function buy(agent, productId, request) {
  const p = T.product(productId);
  const r = T.createIntent(agent.credential, { productId, quantity: 1, amount: negotiate(p, 1).finalPrice, currency: 'USD', merchant: p.merchant, category: p.category }, request);
  if (r.intent.status === 'pending_approval') T.approveIntent(r.intent.id, 'buyer');
  T.merchantCheckout(r.intent.id, { amount: r.intent.amount });
  return payIntent(r.intent, true);
}

export async function runLifecycleDemos() {
  const agent = T.registerAgent({ name: 'Office Procurement Agent', permissions: { maxPerTxn: 500, dailyBudget: 2000, approvalAbove: 300, allowedCategories: 'electronics' } });
  const out = [];

  // Demo 1 — Payment Reality Check
  {
    const it = await buy(agent, 'p25', 'Buy a 4K monitor for the office, under $500');
    A.agentReport(it.id, { amount: 420, status: 'paid', note: 'Agent: "Paid $420, order complete."' });
    A.paypalEvent(it.id, { event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: 378 }, 'PayPal event (simulated for demo)');
    const c = A.chain(it.id);
    out.push({ demo: 'Payment Reality Check', scenario: 'Agent says it paid $420; the PayPal payment event shows $378.',
      detected: c.reconciliation.mismatches.length > 0, findings: c.reconciliation.mismatches, intentId: it.id, disputeRisk: c.disputeRisk.level });
  }

  // Demo 2 — Merchant Promise Failure
  let late;
  {
    const it = await buy(agent, 'p24', 'Buy a smart speaker for the meeting room');
    const by = new Date(it.commitment.deliveryBy).getTime();
    A.merchantEvent(it.id, { type: 'shipped', tracking: 'SIM-TRK-88231', carrier: 'DemoPost', at: iso(Date.now() + DAY) });
    A.merchantEvent(it.id, { type: 'delivery_date_changed', estimatedDelivery: iso(by + 4 * DAY), at: iso(Date.now() + 2 * DAY) });
    const before = A.chain(it.id);
    A.merchantEvent(it.id, { type: 'delivered', tracking: 'SIM-TRK-88231', carrier: 'DemoPost', at: iso(by + 4 * DAY) });
    const after = A.chain(it.id);
    late = it;
    out.push({ demo: 'Merchant Promise Failure', scenario: `Merchant promised delivery by ${it.commitment.deliveryBy.slice(0, 10)}, then pushed the date 4 days and delivered late.`,
      detected: before.commitment.issues.some(i => i.kind === 'delivery_date_changed') && after.commitment.issues.some(i => i.kind === 'late_delivery'),
      findings: [...before.commitment.issues.map(i => 'before delivery: ' + i.msg), ...after.commitment.issues.map(i => 'after delivery: ' + i.msg)],
      actions: after.disputeRisk.actions, intentId: it.id, disputeRisk: after.disputeRisk.level });
  }

  // Demo 3 — Dispute-Ready Evidence (two claims, two honest answers)
  {
    const it = await buy(agent, 'p7', 'Buy a mechanical keyboard');
    A.merchantEvent(it.id, { type: 'shipped', carrier: 'DemoPost', at: iso(Date.now() + DAY) }); // no tracking number
    const asOf = new Date(it.commitment.deliveryBy).getTime() + 3 * DAY;
    const noProof = A.disputePackage(it.id, 'not_received', asOf);
    const withProof = A.disputePackage(late.id, 'not_received');
    out.push({ demo: 'Dispute-Ready Evidence', scenario: '"Item not received" claims on two orders: one has no tracking and is past the promised date; one was delivered (late) with tracking.',
      detected: noProof.canContest === false && withProof.canContest === true,
      findings: [`${it.id}: ${noProof.recommendation}`, `${late.id}: ${withProof.recommendation}`],
      evidence: { noProof: { facts: noProof.facts, missing: noProof.missing }, withProof: { facts: withProof.facts, missing: withProof.missing } }, intentId: it.id });
  }
  return { agentId: agent.id, demos: out, passed: out.filter(d => d.detected).length, total: out.length,
    note: 'Payments use the PayPal simulator. Merchant fulfilment and the $378 PayPal event are simulated and labelled as such in each timeline.' };
}
