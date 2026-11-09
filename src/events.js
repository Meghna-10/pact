// Event ingestion layer. Every external event needs: event id, source, type, timestamp,
// transaction reference. The raw event is stored first (raw_events table, event_id is the
// primary key = idempotency check), then applied to the normalized transaction state.
import * as DB from './db.js';
import { intents } from './trust.js';
import * as A from './assurance.js';

const PAYPAL_TYPES = /^PAYMENT\.CAPTURE\.(COMPLETED|REFUNDED|REVERSED|DENIED|PENDING|DECLINED)$|^CHECKOUT\.ORDER\.(APPROVED|COMPLETED)$/;
const MERCHANT_TYPES = ['shipped', 'delivery_date_changed', 'delivered', 'cancelled', 'refund_promised'];
export const stats = { received: 0, duplicates: 0, unmatched: 0, rejected: 0 };

// Find the PACT transaction by intent id, PayPal order id or capture id.
export function findIntent(ref) {
  if (!ref) return null;
  return intents.get(ref) || [...intents.values()].find(i => i.orderId === ref || i.payment?.captureId === ref || i.payment?.orderId === ref) || null;
}

export function ingest({ eventId, source, type, transactionRef, occurredAt, payload = {}, verified = false, label }) {
  if (!eventId || !source || !type) { stats.rejected++; return { ok: false, status: 400, error: 'eventId, source and type are required' }; }
  if (source === 'paypal' && !PAYPAL_TYPES.test(type)) { stats.rejected++; return { ok: false, status: 400, error: `unsupported PayPal event type ${type}` }; }
  if (source === 'merchant' && !MERCHANT_TYPES.includes(type)) { stats.rejected++; return { ok: false, status: 400, error: `merchant type must be one of ${MERCHANT_TYPES.join(', ')}` }; }
  const it = findIntent(transactionRef);
  const { inserted } = DB.insertRawEvent({ eventId, source, type, transactionId: it?.id || transactionRef, occurredAt, payload, verified });
  stats.received++;
  if (!inserted) { stats.duplicates++; return { ok: true, duplicate: true, note: `event ${eventId} already received; ignored (redelivery is not a second payment)` }; }
  if (!it) { stats.unmatched++; return { ok: true, applied: false, note: 'stored raw; no matching transaction yet (out-of-order delivery is kept, not dropped)' }; }
  if (source === 'paypal' && !verified && !/simulated/.test(label || '')) return { ok: true, applied: false, note: 'stored raw but NOT applied: signature not verified' };

  if (source === 'paypal') {
    A.paypalEvent(it.id, { event_type: type, amount: payload.amount, currency: payload.currency, captureId: payload.captureId, status: payload.status, at: occurredAt, eventId },
      label || (verified ? 'PayPal webhook (verified)' : 'PayPal event (unverified)'));
  } else {
    A.merchantEvent(it.id, { type, at: occurredAt, ...payload }, label || 'merchant (simulated)');
  }
  DB.markApplied(eventId);
  return { ok: true, applied: true, intentId: it.id };
}

// Normalize a real PayPal webhook body into an ingest() call.
export function fromPayPalWebhook(body, verified) {
  const r = body?.resource || {};
  const ref = r.supplementary_data?.related_ids?.order_id || r.purchase_units?.[0]?.reference_id || r.id;
  return ingest({ eventId: body?.id, source: 'paypal', type: body?.event_type, transactionRef: ref, occurredAt: body?.create_time, verified,
    payload: { amount: r.amount?.value, currency: r.amount?.currency_code, captureId: /CAPTURE/.test(body?.event_type || '') ? r.id : undefined, status: r.status } });
}

export function restoreStats(s) { if (s) Object.assign(stats, s); }
