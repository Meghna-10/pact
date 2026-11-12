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
<div class="card"><div class="big" id="verdict">Verifying in this browser…</div><div class="m" id="vdetail"></div></div>
<div class="card" id="amounts"></div>
<div class="card"><b>What this proves</b><p class="m">This file contains ledger entries ${d.segment.from}–${d.segment.to}. Your browser recomputes every SHA-256 hash with no PACT server involved. If anyone edited an amount, a timestamp or an event in this file, verification fails. It does <b>not</b> prove what happened before entry ${d.segment.from}, and it does not stop an operator who rebuilds the entire chain: compare the head hash with one recorded elsewhere. Not an official PayPal document.</p>
<div class="row"><span>Anchor (hash before this segment)</span><code>${esc(d.segment.anchor)}</code></div><div class="row"><span>Head hash</span><code>${esc(d.segment.head)}</code></div></div>
<div class="card"><b>Events for this transaction</b><div id="events"></div></div>
<script id="data" type="application/json">${json}</script>
<script>
const d = JSON.parse(document.getElementById('data').textContent), $ = s => document.getElementById(s);
const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
(async () => {
  let prev = d.segment.anchor, bad = null;
  for (const ev of d.segment.entries) {
    const h = await sha(prev + JSON.stringify({ ...ev, hash: undefined }));
    if (ev.prevHash !== prev || h !== ev.hash) { bad = ev.seq; break; }
    prev = ev.hash;
  }
  const amt = [['Buyer approved', d.buyerApproval?.amount], ['Agent proposed', d.agentProposal?.proposal?.amount], ['Merchant committed', d.merchantCommitment?.price], ['PayPal captured (' + (d.paypal?.source || '') + ')', d.paypal?.amount]];
  const vals = amt.map(a => a[1]).filter(v => v != null).map(v => Number(v).toFixed(2)), agree = vals.length > 1 && vals.every(v => v === vals[0]);
  const ok = bad === null && prev === d.segment.head;
  $('verdict').innerHTML = ok ? '<span class="ok">✓ Ledger segment verified (' + d.segment.entries.length + ' entries)</span>' : '<span class="bad">✗ Verification FAILED at entry ' + e(bad ?? 'head') + ': this file was altered</span>';
  $('vdetail').textContent = agree ? 'All recorded amounts agree: $' + vals[0] : 'Recorded amounts differ: evidence for investigation, not proof of fraud.';
  $('amounts').innerHTML = '<b>Who recorded what</b>' + amt.map(a => '<div class="row"><span>' + e(a[0]) + '</span><b>' + (a[1] == null ? '<span class="m">missing</span>' : '$' + Number(a[1]).toFixed(2)) + '</b></div>').join('') +
    '<div class="row"><span>PayPal order / capture</span><code>' + e(d.paypal?.orderId) + ' / ' + e(d.paypal?.captureId) + '</code></div>';
  const mine = new Set(d.segment.mine);
  $('events').innerHTML = d.segment.entries.filter(x => mine.has(x.seq)).map(x => '<div class="row"><span>#' + x.seq + ' ' + e(x.type.replace(/_/g, ' ')) + ' <span class="m">· ' + e(x.actor) + ' · ' + e(x.at.slice(0, 19).replace('T', ' ')) + '</span></span><code>' + e(x.hash.slice(0, 16)) + '…</code></div>').join('');
})();
</script></main></body></html>`;
}
