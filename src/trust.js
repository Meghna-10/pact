// PACT Financial Trust Core — deterministic. No LLM is consulted here.
// Agent Passport (signed scoped credentials) · Intent Firewall · Behavior Intelligence
// · Approval binding · Hash-chained audit ledger · Merchant intelligence · Dispute evidence.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { round2 } from './policy.js';
import { riskOf, negotiate } from './agents.js';

import * as DB from './db.js';

const SECRET = DB.secret();   // persisted, so passports survive a restart
export const CATALOG = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));
export const product = id => CATALOG.find(p => p.id === id);

export const agents = new Map();   // agentId -> agent
export const intents = new Map();  // intentId -> intent
export const ledger = DB.loadLedger();   // global hash-chained audit log (persisted)
export const securityEvents = [];
export const usedNonces = new Set();

const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim().toLowerCase()).filter(Boolean);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

// ---------------- Audit ledger (append-only, hash-chained) ----------------
export function audit(actor, type, ref, data = {}) {
  const prev = ledger.at(-1)?.hash || 'GENESIS';
  const ev = { seq: ledger.length, at: new Date().toISOString(), actor, type, ref, data };
  ev.prevHash = prev;
  ev.hash = sha(prev + JSON.stringify({ ...ev, hash: undefined }));
  ledger.push(ev);
  DB.appendLedger(ev);
  return ev;
}
export function verifyLedger() {
  for (let i = 0; i < ledger.length; i++) {
    const ev = ledger[i], prev = i ? ledger[i - 1].hash : 'GENESIS';
    if (ev.prevHash !== prev || ev.hash !== sha(prev + JSON.stringify({ ...ev, hash: undefined }))) return { ok: false, brokenAt: i };
  }
  return { ok: true, length: ledger.length };
}
function security(agentId, kind, detail) {
  const e = { at: new Date().toISOString(), agentId, kind, detail };
  securityEvents.push(e);
  audit('firewall', 'security_event', agentId, { kind, detail });
  return e;
}

// ---------------- Agent Passport ----------------
export function registerAgent({ name, owner = 'buyer-102', permissions = {}, human = false }) {
  const id = 'AGENT-' + crypto.randomInt(1000, 9999);
  const a = { id, name: name || id, owner, human, status: 'active', createdAt: new Date().toISOString(), policyVersion: 0, history: [] };
  agents.set(id, a);
  setPermissions(id, permissions, 'buyer');
  return a;
}

export function setPermissions(id, p = {}, actor = 'buyer') {
  const a = agents.get(id); if (!a) throw new Error('unknown agent');
  const cur = a.permissions || {};
  a.permissions = {
    maxPerTxn: Number(p.maxPerTxn ?? cur.maxPerTxn ?? 200),
    dailyBudget: Number(p.dailyBudget ?? cur.dailyBudget ?? 500),
    approvalAbove: Number(p.approvalAbove ?? cur.approvalAbove ?? 100),
    allowedCategories: list(p.allowedCategories ?? cur.allowedCategories ?? []),
    allowedMerchants: list(p.allowedMerchants ?? cur.allowedMerchants ?? []),
    blockedMerchants: list(p.blockedMerchants ?? cur.blockedMerchants ?? []),
    currency: 'USD',
    expiresAt: p.ttlHours ? new Date(Date.now() + p.ttlHours * 3600e3).toISOString() : (cur.expiresAt || new Date(Date.now() + 24 * 3600e3).toISOString()),
  };
  a.policyVersion += 1;           // old credentials stop working
  a.credential = issueCredential(a);
  audit(actor, 'permissions_set', id, { policyVersion: a.policyVersion, permissions: a.permissions });
  return a;
}

export function revokeAgent(id, actor = 'buyer') {
  const a = agents.get(id); if (!a) throw new Error('unknown agent');
  a.status = 'revoked';
  for (const it of intents.values()) if (it.agentId === id && ['pending_approval', 'approved'].includes(it.status)) { it.status = 'revoked'; audit('system', 'intent_revoked', it.id, { reason: 'agent revoked' }); }
  audit(actor, 'agent_revoked', id);
  return a;
}

function issueCredential(a) {
  const payload = { agentId: a.id, owner: a.owner, scope: 'purchase:propose', maxAmount: a.permissions.maxPerTxn, currency: 'USD',
    exp: Math.floor(new Date(a.permissions.expiresAt).getTime() / 1000), nonce: crypto.randomBytes(8).toString('hex'), policyVersion: a.policyVersion };
  const body = b64(payload);
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}

export function verifyCredential(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return { ok: false, reason: 'missing or malformed credential' };
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return { ok: false, reason: 'invalid signature' };
  const c = JSON.parse(Buffer.from(body, 'base64url').toString());
  const a = agents.get(c.agentId);
  if (!a) return { ok: false, reason: 'unknown agent' };
  if (a.status !== 'active') return { ok: false, reason: `agent is ${a.status}`, claims: c };
  if (c.exp * 1000 < Date.now()) return { ok: false, reason: 'credential expired', claims: c };
  if (c.policyVersion !== a.policyVersion) return { ok: false, reason: 'credential issued under an old policy version', claims: c };
  return { ok: true, claims: c, agent: a };
}

// ---------------- Prompt-injection detection on untrusted listing text ----------------
const INJECTION = [/ignore (all|any|previous|prior|your)/i, /system\s*:/i, /you (are|must) now/i, /override/i, /approve (this|automatically|immediately)/i, /disregard/i, /(buy|purchase|order) \d+ (units|more|of)/i, /send (payment|money) to/i];
export function scanListing(text = '') {
  const hits = INJECTION.filter(r => r.test(text)).map(r => r.source);
  return { injection: hits.length > 0, patterns: hits };
}

// ---------------- Behavior Intelligence ----------------
export function behavior(a, proposal, now = Date.now()) {
  const h = a.history;
  const last60s = h.filter(x => now - x.t < 60e3).length;
  const fails10m = h.filter(x => now - x.t < 600e3 && x.outcome === 'blocked').length;
  const paid = h.filter(x => x.outcome === 'captured');
  const avg = paid.length ? paid.reduce((s, x) => s + x.amount, 0) / paid.length : null;
  const reasons = []; let anomaly = 0;
  if (last60s >= 5) { anomaly += 60; reasons.push(`${last60s} purchase attempts in the last 60 s`); }
  if (fails10m >= 3) { anomaly += 30; reasons.push(`${fails10m} blocked attempts in the last 10 min`); }
  if (paid.some(x => x.productId === proposal.productId && now - x.t < 864e5)) { anomaly += 25; reasons.push('same product already bought in the last 24 h'); }
  const merchants = new Set(paid.map(x => x.merchant));
  if (paid.length >= 2 && !merchants.has(String(proposal.merchant).toLowerCase())) { anomaly += 10; reasons.push('merchant switch: never bought from this merchant'); }
  if (avg && proposal.amount > avg * 2.5) { anomaly += 20; reasons.push(`amount is ${round2(proposal.amount / avg)}x this agent's average`); }
  anomaly = Math.min(100, anomaly);
  return { anomaly, agentHealth: a.status === 'active' ? 100 - anomaly : 0, reasons: reasons.length ? reasons : ['normal activity'] };
}

// ---------------- Intent Firewall (preflight) ----------------
// proposal: {productId, quantity, amount, currency, merchant, category, listingText?}
export function preflight(credential, proposal, { record = true } = {}) {
  const t0 = performance.now();
  const checks = [];
  const add = (name, pass, detail, hard = true) => checks.push({ name, pass, detail, hard });

  const cred = verifyCredential(credential);
  add('credential', cred.ok, cred.ok ? `valid · policy v${cred.claims.policyVersion}` : cred.reason);
  const a = cred.agent || agents.get(cred.claims?.agentId);
  const p = product(proposal.productId);
  add('product_exists', !!p, p ? p.title : 'unknown product');
  const amount = round2(proposal.amount);
  const merchant = String(proposal.merchant || p?.merchant || '').toLowerCase();
  const category = String(proposal.category || p?.category || '').toLowerCase();

  // listing text is untrusted data: scanned, recorded, never obeyed
  const scan = scanListing(proposal.listingText);
  if (scan.injection) add('listing_injection', true, `instructions in listing ignored (${scan.patterns.length} pattern(s)); decision uses structured fields only`, false);

  if (p) {
    const expected = negotiate(p, proposal.quantity || 1).finalPrice;
    add('price_integrity', amount === expected, amount === expected ? `$${amount} matches catalog` : `proposal $${amount} ≠ merchant price $${expected}`);
    add('merchant_identity', merchant === p.merchant.toLowerCase(), merchant === p.merchant.toLowerCase() ? p.merchant : `proposal says "${proposal.merchant}", product is sold by ${p.merchant}`);
  }
  add('currency', (proposal.currency || 'USD') === 'USD', proposal.currency || 'USD');

  let beh = { anomaly: 0, agentHealth: 0, reasons: [] };
  if (a) {
    const P = a.permissions;
    add('max_per_txn', amount <= P.maxPerTxn, `$${amount} vs limit $${P.maxPerTxn}`);
    const spent = spentToday(a);
    add('daily_budget', spent + amount <= P.dailyBudget, `$${round2(spent)} spent today + $${amount} vs $${P.dailyBudget}`);
    add('category_scope', !P.allowedCategories.length || P.allowedCategories.includes(category), `${category} vs [${P.allowedCategories.join(', ') || 'any'}]`);
    add('merchant_allowlist', !P.allowedMerchants.length || P.allowedMerchants.includes(merchant), `${merchant} vs [${P.allowedMerchants.join(', ') || 'any'}]`);
    add('merchant_blocklist', !P.blockedMerchants.includes(merchant), merchant);
    beh = behavior(a, { ...proposal, amount, merchant });
  }
  const mrisk = p ? riskOf(p) : { riskScore: 100, riskReasons: ['unknown product'] };
  const transactionRisk = Math.min(100, Math.round(mrisk.riskScore * 0.6 + beh.anomaly * 0.4 + (scan.injection ? 15 : 0)));

  const failed = checks.filter(c => c.hard && !c.pass);
  let decision;
  if (failed.length) decision = 'block';
  else if (beh.anomaly >= 60) decision = 'hold';
  else if (amount > a.permissions.approvalAbove || beh.anomaly >= 25 || transactionRisk >= 50 || scan.injection) decision = 'require_approval';
  else decision = 'allow';

  const result = {
    decision, checks, failed: failed.map(c => `${c.name}: ${c.detail}`),
    scores: { agentHealth: beh.agentHealth, behaviorAnomaly: beh.anomaly, merchantRisk: mrisk.riskScore, transactionRisk },
    reasons: { behavior: beh.reasons, merchant: mrisk.riskReasons },
    injection: scan, latencyMs: round2(performance.now() - t0),
  };
  if (record && a) {
    a.history.push({ t: Date.now(), amount, merchant, productId: proposal.productId, outcome: decision === 'block' ? 'blocked' : 'proposed' });
    if (decision === 'block') security(a.id, 'blocked_transaction', result.failed.join('; '));
    if (scan.injection) security(a.id, 'prompt_injection', scan.patterns.join(', '));
    if (decision === 'hold') security(a.id, 'behavior_hold', beh.reasons.join('; '));
  }
  return result;
}

export function spentToday(a) {
  return a.history.filter(x => x.outcome === 'captured' && Date.now() - x.t < 864e5).reduce((s, x) => s + x.amount, 0);
}

// ---------------- Purchase intents & approval binding ----------------
const bindHash = it => sha([it.agentId, it.proposal.productId, it.proposal.quantity || 1, it.merchant, it.amount.toFixed(2), 'USD', it.nonce].join('|'));

export function createIntent(credential, proposal, userRequest = '') {
  const cred = verifyCredential(credential);
  if (cred.ok && usedNonces.has(proposal.idempotencyKey)) return { error: 'duplicate request (idempotency key reused)', status: 409 };
  const pf = preflight(credential, proposal);
  const a = cred.agent || agents.get(cred.claims?.agentId);
  const id = 'INT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const p = product(proposal.productId);
  const it = {
    id, agentId: a?.id, userRequest, proposal, merchant: p?.merchant, title: p?.title, amount: round2(proposal.amount), currency: 'USD',
    nonce: crypto.randomBytes(8).toString('hex'), createdAt: new Date().toISOString(), preflight: pf,
    permissionsSnapshot: a ? { ...a.permissions, policyVersion: a.policyVersion } : null,
    status: pf.decision === 'block' ? 'blocked' : pf.decision === 'hold' ? 'held' : pf.decision === 'allow' ? 'approved' : 'pending_approval',
  };
  if (proposal.idempotencyKey) usedNonces.add(proposal.idempotencyKey);
  if (it.status === 'approved') { it.approval = { by: 'policy:auto (≤ approvalAbove)', at: it.createdAt, hash: bindHash(it) }; }
  intents.set(id, it);
  audit(a?.id || 'unknown-agent', 'intent_created', id, { userRequest, proposal, decision: pf.decision, failed: pf.failed, scores: pf.scores });
  if (it.approval) audit('policy', 'intent_auto_approved', id, { hash: it.approval.hash });
  if (p && it.status !== 'blocked') {
    // Merchant commitment: what the merchant promised at the moment of purchase.
    it.commitment = { price: it.amount, currency: 'USD', merchant: p.merchant, item: p.title, quantity: proposal.quantity || 1,
      deliveryBy: new Date(Date.now() + p.shippingDays * 864e5).toISOString(), shippingDays: p.shippingDays,
      returns: !!p.returns, returnWindowDays: p.returns ? 30 : 0, warranty: p.warranty || null, source: 'catalog listing at purchase time' };
    audit('merchant', 'merchant_commitment_recorded', id, it.commitment);
  }
  return { intent: it };
}

export function approveIntent(id, by = 'buyer') {
  const it = intents.get(id); if (!it) throw httpErr(404, 'unknown intent');
  if (!['pending_approval', 'held'].includes(it.status)) throw httpErr(409, `intent is ${it.status}`);
  it.status = 'approved';
  it.approval = { by, at: new Date().toISOString(), hash: bindHash(it) };
  audit(by, 'intent_approved', id, { amount: it.amount, hash: it.approval.hash });
  return it;
}

// Merchant reports the real checkout total. Any change invalidates the approval.
export function merchantCheckout(id, { amount, merchant }) {
  const it = intents.get(id); if (!it) throw httpErr(404, 'unknown intent');
  const newAmt = round2(amount ?? it.amount);
  const newMerchant = merchant || it.merchant;
  if (newAmt !== it.amount || newMerchant !== it.merchant) {
    const was = it.status;
    it.status = 'invalidated';
    it.invalidation = { authorized: it.amount, checkout: newAmt, merchant: newMerchant, at: new Date().toISOString() };
    audit('firewall', 'approval_invalidated', id, { ...it.invalidation, previousStatus: was });
    security(it.agentId, 'checkout_mismatch', `authorized $${it.amount} at ${it.merchant}, checkout $${newAmt} at ${newMerchant}`);
    return { ok: false, intent: it, reason: `Checkout amount $${newAmt} differs from buyer-authorized $${it.amount}. A new approval is required.` };
  }
  audit('merchant', 'checkout_confirmed', id, { amount: newAmt });
  return { ok: true, intent: it };
}

// Final gate right before money moves.
export function captureGate(id, paypalOrder) {
  const it = intents.get(id); if (!it) throw httpErr(404, 'unknown intent');
  if (it.status === 'captured' || it.status === 'capturing') { security(it.agentId, 'duplicate_payment', `second capture attempt on ${id}`); throw httpErr(409, 'duplicate payment rejected: intent already paid'); }
  if (it.status !== 'approved') throw httpErr(409, `intent is ${it.status}`);
  if (it.approval.hash !== bindHash(it)) throw httpErr(409, 'approval binding broken');
  const a = agents.get(it.agentId);
  if (!a || a.status !== 'active') throw httpErr(403, 'agent no longer active');
  if (paypalOrder && round2(paypalOrder.amount) !== it.amount) throw httpErr(409, `PayPal amount $${paypalOrder.amount} ≠ authorized $${it.amount}`);
  if (spentToday(a) + it.amount > a.permissions.dailyBudget) throw httpErr(403, 'daily budget would be exceeded');
  it.status = 'capturing';
  return it;
}

export function recordCapture(id, cap) {
  const it = intents.get(id);
  it.status = 'captured'; it.payment = { ...cap, at: new Date().toISOString() };
  const a = agents.get(it.agentId);
  a.history.push({ t: Date.now(), amount: it.amount, merchant: it.merchant.toLowerCase(), productId: it.proposal.productId, outcome: 'captured' });
  audit('paypal', 'payment_captured', id, cap);
  return it;
}
export function releaseCapture(id) { const it = intents.get(id); if (it?.status === 'capturing') it.status = 'approved'; }

export const intentAudit = id => ledger.filter(e => e.ref === id || (e.type === 'paypal_webhook' && e.data?.intentId === id));
function httpErr(status, msg) { return Object.assign(new Error(msg), { status }); }

// ---------------- Merchant Trust Intelligence ----------------
export function merchantProfiles() {
  const by = new Map();
  for (const p of CATALOG) { if (!by.has(p.merchant)) by.set(p.merchant, []); by.get(p.merchant).push(p); }
  return [...by].map(([merchant, items]) => {
    const r = riskOf(items[0]);
    const gaps = [];
    const missing = (f, label) => { const n = items.filter(p => !p[f]).length; if (n) gaps.push(`${n}/${items.length} listings missing ${label}`); };
    missing('description', 'a description'); missing('warranty', 'warranty information');
    if (items.some(p => !p.returns)) gaps.push('no return policy — AI agents and buyers treat this as high dispute risk');
    if (items.some(p => p.shippingDays > 14)) gaps.push('shipping estimate over 14 days');
    if (items[0].merchantAgeDays < 90) gaps.push('merchant account under 90 days old');
    const completeness = Math.round(100 * (1 - gaps.length / 5));
    const its = [...intents.values()].filter(i => i.merchant === merchant);
    return {
      merchant, products: items.length, rating: items[0].merchantRating, ageDays: items[0].merchantAgeDays,
      riskScore: r.riskScore, riskReasons: r.riskReasons, listingCompleteness: completeness,
      aiReadiness: Math.max(0, Math.round(completeness * 0.6 + (items[0].merchantRating / 5) * 40 - r.riskScore * 0.3)),
      gaps, agentAttempts: its.length, blocked: its.filter(i => i.status === 'blocked').length, paid: its.filter(i => i.status === 'captured').length,
    };
  }).sort((a, b) => b.aiReadiness - a.aiReadiness);
}

// ---------------- Dispute Evidence Vault ----------------
export function prepareEvidence(intentId, claim = 'not_received') {
  const it = intents.get(intentId); if (!it) throw httpErr(404, 'unknown intent');
  const trail = intentAudit(intentId);
  const have = [], missing = [];
  const item = (label, ok, value) => (ok ? have : missing).push(ok ? { label, value } : { label });
  item('Original buyer request', !!it.userRequest, it.userRequest);
  item('Agent permissions at purchase time', !!it.permissionsSnapshot, it.permissionsSnapshot);
  item('Buyer approval record', !!it.approval, it.approval);
  item('Product, price & merchant', !!it.title, { title: it.title, amount: it.amount, merchant: it.merchant });
  item('PayPal order & capture IDs', !!it.payment, it.payment && { orderId: it.payment.orderId, captureId: it.payment.captureId });
  item('PayPal webhook events', trail.some(e => e.type === 'paypal_webhook'), trail.filter(e => e.type === 'paypal_webhook').map(e => e.data.event_type));
  item('Shipment tracking / proof of delivery', !!it.delivery, it.delivery);
  item('Hash-chained audit trail', trail.length > 0, { events: trail.length, ledgerIntact: verifyLedger().ok });

  const strength = { unauthorized: it.approval ? 'strong' : 'weak', not_received: it.delivery ? 'strong' : 'insufficient', not_as_described: 'partial' }[claim] || 'partial';
  const draft = {
    unauthorized: `The buyer explicitly authorised this purchase. Approval by "${it.approval?.by}" at ${it.approval?.at} is bound (SHA-256 ${it.approval?.hash?.slice(0, 16)}…) to agent ${it.agentId}, ${it.title}, $${it.amount} USD. The agent's scoped permissions at the time allowed up to $${it.permissionsSnapshot?.maxPerTxn}.`,
    not_received: it.delivery ? `Item shipped: ${JSON.stringify(it.delivery)}.` : `We cannot yet contest this claim: there is no shipment tracking on file. Obtain the carrier tracking number and proof of delivery from ${it.merchant} before responding.`,
    not_as_described: `The listing purchased was "${it.title}" at $${it.amount}. Attach the listing snapshot and the photos/specs the merchant supplied; compare them with the buyer's complaint before responding.`,
  }[claim];
  audit('evidence-vault', 'evidence_prepared', intentId, { claim, strength, missing: missing.map(m => m.label) });
  return { intentId, claim, strength, have, missing, draftResponse: draft, note: 'Draft for merchant review only. Nothing is submitted to PayPal automatically, and no evidence is fabricated.' };
}
