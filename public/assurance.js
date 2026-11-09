// PACT — Transaction Assurance tab
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (p, o = {}) => { const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
const lvl = l => `<span class="dec ${l === 'high' ? 'block' : l === 'medium' ? 'require_approval' : 'allow'}">${esc(l)}</span>`;
import { statusBadge } from './merchant.js';
const src = s =>`<span class="src ${/simulat/i.test(s) ? 'sim' : ''}">${esc(s)}</span>`;
let selected = null;

export async function loadAssurance() {
  const list = await api('/api/assurance');
  $('#assList tbody').innerHTML = list.map(t => `<tr data-id="${t.intentId}" class="${t.intentId === selected ? 'sel' : ''}"><td class="mono">${esc(t.intentId)}<div class="muted small">${esc(t.initiator)}</div></td><td>${esc(t.title)}</td><td>$${t.amount}</td>
    <td>${statusBadge(t.txnStatus)}</td><td>${t.health}</td><td>${esc(t.commitment)}</td><td>${lvl(t.disputeRisk)}</td><td>${t.evidence}%</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No transactions yet. Run the scenarios on the Merchant Dashboard.</td></tr>';
  document.querySelectorAll('#assList tr[data-id]').forEach(r => r.onclick = () => { selected = r.dataset.id; loadAssurance(); });
  if (selected) showChain();
}

async function showChain() {
  const c = await api(`/api/assurance/${selected}`);
  const r = c.reconciliation, d = c.disputeRisk;
  $('#chain').innerHTML = `
    <div><b>${esc(c.intentId)}</b> ${esc(c.title)} · $${c.amount} · ${statusBadge(c.txnStatus)} · health <b>${c.health}</b> · ${esc(c.initiator)}</div>
    <div class="small muted">${c.statusReasons.map(esc).join(' · ')}</div>
    <div class="chain">${c.steps.map(s => `<div class="step ${s.state}"><span></span><b>${esc(s.name)}</b><span>${esc(s.detail)}</span></div>`).join('')}</div>
    <h3>Payment reconciliation ${r.reconciled ? '<span class="dec allow">reconciled</span>' : r.mismatches.length ? '<span class="dec block">mismatch</span>' : ''}</h3>
    <table class="recon">${r.rows.map(x => `<tr><td>${esc(x.label)}</td><td>${x.value == null ? '—' : '$' + x.value}</td><td>${x.value == null ? '' : src(x.source)}</td></tr>`).join('')}</table>
    ${r.mismatches.map(m => `<p class="err">⚠ ${esc(m)}</p>`).join('')}
    <h3>Merchant commitment ${c.commitment.issues.length ? '<span class="dec block">breached</span>' : ''}</h3>
    ${c.commitment.issues.map(i => `<p class="err">⚠ ${esc(i.msg)}</p>`).join('') || '<p class="muted small">All commitments met so far.</p>'}
    <h3>Dispute risk ${lvl(d.level)} <span class="muted small">${d.score}/100</span></h3>
    <div class="small">${d.why.map(esc).join(' · ')}</div>${d.actions.length ? `<ul class="small">${d.actions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
    <p class="muted small">${esc(d.note)}</p>
    <h3>Simulate the world <span class="muted small">(labelled as simulated)</span></h3>
    <div class="mini">
      <button data-m='{"type":"shipped","tracking":"SIM-TRK-1001","carrier":"DemoPost"}'>Merchant: shipped + tracking</button>
      <button data-m='{"type":"delivery_date_changed","late":5}'>Merchant: delay 5 days</button>
      <button data-m='{"type":"delivered","tracking":"SIM-TRK-1001","carrier":"DemoPost"}'>Merchant: delivered</button>
      <button data-m='{"type":"cancelled"}'>Merchant: cancelled</button>
      <button data-agent>Agent claims "paid $${c.amount}"</button>
      <button data-pp>PayPal event with different amount</button>
    </div>
    <h3>Dispute package</h3>
    <div class="ask"><select id="claim"><option value="not_received">Item not received</option><option value="unauthorized">Unauthorized</option><option value="not_as_described">Not as described</option><option value="refund_not_received">Refund not received</option></select><button id="pkg">Prepare</button></div>
    <div id="pkgOut"></div>
    <h3>Evidence timeline</h3>
    <div class="tl mono small">${c.timeline.map(e => `<div>#${e.seq} ${e.at.slice(0, 19).replace('T', ' ')} <b>${esc(e.type)}</b> ${src(e.source)}</div>`).join('')}</div>`;
  const deliveryBy = c.commitment.terms?.deliveryBy;
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => {
    const m = JSON.parse(b.dataset.m);
    if (m.late) { m.estimatedDelivery = new Date(new Date(deliveryBy).getTime() + m.late * 864e5).toISOString(); delete m.late; }
    await api(`/api/assurance/${selected}/merchant-event`, { method: 'POST', body: m }); loadAssurance();
  });
  $('[data-agent]').onclick = async () => { await api(`/api/assurance/${selected}/agent-report`, { method: 'POST', body: { amount: c.amount, status: 'paid' } }); loadAssurance(); };
  $('[data-pp]').onclick = async () => { await api(`/api/assurance/${selected}/paypal-event-sim`, { method: 'POST', body: { event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: Math.round(c.amount * 0.9 * 100) / 100 } }); loadAssurance(); };
  $('#pkg').onclick = async () => {
    const p = await api(`/api/assurance/${selected}/dispute`, { method: 'POST', body: { claim: $('#claim').value } });
    $('#pkgOut').innerHTML = `<p>${p.canContest ? '<span class="dec allow">evidence supports merchant</span>' : '<span class="dec block">cannot contest</span>'} ${esc(p.recommendation)}</p>
      <ol class="small">${p.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ol>${p.missing.length ? `<p class="small err">Missing: ${p.missing.map(esc).join(', ')}</p>` : ''}<p class="muted small">${esc(p.note)}</p>`;
  };
}

$('#lifeSim').onclick = async () => {
  $('#lifeOut').innerHTML = '<p class="muted">Running…</p>';
  const r = await api('/api/assurance/simulate', { method: 'POST' });
  $('#lifeOut').innerHTML = `<div class="kpis"><div><span>Demos</span><b>${r.total}</b></div><div><span>Problems detected</span><b class="${r.passed === r.total ? 'ok' : 'bad'}">${r.passed}/${r.total}</b></div></div>
    <table><thead><tr><th>Demo</th><th>Scenario</th><th>Result</th><th>What PACT found</th></tr></thead><tbody>
    ${r.demos.map(d => `<tr><td><b>${esc(d.demo)}</b></td><td class="why">${esc(d.scenario)}</td><td>${d.detected ? '<span class="dec allow">detected</span>' : '<span class="dec block">missed</span>'}</td>
      <td class="why">${d.findings.map(esc).join('<br>')}${d.actions?.length ? '<br><i>→ ' + d.actions.map(esc).join('; ') + '</i>' : ''}</td></tr>`).join('')}</tbody></table><p class="muted small">${esc(r.note)}</p>`;
  selected = r.demos[0].intentId; loadAssurance();
};
