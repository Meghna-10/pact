// PayPal Orders v2 (sandbox) client. Falls back to an in-memory simulator when
// PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set, so the demo runs offline.
import crypto from 'node:crypto';

const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
export const isLive = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

// Network blips ("fetch failed") are retried. Safe because order create and capture send a
// PayPal-Request-Id, so PayPal treats a repeated request as the same one, never a second payment.
async function fetchRetry(url, opts, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); }
    catch (e) { if (i >= tries) throw new Error(`could not reach PayPal (${e.cause?.code || e.message}); please try again`); await new Promise(r => setTimeout(r, 400 * i)); }
  }
}

let tokenCache = { token: null, exp: 0 };
async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetchRetry(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal auth failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

async function call(method, path, body, extraHeaders = {}) {
  const r = await fetchRetry(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`PayPal ${method} ${path} → ${r.status}: ${text}`);
  return j;
}

// ---- simulator ----
const sim = new Map();

export async function createOrder({ amount, description, referenceId }, simulate = false) {
  const value = amount.toFixed(2);
  if (!isLive() || simulate) {
    const id = 'SIM-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    sim.set(id, { id, status: 'CREATED', amount: value, referenceId });
    return { id, status: 'CREATED', simulated: true };
  }
  const o = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    // Optional: send the money to a specific merchant account (e.g. a US sandbox business account)
    // instead of the account that owns the REST app.
    purchase_units: [{ reference_id: referenceId, description: description.slice(0, 127), amount: { currency_code: 'USD', value },
      ...(process.env.PAYPAL_PAYEE_EMAIL ? { payee: { email_address: process.env.PAYPAL_PAYEE_EMAIL } } : {}) }],
  }, { 'PayPal-Request-Id': `create-${referenceId}` });
  return { id: o.id, status: o.status };
}

export async function getOrder(id, simulate = id.startsWith("SIM-")) {
  if (!isLive() || simulate) {
    const o = sim.get(id);
    if (!o) throw new Error('order not found');
    return { id, status: o.status === 'CREATED' ? 'APPROVED' : o.status, amount: o.amount, referenceId: o.referenceId };
  }
  const o = await call('GET', `/v2/checkout/orders/${id}`);
  const pu = o.purchase_units?.[0] || {};
  return { id: o.id, status: o.status, amount: pu.amount?.value, referenceId: pu.reference_id };
}

export async function captureOrder(id, simulate = id.startsWith("SIM-")) {
  if (!isLive() || simulate) {
    const o = sim.get(id);
    o.status = 'COMPLETED';
    // Simulated fee uses a typical rate for illustration only (labelled "simulated fee estimate").
    const fee = Math.round((Number(o.amount) * 0.0349 + 0.49) * 100) / 100;
    return { id, status: 'COMPLETED', captureId: 'SIMCAP-' + crypto.randomBytes(5).toString('hex').toUpperCase(), amount: o.amount, currency: 'USD', fee, net: Math.round((Number(o.amount) - fee) * 100) / 100, simulated: true };
  }
  const c = await call('POST', `/v2/checkout/orders/${id}/capture`, {}, { 'PayPal-Request-Id': `capture-${id}` });
  const cap = c.purchase_units?.[0]?.payments?.captures?.[0] || {};
  const br = cap.seller_receivable_breakdown || {};
  return { id: c.id, status: c.status, captureId: cap.id, amount: cap.amount?.value, currency: cap.amount?.currency_code,
    fee: br.paypal_fee ? Number(br.paypal_fee.value) : undefined, net: br.net_amount ? Number(br.net_amount.value) : undefined };
}

export async function verifyWebhook(headers, event) {
  if (!isLive() || !process.env.PAYPAL_WEBHOOK_ID) return { verified: false, reason: 'not configured' };
  const r = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  return { verified: r.verification_status === 'SUCCESS' };
}

export { sim as simOrders };
