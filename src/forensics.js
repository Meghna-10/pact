// PACT TrustGraph — the Transaction Truth Engine.
//  truth(it)            each party's version of the same purchase, side by side, and where they contradict
//  forensics(it)        an investigation report: expected vs actual, chronology, confirmed facts vs
//                       hypotheses (always labelled), evidence, missing evidence, next steps
//  simulate(id, key)    Transaction Digital Twin: 10 scenarios replayed on a COPY, step by step
//  accountability()     per-agent measured behaviour with the formula shown
//  settingsStatus()     configuration health without exposing any secret
import { agents, intents, ledger, verifyLedger, preflight, product } from './trust.js';
import * as A from './assurance.js';
import { graph, investigate, getIntent } from './intel.js';
import { incidents, ROUTING } from './incidents.js';
import { round2 } from './policy.js';
import { negotiate } from './agents.js';
import * as DB from './db.js';
import { stats as eventStats } from './events.js';
import * as paypal from './paypal.js';
import { llmEnabled } from './llm.js';

const DAY = 864e5, MIN = 60e3;
const usd = v => (v == null ? '—' : '$' + Number(v).toFixed(2));
const d10 = s => (s ? new Date(s).toISOString().slice(0, 10) : '—');
const err = (s, m) => Object.assign(new Error(m), { status: s });

// ---------------- 1. Truth: every party's version ----------------
export function truth(it, opts = {}) {
  const g = opts.graph || graph(it, opts);
  const agent = agents.get(it.agentId);
  const capEvents = (it.paypalEvents || []).filter(e => e.event_type === 'PAYMENT.CAPTURE.COMPLETED');
  const caps = new Map();
  if (it.payment) caps.set(it.payment.captureId, { id: it.payment.captureId, amount: Number(it.payment.amount), source: it.payment.simulated ? 'PayPal (simulator)' : 'PayPal sandbox', from: 'capture API response' });
  for (const e of capEvents) {
    if (e.captureId && !caps.has(e.captureId)) caps.set(e.captureId, { id: e.captureId, amount: e.amount, source: e.source, from: 'PayPal event' });
  }
  const paypalSays = capEvents.find(e => e.amount != null && it.payment && e.amount !== Number(it.payment.amount) && (!e.captureId || e.captureId === it.payment.captureId));
  const parties = [
    { party: 'Buyer', says: it.approval ? it.amount : null, record: it.approval ? `approval ${it.approval.hash.slice(0, 10)}…` : 'no approval', source: 'consent record', node: 'approval' },
    { party: agent?.human ? 'Checkout' : 'AI agent', says: it.proposal?.amount != null ? round2(it.proposal.amount) : null, record: `${it.agentId} · ${it.id}`, source: agent?.human ? 'buyer checkout' : 'agent proposal', node: 'agent' },
    { party: 'Merchant', says: it.commitment?.price ?? null, record: it.commitment ? `${it.commitment.merchant} order` : 'no order', source: it.commitment?.source || '—', node: 'merchant' },
    { party: 'PayPal', says: paypalSays ? paypalSays.amount : it.payment ? Number(it.payment.amount) : null, record: it.payment ? `capture ${it.payment.captureId}` : (it.orderId ? `order ${it.orderId} (not captured)` : 'no record'),
      source: paypalSays ? paypalSays.source : it.payment ? (it.payment.simulated ? 'PayPal (simulator)' : 'PayPal sandbox') : '—', node: 'capture' },
  ];
  if (it.agentReport) parties.push({ party: 'Agent report', says: it.agentReport.amount, record: `agent says "${it.agentReport.status}"`, source: 'agent claim (unverified)', node: 'agent' });
  const expected = it.approval ? it.amount : null;
  const contradictions = parties.filter(p => expected != null && p.says != null && round2(p.says) !== expected)
    .map(p => ({ party: p.party, expected, actual: round2(p.says), difference: round2(p.says - expected), record: p.record, source: p.source, node: p.node }));
  if (caps.size > 1) contradictions.push({ party: 'PayPal', kind: 'duplicate capture', expected: 1, actual: caps.size, record: [...caps.keys()].join(', '), source: 'PayPal', node: 'capture' });
  const currencies = [...new Set((it.paypalEvents || []).map(e => e.currency).filter(Boolean))];
  if (currencies.some(c => c !== 'USD')) contradictions.push({ party: 'PayPal', kind: 'currency', expected: 'USD', actual: currencies.join(', '), record: 'PayPal event', source: 'PayPal', node: 'capture' });
  for (const i of g.commitment.issues.filter(x => x.kind !== 'price')) contradictions.push({ party: 'Merchant', kind: 'promise', expected: 'as promised', actual: i.msg, record: 'merchant events', source: 'merchant', node: i.kind === 'refund_missing' ? 'refund' : 'delivery' });

  const n = g.nodes.filter(x => x.id !== 'verdict');
  const summary = { connectedRecords: n.filter(x => x.status !== 'missing').length + capEvents.length, verifiedRelationships: g.edges.filter(e => e.status === 'ok').length,
    conflictingRecords: n.filter(x => x.status === 'conflict').length, missingRecords: n.filter(x => x.status === 'missing').length, totalRelationships: g.edges.length, status: g.status };
  return { intentId: it.id, title: it.title, expected, parties, captures: [...caps.values()], contradictions, summary,
    headline: contradictions.find(c => typeof c.difference === 'number') || null };
}

// ---------------- 2. Forensics report ----------------
const HYPOTHESES = {
  amount: ['The order may have been edited after approval (item removed or coupon applied).', 'A second charge or a shipping fee may have been added outside the approved order.', 'The PayPal event may refer to a partial capture.'],
  duplicate: ['The capture request may have been retried without an idempotency key.', 'Two checkouts may have been completed for the same order.'],
  currency: ['The merchant may have charged in a different currency than the buyer approved.'],
  delivery: ['The merchant may have shipped late or the carrier may be delayed.', 'The fulfilment event may not have been sent to PACT yet.'],
  refund: ['The merchant may have issued the refund outside PayPal.', 'The refund may still be processing.'],
};
export async function forensics(it, opts = {}) {
  const inv = await investigate(it, opts);
  const g = inv.graph;
  const t = truth(it, { graph: g, ...opts });
  const chronology = ledger.filter(e => e.ref === it.id).map(e => ({ seq: e.seq, at: e.at, event: e.type.replace(/_/g, ' '), source: e.data?.source || e.actor, hash: e.hash.slice(0, 12) }));
  const kinds = new Set(t.contradictions.map(c => c.kind || 'amount'));
  const hypotheses = [];
  if (kinds.has('amount') && t.headline) HYPOTHESES.amount.forEach(h => hypotheses.push(h));
  if (kinds.has('duplicate capture')) HYPOTHESES.duplicate.forEach(h => hypotheses.push(h));
  if (kinds.has('currency')) HYPOTHESES.currency.forEach(h => hypotheses.push(h));
  if (g.commitment.issues.some(i => /deliver|ship/.test(i.kind))) HYPOTHESES.delivery.forEach(h => hypotheses.push(h));
  if (g.commitment.issues.some(i => i.kind === 'refund_missing')) HYPOTHESES.refund.forEach(h => hypotheses.push(h));
  const h = t.headline;
  const expectedLine = `Buyer approved ${usd(t.expected)} for ${it.title} from ${it.merchant}; the merchant promised delivery by ${d10(it.commitment?.deliveryBy)}.`;
  const actualLine = h ? `${h.party} records ${usd(h.actual)}: a difference of ${h.difference > 0 ? '+' : ''}${usd(h.difference).replace('$-', '-$')} against the approval.`
    : t.contradictions.length ? t.contradictions.map(c => `${c.party}: ${c.kind || 'amount'} — ${c.actual}`).join(' ') : 'All records available so far agree with the approval.';
  const report = {
    whatHappened: inv.sections.whatHappened,
    expected: expectedLine,
    actual: actualLine,
    disagreements: inv.sections.disagreements,
    evidence: g.nodes.filter(n => n.evidence.length).map(n => ({ node: n.id, label: n.label, status: n.status, ledger: n.evidence.map(e => e.seq), source: n.source })),
    missingEvidence: inv.sections.missingEvidence,
    nextSteps: inv.sections.nextSteps,
    hypotheses: hypotheses.map(text => ({ text, label: 'Hypothesis: not verified' })),
  };
  return { intentId: it.id, title: it.title, status: g.status, summary: inv.summary, summarySource: inv.summarySource, truth: t, chronology, report,
    confidence: t.contradictions.length ? `${t.parties.filter(p => p.says != null).length} independent records compared` : 'no contradictions found',
    guardrail: 'Confirmed facts come from recorded events. Hypotheses are possible explanations only and are never presented as findings. PACT does not determine fraud.',
    graph: g };
}

export function reportMarkdown(f) {
  const L = [];
  L.push(`# PACT investigation report: ${f.title}`, '', `Transaction ${f.intentId} · status **${f.status.toUpperCase()}** · generated ${new Date().toISOString()}`, '', `> ${f.summary}`, '');
  L.push('## What was expected', f.report.expected, '', '## What actually happened', f.report.actual, '');
  L.push('## Each party\'s version', '| Party | Amount | Record | Source |', '|---|---|---|---|', ...f.truth.parties.map(p => `| ${p.party} | ${usd(p.says)} | ${p.record} | ${p.source} |`), '');
  const sec = (t, a) => { L.push(`## ${t}`); if (!a.length) L.push('None.'); a.forEach(s => L.push(`- ${s.text}${s.evidence?.length ? ` _(evidence: ${s.evidence.map(e => `${e.label}${e.ledger.length ? ' #' + e.ledger.join(',') : ''}`).join('; ')})_` : ''}`)); L.push(''); };
  sec('What happened', f.report.whatHappened); sec('Records that disagree', f.report.disagreements); sec('Missing evidence', f.report.missingEvidence); sec('Recommended next steps', f.report.nextSteps);
  L.push('## Possible explanations (hypotheses, not verified)'); if (!f.report.hypotheses.length) L.push('None.'); f.report.hypotheses.forEach(h => L.push(`- ${h.text}`)); L.push('');
  L.push('## Chronology (audit ledger)', '| # | Time | Event | Source | Hash |', '|---|---|---|---|---|', ...f.chronology.map(c => `| ${c.seq} | ${c.at} | ${c.event} | ${c.source} | ${c.hash} |`), '');
  L.push('---', f.guardrail, 'This report is a draft for review. PACT has not refunded, cancelled or disputed anything.');
  return L.join('\n');
}

// ---------------- 3. Transaction Digital Twin: 10 scenarios ----------------
export const SCENARIOS = {
  successful:          { label: 'Successful purchase', incident: null, desc: 'The recorded purchase replayed as it happened. Every record agrees.' },
  price_changed:       { label: 'Merchant price changes after approval', incident: 'amount_mismatch', desc: 'PayPal records a capture $10 higher than the buyer approved.' },
  duplicate_capture:   { label: 'Duplicate PayPal capture', incident: 'duplicate_capture', desc: 'PayPal reports a second capture with a different ID for the same order.' },
  missing_payment:     { label: 'Missing payment event', incident: 'amount_mismatch', desc: 'The agent reports "paid" but PayPal never confirms a capture.' },
  late_delivery:       { label: 'Late delivery', incident: 'delivery_delayed', desc: 'The merchant moves the delivery 5 days past its promise.' },
  refund_overdue:      { label: 'Refund overdue', incident: 'refund_missing', desc: 'The order is cancelled; 9 days later no refund has arrived.' },
  currency_changed:    { label: 'Merchant changes currency', incident: 'amount_mismatch', desc: 'A PayPal event arrives in EUR for a USD order.' },
  agent_over_limit:    { label: 'AI agent exceeds spending limit', incident: null, desc: 'The agent tries to buy 3 units, above its passport limit. The firewall checks it before payment.' },
  order_differs:       { label: 'Merchant order differs from PayPal capture', incident: 'amount_mismatch', desc: 'The merchant\'s order total changes to $5 more than PayPal captured.' },
  missing_fulfilment:  { label: 'Missing fulfilment confirmation', incident: 'not_delivered', desc: 'The promised date passes with no shipment or delivery event.' },
};
const NEXT = { amount_mismatch: 'Compare the merchant order, the buyer approval and the PayPal gross capture; ask the merchant for the order reference.',
  duplicate_capture: 'Confirm how many orders were fulfilled; the merchant refunds the extra capture through PayPal.',
  delivery_delayed: 'Ask the merchant to confirm the new date and inform the buyer before a claim is opened.',
  refund_missing: 'Ask the merchant for the refund reference; escalate through the authorized PayPal channel if none.',
  not_delivered: 'Request carrier and tracking; without proof of delivery, resolve in the buyer\'s favour.' };

export function simulate(id, key) {
  const sc = SCENARIOS[key]; if (!sc) throw err(400, `unknown scenario ${key}`);
  const real = getIntent(id);
  if (!real.payment) throw err(409, 'pick a transaction with a captured payment');
  const it = structuredClone(real);          // the real record is never touched
  const t0 = new Date(real.createdAt).getTime();
  let clock = t0;
  const steps = [];
  const view = () => { const g = graph(it, { asOf: clock }); return { g, issues: [...new Set([...g.reasons, ...g.commitment.issues.map(i => i.msg)])] }; };
  const step = (label, opts = {}) => {
    const before = steps.length ? steps[steps.length - 1] : null;
    if (opts.apply) opts.apply();
    const { g, issues } = view();
    const added = before ? issues.filter(r => !before.issues.includes(r)) : [];
    steps.push({ at: new Date(clock).toISOString(), label, simulated: !!opts.simulated, status: g.status, issues, newIssues: added,
      changed: !!before && (before.status !== g.status || added.length > 0), firewall: opts.firewall || null });
  };
  // the recorded history, compressed to the same chronology
  const realMoney = Number(real.payment.amount);
  if (key === 'missing_payment') { it.payment = null; it.paypalEvents = []; it.fulfillment = []; delete it.delivery; delete it.shipment; }
  if (key !== 'successful') { it.fulfillment = (it.fulfillment || []).filter(e => e.type !== 'delivered' && e.type !== 'cancelled' && e.type !== 'refund_promised'); delete it.delivery; }
  if (key !== 'successful' && key !== 'missing_payment') it.paypalEvents = (it.paypalEvents || []).filter(e => !(e.event_type === 'PAYMENT.CAPTURE.COMPLETED' && (e.amount !== realMoney || (e.captureId && e.captureId !== real.payment.captureId))));
  it.agentReport = key === 'missing_payment' ? null : it.agentReport;

  step(`Buyer approved ${usd(real.amount)} for ${real.title}`);
  clock += MIN; step(`Merchant ${real.merchant} confirmed the order at ${usd(real.commitment?.price)}, delivery by ${d10(real.commitment?.deliveryBy)}`);
  if (key !== 'missing_payment') { clock += MIN; step(`PayPal captured ${usd(realMoney)} (${real.payment.captureId})`); }

  const sim = { simulated: true };
  clock += MIN;
  if (key === 'successful') {
    if ((real.fulfillment || []).some(e => e.type === 'delivered')) step('Merchant confirmed delivery (as recorded)');
    else step('Waiting for the merchant\'s delivery (as recorded)');
  }
  if (key === 'price_changed') step(`SIMULATED · PayPal capture event reports ${usd(realMoney + 10)}`, { ...sim, apply: () => it.paypalEvents.push({ event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: round2(realMoney + 10), captureId: real.payment.captureId, source: 'simulated', at: new Date(clock).toISOString() }) });
  if (key === 'duplicate_capture') step('SIMULATED · PayPal reports a second capture SIM-CAP-2 for the same order', { ...sim, apply: () => it.paypalEvents.push({ event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: realMoney, captureId: 'SIM-CAP-2', source: 'simulated', at: new Date(clock).toISOString() }) });
  if (key === 'missing_payment') step(`SIMULATED · Agent reports "paid ${usd(real.amount)}", but no PayPal capture exists`, { ...sim, apply: () => { it.agentReport = { amount: real.amount, status: 'paid' }; } });
  if (key === 'late_delivery') step(`SIMULATED · Merchant moves delivery to ${d10(new Date(real.commitment.deliveryBy).getTime() + 5 * DAY)}`, { ...sim, apply: () => it.fulfillment.push({ type: 'delivery_date_changed', estimatedDelivery: new Date(new Date(real.commitment.deliveryBy).getTime() + 5 * DAY).toISOString(), source: 'simulated', at: new Date(clock).toISOString() }) });
  if (key === 'refund_overdue') {
    step('SIMULATED · Merchant cancels the order; refund due within 7 days', { ...sim, apply: () => it.fulfillment.push({ type: 'cancelled', source: 'simulated', at: new Date(clock).toISOString() }) });
    clock += 9 * DAY; step('SIMULATED · Day 9: no PayPal refund event has arrived', sim);
  }
  if (key === 'currency_changed') step(`SIMULATED · PayPal capture event arrives as ${usd(realMoney).replace('$', '€')} (EUR)`, { ...sim, apply: () => it.paypalEvents.push({ event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: realMoney, currency: 'EUR', captureId: real.payment.captureId, source: 'simulated', at: new Date(clock).toISOString() }) });
  if (key === 'order_differs') step(`SIMULATED · Merchant order total changes to ${usd(real.commitment.price + 5)}`, { ...sim, apply: () => { it.commitment.price = round2(real.commitment.price + 5); } });
  if (key === 'missing_fulfilment') { clock = new Date(real.commitment.deliveryBy).getTime() + DAY; step(`SIMULATED · ${d10(clock)}: promised date passed with no shipment or delivery event`, sim); }
  if (key === 'agent_over_limit') {
    const a = agents.get(real.agentId), p = product(real.proposal.productId);
    const unit = negotiate(p, 1).finalPrice, qty = Math.max(2, Math.floor((a?.permissions.maxPerTxn || 0) / unit) + 1), amount = negotiate(p, qty).finalPrice;
    const pf = a ? preflight(a.credential, { productId: p.id, quantity: qty, amount, currency: 'USD', merchant: p.merchant, category: p.category }, { record: false }) : null;
    steps.push({ at: new Date(clock).toISOString(), label: `SIMULATED · Agent proposes ${qty} units for ${usd(amount)} (limit ${usd(a?.permissions.maxPerTxn)})`, simulated: true,
      status: pf?.decision === 'block' ? 'blocked' : steps.at(-1).status, issues: pf?.failed || [], newIssues: pf?.failed || [], changed: pf?.decision === 'block',
      firewall: pf ? { decision: pf.decision, failed: pf.failed, credentialValid: pf.checks.find(c => c.name === 'credential')?.pass } : { decision: 'no agent' } });
  }
  const BAD = ['mismatch', 'missing', 'blocked', 'unverified'];
  const trigger = steps.find(s => s.changed && BAD.includes(s.status)) || steps.find(s => s.changed) || null;
  const last = steps[steps.length - 1];
  const g = key === 'agent_over_limit' ? graph(it, { asOf: clock }) : view().g;
  const kind = sc.incident;
  return {
    intentId: id, title: real.title, scenario: key, label: sc.label, description: sc.desc, steps,
    detection: trigger ? {
      anomaly: key === 'agent_over_limit' ? 'Purchase blocked before payment' : `${last.status.toUpperCase()}: ${trigger.newIssues[0] || last.issues[0] || ''}`,
      why: trigger.newIssues.length ? trigger.newIssues : last.issues,
      trigger: trigger.label,
      evidence: g.nodes.filter(n => ['conflict', 'missing'].includes(n.status)).map(n => ({ node: n.id, label: n.label, status: n.status, detail: n.detail })),
      incident: kind ? { kind, severity: ROUTING[kind].severity, notifies: ['buyer', ROUTING[kind].merchant !== 'no' && 'merchant', ROUTING[kind].paypal === 'yes' && 'PayPal (authorized channel)'].filter(Boolean),
        note: 'An incident of this kind would open in the Incident Center. In the simulator it is shown only, not created.' } : null,
      next: kind ? NEXT[kind] : key === 'agent_over_limit' ? 'No payment was attempted. Review the agent\'s passport limits if the request was legitimate.' : '',
    } : null,
    finalStatus: last.status, graph: g,
    note: 'Simulated on a copy of the transaction. Nothing is saved, nothing is sent to PayPal and no incident is created.',
  };
}

// ---------------- 4. Agent accountability ----------------
export function accountability() {
  return [...agents.values()].filter(a => !a.human).map(a => {
    const its = [...intents.values()].filter(i => i.agentId === a.id);
    const m = {
      proposals: its.length,
      blocked: its.filter(i => i.status === 'blocked').length,
      priceDeviations: its.filter(i => i.preflight.failed.some(f => f.startsWith('price_integrity'))).length,
      duplicateAttempts: a.history.filter((h, k, arr) => h.outcome !== 'captured' && arr.some((x, j) => j < k && x.productId === h.productId && x.outcome === 'captured')).length,
      policyViolations: its.reduce((s, i) => s + i.preflight.failed.length, 0),
      paid: its.filter(i => i.payment).length,
      fulfilled: its.filter(i => (i.fulfillment || []).some(e => e.type === 'delivered')).length,
      reconciled: its.filter(i => i.payment && A.reconcile(i).reconciled).length,
    };
    const n = m.proposals;
    const score = n ? Math.max(0, Math.round(100 - 100 * (m.blocked * 1 + m.priceDeviations * 2 + m.duplicateAttempts * 2) / n - (m.paid ? 20 * (1 - m.reconciled / m.paid) : 0))) : null;
    return { agentId: a.id, name: a.name, status: a.status, metrics: m, score,
      confidence: n >= 20 ? 'high' : n >= 5 ? 'medium' : 'low', basis: `${n} proposal${n === 1 ? '' : 's'}`,
      formula: '100 − 100 × (blocked + 2 × price deviations + 2 × duplicate attempts) ÷ proposals − 20 × share of paid purchases that did not reconcile' };
  });
}

// ---------------- 5. Settings / health ----------------
export function settingsStatus() {
  const L = verifyLedger();
  const set = v => (v ? 'configured' : 'missing');
  return {
    environment: paypal.isLive() ? 'sandbox' : 'simulator', live: false,
    paypal: { mode: paypal.isLive() ? 'Sandbox (api-m.sandbox.paypal.com)' : 'Simulator (no keys)', clientId: set(process.env.PAYPAL_CLIENT_ID), secret: set(process.env.PAYPAL_CLIENT_SECRET),
      payeeOverride: process.env.PAYPAL_PAYEE_EMAIL ? 'set (payments go to a named sandbox merchant)' : 'not set' },
    webhooks: { id: set(process.env.PAYPAL_WEBHOOK_ID), note: process.env.PAYPAL_WEBHOOK_ID ? 'signatures verified via PayPal API' : 'needs a public URL and a webhook ID', received: eventStats.received, duplicatesIgnored: eventStats.duplicates },
    ai: { provider: llmEnabled() ? 'Claude (Anthropic API)' : 'none, rule-based text', key: set(process.env.ANTHROPIC_API_KEY) },
    email: { provider: process.env.RESEND_API_KEY ? 'Resend' : 'none, messages stay in the outbox', key: set(process.env.RESEND_API_KEY), from: set(process.env.PACT_FROM_EMAIL), buyer: set(process.env.BUYER_EMAIL) },
    paypalReporting: set(process.env.PAYPAL_REPORTING_WEBHOOK_URL),
    database: { engine: 'SQLite (node:sqlite)', file: DB.dbFile, transactions: intents.size, incidents: incidents.size, ledgerEntries: ledger.length, ledgerIntact: L.ok },
    security: { signingSecret: process.env.PACT_SECRET ? 'from environment' : 'generated and stored locally', approvalGate: 'always on', autoRefunds: 'never', autoDisputes: 'never' },
  };
}
