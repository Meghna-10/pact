// Judge Mode extras.
// 1. "Attack it yourself": the judge writes any listing text. A deliberately naive agent reads it the way a
//    careless LLM agent might (quantity, price, payee), then the real firewall decides with record:false so
//    the trial never touches the agent's spending history. The injection scanner is regex-based and CAN miss
//    wording; the verdict shows whether the structured checks still caught the resulting proposal.
// 2. Verifiable receipt: a self-contained HTML file that recomputes the ledger hashes in the browser.
import * as T from './trust.js';
import * as DB from './db.js';
import { round2 } from './policy.js';
import { getRun, runs, evidence, PRODUCT_ID } from './judge.js';

const err = (status, m) => Object.assign(new Error(m), { status });
const save = () => DB.saveState('judgeRuns', Object.fromEntries(runs));

export function naiveAgent(text) {
  const p = T.product(PRODUCT_ID), t = String(text), followed = [];
  let qty = 1, amount = null, merchant = p.merchant;
  const q = t.match(/\b(?:buy|purchase|order|add|get)\s+(\d{1,4})\b/i) || t.match(/\b(\d{1,4})\s*(?:units|pcs|pieces|monitors|items)\b/i);
  if (q && +q[1] > 0) { qty = +q[1]; followed.push(`quantity ${qty} (from "${q[0]}")`); }
  const price = t.match(/(?:price|pay|total|charge|for)\s*(?:is|of|:)?\s*\$\s?(\d+(?:\.\d{1,2})?)/i);
  if (price) { amount = round2(+price[1]); followed.push(`amount $${amount} (from "${price[0]}")`); }
  const known = [...new Set(T.CATALOG.map(c => c.merchant))];
  const other = known.find(m => m.toLowerCase() !== p.merchant.toLowerCase() && t.toLowerCase().includes(m.toLowerCase()));
  const payee = t.match(/(?:send (?:payment|money)|pay(?:ment)?)\s+to\s+([A-Za-z0-9._@-]{3,40})/i);
  if (other) { merchant = other; followed.push(`merchant "${other}"`); } else if (payee) { merchant = payee[1]; followed.push(`payee "${payee[1]}"`); }
  return { proposal: { productId: p.id, quantity: qty, amount: amount ?? round2(p.price * qty), currency: 'USD', merchant, category: p.category, listingText: t, requestedQuantity: 1 }, followed };
}

export function customAttack(id, text) {
  const r = getRun(id), a = T.agents.get(r.agentId);
  if (!a) throw err(410, 'the run\'s agent no longer exists; start a new run');
  text = String(text || '').trim().slice(0, 600);
  if (!text) throw err(400, 'write some listing text first');
  const { proposal, followed } = naiveAgent(text);
  const pf = T.preflight(a.credential, proposal, { record: false });
  const scan = T.scanListing(text);
  const caughtBy = pf.failed.length ? 'structured checks' : pf.decision !== 'allow' ? 'buyer approval gate' : 'nothing';
  const trial = { at: new Date().toISOString(), text, scan, followed, proposal: { quantity: proposal.quantity, amount: proposal.amount, merchant: proposal.merchant },
    decision: pf.decision, failed: pf.failed, checks: pf.checks, caughtBy, source: 'JUDGE-WRITTEN ATTACK', decidedBy: 'RULE-BASED DECISION' };
  T.audit('firewall', 'judge_custom_attack', r.id, { decision: pf.decision, injectionFlagged: scan.injection, proposal: trial.proposal });
  (r.trials ||= []).unshift(trial); r.trials.length = Math.min(r.trials.length, 20);
  save();
  return trial;
}

// The contiguous ledger segment covering this transaction. Anyone can recompute every hash with no PACT
// server. It proves the segment is internally consistent and chains from the anchor; it cannot prove what
// happened before the segment, or that the operator did not rebuild the whole chain.
export async function receiptData(id) {
  const ev = await evidence(id);
  const seqs = T.intentAudit(ev.transaction).map(e => e.seq);
  const lo = Math.min(...seqs), hi = Math.max(...seqs);
  const entries = T.ledger.slice(lo, hi + 1);
  return { ...ev, segment: { from: lo, to: hi, anchor: entries[0].prevHash, head: entries.at(-1).hash, mine: seqs, entries } };
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function receiptHtml(id) {
  const d = await receiptData(id);
  const json = JSON.stringify(d).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PACT receipt · ${esc(d.transaction)}</title>
<style>body{margin:0;background:#0b0e14;color:#e6e9f0;font:15px/1.5 Inter,Segoe UI,system-ui,sans-serif}main{max-width:860px;margin:40px auto;padding:0 20px}
h1{font-size:28px;margin:0 0 4px}.m{color:#8b93a7}.card{background:#121722;border:1px solid #232b3b;border-radius:12px;padding:16px 18px;margin:14px 0}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #1c2331}.row:last-child{border:0}code{font:12px ui-monospace,Consolas,monospace;color:#b9c4ff;word-break:break-all}
.ok{color:#3ecf8e}.bad{color:#ff6b6b}.big{font-size:20px;font-weight:700}.tag{font-size:11px;border:1px solid #7c9cff;border-radius:6px;padding:1px 6px;color:#b9c4ff}</style></head>
<body><main><h1>PACT transaction receipt</h1><div class="m">Transaction <code>${esc(d.transaction)}</code> · generated ${esc(d.generatedAt)}</div>
<div class="card"><div class="big" id="verdict">Verifying in this browser…</div><div class="m" id="vdetail"></div><div id="broken"></div></div>
<div class="card" id="amounts"></div>
<div class="card"><b>Receipt fingerprint</b><div class="row"><span>Head hash (SHA-256 of the whole chain up to this purchase)</span><code>${esc(d.segment.head)}</code></div>
<p class="m">Every amount above is read from inside the hashed ledger entries, not from a summary, so changing any of them changes that entry's hash. If someone rebuilt every hash to hide an edit, the head hash would no longer match the fingerprint the buyer was given at purchase time. This file covers entries ${d.segment.from}–${d.segment.to}; it does not prove what happened before entry ${d.segment.from}. Not an official PayPal document.</p>
<div class="row"><span>Anchor (hash before this segment)</span><code>${esc(d.segment.anchor)}</code></div></div>
<div class="card"><b>Events for this transaction</b><div id="events"></div></div>
<script id="data" type="application/json">${json}</script>
<script>
const d = JSON.parse(document.getElementById('data').textContent), $ = s => document.getElementById(s);
const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const money = v => v == null ? null : Number(v).toFixed(2);
(async () => {
  let prev = d.segment.anchor, bad = null;
  for (const ev of d.segment.entries) {
    const h = await sha(prev + JSON.stringify({ ...ev, hash: undefined }));
    if (ev.prevHash !== prev || h !== ev.hash) { bad = { ev, recorded: ev.hash, now: h, link: ev.prevHash !== prev }; break; }
    prev = ev.hash;
  }
  const ok = !bad && prev === d.segment.head;
  const mine = d.segment.entries.filter(x => d.segment.mine.includes(x.seq)), find = t => mine.find(x => x.type === t);
  // amounts come from the hashed entries themselves
  const amt = [['Buyer approved', 'intent_approved', x => x.data.amount], ['Agent proposed', 'intent_created', x => x.data.proposal?.amount],
    ['Merchant committed', 'merchant_commitment_recorded', x => x.data.price], ['PayPal captured', 'payment_captured', x => x.data.amount]]
    .map(([label, type, f]) => { const x = find(type); return { label, type, seq: x?.seq, v: x ? money(f(x)) : null }; });
  const base = amt[0].v, odd = amt.filter(a => a.v != null && base != null && a.v !== base);
  $('verdict').innerHTML = ok ? '<span class="ok">✓ Verified in this browser: ' + d.segment.entries.length + ' ledger entries, every hash matches</span>' : '<span class="bad">✗ Verification FAILED: this file was altered after PACT issued it</span>';
  $('vdetail').textContent = odd.length ? 'Recorded amounts disagree: ' + odd.map(a => a.label + ' $' + a.v).join(', ') + ' vs buyer-approved $' + base + '.' : 'All four recorded amounts agree: $' + base + '.';
  if (bad) {
    const conflict = odd.filter(a => a.seq === bad.ev.seq);
    $('broken').innerHTML = '<div style="margin-top:12px;padding:12px 14px;border:1px solid #ff6b6b;border-radius:10px;background:rgba(255,107,107,.07)">'
      + '<div class="row"><span>Altered entry</span><b>#' + bad.ev.seq + ' ' + e(bad.ev.type.replace(/_/g, ' ')) + '</b></div>'
      + (conflict.length ? conflict.map(a => '<div class="row"><span>Field that changed</span><b class="bad">' + e(a.type) + '.amount = $' + a.v + ' (approved: $' + base + ')</b></div>').join('') : '')
      + '<div class="row"><span>Hash recorded at issue</span><code>' + e(bad.recorded) + '</code></div>'
      + '<div class="row"><span>Hash of the content now</span><code class="bad">' + e(bad.now) + '</code></div></div>';
  }
  $('amounts').innerHTML = '<b>Who recorded what</b> <span class="m">(read from the hashed entries)</span>' + amt.map(a => '<div class="row"><span>' + e(a.label) + (a.seq != null ? ' <span class="m">· entry #' + a.seq + '</span>' : '') + '</span><b' + (odd.includes(a) ? ' class="bad"' : '') + '>' + (a.v == null ? '<span class="m">missing</span>' : '$' + a.v) + '</b></div>').join('') +
    '<div class="row"><span>PayPal order / capture (' + e(d.paypal?.source) + ')</span><code>' + e(find('payment_captured')?.data.orderId) + ' / ' + e(find('payment_captured')?.data.captureId) + '</code></div>';
  $('events').innerHTML = mine.map(x => '<div class="row"><span>#' + x.seq + ' ' + e(x.type.replace(/_/g, ' ')) + ' <span class="m">· ' + e(x.actor) + ' · ' + e(x.at.slice(0, 19).replace('T', ' ')) + '</span></span><code>' + e(x.hash.slice(0, 16)) + '…</code></div>').join('');
})();
</script></main></body></html>`;
}
