// PACT Financial Intelligence — one shared engine behind six modules:
//   Money Recovery · Refund Radar · Subscription Guardian · Payment Failure Recovery ·
//   Cashflow Forecast · Dispute Intelligence
// Every record carries `source`: 'paypal-sandbox' | 'paypal-simulator' | 'computed' | 'user' | 'sample'.
// Nothing here moves money, files a dispute, or claims to know PayPal's internal risk decisions.
import crypto from 'node:crypto';
import { intents } from './trust.js';
import * as A from './assurance.js';
import { round2 } from './policy.js';

const DAY = 864e5;
const id = p => p + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const iso = t => new Date(t).toISOString();
const err = (s, m) => Object.assign(new Error(m), { status: s });
const srcOf = it => (it.payment?.simulated || it.orderId?.startsWith('SIM-') ? 'paypal-simulator' : 'paypal-sandbox');

// Persisted stores (saved by state.js)
export const fin = { holds: new Map(), subscriptions: new Map(), failures: new Map(), disputes: new Map() };

// ================= 4. Payment Failure Recovery =================
// PayPal Orders v2 error names (issue codes) → plain category, meaning and SAFE next action.
export const FAILURE_CODES = {
  INSTRUMENT_DECLINED: { category: 'Payment declined', retry: 'buyer', meaning: 'The buyer\'s card or bank refused the payment.', action: 'Ask the buyer to choose another payment method in PayPal and approve again. Do not re-capture with the same instrument.' },
  PAYER_ACTION_REQUIRED: { category: 'Buyer action needed', retry: 'buyer', meaning: 'The buyer has not finished approving the payment.', action: 'Send the buyer back to the PayPal approval step.' },
  ORDER_NOT_APPROVED: { category: 'Not approved yet', retry: 'after-approval', meaning: 'Capture was attempted before the buyer approved the order.', action: 'Wait for buyer approval, then capture once.' },
  ORDER_ALREADY_CAPTURED: { category: 'Already captured', retry: 'never', meaning: 'This order was already paid. Retrying could double-charge.', action: 'Do not retry. Reconcile with the existing capture.' },
  DUPLICATE_INVOICE_ID: { category: 'Duplicate', retry: 'never', meaning: 'An order with this invoice ID was already processed.', action: 'Do not retry. Check for an existing payment.' },
  TRANSACTION_REFUSED: { category: 'Refused by PayPal', retry: 'no', meaning: 'PayPal refused the transaction.', action: 'Do not retry automatically. Ask the buyer to contact PayPal or use another method.' },
  COMPLIANCE_VIOLATION: { category: 'Compliance / regulation', retry: 'no', meaning: 'Declined for regulatory reasons (for example a cross-border restriction between the buyer\'s and seller\'s countries).', action: 'Do not retry. Check that the buyer and seller accounts are allowed to transact (country, currency).' },
  PAYEE_ACCOUNT_RESTRICTED: { category: 'Seller account restricted', retry: 'no', meaning: 'The receiving account cannot accept payments right now.', action: 'The seller resolves the restriction in their PayPal account before taking payments.' },
  NETWORK: { category: 'Network / timeout', retry: 'safe', meaning: 'PACT could not reach PayPal.', action: 'Safe to retry: PACT sends a PayPal-Request-Id, so a retry is never a second payment.' },
  INTERNAL_SERVER_ERROR: { category: 'PayPal temporary error', retry: 'safe', meaning: 'PayPal returned a temporary error.', action: 'Retry later with the same request ID.' },
  POLICY: { category: 'Blocked by PACT policy', retry: 'no', meaning: 'PACT\'s firewall or the buyer\'s limits blocked the payment before it reached PayPal.', action: 'Review the agent\'s passport limits or choose another product.' },
  UNKNOWN: { category: 'Unclassified', retry: 'review', meaning: 'An error PACT does not recognise.', action: 'Review the raw error before retrying.' },
};
export function classifyError(message = '') {
  const m = String(message);
  for (const k of Object.keys(FAILURE_CODES)) if (m.includes(k)) return k;
  if (/could not reach PayPal|fetch failed|ECONN|timeout/i.test(m)) return 'NETWORK';
  if (/buyer has not approved|status CREATED/i.test(m)) return 'ORDER_NOT_APPROVED';
  if (/duplicate payment|already paid/i.test(m)) return 'ORDER_ALREADY_CAPTURED';
  if (/international regulations/i.test(m)) return 'COMPLIANCE_VIOLATION';
  if (/policy violation|Intent Firewall|blocked/i.test(m)) return 'POLICY';
  return 'UNKNOWN';
}
export function recordFailure({ intentId, stage, message, source = 'paypal-sandbox', amount, merchant, at }) {
  const it = intentId ? intents.get(intentId) : null;
  const code = classifyError(message);
  const f = { id: id('FAIL'), intentId: intentId || null, stage, code, message: String(message).slice(0, 300), amount: amount ?? it?.amount ?? null,
    merchant: merchant ?? it?.merchant ?? null, at: at || iso(Date.now()), source, recovered: false };
  fin.failures.set(f.id, f);
  return f;
}
export function failures() {
  const list = [...fin.failures.values()].map(f => {
    const it = f.intentId && intents.get(f.intentId);
    const recovered = !!(it && it.payment && f.code !== 'ORDER_ALREADY_CAPTURED' && new Date(it.payment.at) > new Date(f.at));
    return { ...f, recovered: f.recovered || recovered, ...FAILURE_CODES[f.code] };
  }).sort((a, b) => b.at.localeCompare(a.at));
  const byKey = {};
  for (const f of list) { const k = f.intentId || f.merchant || f.id; (byKey[k] ||= []).push(f); }
  const repeated = Object.entries(byKey).filter(([, a]) => a.length >= 3).map(([k, a]) => ({ key: k, count: a.length, codes: [...new Set(a.map(x => x.code))] }));
  const byCategory = {};
  for (const f of list) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  const byMerchant = {};
  for (const f of list.filter(x => x.merchant)) { const m = (byMerchant[f.merchant] ||= { merchant: f.merchant, failed: 0, recovered: 0 }); m.failed++; if (f.recovered) m.recovered++; }
  return { failures: list, total: list.length, recovered: list.filter(f => f.recovered).length, repeated, byCategory, byMerchant: Object.values(byMerchant), codes: FAILURE_CODES };
}

// ================= 2. Refund Radar =================
// Estimates only: PayPal documents typical timings, the real timing depends on the funding source.
const REFUND_ESTIMATE = { 'PayPal balance': '1 to 2 days', 'Card': '3 to 7 business days', 'Bank account': '5 to 10 business days', 'Unknown': 'up to 10 business days' };
export function refunds(asOf = Date.now()) {
  const rows = [];
  for (const it of intents.values()) {
    if (!it.payment) continue;
    const rf = A.refundStatus(it, asOf);
    const evts = (it.paypalEvents || []).filter(e => /REFUNDED|REVERSED/.test(e.event_type));
    if (!rf && !evts.length) continue;
    const refunded = round2(evts.reduce((s, e) => s + (e.amount || 0), 0));
    const capture = Number(it.payment.amount);
    const method = it.payment.fundingSource || 'Unknown';
    const state = rf ? (rf.state === 'refunded' ? 'completed' : rf.state === 'overdue' ? 'delayed' : refunded > 0 ? 'partial' : 'pending') : refunded >= capture ? 'completed' : 'partial';
    rows.push({ intentId: it.id, title: it.title, merchant: it.merchant, capture, owed: rf?.expected ?? refunded, refunded, outstanding: round2((rf?.expected ?? refunded) - refunded),
      state, initiatedAt: rf?.since || evts[0]?.at, deadline: rf?.deadline || null, daysOverdue: rf?.daysOverdue || 0,
      originalMethod: method, estimate: REFUND_ESTIMATE[method] || REFUND_ESTIMATE.Unknown, estimateLabel: 'estimate',
      overRefund: refunded > capture, source: evts.length ? (evts[0].source || srcOf(it)) : 'computed',
      escalation: state === 'delayed' ? ['Confirm the merchant issued the refund and get the refund ID', 'Check the refund in the PayPal activity of the buyer', 'If still missing, escalate through the authorized PayPal channel (Incident Center)'] : [] });
  }
  const sum = k => round2(rows.reduce((s, r) => s + r[k], 0));
  return { refunds: rows, totals: { owed: sum('owed'), refunded: sum('refunded'), outstanding: sum('outstanding'), delayed: rows.filter(r => r.state === 'delayed').length, pending: rows.filter(r => ['pending', 'partial'].includes(r.state)).length } };
}

// ================= 1. Money Recovery (holds) =================
// PayPal does not expose hold reasons to this integration; holds are user-entered or sample.
const HOLD_PLAYBOOK = {
  new_seller: { label: 'New seller or low sales history', docs: ['Proof of business identity', 'Supplier invoice for the item'], steps: ['Add tracking with a supported carrier', 'Confirm delivery', 'Keep the buyer updated'], typicalDays: 21 },
  unusual_activity: { label: 'Unusual selling activity', docs: ['Explanation of the sales spike', 'Supplier invoices'], steps: ['Add tracking', 'Respond to any PayPal information request'], typicalDays: 21 },
  high_risk_category: { label: 'Higher-risk item category', docs: ['Proof of authenticity or licence'], steps: ['Add tracking', 'Confirm delivery'], typicalDays: 21 },
  dispute_open: { label: 'Open dispute or claim on the payment', docs: ['Proof of delivery', 'Order and communication records'], steps: ['Respond to the dispute before its deadline (Dispute Intelligence)'], typicalDays: null },
  account_review: { label: 'Account under review', docs: ['Documents PayPal requests in the Resolution Center'], steps: ['Upload requested documents', 'Wait for review'], typicalDays: null },
  unknown: { label: 'Reason not stated', docs: [], steps: ['Check the PayPal Resolution Center message for the reason'], typicalDays: null },
};
export function addHold(h, source = 'user') {
  if (!(Number(h.amount) > 0)) throw err(400, 'amount required');
  const reason = HOLD_PLAYBOOK[h.reason] ? h.reason : 'unknown';
  const r = { id: id('HOLD'), amount: round2(h.amount), currency: 'USD', reason, intentId: h.intentId || null, merchant: h.merchant || null, placedAt: h.placedAt || iso(Date.now()),
    note: String(h.note || '').slice(0, 200), status: 'held', releasedAt: null, done: { docs: [], steps: [] }, reminders: [], history: [{ at: iso(Date.now()), event: 'Hold recorded' }], source };
  fin.holds.set(r.id, r);
  return r;
}
export function updateHold(hid, { status, doneDoc, doneStep, remindAt }) {
  const h = fin.holds.get(hid); if (!h) throw err(404, 'unknown hold');
  if (status && ['held', 'released'].includes(status)) { h.status = status; if (status === 'released') h.releasedAt = iso(Date.now()); h.history.push({ at: iso(Date.now()), event: `Marked ${status}` }); }
  if (doneDoc != null && !h.done.docs.includes(doneDoc)) { h.done.docs.push(doneDoc); h.history.push({ at: iso(Date.now()), event: `Document ready: ${doneDoc}` }); }
  if (doneStep != null && !h.done.steps.includes(doneStep)) { h.done.steps.push(doneStep); h.history.push({ at: iso(Date.now()), event: `Step done: ${doneStep}` }); }
  if (remindAt) { h.reminders.push(remindAt); h.history.push({ at: iso(Date.now()), event: `Reminder set for ${remindAt.slice(0, 10)}` }); }
  return holdView(h);
}
function holdView(h, asOf = Date.now()) {
  const p = HOLD_PLAYBOOK[h.reason];
  const days = Math.floor(((h.releasedAt ? new Date(h.releasedAt) : asOf) - new Date(h.placedAt)) / DAY);
  const it = h.intentId && intents.get(h.intentId);
  const shipped = it ? (it.fulfillment || []).some(e => e.type === 'shipped' && e.tracking) || !!it.shipment : null;
  const delivered = it ? !!it.delivery : null;
  return { ...h, reasonLabel: p.label, daysHeld: days, typicalDays: p.typicalDays, expectedRelease: p.typicalDays ? iso(new Date(h.placedAt).getTime() + p.typicalDays * DAY) : null,
    checklist: { docs: p.docs.map(d => ({ item: d, done: h.done.docs.includes(d) })), steps: p.steps.map(s => ({ item: s, done: h.done.steps.includes(s) })),
      shipment: it ? [{ item: 'Tracking number on record', done: !!shipped, source: 'computed' }, { item: 'Delivery confirmed', done: !!delivered, source: 'computed' }] : [] },
    nextStep: p.steps.find(s => !h.done.steps.includes(s)) || (p.docs.find(d => !h.done.docs.includes(d)) ? 'Prepare: ' + p.docs.find(d => !h.done.docs.includes(d)) : 'Wait for release'),
    dueReminders: h.reminders.filter(r => new Date(r) <= asOf) };
}
export function holds(asOf = Date.now()) {
  const list = [...fin.holds.values()].map(h => holdView(h, asOf)).sort((a, b) => (a.status === b.status ? b.amount - a.amount : a.status === 'held' ? -1 : 1));
  return { holds: list, held: round2(list.filter(h => h.status === 'held').reduce((s, h) => s + h.amount, 0)), count: list.filter(h => h.status === 'held').length,
    note: 'PayPal does not share hold reasons with this integration. Holds here are entered by you (from PayPal\'s notice) or are sample data; timelines are typical, not guaranteed.' };
}

// ================= 3. Subscription Guardian =================
export function addSubscription(s, source = 'user') {
  const r = { id: id('SUB'), merchant: s.merchant, plan: s.plan || 'Plan', amount: round2(s.amount), interval: ['monthly', 'yearly', 'weekly'].includes(s.interval) ? s.interval : 'monthly',
    charges: (s.charges || []).map(c => ({ at: c.at, amount: round2(c.amount) })), status: 'active', cancelUrl: s.cancelUrl || null, source };
  fin.subscriptions.set(r.id, r);
  return r;
}
const STEP = { weekly: 7, monthly: 30, yearly: 365 };
export function subscriptions(asOf = Date.now()) {
  const subs = [...fin.subscriptions.values()].map(s => {
    const charges = [...s.charges].sort((a, b) => a.at.localeCompare(b.at));
    const last = charges.at(-1);
    const next = last ? iso(new Date(last.at).getTime() + STEP[s.interval] * DAY) : null;
    const issues = [];
    for (let i = 1; i < charges.length; i++) {
      const gap = (new Date(charges[i].at) - new Date(charges[i - 1].at)) / DAY;
      if (gap < STEP[s.interval] * 0.25) issues.push({ kind: 'duplicate', msg: `Charged twice within ${Math.round(gap)} day(s): ${charges[i - 1].at.slice(0, 10)} and ${charges[i].at.slice(0, 10)}` });
      if (charges[i].amount !== charges[i - 1].amount) issues.push({ kind: 'amount_change', msg: `Amount changed from $${charges[i - 1].amount.toFixed(2)} to $${charges[i].amount.toFixed(2)} on ${charges[i].at.slice(0, 10)}` });
    }
    const monthly = s.interval === 'yearly' ? s.amount / 12 : s.interval === 'weekly' ? s.amount * 52 / 12 : s.amount;
    return { ...s, charges, nextCharge: next, dueInDays: next ? Math.ceil((new Date(next) - asOf) / DAY) : null, monthlyCost: round2(monthly), issues,
      cancel: s.cancelUrl ? `Cancel from the merchant (${s.cancelUrl}) or in PayPal: Settings → Payments → Manage automatic payments.` : 'Cancel in PayPal: Settings → Payments → Manage automatic payments, or contact the merchant.' };
  });
  // Detect recurring charges in real transactions: same merchant + same amount, 2+ times, roughly regular.
  const groups = {};
  for (const it of intents.values()) if (it.payment) (groups[`${it.merchant}|${it.amount}`] ||= []).push(it);
  const detected = Object.values(groups).filter(a => a.length >= 2).map(a => ({ merchant: a[0].merchant, amount: a[0].amount, count: a.length, dates: a.map(i => i.payment.at.slice(0, 10)), source: 'computed',
    note: a.length >= 2 ? 'Same merchant and amount charged more than once: a possible recurring charge or a duplicate purchase.' : '' }));
  return { subscriptions: subs, detected, monthlyTotal: round2(subs.filter(s => s.status === 'active').reduce((s, x) => s + x.monthlyCost, 0)),
    upcoming: subs.filter(s => s.dueInDays != null && s.dueInDays >= 0 && s.dueInDays <= 7), flagged: subs.filter(s => s.issues.length) };
}
export function cancelSubscription(sid) { const s = fin.subscriptions.get(sid); if (!s) throw err(404, 'unknown subscription'); s.status = 'cancel_requested'; return s; }

// ================= 6. Dispute Intelligence =================
export function addDispute(d, source = 'user') {
  const it = d.intentId && intents.get(d.intentId);
  if (!it) throw err(400, 'dispute must reference a PACT transaction');
  const reasons = ['not_received', 'not_as_described', 'unauthorized', 'refund_not_received'];
  const r = { id: id('DSP'), intentId: it.id, reason: reasons.includes(d.reason) ? d.reason : 'not_received', amount: round2(d.amount ?? it.amount), openedAt: d.openedAt || iso(Date.now()),
    respondBy: d.respondBy || iso((d.openedAt ? new Date(d.openedAt).getTime() : Date.now()) + 10 * DAY), status: 'open', source };
  fin.disputes.set(r.id, r);
  return r;
}
export function disputes(asOf = Date.now()) {
  return [...fin.disputes.values()].map(d => {
    const it = intents.get(d.intentId);
    const pkg = A.disputePackage(d.intentId, d.reason, asOf, { record: false });   // viewing must not write to the audit log
    const left = Math.ceil((new Date(d.respondBy) - asOf) / DAY);
    return { ...d, title: it?.title, merchant: it?.merchant, daysLeft: left, deadlineState: left < 0 ? 'missed' : left <= 3 ? 'due_soon' : 'ok',
      canContest: pkg.canContest, recommendation: pkg.recommendation, facts: pkg.facts, missing: pkg.missing, timeline: pkg.timeline.map(t => ({ at: t.at, type: t.type, source: t.source })),
      draft: draftResponse(d, it, pkg) };
  }).sort((a, b) => a.daysLeft - b.daysLeft);
}
function draftResponse(d, it, pkg) {
  const head = `Re: dispute ${d.id} for ${it.title} (${'$' + d.amount.toFixed(2)}), PayPal capture ${it.payment?.captureId || '—'}.`;
  if (!pkg.canContest) return `${head}\n\nWe have reviewed our records. We do not currently hold sufficient evidence to contest this claim (missing: ${pkg.missing.join(', ') || 'n/a'}). We propose to resolve it in the buyer's favour unless the missing evidence is obtained before ${d.respondBy.slice(0, 10)}.`;
  return `${head}\n\nThe records below were captured at the time of purchase and are attached:\n${pkg.facts.map(f => '- ' + f).join('\n')}\n\nWe request that the claim be reviewed in light of this evidence.`;
}

// ================= 5. Cashflow Forecast =================
export function cashflow(asOf = Date.now()) {
  const paid = [...intents.values()].filter(i => i.payment);
  const gross = round2(paid.reduce((s, i) => s + Number(i.payment.amount), 0));
  const fees = round2(paid.reduce((s, i) => s + (i.payment.fee || 0), 0));
  const rf = refunds(asOf);
  const hd = holds(asOf);
  const sb = subscriptions(asOf);
  const ds = [...fin.disputes.values()].filter(d => d.status === 'open');
  const pending = round2([...intents.values()].filter(i => i.orderId && !i.payment && i.status === 'approved').reduce((s, i) => s + i.amount, 0));
  const available = round2(gross - fees - rf.totals.refunded - hd.held);
  // average daily net inflow over the observed window (at least 7 days)
  const first = paid.length ? Math.min(...paid.map(i => new Date(i.payment.at).getTime())) : asOf;
  const span = Math.max(30, (asOf - first) / DAY);   // never extrapolate from less than a month
  const daily = round2((gross - fees) / span);
  const subsMonthly = sb.monthlyTotal;
  const proj = days => {
    const inflow = round2(daily * days);
    const release = round2(hd.holds.filter(h => h.status === 'held' && h.expectedRelease && new Date(h.expectedRelease) <= asOf + days * DAY).reduce((s, h) => s + h.amount, 0));
    const outflow = round2(rf.totals.outstanding + subsMonthly * days / 30);
    const disputeRisk = round2(ds.reduce((s, d) => s + d.amount, 0));
    return { days, expected: round2(available + inflow + release - outflow), best: round2(available + inflow * 1.2 + release - rf.totals.outstanding),
      worst: round2(available + inflow * 0.5 - outflow - disputeRisk), inflow, release, outflow, disputeRisk };
  };
  const p = [7, 30, 90].map(proj);
  const alerts = [];
  if (hd.held > 0) alerts.push(`$${hd.held.toFixed(2)} is held and not available yet.`);
  if (rf.totals.delayed) alerts.push(`${rf.totals.delayed} refund(s) are past their deadline.`);
  if (ds.length) alerts.push(`${ds.length} open dispute(s) put $${ds.reduce((s, d) => s + d.amount, 0).toFixed(2)} at risk.`);
  if (p.some(x => x.worst < 0)) alerts.push(`In the worst case the balance goes negative within ${p.find(x => x.worst < 0).days} days.`);
  return { asOf: iso(asOf), balances: { gross, fees, refunded: rf.totals.refunded, held: hd.held, pending, available }, dailyNetInflow: daily, observedDays: Math.round(span), projections: p, alerts,
    note: 'Computed from PACT\'s own records of PayPal sandbox payments, not from a PayPal balance API. Projections are estimates based on the daily average over the observed period (at least 30 days); best case +20% inflow, worst case −50% inflow, refunds paid, holds not released, open disputes lost.' };
}

// ================= Shared: one transaction → every module =================
export function linksFor(intentId) {
  return {
    refunds: refunds().refunds.filter(r => r.intentId === intentId),
    holds: holds().holds.filter(h => h.intentId === intentId),
    failures: failures().failures.filter(f => f.intentId === intentId),
    disputes: [...fin.disputes.values()].filter(d => d.intentId === intentId),
  };
}

// ================= Sample seller data (clearly labelled) =================
export function loadSample() {
  for (const m of Object.values(fin)) for (const [k, v] of m) if (v.source === 'sample') m.delete(k);
  const paid = [...intents.values()].filter(i => i.payment);
  const t = Date.now();
  if (paid[0]) addHold({ amount: paid[0].amount, reason: 'new_seller', intentId: paid[0].id, merchant: paid[0].merchant, placedAt: iso(t - 4 * DAY) }, 'sample');
  addHold({ amount: 500, reason: 'unusual_activity', merchant: 'OfficeWorks', placedAt: iso(t - 12 * DAY), note: 'Sample: 6 orders in one hour' }, 'sample');
  addSubscription({ merchant: 'CloudStorage Pro', plan: '2 TB', amount: 9.99, interval: 'monthly', charges: [{ at: iso(t - 58 * DAY), amount: 9.99 }, { at: iso(t - 28 * DAY), amount: 9.99 }, { at: iso(t - 27 * DAY), amount: 9.99 }] }, 'sample');
  addSubscription({ merchant: 'StreamBox', plan: 'Premium', amount: 15.99, interval: 'monthly', charges: [{ at: iso(t - 55 * DAY), amount: 12.99 }, { at: iso(t - 25 * DAY), amount: 15.99 }] }, 'sample');
  addSubscription({ merchant: 'DesignKit', plan: 'Team', amount: 120, interval: 'yearly', charges: [{ at: iso(t - 360 * DAY), amount: 120 }] }, 'sample');
  for (const [code, stage, ago] of [['INSTRUMENT_DECLINED', 'capture', 3], ['NETWORK', 'create order', 2], ['COMPLIANCE_VIOLATION', 'buyer approval', 1]])
    // Standalone sample failures (not linked to a paid PACT transaction, which would count them as already recovered)
    recordFailure({ intentId: null, merchant: ['SoundHub', 'KeyLab', 'RunFast'][ago - 1], amount: [129.95, 89, 74.99][ago - 1], stage, message: `${code} (sample)`, source: 'sample', at: iso(t - ago * DAY) });
  if (paid[2]) addDispute({ intentId: paid[2].id, reason: 'not_received', openedAt: iso(t - 2 * DAY) }, 'sample');
  if (paid[3]) addDispute({ intentId: paid[3].id, reason: 'unauthorized', openedAt: iso(t - 8 * DAY) }, 'sample');
  return { holds: fin.holds.size, subscriptions: fin.subscriptions.size, failures: fin.failures.size, disputes: fin.disputes.size };
}
export function clearSample() { for (const m of Object.values(fin)) for (const [k, v] of m) if (v.source === 'sample') m.delete(k); }
