// PayPal Developer Sandbox client (backend only; credentials never reach the browser).
// Verified against developer.paypal.com: /v1/oauth2/token, /v1/catalogs/products, /v1/billing/plans,
// /v1/billing/subscriptions, /v1/notifications/verify-webhook-signature.
const BASE = 'https://api-m.sandbox.paypal.com';
export const isLive = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const fail = (status, msg) => Object.assign(new Error(msg), { status });

async function fetchRetry(url, opts, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); }
    catch (e) { if (i >= tries) throw fail(502, `could not reach PayPal (${e.cause?.code || e.message})`); await new Promise(r => setTimeout(r, 400 * i)); }
  }
}
let token = { v: null, exp: 0 };
async function accessToken() {
  if (!isLive()) throw fail(409, 'PayPal sandbox keys are not configured (see .env.example)');
  if (token.v && Date.now() < token.exp) return token.v;
  const r = await fetchRetry(`${BASE}/v1/oauth2/token`, { method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!r.ok) throw fail(502, `PayPal auth failed (${r.status})`);
  const j = await r.json();
  token = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return token.v;
}
async function call(method, path, body, headers = {}) {
  const r = await fetchRetry(BASE + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...headers } });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw fail(r.status === 404 ? 404 : 502, `PayPal ${method} ${path.split('?')[0]} → ${r.status} ${j.details?.[0]?.issue || j.name || ''}`.trim());
  return j;
}
const rid = p => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;   // PayPal-Request-Id: safe retries

export const createProduct = (name, description) => call('POST', '/v1/catalogs/products', { name, description, type: 'SERVICE', category: 'SOFTWARE' }, { 'PayPal-Request-Id': rid('prod') });
export function createPlan({ productId, name, amount, currency = 'USD', interval = 'MONTH', trialDays = 0 }) {
  const cycles = [];
  if (trialDays > 0) cycles.push({ frequency: { interval_unit: 'DAY', interval_count: trialDays }, tenure_type: 'TRIAL', sequence: 1, total_cycles: 1 });
  cycles.push({ frequency: { interval_unit: interval, interval_count: 1 }, tenure_type: 'REGULAR', sequence: cycles.length + 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: Number(amount).toFixed(2), currency_code: currency } } });
  return call('POST', '/v1/billing/plans', { product_id: productId, name, status: 'ACTIVE', billing_cycles: cycles, payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 } }, { 'PayPal-Request-Id': rid('plan') });
}
export const getPlan = id => call('GET', `/v1/billing/plans/${encodeURIComponent(id)}`);
export const updatePlanPricing = (id, sequence, amount, currency = 'USD') =>
  call('POST', `/v1/billing/plans/${encodeURIComponent(id)}/update-pricing-schemes`, { pricing_schemes: [{ billing_cycle_sequence: sequence, pricing_scheme: { fixed_price: { value: Number(amount).toFixed(2), currency_code: currency } } }] });
export const createSubscription = (planId, returnUrl) => call('POST', '/v1/billing/subscriptions',
  { plan_id: planId, application_context: { brand_name: 'StreamBox Demo', user_action: 'SUBSCRIBE_NOW', return_url: returnUrl, cancel_url: returnUrl } }, { 'PayPal-Request-Id': rid('sub') });
export const getSubscription = id => call('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`);

export async function verifyWebhook(headers, event) {
  if (!isLive() || !process.env.PAYPAL_WEBHOOK_ID) return { verified: false, reason: 'PAYPAL_WEBHOOK_ID not configured' };
  const r = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: event });
  return { verified: r.verification_status === 'SUCCESS', reason: r.verification_status };
}
