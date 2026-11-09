// PACT Transaction Intelligence
//  A. graph(it)        one purchase as linked records: approval → agent → merchant order → PayPal order
//                      → PayPal capture(s) → delivery → refund → PACT verdict. Every node carries its
//                      source and the audit-ledger entries (seq + hash) that prove it.
//  B. investigate(it)  evidence-grounded investigation: every statement cites nodes and ledger entries.
//                      Rules decide; the optional LLM only rephrases the summary and may not add facts.
//  C. replay(it, inj)  what-if on a deep COPY of the transaction: inject a problem, see the exact event
//                      that changed the status. Nothing is saved, no money moves, no incident is opened.
import { intents, agents, ledger } from './trust.js';
import * as A from './assurance.js';
import { incidents } from './incidents.js';
import { ask } from './llm.js';
import { round2 } from './policy.js';

const DAY = 864e5;
const d10 = s => (s ? new Date(s).toISOString().slice(0, 10) : '—');
const err = (s, m) => Object.assign(new Error(m), { status: s });
export const getIntent = id => { const it = intents.get(id); if (!it) throw err(404, 'unknown transaction'); return it; };

// Which ledger entries prove which node.
const NODE_OF = {
  intent_created: 'agent', intent_approved: 'approval', intent_auto_approved: 'approval',
  merchant_commitment_recorded: 'merchant', checkout_confirmed: 'merchant', approval_invalidated: 'approval',
  order_created: 'paypal_order', payment_captured: 'capture',
  merchant_shipped: 'delivery', merchant_delivered: 'delivery', merchant_delivery_date_changed: 'delivery',
  merchant_cancelled: 'refund', merchant_refund_promised: 'refund',
};
function evidenceFor(it, extra = []) {
  const map = {};
  const add = (node, e) => (map[node] ||= []).push({ seq: e.seq, type: e.type, at: e.at, hash: e.hash?.slice(0, 12), source: e.data?.source || e.actor, replay: !!e.replay });
  for (const e of [...ledger.filter(l => l.ref === it.id), ...extra]) {
    let n = NODE_OF[e.type];
    if (e.type === 'paypal_webhook') n = /REFUND|REVERS/.test(e.data?.event_type || '') ? 'refund' : 'capture';
    if (n) add(n, e);
  }
  return map;
}

// ---------------- A. graph ----------------
export function graph(it, { asOf = Date.now(), extraEvidence = [] } = {}) {
  const rec = A.reconcile(it), com = A.commitmentCheck(it, asOf), ts = A.txnStatus(it, asOf, rec, com);
  const ev = evidenceFor(it, extraEvidence);
  const ref = it.approval ? it.amount : null;
  const agent = agents.get(it.agentId);
  const nodes = [];
  const node = (id, label, o) => nodes.push({ id, label, evidence: ev[id] || [], ...o });
  const money = v => (v == null ? null : round2(v));
  const off = v => ref != null && v != null && money(v) !== ref;

  node('approval', 'Buyer approval', { amount: it.approval ? it.amount : null, at: it.approval?.at,
    status: it.status === 'invalidated' ? 'conflict' : it.approval ? 'ok' : 'missing', source: 'consent record',
    detail: it.approval ? `Approved by ${it.approval.by}; bound to item, merchant and amount (${it.approval.hash.slice(0, 12)}…)` : 'No approval recorded',
    record: it.approval || null });
  node('agent', agent?.human ? 'Buyer checkout' : 'AI agent', { amount: money(it.proposal?.amount), at: it.createdAt,
    status: it.preflight.decision === 'block' ? 'conflict' : 'ok', source: agent?.human ? 'buyer' : `agent ${it.agentId}`,
    detail: `${agent?.human ? 'Buyer' : it.agentId} selected ${it.title}; firewall: ${it.preflight.decision}`,
    record: { agentId: it.agentId, request: it.userRequest, product: it.title, quantity: it.proposal?.quantity, firewall: it.preflight.decision, scores: it.preflight.scores } });
  node('merchant', 'Merchant order', { amount: money(it.commitment?.price), at: it.createdAt,
    status: !it.commitment ? 'missing' : off(it.commitment.price) ? 'conflict' : 'ok', source: it.commitment?.source || '—',
    detail: it.commitment ? `${it.commitment.merchant} committed ${'$' + it.commitment.price.toFixed(2)}, delivery by ${d10(it.commitment.deliveryBy)}` : 'No merchant commitment',
    record: it.commitment || null });
  node('paypal_order', 'PayPal order', { amount: it.orderId ? it.amount : null, at: ev.paypal_order?.[0]?.at,
    status: it.orderId ? 'ok' : 'missing', source: it.orderId?.startsWith('SIM-') ? 'PayPal (simulator)' : 'PayPal sandbox',
    detail: it.orderId ? `Order ${it.orderId}` : 'No PayPal order', record: it.orderId ? { orderId: it.orderId, amount: it.amount, currency: 'USD' } : null });

  // captures: the API capture, plus any different capture id or amount reported by PayPal events
  const capEvents = (it.paypalEvents || []).filter(e => e.event_type === 'PAYMENT.CAPTURE.COMPLETED');
  const captureIssues = [];
  for (const e of capEvents) {
    if (it.payment && e.captureId && e.captureId !== it.payment.captureId) captureIssues.push(`second capture ${e.captureId} for $${Number(e.amount).toFixed(2)}`);
    else if (it.payment && e.amount != null && e.amount !== Number(it.payment.amount)) captureIssues.push(`PayPal event reports $${Number(e.amount).toFixed(2)}, capture response $${Number(it.payment.amount).toFixed(2)}`);
  }
  node('capture', 'PayPal capture', { amount: it.payment ? money(it.payment.amount) : null, at: it.payment?.at,
    status: !it.payment ? (it.orderId ? 'pending' : 'missing') : (off(it.payment.amount) || captureIssues.length) ? 'conflict' : 'ok',
    source: it.payment ? (it.payment.simulated ? 'PayPal (simulator)' : 'PayPal sandbox') : '—',
    detail: it.payment ? `Capture ${it.payment.captureId}${it.payment.fee != null ? ` · fee $${it.payment.fee} (not compared)` : ''}${captureIssues.length ? ' · ' + captureIssues.join('; ') : ''}` : 'Not captured yet',
    note: captureIssues.length ? captureIssues[0].replace(/^PayPal event reports/, 'event says').replace(/, capture response.*/, '') : '',
    record: it.payment ? { ...it.payment, events: capEvents } : null });

  const late = com.issues.find(i => ['late_delivery', 'delivery_date_changed'].includes(i.kind));
  const gone = com.issues.find(i => ['not_delivered', 'not_shipped'].includes(i.kind));
  const f = it.fulfillment || [];
  node('delivery', 'Delivery', { amount: null, at: f.find(e => e.type === "delivered")?.at || f.at(-1)?.at,
    status: late ? 'conflict' : gone ? 'missing' : f.some(e => e.type === 'delivered') ? 'ok' : 'pending',
    source: f.length ? f[f.length - 1].source : 'no merchant event yet',
    detail: late ? late.msg : gone ? gone.msg : f.some(e => e.type === 'delivered') ? `Delivered ${d10(f.find(e => e.type === 'delivered').at)}` : `Expected by ${d10(it.commitment?.deliveryBy)}`,
    record: f.length ? f : null });

  const rf = com.refund;
  if (rf) node('refund', 'Refund', { amount: rf.refunded, at: rf.since, status: rf.state === 'refunded' ? 'ok' : rf.state === 'overdue' ? 'missing' : 'pending',
    source: 'merchant + PayPal events', detail: `Owed ${'$' + rf.expected.toFixed(2)} by ${d10(rf.deadline)} · refunded ${'$' + rf.refunded.toFixed(2)}`, record: rf });

  node('verdict', 'PACT verdict', { amount: null, at: new Date(asOf).toISOString(),
    status: ts.status === 'verified' ? 'ok' : ts.status === 'pending' ? 'pending' : ts.status === 'missing' ? 'missing' : 'conflict',
    source: 'PACT rules', detail: `${ts.status.toUpperCase()}: ${ts.reasons.join('; ')}`, record: { status: ts.status, reasons: ts.reasons } });

  const ids = nodes.map(n => n.id);
  const edges = ids.slice(0, -1).map((a, i) => {
    const A1 = nodes[i], B1 = nodes[i + 1];
    const conflict = A1.amount != null && B1.amount != null && A1.amount !== B1.amount && B1.id !== 'refund';
    return { from: a, to: ids[i + 1], status: conflict ? 'conflict' : B1.status === 'missing' ? 'missing' : B1.status === 'pending' ? 'pending' : 'ok',
      note: conflict ? `$${A1.amount.toFixed(2)} → $${B1.amount.toFixed(2)}` : '' };
  });
  return { intentId: it.id, title: it.title, status: ts.status, reasons: ts.reasons, nodes, edges, reconciliation: rec, commitment: com };
}

// ---------------- B. investigation copilot ----------------
export async function investigate(it, opts = {}) {
  const g = graph(it, opts);
  const N = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  const cite = (...ids) => ids.filter(i => N[i]).map(i => ({ node: i, label: N[i].label, ledger: N[i].evidence.map(e => e.seq), source: N[i].source }));
  const S = (text, ...ids) => ({ text, evidence: cite(...ids) });

  const happened = [];
  if (N.agent) happened.push(S(`${N.agent.detail}.`, 'agent'));
  if (it.approval) happened.push(S(`Buyer approved $${it.amount.toFixed(2)} at ${d10(it.approval.at)}.`, 'approval'));
  if (it.commitment) happened.push(S(`${it.commitment.merchant} committed to $${it.commitment.price.toFixed(2)} and delivery by ${d10(it.commitment.deliveryBy)}.`, 'merchant'));
  if (it.orderId) happened.push(S(`PayPal order ${it.orderId} was created for $${it.amount.toFixed(2)}.`, 'paypal_order'));
  if (it.payment) happened.push(S(`PayPal captured $${Number(it.payment.amount).toFixed(2)} (capture ${it.payment.captureId}).`, 'capture'));
  for (const e of it.fulfillment || []) happened.push(S(`Merchant reported "${e.type.replace(/_/g, ' ')}"${e.estimatedDelivery ? ` with a new date of ${d10(e.estimatedDelivery)}` : ''} on ${d10(e.at)} [${e.source}].`, e.type === 'cancelled' || e.type === 'refund_promised' ? 'refund' : 'delivery'));

  const disagree = [];
  for (const m of g.reconciliation.mismatches) {
    const ids = /captures|DUPLICATE|webhook|capture/i.test(m) ? ['approval', 'capture'] : /Merchant/.test(m) ? ['approval', 'merchant'] : /Agent/.test(m) ? ['agent', 'capture'] : ['approval', 'capture'];
    disagree.push(S(m.replace(/^DUPLICATE CAPTURE: /, 'Two captures for one order: ') + '.', ...ids));
  }
  for (const e of g.edges.filter(x => x.status === 'conflict')) disagree.push(S(`${N[e.from].label} and ${N[e.to].label} disagree: ${e.note}.`, e.from, e.to));

  const why = [];
  for (const r of g.reasons) why.push(S(r.charAt(0).toUpperCase() + r.slice(1) + '.', 'verdict'));
  for (const i of g.commitment.issues) why.push(S(`Merchant commitment not met: ${i.msg}.`, i.kind === 'refund_missing' ? 'refund' : i.kind === 'price' ? 'merchant' : 'delivery'));

  const evc = A.evidenceCompleteness(it);
  const missing = evc.items.filter(x => !x.have).map(x => S(`${x.label} is not on record.`, ...(/Shipment|Delivery/.test(x.label) ? ['delivery'] : /PayPal/.test(x.label) ? ['capture'] : [])));

  const inc = [...incidents.values()].filter(i => i.intentId === it.id && i.status !== 'resolved');
  const risk = A.disputeRisk(it, g.reconciliation, g.commitment);
  const next = [...new Set([...inc.map(i => i.recommendedAction), ...risk.actions])].map(a => S(a, 'verdict'));
  if (!next.length) next.push(S('No action needed. All available records agree.', 'verdict'));

  const sections = { whatHappened: happened, disagreements: disagree, whyFlagged: why, missingEvidence: missing, nextSteps: next };
  const facts = Object.entries(sections).flatMap(([k, v]) => v.map(s => `[${k}] ${s.text}`));
  const fallback = g.status === 'verified'
    ? `All available records agree for ${it.title}: the buyer approved $${it.amount.toFixed(2)} and PayPal captured the same amount.`
    : `${it.title} is marked ${g.status}. ${disagree[0]?.text || why[0]?.text || ''} ${next[0]?.text || ''}`.trim();
  const llm = await ask('You are an investigation assistant for payment operations. Summarise in 2-3 sentences using ONLY the facts given. Do not add facts, numbers or causes that are not listed. Never say fraud or accuse anyone; say "discrepancy" and "requires verification".',
    facts.join('\n'), { maxTokens: 220 });
  return { intentId: it.id, title: it.title, status: g.status, summary: llm || fallback, summarySource: llm ? 'AI summary of the facts below' : 'rule-based summary',
    sections, openIncidents: inc.map(i => ({ id: i.id, kind: i.kind, stage: i.status })), graph: g,
    guardrail: 'Detection is rule-based. Every statement cites the records it comes from. PACT does not determine fraud.' };
}

// ---------------- C. replay / what-if ----------------
export const INJECTIONS = {
  price_changed: 'Merchant changes the price after approval',
  duplicate_capture: 'PayPal reports a second capture',
  delivery_delayed: 'Merchant pushes delivery back 5 days',
  refund_never_arrived: 'Order cancelled, refund never arrives',
};
export function replay(id, inject = []) {
  const real = getIntent(id);
  if (!real.payment) throw err(409, 'replay needs a captured payment');
  const it = structuredClone(real);                 // never touches the real transaction
  const t0 = Date.now();
  let asOf = t0;
  const steps = [];
  const extra = [];
  let seq = 1e9;
  const snap = () => { const g = graph(it, { asOf, extraEvidence: extra }); return { status: g.status, reasons: [...new Set([...g.reasons, ...g.commitment.issues.map(i => i.msg)])] }; };
  const push = (event, apply) => {
    const before = snap();
    apply();
    extra.push({ seq: seq++, type: event.type, at: new Date(asOf).toISOString(), ref: it.id, actor: 'replay', data: { source: 'replay (not saved)', event_type: event.event_type }, replay: true });
    const after = snap();
    steps.push({ at: new Date(asOf).toISOString(), event: event.label, before: before.status, after: after.status, triggered: before.status !== after.status || after.reasons.some(r => !before.reasons.includes(r)), newReasons: after.reasons.filter(r => !before.reasons.includes(r)), reasons: after.reasons });
  };
  steps.push({ at: new Date(asOf).toISOString(), event: 'Starting point: the real transaction as recorded', before: null, after: snap().status, triggered: false, reasons: snap().reasons });
  for (const k of inject) {
    if (!INJECTIONS[k]) throw err(400, `unknown injection ${k}`);
    if (k === 'price_changed') {
      const newAmt = round2(it.amount + 10);
      push({ label: `Merchant/PayPal records a charge of $${newAmt.toFixed(2)} instead of $${it.amount.toFixed(2)}`, type: 'paypal_webhook', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
        () => (it.paypalEvents ||= []).push({ event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: newAmt, captureId: it.payment.captureId, at: new Date(asOf).toISOString(), source: 'replay (not saved)' }));
    }
    if (k === 'duplicate_capture') {
      push({ label: 'PayPal reports a second capture REPLAY-CAP-2 for the same order', type: 'paypal_webhook', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
        () => (it.paypalEvents ||= []).push({ event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: Number(it.payment.amount), captureId: 'REPLAY-CAP-2', at: new Date(asOf).toISOString(), source: 'replay (not saved)' }));
    }
    if (k === 'delivery_delayed') {
      const by = new Date(it.commitment.deliveryBy).getTime();
      if ((it.fulfillment || []).some(e => e.type === 'delivered')) {
        it.fulfillment = it.fulfillment.filter(e => e.type !== 'delivered'); delete it.delivery;
        steps.push({ at: new Date(asOf).toISOString(), event: 'Rewound to before delivery, so the delay can be tested', before: null, after: snap().status, triggered: false, reasons: snap().reasons });
      }
      push({ label: `Merchant moves delivery to ${d10(by + 5 * DAY)} (promised ${d10(by)})`, type: 'merchant_delivery_date_changed' },
        () => (it.fulfillment ||= []).push({ type: 'delivery_date_changed', estimatedDelivery: new Date(by + 5 * DAY).toISOString(), at: new Date(asOf).toISOString(), source: 'replay (not saved)' }));
    }
    if (k === 'refund_never_arrived') {
      push({ label: 'Merchant cancels the order (refund due within 7 days)', type: 'merchant_cancelled' },
        () => (it.fulfillment ||= []).push({ type: 'cancelled', at: new Date(asOf).toISOString(), source: 'replay (not saved)' }));
      push({ label: 'Day 9: no PayPal refund event has arrived', type: 'clock' }, () => { asOf += 9 * DAY; });
    }
  }
  const trigger = steps.find(s => s.triggered && ['mismatch', 'missing'].includes(s.after)) || steps.find(s => s.triggered);
  return { intentId: id, title: real.title, injected: inject.map(k => INJECTIONS[k]), steps, trigger: trigger ? trigger.event : null,
    final: graph(it, { asOf, extraEvidence: extra }), note: 'Replayed on a copy. Nothing was saved, no money moved and no incident was opened.' };
}
