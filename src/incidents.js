// PACT Transaction Incident & Resolution Center.
// Detect → incident ID → route notifications per problem type → request verification
// → track responses → Open → Under Review → Resolved, all on the audit ledger.
//
// Guardrails (enforced here, not just documented):
//  - PACT never refunds, cancels, files a dispute or accuses anyone. Messages say
//    "discrepancy" and "please verify". There is no code path that moves money.
//  - PayPal is only contacted through an AUTHORIZED reporting integration
//    (PAYPAL_REPORTING_WEBHOOK_URL). Without one, the PayPal notice stays a draft.
//  - Merchants are only notified when their contact is verified.
//  - Email goes out only if RESEND_API_KEY + addresses are configured; otherwise it
//    sits in the outbox, marked "not sent".
import crypto from 'node:crypto';
import { intents, audit, securityEvents, agents } from './trust.js';
import { chain } from './assurance.js';

export const incidents = new Map();
const STATUSES = ['open', 'under_review', 'resolved'];

// Verified merchant contacts (demo directory). Unverified merchants are not emailed.
const MERCHANT_CONTACTS = {
  OfficeWorks: { email: process.env.MERCHANT_EMAIL_OFFICEWORKS || 'orders@officeworks.example', verified: true },
  SmartHomePlus: { email: 'support@smarthomeplus.example', verified: true },
  KeyLab: { email: 'help@keylab.example', verified: true },
  OutdoorCo: { email: 'care@outdoorco.example', verified: true },
  SoundHub: { email: 'orders@soundhub.example', verified: true },
  MegaDealz247: { email: 'sales@megadealz247.example', verified: false },
};
const merchantContact = m => MERCHANT_CONTACTS[m] || { email: null, verified: false };

// ---------------- routing matrix ----------------
// buyer: always · merchant: yes / if_relevant · paypal: no / if_relevant / yes / on_escalation
export const ROUTING = {
  amount_mismatch:      { severity: 'critical', buyer: true, merchant: 'yes',         paypal: 'if_relevant' },
  duplicate_capture:    { severity: 'critical', buyer: true, merchant: 'yes',         paypal: 'yes' },
  delivery_delayed:     { severity: 'medium',   buyer: true, merchant: 'yes',         paypal: 'no' },
  not_delivered:        { severity: 'high',     buyer: true, merchant: 'yes',         paypal: 'no' },
  refund_missing:       { severity: 'high',     buyer: true, merchant: 'yes',         paypal: 'on_escalation' },
  suspicious_agent:     { severity: 'high',     buyer: true, merchant: 'if_relevant', paypal: 'on_escalation' },
  missing_evidence:     { severity: 'medium',   buyer: true, merchant: 'yes',         paypal: 'on_escalation' },
};

const OWNER = { amount_mismatch: 'merchant', duplicate_capture: 'merchant', delivery_delayed: 'merchant', not_delivered: 'merchant', refund_missing: 'merchant', suspicious_agent: 'buyer', missing_evidence: 'merchant' };
const DUE_HOURS = { critical: 24, high: 48, medium: 72 };
const ACTION = {
  amount_mismatch: 'Compare the merchant order total, the buyer approval and the PayPal gross capture; check for order edits or coupons.',
  duplicate_capture: 'Confirm with the merchant how many orders were fulfilled; if one, the merchant refunds the extra capture through PayPal.',
  delivery_delayed: 'Merchant confirms the new delivery date; buyer is informed before a claim is opened.',
  not_delivered: 'Merchant supplies carrier + tracking; without proof, resolve in the buyer\'s favour.',
  refund_missing: 'Merchant confirms the refund reference; if none by the deadline, escalate through the authorized PayPal channel.',
  suspicious_agent: 'Buyer reviews the agent and revokes it if unrecognised.',
  missing_evidence: 'Merchant uploads the missing records before the dispute response deadline.',
};
// Lifecycle stage shown to merchants: Detected → Notified → Investigating → Evidence collected → Resolved.
export function stage(i) {
  if (i.status === 'resolved') return 'resolved';
  if (i.responses.some(r => r.evidence)) return 'evidence_collected';
  if (i.status === 'under_review' || i.responses.length) return 'investigating';
  if (i.notifications.length) return 'notified';
  return 'detected';
}

const KIND_OF_ISSUE ={ late_delivery: 'delivery_delayed', delivery_date_changed: 'delivery_delayed', not_shipped: 'delivery_delayed', not_delivered: 'not_delivered', refund_missing: 'refund_missing', price: 'amount_mismatch' };

// ---------------- message templates (neutral wording, no accusations) ----------------
function messages(kind, inc, it) {
  const ids = `Incident ${inc.id} · PACT intent ${it.id}${it.orderId ? ` · PayPal order ${it.orderId}` : ''}${it.payment?.captureId ? ` · capture ${it.payment.captureId}` : ''}`;
  const d = inc.detail;
  const T = {
    amount_mismatch: {
      buyer: [`Payment amount discrepancy detected`, `${d} Please review this transaction before taking further action. PACT has not changed or cancelled anything.`],
      merchant: [`Transaction amount discrepancy — verification requested`, `The approved purchase amount and the payment records for order "${it.title}" do not match: ${d} Please verify your order and payment records and reply with your order reference.`],
      paypal: [`Transaction discrepancy report`, `PACT identified a discrepancy between transaction records: ${d} Transaction identifiers and the event timeline are attached for review.`],
    },
    duplicate_capture: {
      buyer: [`Possible duplicate payment detected`, `${d} No action has been taken on your account. Please check your PayPal activity.`],
      merchant: [`Possible duplicate payment — verification requested`, `${d} Please confirm whether one order or two was fulfilled.`],
      paypal: [`Possible duplicate capture report`, `${d} Identifiers and timeline attached for review.`],
    },
    delivery_delayed: {
      buyer: [`Your delivery is behind the merchant's commitment`, `${d} We've asked the merchant to confirm a delivery date.`],
      merchant: [`Delivery commitment update requested`, `${d} Please confirm the current delivery date and tracking number for "${it.title}".`],
    },
    not_delivered: {
      buyer: [`No delivery record for your order`, `${d} We've asked the merchant for tracking and proof of delivery. You may also contact the merchant directly.`],
      merchant: [`Proof of delivery requested`, `${d} Please provide the carrier and tracking number for "${it.title}".`],
    },
    refund_missing: {
      buyer: [`Refund not yet visible in your payment records`, `${d} We've asked the merchant to confirm the refund status.`],
      merchant: [`Refund status confirmation requested`, `${d} Please confirm whether the refund has been issued and share the refund reference.`],
      paypal: [`Unresolved refund report`, `${d} The merchant has been asked to confirm. Identifiers and timeline attached.`],
    },
    suspicious_agent: {
      buyer: [`Unusual activity from your AI agent`, `${d} Review the agent's permissions. You can revoke it from the Buyer Command Center.`],
      merchant: [`Unusual agent-initiated order activity`, `${d} Please hold fulfilment of any duplicate orders until the buyer confirms.`],
      paypal: [`Agent activity report`, `${d} Identifiers attached.`],
    },
    missing_evidence: {
      buyer: [`Information needed for your transaction record`, `${d}`],
      merchant: [`Supporting records requested`, `${d} Please supply the missing records listed.`],
      paypal: [`Dispute evidence summary`, `${d} Evidence package attached.`],
    },
  }[kind];
  const out = {};
  for (const k of Object.keys(T)) out[k] = { subject: `[PACT ${inc.id}] ${T[k][0]}`, body: `${T[k][1]}\n\n${ids}\n\nThis message was generated by PACT. It reports a discrepancy and requests verification. It is not an accusation, and PACT has not refunded, cancelled or disputed anything.` };
  return out;
}

// ---------------- delivery channels ----------------
async function sendEmail(to, subject, body) {
  if (!process.env.RESEND_API_KEY || !process.env.PACT_FROM_EMAIL || !to) return { status: 'outbox', reason: !to ? 'no address on file' : 'email provider not configured (RESEND_API_KEY / PACT_FROM_EMAIL)' };
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.PACT_FROM_EMAIL, to, subject, text: body }) });
    return r.ok ? { status: 'sent', providerId: (await r.json()).id } : { status: 'failed', reason: `Resend ${r.status}` };
  } catch (e) { return { status: 'failed', reason: e.message }; }
}
async function sendPayPalReport(payload) {
  const url = process.env.PAYPAL_REPORTING_WEBHOOK_URL;
  if (!url) return { status: 'draft', reason: 'no authorized PayPal reporting integration configured; PACT does not contact PayPal by other means' };
  try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: r.ok ? 'sent' : 'failed', reason: r.ok ? undefined : `HTTP ${r.status}` }; }
  catch (e) { return { status: 'failed', reason: e.message }; }
}

async function notify(inc, party, why) {
  const it = intents.get(inc.intentId);
  const msg = messages(inc.kind, inc, it)[party];
  if (!msg) return;
  let to = null, res;
  if (party === 'buyer') { to = process.env.BUYER_EMAIL || null; res = await sendEmail(to, msg.subject, msg.body); }
  if (party === 'merchant') {
    const c = merchantContact(it.merchant);
    if (!c.verified) { res = { status: 'skipped', reason: `merchant ${it.merchant} contact is not verified` }; }
    else { to = c.email; res = await sendEmail(to, msg.subject, msg.body); }
  }
  if (party === 'paypal') {
    to = 'PayPal authorized reporting integration';
    res = await sendPayPalReport({ incidentId: inc.id, kind: inc.kind, detail: inc.detail, intentId: it.id, orderId: it.orderId, captureId: it.payment?.captureId, timeline: chain(it.id).timeline.map(e => ({ at: e.at, type: e.type, source: e.source })) });
  }
  const n = { party, to, channel: party === 'paypal' ? 'authorized integration' : 'email + in-app', subject: msg.subject, body: msg.body, why, at: new Date().toISOString(), ...res };
  inc.notifications.push(n);
  log(inc, 'pact', 'notification_' + n.status, { party, to, reason: n.reason });
}

function log(inc, actor, type, data = {}) {
  const e = { at: new Date().toISOString(), actor, type, data };
  inc.timeline.push(e);
  audit(actor, 'incident_' + type, inc.id, { intentId: inc.intentId, ...data });
}

// ---------------- create & route ----------------
export async function openIncident(intentId, kind, detail, { relevantToPayPal = false, merchantRelevant = true } = {}) {
  const dupe = [...incidents.values()].find(i => i.intentId === intentId && i.kind === kind && i.status !== 'resolved');
  if (dupe) return dupe;
  const R = ROUTING[kind]; if (!R) throw new Error('unknown incident kind ' + kind);
  const it = intents.get(intentId);
  const inc = { id: 'INC-' + crypto.randomBytes(3).toString('hex').toUpperCase(), intentId, kind, severity: R.severity, status: 'open', detail,
    title: it?.title, merchant: it?.merchant, agentId: it?.agentId, createdAt: new Date().toISOString(), notifications: [], requests: [], responses: [], timeline: [], escalated: false,
    owner: OWNER[kind], dueAt: new Date(Date.now() + DUE_HOURS[R.severity] * 3600e3).toISOString(), recommendedAction: ACTION[kind] };
  incidents.set(inc.id, inc);
  log(inc, 'pact', 'opened', { kind, severity: inc.severity, detail });

  await notify(inc, 'buyer', 'buyer is always notified');
  if (R.merchant === 'yes' || (R.merchant === 'if_relevant' && merchantRelevant)) {
    await notify(inc, 'merchant', R.merchant === 'yes' ? `routing: ${kind} → merchant` : 'merchant is party to the flagged transaction');
    inc.requests.push({ party: 'merchant', what: requestFor(kind), status: 'awaiting', at: new Date().toISOString() });
  }
  if (R.paypal === 'yes' || (R.paypal === 'if_relevant' && relevantToPayPal)) await notify(inc, 'paypal', R.paypal === 'yes' ? `routing: ${kind} → PayPal` : 'discrepancy involves a PayPal record');
  inc.requests.push({ party: 'buyer', what: 'Confirm whether you recognise this transaction and its amount', status: 'awaiting', at: new Date().toISOString() });
  return inc;
}
const requestFor = k => ({ amount_mismatch: 'Order reference and the amount you charged', duplicate_capture: 'Number of orders fulfilled for this purchase', delivery_delayed: 'Confirmed delivery date and tracking number',
  not_delivered: 'Carrier and tracking number / proof of delivery', refund_missing: 'Refund reference and date issued', suspicious_agent: 'Confirm whether you received duplicate or unusual orders', missing_evidence: 'Missing supporting records' }[k]);

// ---------------- detection scan ----------------
export async function scan(asOf = Date.now(), onlyIntentId = null) {
  const opened = [];
  for (const it of intents.values()) {
    if (onlyIntentId && it.id !== onlyIntentId) continue;
    if (!it.payment && !it.agentReport) continue;
    const c = chain(it.id, asOf);
    for (const m of c.reconciliation.mismatches) {
      if (/DUPLICATE CAPTURE/.test(m)) { opened.push(await openIncident(it.id, 'duplicate_capture', m.replace('DUPLICATE CAPTURE: ', '') + '.')); continue; }
      const involvesPayPal = /PayPal|capture|refund|reversed/i.test(m);
      opened.push(await openIncident(it.id, 'amount_mismatch', m + '.', { relevantToPayPal: involvesPayPal }));
    }
    for (const i of c.commitment.issues) opened.push(await openIncident(it.id, KIND_OF_ISSUE[i.kind] || 'delivery_delayed', `Merchant commitment not met: ${i.msg}.`));
  }
  for (const e of securityEvents) {
    if (e.kind === 'duplicate_payment') {
      const id = (e.detail.match(/INT-[A-F0-9]+/) || [])[0];
      if (id && intents.get(id)?.payment) opened.push(await openIncident(id, 'duplicate_capture', `A second payment capture was attempted on ${id} and was rejected by PACT before money moved.`));
    }
    if (e.kind === 'behavior_hold') {
      const last = [...intents.values()].reverse().find(i => i.agentId === e.agentId && i.status !== 'blocked') || [...intents.values()].reverse().find(i => i.agentId === e.agentId);
      if (last) opened.push(await openIncident(last.id, 'suspicious_agent', `Agent ${e.agentId} was put on hold: ${e.detail}.`, { merchantRelevant: last.status === 'captured' }));
    }
  }
  return [...new Set(opened)];
}

// ---------------- resolution workflow ----------------
const get = id => { const i = incidents.get(id); if (!i) throw Object.assign(new Error('unknown incident'), { status: 404 }); return i; };

export function respond(id, { party, message, evidence }) {
  const inc = get(id);
  if (!['buyer', 'merchant', 'paypal'].includes(party)) throw Object.assign(new Error('party must be buyer, merchant or paypal'), { status: 400 });
  const r = { party, message, evidence: evidence || null, at: new Date().toISOString() };
  inc.responses.push(r);
  for (const q of inc.requests) if (q.party === party && q.status === 'awaiting') q.status = 'answered';
  log(inc, party, 'response_received', { message, evidence });
  if (inc.status === 'open') setStatus(id, 'under_review', 'pact', 'a party responded');
  return inc;
}

export function setStatus(id, status, by = 'buyer', note = '') {
  const inc = get(id);
  if (!STATUSES.includes(status)) throw Object.assign(new Error(`status must be ${STATUSES.join(' / ')}`), { status: 400 });
  if (STATUSES.indexOf(status) < STATUSES.indexOf(inc.status)) throw Object.assign(new Error(`cannot go back from ${inc.status} to ${status}`), { status: 409 });
  if (status === 'resolved' && !note) throw Object.assign(new Error('a resolution note is required'), { status: 400 });
  const from = inc.status; inc.status = status;
  if (status === 'resolved') inc.resolution = { by, note, at: new Date().toISOString() };
  log(inc, by, 'status_changed', { from, to: status, note });
  return inc;
}

export async function escalate(id, by = 'buyer') {
  const inc = get(id);
  const R = ROUTING[inc.kind];
  if (R.paypal === 'no') throw Object.assign(new Error(`${inc.kind} is a buyer–merchant matter and is not escalated to PayPal`), { status: 409 });
  if (inc.notifications.some(n => n.party === 'paypal')) throw Object.assign(new Error('PayPal has already been notified for this incident'), { status: 409 });
  inc.escalated = true;
  log(inc, by, 'escalated', { to: 'paypal' });
  await notify(inc, 'paypal', `escalated by ${by}`);
  return inc;
}

export const list = () => [...incidents.values()].reverse().map(i => ({ id: i.id, kind: i.kind, severity: i.severity, status: i.status, stage: stage(i), owner: i.owner, dueAt: i.dueAt,
  overdue: i.status !== 'resolved' && Date.now() > new Date(i.dueAt).getTime(), recommendedAction: i.recommendedAction, title: i.title, merchant: i.merchant, intentId: i.intentId, createdAt: i.createdAt,
  notified: i.notifications.map(n => `${n.party}:${n.status}`), awaiting: i.requests.filter(r => r.status === 'awaiting').map(r => r.party) }));
export const detail = id => { const i = get(id); return { ...i, stage: stage(i) }; };
export { MERCHANT_CONTACTS };

export function assign(id, owner, by = 'pact-ops') {
  const inc = get(id);
  if (!owner || String(owner).length > 60) throw Object.assign(new Error('owner name required (max 60 chars)'), { status: 400 });
  const from = inc.owner; inc.owner = String(owner);
  log(inc, by, 'assigned', { from, to: inc.owner });
  return inc;
}
