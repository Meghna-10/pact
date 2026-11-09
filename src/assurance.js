// PACT — Payment Assurance & Commerce Trust.
// One transaction, one chain of accountability:
//   Intent → Agent action → Merchant commitment → Payment (PayPal) → Outcome → Evidence
// Deterministic. Every event is labelled with WHERE it came from, so the evidence never
// mixes real PayPal sandbox data with simulated merchant data without saying so.
import { intents, audit, ledger, verifyLedger, product, agents } from './trust.js';
import { round2 } from './policy.js';

const DAY = 864e5;
const err = (s, m) => Object.assign(new Error(m), { status: s });
const get = id => { const it = intents.get(id); if (!it) throw err(404, 'unknown intent'); return it; };

// ---------- inputs from the world ----------
// What the agent CLAIMS it did (agents can be wrong or compromised).
export function agentReport(id, { amount, status = 'paid', note }) {
  const it = get(id);
  it.agentReport = { amount: round2(amount), status, note, at: new Date().toISOString() };
  audit(it.agentId, 'agent_reported', id, it.agentReport);
  return it;
}

// Merchant fulfilment events. In this prototype they are SIMULATED and labelled as such.
const FULFIL = ['shipped', 'delivery_date_changed', 'delivered', 'cancelled', 'refund_promised'];
export function merchantEvent(id, ev, source = 'merchant (simulated)') {
  const it = get(id);
  if (!FULFIL.includes(ev.type)) throw err(400, `type must be one of ${FULFIL.join(', ')}`);
  const e = { type: ev.type, at: ev.at || new Date().toISOString(), tracking: ev.tracking, carrier: ev.carrier, estimatedDelivery: ev.estimatedDelivery, amount: ev.amount, deadline: ev.deadline, source };
  (it.fulfillment ||= []).push(e);
  if (e.type === 'delivered') it.delivery = { at: e.at, tracking: e.tracking || null, carrier: e.carrier || null, source };
  if (e.type === 'shipped' && e.tracking) it.shipment = { tracking: e.tracking, carrier: e.carrier, source };
  audit('merchant', 'merchant_' + e.type, id, e);
  return it;
}

// PayPal payment lifecycle events (from verified webhooks, or simulated for the demo).
export function paypalEvent(id, ev, source) {
  const it = get(id);
  const e = { event_type: ev.event_type, amount: ev.amount != null ? round2(ev.amount) : undefined, currency: ev.currency, captureId: ev.captureId, eventId: ev.eventId, status: ev.status, at: ev.at || new Date().toISOString(), source };
  (it.paypalEvents ||= []).push(e);
  audit(source.startsWith('PayPal webhook') ? 'paypal-webhook' : 'paypal', 'paypal_webhook', id, { ...e, intentId: id });
  return it;
}

// ---------- C. Payment reconciliation ----------
export function reconcile(it) {
  const rows = [];
  const row = (label, value, source) => rows.push({ label, value: value == null ? null : round2(value), source });
  row('Buyer-approved amount', it.approval ? it.amount : null, 'consent record');
  row('Merchant committed price', it.commitment?.price, it.commitment?.source);
  row('PayPal order amount', it.orderId ? it.amount : null, it.orderId?.startsWith('SIM-') ? 'PayPal (simulator)' : 'PayPal sandbox');
  row('PayPal gross capture', it.payment ? Number(it.payment.amount) : null, it.payment?.simulated ? 'PayPal (simulator)' : 'PayPal sandbox');
  row('Agent-reported amount', it.agentReport?.amount, 'agent claim (unverified)');
  // Fees are shown, never compared: comparing net to the order total would flag every normal fee.
  if (it.payment?.fee != null) { row('PayPal fee (not compared)', it.payment.fee, it.payment.simulated ? 'simulated fee estimate' : 'PayPal sandbox'); }

  const refunds = (it.paypalEvents || []).filter(e => /REFUNDED|REVERSED/.test(e.event_type));
  const refunded = round2(refunds.reduce((s, e) => s + (e.amount || 0), 0));
  if (refunds.length) row('Refunded / reversed', refunded, refunds[0].source);
  const net = it.payment ? round2(Number(it.payment.amount) - refunded) : null;
  row('Gross after refunds', net, 'computed');
  if (it.payment?.fee != null) row('Merchant net after fees', round2(net - it.payment.fee), 'computed');

  const mismatches = [];
  const ref = it.approval ? it.amount : null;
  const COMPARED = ['Merchant committed price', 'PayPal order amount', 'PayPal gross capture', 'Agent-reported amount'];
  for (const r of rows.filter(r => COMPARED.includes(r.label))) if (ref != null && r.value != null && r.value !== ref)
    mismatches.push(`${r.label} $${r.value} ≠ buyer-approved $${ref}`);
  if (refunded > 0 && it.agentReport?.status === 'paid') mismatches.push(`Agent reports paid ${it.agentReport.amount}, but PayPal reversed/refunded ${refunded} (net ${net})`);
  if (it.agentReport?.status === 'paid' && !it.payment) mismatches.push('Agent reports "paid" but PayPal shows no capture');
  if (it.payment && it.agentReport && it.agentReport.status !== 'paid') mismatches.push(`Agent reports "${it.agentReport.status}" but PayPal captured`);
  for (const e of it.paypalEvents || []) {
    if (/DENIED|DECLINED|PENDING/.test(e.event_type)) mismatches.push(`PayPal event ${e.event_type} contradicts a completed payment`);
    if (e.event_type === 'PAYMENT.CAPTURE.COMPLETED' && e.amount != null && it.payment && e.amount !== Number(it.payment.amount))
      mismatches.push(`PayPal webhook amount $${Number(e.amount).toFixed(2)} ≠ capture response $${Number(it.payment.amount).toFixed(2)}`);
    if (e.currency && e.currency !== (it.currency || 'USD')) mismatches.push(`PayPal event currency ${e.currency} ≠ order currency ${it.currency || 'USD'}`);
  }
  // Duplicate capture = two DIFFERENT capture IDs for one order. A redelivered webhook (same
  // event id) never reaches here: it is dropped at ingestion by the idempotency check.
  const caps = new Set([it.payment?.captureId, ...(it.paypalEvents || []).filter(e => e.event_type === 'PAYMENT.CAPTURE.COMPLETED' && e.captureId).map(e => e.captureId)].filter(Boolean));
  if (caps.size > 1) mismatches.push(`DUPLICATE CAPTURE: ${caps.size} different PayPal captures recorded for one order (${[...caps].join(', ')})`);
  return { rows, mismatches, reconciled: mismatches.length === 0 && !!it.payment };
}

// ---------- Merchant commitment monitor ----------
export function commitmentCheck(it, asOf = Date.now()) {
  const c = it.commitment; if (!c) return { issues: [], status: 'no commitment' };
  const issues = [];
  const f = it.fulfillment || [];
  const by = new Date(c.deliveryBy).getTime();
  const fmt = t => new Date(t).toISOString().slice(0, 10);
  const delivered = f.find(e => e.type === 'delivered');
  const cancelled = f.find(e => e.type === 'cancelled');
  const lastEta = [...f].reverse().find(e => e.estimatedDelivery)?.estimatedDelivery;

  if (it.payment && Number(it.payment.amount) !== c.price) issues.push({ kind: 'price', severity: 'high', msg: `charged $${it.payment.amount}, merchant committed $${c.price}` });
  if (delivered && new Date(delivered.at).getTime() > by) issues.push({ kind: 'late_delivery', severity: 'medium', msg: `delivered ${fmt(delivered.at)}, promised by ${fmt(by)}` });
  if (!delivered && lastEta && new Date(lastEta).getTime() > by) issues.push({ kind: 'delivery_date_changed', severity: 'medium', msg: `merchant now estimates ${fmt(lastEta)}, promised by ${fmt(by)}` });
  if (!delivered && !cancelled && it.payment && asOf > by) issues.push({ kind: 'not_delivered', severity: 'high', msg: `no delivery record and the promised date ${fmt(by)} has passed` });
  if (it.payment && !f.some(e => e.type === 'shipped') && !cancelled && asOf > new Date(it.payment.at || it.createdAt).getTime() + Math.min(3, c.shippingDays) * DAY)
    issues.push({ kind: 'not_shipped', severity: 'medium', msg: 'no shipment event yet' });
  const rf = refundStatus(it, asOf);
  if (rf?.state === 'overdue')
    issues.push({ kind: 'refund_missing', severity: 'high', msg: `merchant ${rf.reason} on ${fmt(rf.since)}; refund due by ${fmt(rf.deadline)} but PayPal shows no refund` });
  return { issues, refund: rf, status: issues.length ? 'breached' : rf?.state === 'awaiting' ? 'refund pending' : rf?.state === 'refunded' ? 'refunded' : delivered ? 'fulfilled' : it.payment ? 'in progress' : 'not paid' };
}

// ---------- Refund tracker ----------
const REFUND_DAYS = 7;
export function refundStatus(it, asOf = Date.now()) {
  const f = it.fulfillment || [];
  const trigger = f.find(e => e.type === 'refund_promised') || f.find(e => e.type === 'cancelled');
  if (!trigger || !it.payment) return null;
  const since = new Date(trigger.at).getTime();
  const deadline = trigger.deadline ? new Date(trigger.deadline).getTime() : since + REFUND_DAYS * DAY;
  const expected = round2(trigger.amount ?? Number(it.payment.amount));
  const refunded = round2((it.paypalEvents || []).filter(e => /REFUNDED/.test(e.event_type)).reduce((s, e) => s + (e.amount || 0), 0));
  const state = refunded >= expected ? 'refunded' : asOf > deadline ? 'overdue' : 'awaiting';
  return { state, reason: trigger.type === 'cancelled' ? 'cancelled the order' : 'promised a refund', since: iso(since), deadline: iso(deadline), expected, refunded, daysOverdue: state === 'overdue' ? Math.floor((asOf - deadline) / DAY) : 0 };
}
const iso = t => new Date(t).toISOString();
export const refundTracker = (asOf = Date.now()) => [...intents.values()].map(it => ({ it, r: refundStatus(it, asOf) })).filter(x => x.r)
  .map(({ it, r }) => ({ intentId: it.id, title: it.title, merchant: it.merchant, ...r }));

// ---------- Transaction status + health ----------
// verified · mismatch · missing · pending · unverified. A missing event is NOT a failed payment:
// webhooks can be late or out of order, so a gap inside the grace window is "pending".
const WEBHOOK_GRACE_MS = Number(process.env.PACT_WEBHOOK_GRACE_MIN || 10) * 60e3;
export function txnStatus(it, asOf = Date.now(), rec = reconcile(it), com = commitmentCheck(it, asOf)) {
  const reasons = [];
  if (!it.payment && it.agentReport?.status === 'paid') return { status: 'unverified', reasons: ['only the agent says this was paid; no PayPal record'] };
  if (rec.mismatches.length || com.issues.some(i => ['price', 'late_delivery', 'delivery_date_changed'].includes(i.kind))) {
    return { status: 'mismatch', reasons: [...rec.mismatches, ...com.issues.filter(i => ['price', 'late_delivery', 'delivery_date_changed'].includes(i.kind)).map(i => i.msg)] };
  }
  if (com.issues.length) return { status: 'missing', reasons: com.issues.map(i => i.msg) };
  if (!it.payment) return { status: 'pending', reasons: [it.orderId ? 'PayPal order created, not captured yet' : 'not paid yet'] };
  const webhookExpected = !it.payment.simulated && !!process.env.PAYPAL_WEBHOOK_ID;
  const gotWebhook = (it.paypalEvents || []).some(e => e.event_type === 'PAYMENT.CAPTURE.COMPLETED' && /webhook \(verified\)/.test(e.source));
  if (webhookExpected && !gotWebhook) {
    if (asOf - new Date(it.payment.at).getTime() < WEBHOOK_GRACE_MS) return { status: 'pending', reasons: ['capture confirmed by API; waiting for the PayPal webhook (within grace window)'] };
    return { status: 'missing', reasons: ['no PAYMENT.CAPTURE.COMPLETED webhook received after the grace window'] };
  }
  if (com.refund?.state === 'awaiting') return { status: 'pending', reasons: [`refund of $${com.refund.expected} due by ${com.refund.deadline.slice(0, 10)}`] };
  reasons.push('buyer approval, merchant price and PayPal gross capture agree');
  if (it.payment.simulated) reasons.push('source: PayPal simulator');
  return { status: 'verified', reasons };
}

export function healthScore(it, rec, com, ev) {
  let s = 100;
  s -= 30 * rec.mismatches.length;
  for (const i of com.issues) s -= i.severity === 'high' ? 25 : 15;
  if (!it.approval) s -= 20;
  s -= Math.round((100 - ev.score) * 0.2);
  return Math.max(0, Math.min(100, s));
}

// ---------- A. The complete chain ----------
const SRC = e => {
  if (e.actor === 'paypal-webhook') return e.data?.source || 'PayPal webhook (verified)';
  if (e.actor === 'paypal') return e.data?.source || (e.data?.simulated || String(e.data?.orderId || '').startsWith('SIM-') ? 'PayPal (simulator)' : 'PayPal sandbox');
  if (e.actor === 'merchant') return e.data?.source || 'merchant';
  if (e.actor === 'buyer') return 'buyer';
  if (e.actor === 'firewall' || e.actor === 'policy') return 'PACT engine';
  if (e.actor?.startsWith('AGENT-')) return 'AI agent';
  return e.actor;
};
export function timeline(id) {
  return ledger.filter(e => e.ref === id).map(e => ({ seq: e.seq, at: e.at, type: e.type, source: SRC(e), data: e.data, hash: e.hash }));
}

export function chain(id, asOf = Date.now()) {
  const it = get(id);
  const rec = reconcile(it), com = commitmentCheck(it, asOf);
  const pf = it.preflight;
  const step = (name, state, detail) => ({ name, state, detail });
  const steps = [
    step('Intent', it.userRequest ? 'ok' : 'missing', it.userRequest || 'no buyer request recorded'),
    step('Agent action', pf.decision === 'block' ? 'blocked' : pf.injection?.injection ? 'warn' : 'ok',
      `${it.agentId} proposed ${it.title} $${it.amount} · firewall ${pf.decision}${it.agentReport ? ` · agent reports ${it.agentReport.status} $${it.agentReport.amount}` : ''}`),
    step('Consent', it.approval ? (it.status === 'invalidated' ? 'broken' : 'ok') : 'missing',
      it.approval ? `${it.approval.by} at ${it.approval.at.slice(0, 19)} · bound ${it.approval.hash.slice(0, 12)}…` : 'no approval'),
    step('Merchant commitment', it.commitment ? (com.issues.length ? 'warn' : 'ok') : 'missing',
      it.commitment ? `$${it.commitment.price} · deliver by ${it.commitment.deliveryBy.slice(0, 10)} · ${it.commitment.returns ? '30-day returns' : 'no returns'}` : '—'),
    step('Payment', !it.payment ? 'pending' : rec.mismatches.length ? 'warn' : 'ok',
      it.payment ? `${it.payment.simulated ? 'PayPal (simulator)' : 'PayPal sandbox'} capture ${it.payment.captureId} $${it.payment.amount}` : (it.orderId ? `order ${it.orderId}, not captured` : 'no order')),
    step('Outcome', com.status === 'fulfilled' ? 'ok' : com.status === 'breached' ? 'warn' : 'pending', com.status),
  ];
  const ev = evidenceCompleteness(it);
  steps.push(step('Evidence', ev.score >= 80 ? 'ok' : ev.score >= 50 ? 'warn' : 'missing', `${ev.score}% complete · ledger ${verifyLedger().ok ? 'intact' : 'BROKEN'}`));
  const ts = txnStatus(it, asOf, rec, com);
  return { intentId: id, title: it.title, amount: it.amount, status: it.status, initiator: agents.get(it.agentId)?.human ? 'human buyer' : 'AI agent',
    txnStatus: ts.status, statusReasons: ts.reasons, health: healthScore(it, rec, com, ev),
    steps, reconciliation: rec, commitment: { terms: it.commitment, ...com }, evidence: ev, disputeRisk: disputeRisk(it, rec, com), timeline: timeline(id) };
}

// ---------- B. Dispute prevention & evidence ----------
export function evidenceCompleteness(it) {
  const items = [
    ['Buyer request', !!it.userRequest], ['Buyer consent bound to terms', !!it.approval], ['Merchant commitment', !!it.commitment],
    ['PayPal order', !!it.orderId], ['PayPal capture', !!it.payment], ['PayPal lifecycle event', !!it.paypalEvents?.length],
    ['Shipment tracking', !!it.shipment?.tracking], ['Delivery confirmation', !!it.delivery],
  ];
  return { score: Math.round(100 * items.filter(i => i[1]).length / items.length), items: items.map(([label, have]) => ({ label, have })) };
}

export function disputeRisk(it, rec = reconcile(it), com = commitmentCheck(it)) {
  let s = 0; const why = [], actions = [];
  for (const i of com.issues) {
    s += i.severity === 'high' ? 35 : 20; why.push(i.msg);
    actions.push({ late_delivery: 'Offer the buyer a partial credit for the delay', delivery_date_changed: 'Ask the merchant to confirm the new date and tell the buyer before they open a claim',
      not_delivered: 'Request carrier tracking from the merchant now; prepare a refund if none exists', not_shipped: 'Ask the merchant for a shipment confirmation',
      refund_missing: 'Escalate: refund promised/cancelled but not processed in PayPal', price: 'Refund the overcharge difference' }[i.kind]);
  }
  for (const m of rec.mismatches) { s += 30; why.push(m); actions.push('Reconcile with PayPal before any payout or agent retry'); }
  if (it.commitment && !it.commitment.returns) { s += 10; why.push('merchant offers no returns'); }
  s = Math.min(100, s);
  return { score: s, level: s >= 60 ? 'high' : s >= 25 ? 'medium' : 'low', why: why.length ? why : ['all commitments met so far'], actions: [...new Set(actions)],
    note: 'Prioritisation signal from the rules above, not a validated dispute prediction.' };
}

export function disputePackage(id, claim = 'not_received', asOf = Date.now()) {
  const c = chain(id, asOf);
  const it = get(id);
  const fmt = t => t?.slice(0, 10);
  const facts = [];
  facts.push(`Buyer asked: "${it.userRequest}".`);
  if (it.approval) facts.push(`Buyer approved $${it.amount} for ${it.title} from ${it.merchant} on ${fmt(it.approval.at)}; approval is cryptographically bound to these terms.`);
  if (it.commitment) facts.push(`Merchant committed to deliver by ${fmt(it.commitment.deliveryBy)}${it.commitment.returns ? ' with 30-day returns' : ', no returns'}.`);
  if (it.payment) facts.push(`${it.payment.simulated ? 'PayPal simulator' : 'PayPal sandbox'} captured $${it.payment.amount} (capture ${it.payment.captureId}).`);
  for (const f of it.fulfillment || []) facts.push(`${fmt(f.at)}: merchant ${f.type.replace(/_/g, ' ')}${f.estimatedDelivery ? ` (new ETA ${fmt(f.estimatedDelivery)})` : ''}${f.tracking ? ` tracking ${f.tracking}` : ''} [${f.source}].`);
  for (const i of c.commitment.issues) facts.push(`Unmet commitment: ${i.msg}.`);

  const missing = c.evidence.items.filter(i => !i.have).map(i => i.label);
  const canContest = { not_received: !!it.delivery?.tracking, unauthorized: !!it.approval, not_as_described: !!it.commitment, refund_not_received: (it.paypalEvents || []).some(e => /REFUNDED/.test(e.event_type)) }[claim];
  const recommendation = canContest
    ? 'Evidence supports the merchant position on this claim. Review, then respond through PayPal Resolution Center.'
    : `Evidence does NOT support contesting "${claim.replace(/_/g, ' ')}". ${claim === 'not_received' ? 'There is no delivery confirmation with tracking.' : ''} Recommend resolving in the buyer's favour or obtaining: ${missing.join(', ') || 'n/a'}.`;
  audit('pact', 'dispute_package_prepared', id, { claim, canContest, missing });
  return { intentId: id, claim, canContest, recommendation, facts, missing, timeline: c.timeline, sources: [...new Set(c.timeline.map(t => t.source))],
    note: 'Assembled from recorded events only. Simulated events are labelled. Nothing is submitted to PayPal automatically and nothing is fabricated.' };
}

export const assuranceList = () => [...intents.values()].filter(i => i.status !== 'blocked').map(i => {
  const c = chain(i.id);
  return { intentId: i.id, title: i.title, amount: i.amount, status: i.status, agentId: i.agentId, reconciled: c.reconciliation.reconciled, mismatches: c.reconciliation.mismatches.length,
    commitment: c.commitment.status, txnStatus: c.txnStatus, health: c.health, initiator: c.initiator, disputeRisk: c.disputeRisk.level, evidence: c.evidence.score,
    merchant: i.merchant, createdAt: i.createdAt, orderId: i.orderId, captureId: i.payment?.captureId, simulated: !!i.payment?.simulated, steps: c.steps.map(s => s.state), statusReasons: c.statusReasons };
}).reverse();

export { product };
