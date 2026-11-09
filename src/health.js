// PACT Financial Health & Recovery Engine.
// Answers six questions from the shared financial engine (finance.js). Every line carries a
// label (live / calculated / estimated / simulated / user) and links to the records it comes
// from. Rules only: nothing is invented, nothing moves money.
import { intents } from './trust.js';
import * as A from './assurance.js';
import { holds, refunds, subscriptions, failures, disputes, cashflow } from './finance.js';

const money = v => '$' + Number(v).toFixed(2);
const srcOf = it => (it.payment?.simulated || it.orderId?.startsWith('SIM-') ? 'paypal-simulator' : 'paypal-sandbox');

export const LABEL = { 'paypal-sandbox': 'live', 'paypal-simulator': 'simulated', sample: 'simulated', computed: 'calculated', estimate: 'estimated', user: 'user' };
const lab = s => LABEL[s] || (/sandbox|webhook \(verified\)/i.test(s || '') ? 'live' : /simulat|sample/i.test(s || '') ? 'simulated' : 'calculated');
const txLink = it => (it ? { kind: 'transaction', id: it.id, label: `${it.title} · $${it.amount.toFixed(2)}`,
  ref: it.payment?.captureId ? `capture ${it.payment.captureId}` : it.orderId ? `order ${it.orderId}` : it.id, label2: lab(it.payment ? srcOf(it) : 'computed') } : null);
const line = (text, label, links = [], extra = {}) => ({ text, label, links: links.filter(Boolean), ...extra });

export const QUESTIONS = {
  unavailable: 'Why is my money unavailable?',
  refunds: 'Which refunds need attention?',
  cashflow: 'Which payments are likely to cause cashflow problems?',
  subscriptions: 'Which subscriptions have unusual billing patterns?',
  recoverable: 'Which failed payments can safely be recovered?',
  next: 'What should I do next, and what evidence supports it?',
};

export function health(asOf = Date.now()) {
  const H = holds(asOf), R = refunds(asOf), S = subscriptions(asOf), F = failures(), D = disputes(asOf), C = cashflow(asOf);
  const out = {};

  // 1. Why is my money unavailable?
  const held = H.holds.filter(h => h.status === 'held');
  const pendingOrders = [...intents.values()].filter(i => i.orderId && !i.payment && i.status === 'approved');
  const pendingAmt = pendingOrders.reduce((s, i) => s + i.amount, 0);
  const u = [];
  for (const h of held) u.push(line(`${money(h.amount)} on hold for ${h.daysHeld} days: ${h.reasonLabel}. Next step: ${h.nextStep}.${h.expectedRelease ? ` Typical release around ${h.expectedRelease.slice(0, 10)} (estimate).` : ''}`,
    lab(h.source), [h.intentId ? txLink(intents.get(h.intentId)) : null, { kind: 'hold', id: h.id, label: `hold ${h.id}`, label2: lab(h.source) }], { amount: h.amount, severity: 'high', module: 'money' }));
  if (pendingOrders.length) u.push(line(`${money(pendingAmt)} sits in ${pendingOrders.length} PayPal order(s) approved in PACT but never captured, so no money was received for them.`,
    'live', pendingOrders.slice(0, 5).map(txLink), { amount: pendingAmt, severity: 'medium', module: 'transactions' }));
  if (R.totals.outstanding > 0) u.push(line(`${money(R.totals.outstanding)} is owed back to buyers as refunds and is not yours to spend.`,
    'calculated', R.refunds.filter(r => r.outstanding > 0).map(r => txLink(intents.get(r.intentId))), { amount: R.totals.outstanding, severity: 'medium', module: 'refunds' }));
  if (C.balances.fees > 0) u.push(line(`${money(C.balances.fees)} went to PayPal fees, as reported in the capture responses.`, 'live', [], { amount: C.balances.fees, severity: 'low', module: 'cashflow' }));
  out.unavailable = { answer: held.length || pendingOrders.length
    ? `${money(C.balances.held)} is on hold and ${money(pendingAmt)} was approved but never captured. Available now: ${money(C.balances.available)}.`
    : `Nothing is held. Available now: ${money(C.balances.available)} after fees and refunds.`, lines: u };

  // 2. Which refunds need attention?
  const rf = R.refunds.filter(r => ['delayed', 'pending', 'partial'].includes(r.state) || r.overRefund)
    .sort((a, b) => (b.state === 'delayed') - (a.state === 'delayed') || b.outstanding - a.outstanding);
  out.refunds = { answer: rf.length ? `${rf.length} refund(s) need attention${rf.some(r => r.state === 'delayed') ? `, ${rf.filter(r => r.state === 'delayed').length} past the deadline` : ''}.` : 'No refunds need attention.',
    lines: rf.map(r => line(
      r.overRefund ? `${r.title}: refunded ${money(r.refunded)}, more than the ${money(r.capture)} captured. Check for a duplicate refund.`
        : r.state === 'delayed' ? `${r.title}: ${money(r.outstanding)} still owed, ${r.daysOverdue} day(s) past the ${r.deadline.slice(0, 10)} deadline. ${r.escalation[0]}.`
        : `${r.title}: ${money(r.outstanding)} owed, due by ${r.deadline ? r.deadline.slice(0, 10) : '—'}. Typical refund time ${r.estimate} (estimate).`,
      r.state === 'delayed' || r.overRefund ? 'calculated' : 'estimated', [txLink(intents.get(r.intentId))],
      { amount: r.outstanding, severity: r.state === 'delayed' || r.overRefund ? 'high' : 'medium', module: 'refunds' })) };

  // 3. Which payments are likely to cause cashflow problems?
  const risk = new Map();
  const addRisk = (it, amt, why, label) => {
    if (!it) return;
    const r = risk.get(it.id) || { it, amount: 0, why: [], labels: new Set() };
    r.amount += amt; r.why.push(why); r.labels.add(label); risk.set(it.id, r);
  };
  for (const d of D.filter(x => x.status === 'open')) addRisk(intents.get(d.intentId), d.amount,
    `open ${d.reason.replace(/_/g, ' ')} dispute, ${d.daysLeft >= 0 ? `respond within ${d.daysLeft} day(s)` : 'deadline missed'}${d.canContest ? '' : ', evidence not enough to contest'}`, lab(d.source));
  for (const h of held.filter(x => x.intentId)) addRisk(intents.get(h.intentId), h.amount, `${money(h.amount)} on hold`, lab(h.source));
  for (const r of R.refunds.filter(x => x.outstanding > 0)) addRisk(intents.get(r.intentId), r.outstanding, `${money(r.outstanding)} refund owed`, 'calculated');
  for (const it of intents.values()) if (it.payment) {
    const m = A.reconcile(it).mismatches;
    if (m.length) addRisk(it, 0, `records disagree: ${m[0]}`, lab(srcOf(it)));
  }
  const ranked = [...risk.values()].sort((a, b) => b.amount - a.amount);
  out.cashflow = {
    answer: ranked.length ? `${ranked.length} payment(s) put ${money(ranked.reduce((s, r) => s + r.amount, 0))} at risk.` : 'No payment currently threatens your cashflow.',
    lines: ranked.map(r => line(`${r.it.title} (${money(r.it.amount)}): ${r.why.join('; ')}.`, r.labels.has('simulated') ? 'simulated' : [...r.labels][0],
      [txLink(r.it)], { amount: r.amount, severity: r.amount >= 100 ? 'high' : 'medium', module: 'cashflow' })),
    estimate: line(`30-day outlook: worst ${money(C.projections[1].worst)}, expected ${money(C.projections[1].expected)}, best ${money(C.projections[1].best)}, projected from a ${C.observedDays}-day average.`, 'estimated'),
  };

  // 4. Which subscriptions have unusual billing patterns?
  const subLines = S.flagged.map(s => line(`${s.merchant} (${s.plan}): ${s.issues.map(i => i.msg).join('; ')}.`, lab(s.source),
    [{ kind: 'subscription', id: s.id, label: `${s.merchant} subscription`, label2: lab(s.source) }],
    { amount: s.amount, severity: s.issues.some(i => i.kind === 'duplicate') ? 'high' : 'medium', module: 'subscriptions' }));
  for (const d of S.detected) subLines.push(line(`${d.merchant}: ${money(d.amount)} charged ${d.count} times (${d.dates.join(', ')}). ${d.note}`, 'calculated',
    [...intents.values()].filter(i => i.payment && i.merchant === d.merchant && i.amount === d.amount).map(txLink),
    { amount: d.amount * (d.count - 1), severity: 'medium', module: 'subscriptions' }));
  out.subscriptions = { answer: subLines.length ? `${subLines.length} unusual billing pattern(s) found.` : 'No unusual billing patterns.', lines: subLines };

  // 5. Which failed payments can safely be recovered?
  const open = F.failures.filter(f => !f.recovered);
  const safe = open.filter(f => ['safe', 'buyer', 'after-approval'].includes(f.retry));
  const unsafe = open.filter(f => ['never', 'no'].includes(f.retry));
  const fLinks = f => [f.intentId ? txLink(intents.get(f.intentId)) : null, { kind: 'failure', id: f.id, label: f.id, label2: lab(f.source) }];
  out.recoverable = {
    answer: open.length ? `${safe.length} of ${open.length} unrecovered failure(s) can be recovered safely; ${unsafe.length} must not be retried.` : 'No unrecovered failed payments.',
    lines: [
      ...safe.map(f => line(`Recoverable: ${f.category} (${f.code}) at "${f.stage}". ${f.action}`, lab(f.source), fLinks(f), { severity: 'medium', recoverable: true, module: 'failures' })),
      ...unsafe.map(f => line(`Do not retry: ${f.category} (${f.code}). ${f.action}`, lab(f.source), fLinks(f), { severity: 'low', recoverable: false, module: 'failures' })),
    ],
  };

  // 6. What should I do next? Ranked actions, each with its evidence and links.
  const SEV = { high: 3, medium: 2, low: 1 };
  const actions = [
    ...D.filter(d => d.status === 'open').map(d => ({
      action: d.canContest ? `Send the dispute response for ${d.title} (draft ready)` : `Resolve the ${d.reason.replace(/_/g, ' ')} dispute on ${d.title}, or obtain: ${d.missing.join(', ')}`,
      due: d.respondBy, severity: d.daysLeft <= 3 ? 'high' : 'medium', label: lab(d.source), evidence: `${d.facts.length} recorded fact(s) · dispute ${d.id}`,
      links: [txLink(intents.get(d.intentId))], module: 'disputes' })),
    ...rf.filter(r => r.state === 'delayed').map(r => ({ action: `Chase the ${money(r.outstanding)} refund for ${r.title}`, due: r.deadline, severity: 'high', label: 'calculated',
      evidence: `refund due ${r.deadline.slice(0, 10)}; no PayPal refund event received`, links: [txLink(intents.get(r.intentId))], module: 'refunds' })),
    ...held.map(h => ({ action: `${h.nextStep}, to release the ${money(h.amount)} hold`, due: h.expectedRelease, severity: 'medium', label: lab(h.source),
      evidence: `${h.reasonLabel}; held ${h.daysHeld} days`, links: [h.intentId ? txLink(intents.get(h.intentId)) : null], module: 'money' })),
    ...S.flagged.map(s => ({ action: `Check ${s.merchant}: ${s.issues[0].msg}`, due: s.nextCharge, severity: s.issues.some(i => i.kind === 'duplicate') ? 'high' : 'medium',
      label: lab(s.source), evidence: `${s.charges.length} charges on record`, links: [], module: 'subscriptions' })),
    ...safe.map(f => ({ action: `Recover the ${f.category.toLowerCase()} failure: ${f.action}`, due: null, severity: 'medium', label: lab(f.source),
      evidence: `${f.code} at ${f.stage}, ${f.at.slice(0, 10)}`, links: [f.intentId ? txLink(intents.get(f.intentId)) : null], module: 'failures' })),
  ].map(a => ({ ...a, links: a.links.filter(Boolean) }))
    .sort((a, b) => SEV[b.severity] - SEV[a.severity] || String(a.due || '9').localeCompare(String(b.due || '9')));
  out.next = { answer: actions.length ? `${actions.length} action(s), ${actions.filter(a => a.severity === 'high').length} urgent. Start with: ${actions[0].action}.` : 'Nothing needs action right now.', actions };

  return {
    asOf: new Date(asOf).toISOString(), questions: QUESTIONS, answers: out,
    labels: { live: 'from PayPal sandbox records', calculated: 'computed by PACT from records', estimated: 'a projection or typical timing', simulated: 'sample or simulator data', user: 'entered by you' },
    note: 'Rule-based answers from PACT\'s records. Every line names its label and links to the records it comes from. Nothing here moves money.',
  };
}

// Free-text question → the closest of the six questions (keywords only).
export function routeQuestion(q = '') {
  const s = String(q).toLowerCase();
  if (/hold|unavailable|available|locked|frozen|where.*money|balance/.test(s)) return 'unavailable';
  if (/refund/.test(s)) return 'refunds';
  if (/cash ?flow|risk|forecast|run out/.test(s)) return 'cashflow';
  if (/subscri|recurring|renew|billing|charged twice/.test(s)) return 'subscriptions';
  if (/fail|declin|retry|recover/.test(s)) return 'recoverable';
  return 'next';
}
