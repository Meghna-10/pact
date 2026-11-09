// PACT — Merchant Dashboard (home)
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (p, o = {}) => { const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
const ST = { verified: 'allow', mismatch: 'block', missing: 'block', pending: 'require_approval', unverified: 'hold' };
export const statusBadge = s => `<span class="dec ${ST[s] || ''}">${esc(s)}</span>`;

export async function loadMerchant() {
  const [m, refunds, cfg] = await Promise.all([api('/api/impact'), api('/api/refunds'), api('/api/config')]);
  const t = m.transactions;
  $('#kpi').innerHTML = [
    ['Transactions monitored', t.total, `${t.human} human · ${t.agent} AI agent`],
    ['Verified', t.byStatus.verified || 0, 'records agree'],
    ['Reconciliation discrepancies', m.reconciliationDiscrepancies, 'found by PACT'],
    ['Duplicate captures detected', m.duplicateCapturesDetected, `${m.duplicateDeliveriesIgnored} webhook redeliveries ignored`],
    ['Refunds awaiting / overdue', `${m.refundsAwaiting} / ${m.refundsOverdue}`, 'vs merchant deadline'],
    ['Incidents open · review · resolved', `${m.incidents.open} · ${m.incidents.underReview} · ${m.incidents.resolved}`, m.avgTimeToResolutionMin != null ? `avg ${m.avgTimeToResolutionMin} min to resolve` : 'none resolved yet'],
    ['Evidence completeness', m.evidenceCompletenessAvg != null ? m.evidenceCompletenessAvg + '%' : '—', 'average per transaction'],
    ['Avg transaction health', t.avgHealth ?? '—', '0-100'],
  ].map(([l, v, s]) => `<div><span>${esc(l)}</span><b>${esc(v)}</b><small>${esc(s)}</small></div>`).join('');
  $('#statusBar').innerHTML = ['verified', 'pending', 'mismatch', 'missing', 'unverified'].map(s => `${statusBadge(s)} ${t.byStatus[s] || 0}`).join(' &nbsp; ');
  $('#impactNote').textContent = m.note;
  $('#storage').textContent = `Storage: SQLite ${cfg.storage.file} · PayPal webhooks ${cfg.webhooks ? 'configured' : 'not configured (simulated events only)'}`;
  $('#refunds tbody').innerHTML = refunds.map(r => `<tr><td class="mono">${esc(r.intentId)}</td><td>${esc(r.title)}</td><td>${esc(r.merchant)}</td><td>$${r.expected}</td><td>$${r.refunded}</td>
    <td>${r.deadline.slice(0, 10)}</td><td>${r.state === 'refunded' ? '<span class="dec allow">refunded</span>' : r.state === 'overdue' ? `<span class="dec block">overdue ${r.daysOverdue}d</span>` : '<span class="dec require_approval">awaiting</span>'}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted">No refunds owed.</td></tr>';
}

$('#seed').onclick = async () => {
  $('#scen').innerHTML = '<p class="muted">Resetting and running the 5 scenarios…</p>';
  const r = await api('/api/demo/seed', { method: 'POST' });
  $('#scen').innerHTML = `<p><b class="${r.passed === r.total ? 'ok' : 'bad'}">${r.passed}/${r.total} scenarios passed</b> · ${r.incidents} incidents opened</p>
    ${r.scenarios.map(s => `<details class="mail" ${s.passed ? '' : 'open'}><summary>${s.passed ? '✅' : '❌'} <b>${s.n}. ${esc(s.name)}</b> ${s.txnStatus ? statusBadge(s.txnStatus) : ''} <span class="muted small">${esc(s.initiator || '')}${s.health != null ? ' · health ' + s.health : ''}</span></summary>
      ${s.sourceRecords ? `<div class="small"><b>Source records</b><ul>${s.sourceRecords.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="small"><b>PACT found:</b> ${esc(s.finding)}</div><div class="small"><b>Why:</b> ${esc(s.why)}</div><div class="small"><b>Recommended:</b> ${esc(s.action)}</div></details>`).join('')}
    <p class="muted small">${esc(r.note)}</p>`;
  loadMerchant();
};
$('#reset').onclick = async () => { await api('/api/demo/reset', { method: 'POST' }); $('#scen').innerHTML = '<p class="muted">All data cleared.</p>'; loadMerchant(); };
