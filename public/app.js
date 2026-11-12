import { loadAssurance } from './assurance.js';
import { loadIncidents } from './incidents.js';
import { loadMerchant } from './merchant.js';
const $ = s => document.querySelector(s);
let cfg = {}, session = null, es = null, current = null;

const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { data: j });
  return j;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const badge = d => `<span class="dec ${d}">${esc(String(d).replace('_', ' '))}</span>`;

function tab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === name));
  ({ merchant: loadMerchant, command: loadAgents, assurance: loadAssurance, incidents: loadIncidents, trust: loadTrust, payments: loadPayments })[name]?.();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => tab(b.dataset.tab));
document.querySelectorAll('.examples a').forEach(a => a.onclick = () => $('#intent').value = a.textContent);
const formObj = sel => { const o = Object.fromEntries(new FormData($(sel))); for (const k in o) if (o[k] !== '' && !isNaN(o[k]) && !/Merchants|Categories/.test(k)) o[k] = Number(o[k]); return o; };

// ---------------- Passports ----------------
async function loadAgents() {
  const list = await api('/api/agents');
  $('#agentSel').innerHTML = list.filter(a => a.status === 'active').map(a => `<option value="${a.id}">${a.id} — ${esc(a.name)}</option>`).join('');
  $('#agents').innerHTML = list.map(a => {
    const P = a.permissions, exp = new Date(P.expiresAt);
    return `<div class="passport ${a.status}">
      <div class="ph"><b>${a.id}</b> ${esc(a.name)} <span class="dec ${a.status === 'active' ? 'allow' : 'block'}">${a.status}</span></div>
      <div class="pg">
        <span>Owner</span><b>${esc(a.owner)}</b><span>Max / txn</span><b>$${P.maxPerTxn}</b>
        <span>Daily</span><b>$${a.spentToday} / $${P.dailyBudget}</b><span>Approval above</span><b>$${P.approvalAbove}</b>
        <span>Categories</span><b>${esc(P.allowedCategories.join(', ') || 'any')}</b><span>Merchants</span><b>${esc(P.allowedMerchants.join(', ') || 'any')}</b>
        <span>Blocked</span><b>${P.blockedMerchants.length}</b><span>Expires</span><b>${exp.toLocaleString()}</b>
        <span>Policy version</span><b>v${a.policyVersion}</b><span>Credential</span><b class="mono cred" title="${esc(a.credential)}">${esc(a.credential.slice(0, 28))}…</b>
      </div>
      ${a.status === 'active' ? `<div class="pa"><button data-tighten="${a.id}">Halve limit (re-sign)</button><button class="danger" data-revoke="${a.id}">Revoke now</button></div>` : ''}
    </div>`;
  }).join('');
  document.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { await api(`/api/agents/${b.dataset.revoke}/revoke`, { method: 'POST' }); loadAgents(); });
  document.querySelectorAll('[data-tighten]').forEach(b => b.onclick = async () => {
    const a = list.find(x => x.id === b.dataset.tighten);
    await api(`/api/agents/${a.id}/permissions`, { method: 'POST', body: { maxPerTxn: Math.round(a.permissions.maxPerTxn / 2) } }); loadAgents();
  });
}
$('#register').onclick = async () => { await api('/api/agents/register', { method: 'POST', body: { name: formObj('#newAgent').name, permissions: formObj('#newAgent') } }); loadAgents(); };

// ---------------- Shopping session ----------------
$('#go').onclick = async () => {
  const policy = formObj('#policy');
  $('#liveMax').value = policy.maxPerItem; $('#liveMaxV').textContent = '$' + policy.maxPerItem;
  $('#liveRisk').value = policy.maxRiskScore; $('#liveRiskV').textContent = policy.maxRiskScore;
  $('#feed').innerHTML = ''; $('#cands').innerHTML = ''; $('#rec').textContent = 'Agents working…';
  const { id } = await api('/api/sessions', { method: 'POST', body: { text: $('#intent').value, policy, agentId: $('#agentSel').value } });
  tab('workspace');
  es?.close();
  es = new EventSource(`/api/sessions/${id}/events`);
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.agent === 'system' && ev.data) { session = ev.data; render(); return; }
    const d = document.createElement('div'); d.className = 'ev ' + ev.agent;
    d.innerHTML = `<b>${ev.agent}</b><span>${esc(ev.msg)}</span>`;
    $('#feed').appendChild(d); $('#feed').scrollTop = 1e9;
  };
};

function render() {
  if (!session) return;
  const rec = session.recommendation;
  $('#rec').innerHTML = rec ? esc(rec.explanation) : '<span class="err">No option satisfies your policy.</span>';
  $('#cands').innerHTML = session.candidates.map(c => `
    <div class="cand ${c.policy.allowed ? '' : 'blocked'} ${rec?.id === c.id ? 'top' : ''}">
      <div><div class="t">${esc(c.title)}${rec?.id === c.id ? '<span class="pill">AI pick</span>' : ''}</div>
        <div class="m">${esc(c.merchant)} · ★${c.merchantRating} · risk ${c.riskScore} · ${c.shippingDays}d ship${c.appliedOffer ? ' · ' + esc(c.appliedOffer) + ' −$' + c.savings : ''}</div></div>
      <div><div class="p">$${c.finalPrice.toFixed(2)}</div>${c.policy.allowed ? `<button data-approve="${c.id}">Approve</button>` : ''}</div>
      ${c.policy.allowed ? '' : `<div class="v">⛔ ${c.policy.violations.map(v => esc(v.msg)).join(' · ')}</div>`}
    </div>`).join('') || '<p class="muted">No options.</p>';
  document.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => approve(b.dataset.approve));
}

let liveTimer;
function liveUpdate() {
  $('#liveMaxV').textContent = '$' + $('#liveMax').value; $('#liveRiskV').textContent = $('#liveRisk').value;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    if (!session) return;
    session = await api(`/api/sessions/${session.id}/policy`, { method: 'PUT', body: { maxPerItem: +$('#liveMax').value, maxRiskScore: +$('#liveRisk').value } });
    render();
  }, 350);
}
$('#liveMax').oninput = liveUpdate; $('#liveRisk').oninput = liveUpdate;

// ---------------- Approval → PayPal ----------------
async function approve(candidateId) {
  const c = session.candidates.find(x => x.id === candidateId);
  tab('payments');
  $('#paypal-buttons').innerHTML = '';
  try {
    const o = await api(`/api/sessions/${session.id}/approve`, { method: 'POST', body: { candidateId } });
    current = o;
    const sc = o.preflight.scores;
    $('#approval').innerHTML = `<div class="approve-box"><div class="muted">You are authorising</div><div class="amt">$${o.amount.toFixed(2)}</div>
      <div>${esc(c.title)} · ${esc(c.merchant)}</div>
      <div class="scores">${badge(o.preflight.decision)} agent health <b>${sc.agentHealth}</b> · anomaly <b>${sc.behaviorAnomaly}</b> · merchant risk <b>${sc.merchantRisk}</b> · txn risk <b>${sc.transactionRisk}</b></div>
      <div class="checks">${o.preflight.checks.map(k => `<span class="${k.pass ? 'ok' : 'bad'}">${k.pass ? '✓' : '✗'} ${esc(k.name)}</span>`).join('')}</div>
      <div class="muted">Intent ${esc(o.intentId)} · PayPal order ${esc(o.orderId)}. The approval is bound to this exact amount, merchant and agent.</div>
      <button class="ghost" id="tamper">Simulate: merchant changes total to $${(o.amount * 1.2).toFixed(2)}</button></div>`;
    $('#tamper').onclick = async () => {
      const r = await fetch(`/api/intents/${o.intentId}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: +(o.amount * 1.2).toFixed(2) }) }).then(r => r.json());
      showErr(r.reason || 'checkout confirmed'); $('#paypal-buttons').innerHTML = '';
    };
    if (o.simulated) {
      $('#paypal-buttons').innerHTML = `<button class="sim">Pay with PayPal (simulated sandbox)</button>`;
      $('#paypal-buttons button').onclick = () => capture(o.intentId);
    } else {
      await loadPayPal();
      paypal.Buttons({ createOrder: () => o.orderId, onApprove: () => capture(o.intentId), onError: e => showErr(e.message) }).render('#paypal-buttons');
    }
  } catch (e) {
    $('#approval').innerHTML = `<div class="approve-box blockbox"><div class="amt">⛔ Blocked</div>${esc(e.message)}<ul>${(e.data?.failed || []).map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>`;
  }
}
async function capture(intentId) {
  try {
    const t = await api(`/api/intents/${intentId}/capture`, { method: 'POST' });
    $('#approval').innerHTML = `<div class="approve-box">✅ Paid $${t.amount} · capture ${esc(t.captureId)} <button class="ghost" id="again">Try paying again (duplicate)</button></div>`;
    $('#again').onclick = () => capture(intentId);
    $('#paypal-buttons').innerHTML = '';
    loadPayments();
  } catch (e) { showErr(e.message); }
}
const showErr = m => $('#approval').insertAdjacentHTML('beforeend', `<p class="err">⛔ ${esc(m)}</p>`);
function loadPayPal() {
  if (window.paypal) return Promise.resolve();
  return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = `https://www.paypal.com/sdk/js?client-id=${cfg.paypalClientId}&currency=USD&intent=capture`; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
}

// ---------------- Trust ops ----------------
$('#sim').onclick = async () => {
  $('#simOut').innerHTML = '<p class="muted">Running…</p>';
  const r = await api('/api/security/simulate', { method: 'POST' });
  const s = r.summary;
  $('#simOut').innerHTML = `
    <div class="kpis"><div><span>Attack attempts</span><b>${s.attackAttempts}</b></div><div><span>Blocked attacks</span><b class="${s.blockedAttacks === s.attackAttempts ? 'ok' : 'bad'}">${s.blockedAttacks}</b></div>
      <div><span>Legitimate payment</span><b class="ok">${esc(s.legitimatePayment)} $${s.legitimate.amount}</b></div><div><span>Preflight p50 / p95</span><b>${r.metrics.preflightP50ms} / ${r.metrics.preflightP95ms} ms</b></div></div>
    <table><thead><tr><th>Attack</th><th>Expected</th><th>Result</th><th>What the firewall did</th></tr></thead><tbody>
    ${r.attacks.map(a => `<tr><td>${esc(a.attack)}</td><td>${esc(a.expected)}</td><td>${a.blocked ? '<span class="dec allow">stopped</span>' : '<span class="dec block">GOT THROUGH</span>'}</td><td class="why">${esc(a.outcome)}</td></tr>`).join('')}
    <tr><td>Legitimate $420 purchase</td><td>Pass</td><td><span class="dec allow">${esc(s.legitimatePayment)}</span></td><td class="why">PayPal ${esc(s.legitimate.orderId)} · ${esc(s.legitimate.captureId)}</td></tr></tbody></table>
    <p class="muted">${esc(r.note)}</p>`;
  loadTrust();
};
async function loadTrust() {
  const [ints, sec, led] = await Promise.all([api('/api/intents'), api('/api/security/events'), api('/api/ledger')]);
  $('#intents').innerHTML = ints.map(i => `<div class="row"><div>${badge(i.preflight.decision)} <b>${esc(i.id)}</b> ${esc(i.agentId)} · ${esc(i.title)} · $${i.amount} → <i>${esc(i.status)}</i></div>
    <div class="muted small">${i.preflight.failed.length ? esc(i.preflight.failed.join(' · ')) : `health ${i.preflight.scores.agentHealth} · anomaly ${i.preflight.scores.behaviorAnomaly} · txn risk ${i.preflight.scores.transactionRisk} · ${esc(i.preflight.reasons.behavior.join(', '))}`}</div></div>`).join('') || '<p class="muted">None yet.</p>';
  $('#secEvents').innerHTML = sec.events.map(e => `<div class="row"><b class="kind">${esc(e.kind)}</b> ${esc(e.agentId)}<div class="muted small">${esc(e.detail)}</div></div>`).join('') || '<p class="muted">None yet.</p>';
  $('#ledgerOk').innerHTML = led.integrity.ok ? `<span class="dec allow">hash chain intact · ${led.integrity.length} events</span>` : `<span class="dec block">BROKEN at ${led.integrity.brokenAt}</span>`;
  $('#ledger').innerHTML = led.events.map(e => `<div>#${e.seq} ${e.at.slice(11, 19)} <b>${esc(e.type)}</b> ${esc(e.actor)} → ${esc(e.ref)} <span class="muted">${e.hash.slice(0, 12)}</span></div>`).join('');
}

// ---------------- Payments / merchants / disputes ----------------
async function loadPayments() {
  const [{ transactions }, merchants] = await Promise.all([api('/api/transactions'), api('/api/merchants')]);
  $('#txns tbody').innerHTML = transactions.map(t => `<tr><td>${new Date(t.at).toLocaleString()}</td><td>${esc(t.agentId)}</td><td>${esc(t.title)}</td><td>$${t.amount}</td>
    <td class="mono">${esc(t.orderId)}</td><td class="mono">${esc(t.captureId)}</td><td>${badge(t.decision)} risk ${t.scores.transactionRisk}</td><td><button class="ghost" data-audit="${t.intentId}">audit</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No transactions yet.</td></tr>';
  $('#evTxn').innerHTML = transactions.map(t => `<option value="${t.intentId}">${esc(t.intentId)} — ${esc(t.title)}</option>`).join('');
  document.querySelectorAll('[data-audit]').forEach(b => b.onclick = async () => {
    const r = await api(`/api/transactions/${b.dataset.audit}/audit`);
    $('#auditOut').innerHTML = r.events.map(e => `<div>#${e.seq} ${e.at.slice(11, 19)} <b>${esc(e.type)}</b> by ${esc(e.actor)} <span class="muted">${e.hash.slice(0, 12)}</span></div>`).join('') + `<p>${r.ledger.ok ? '✓ chain verified' : '✗ chain broken'}</p>`;
  });
  $('#merchants tbody').innerHTML = merchants.map(m => `<tr><td><b>${esc(m.merchant)}</b><div class="muted small">★${m.rating} · ${m.ageDays} days</div></td>
    <td><div class="bar"><i style="width:${m.aiReadiness}%"></i></div>${m.aiReadiness}</td><td>${m.listingCompleteness}%</td><td>${m.riskScore}</td>
    <td>${m.agentAttempts} / ${m.blocked} / ${m.paid}</td><td class="why">${esc(m.gaps.join(' · ') || 'nothing — AI-commerce ready')}</td></tr>`).join('');
}
$('#evBtn').onclick = async () => {
  if (!$('#evTxn').value) return;
  const r = await api('/api/disputes/prepare-evidence', { method: 'POST', body: { intentId: $('#evTxn').value, claim: $('#evClaim').value } });
  $('#evidence').innerHTML = `<p>Evidence strength: <span class="dec ${r.strength === 'strong' ? 'allow' : r.strength === 'partial' ? 'require_approval' : 'block'}">${r.strength}</span></p>
    <div class="checks">${r.have.map(h => `<span class="ok">✓ ${esc(h.label)}</span>`).join('')}${r.missing.map(m => `<span class="bad">✗ ${esc(m.label)}</span>`).join('')}</div>
    <h3>Draft response</h3><p>${esc(r.draftResponse)}</p><p class="muted small">${esc(r.note)}</p>`;
};
$('#askBtn').onclick = async () => { $('#answer').textContent = '…'; $('#answer').textContent = (await api('/api/assistant', { method: 'POST', body: { question: $('#q').value } })).answer; };

cfg = await api('/api/config');
$('#mode').innerHTML = `PayPal<i>${cfg.paypalLive ? 'SANDBOX' : 'SIMULATED'}</i> AI<i>${cfg.llm ? (cfg.llmLabel || 'on').split(' ')[0] : 'rules'}</i>`;
loadAgents(); loadMerchant();
