// PACT — Transaction Incident & Resolution Center tab
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (p, o = {}) => { const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
const sev = s => `<span class="dec ${s === 'critical' || s === 'high' ? 'block' : 'require_approval'}">${esc(s)}</span>`;
const st = s => `<span class="dec ${s === 'resolved' ? 'allow' : s === 'under_review' ? 'require_approval' : 'block'}">${esc(s.replace('_', ' '))}</span>`;
const ns = s => `<span class="src ${s === 'sent' ? '' : 'sim'}">${esc(s)}</span>`;
const lab = { yes: '✓', no: '—', if_relevant: 'if relevant', on_escalation: 'on escalation' };
let sel = null;

export async function loadIncidents() {
  await api('/api/incidents/scan', { method: 'POST' });
  const { incidents, routing, channels } = await api('/api/incidents');
  $('#incChannels').innerHTML = `Email ${channels.email ? '<b class="ok">connected</b>' : '<b class="bad">not configured → outbox</b>'} ·
    Buyer address ${channels.buyerEmail ? '<b class="ok">set</b>' : '<b class="bad">not set</b>'} ·
    PayPal reporting ${channels.paypalReporting ? '<b class="ok">authorized integration</b>' : '<b class="bad">none → drafts only</b>'}`;
  $('#routing tbody').innerHTML = Object.entries(routing).map(([k, r]) => `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td>${sev(r.severity)}</td><td>✓</td><td>${lab[r.merchant]}</td><td>${lab[r.paypal]}</td></tr>`).join('');
  $('#incList tbody').innerHTML = incidents.map(i => `<tr data-id="${i.id}" class="${i.id === sel ? 'sel' : ''}"><td class="mono">${esc(i.id)}</td><td>${esc(i.kind.replace(/_/g, ' '))}</td><td>${sev(i.severity)}</td><td>${st(i.status)}</td>
    <td>${esc(i.title)}</td><td class="small">${i.notified.map(n => esc(n)).join('<br>')}</td><td>${esc(i.awaiting.join(', ') || '—')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No incidents. Run the lifecycle demos or the attack simulation.</td></tr>';
  document.querySelectorAll('#incList tr[data-id]').forEach(r => r.onclick = () => { sel = r.dataset.id; loadIncidents(); });
  if (sel) show();
}

async function show() {
  const i = await api(`/api/incidents/${sel}`);
  $('#incDetail').innerHTML = `
    <div><b>${esc(i.id)}</b> ${sev(i.severity)} ${st(i.status)} · ${esc(i.kind.replace(/_/g, ' '))} · intent ${esc(i.intentId)}</div>
    <p>${esc(i.detail)}</p>
    <h3>Notifications</h3>
    ${i.notifications.map(n => `<details class="mail"><summary><b>${esc(n.party)}</b> → ${esc(n.to || '—')} ${ns(n.status)} <span class="muted small">${esc(n.subject)}</span></summary>
      <pre class="answer small">${esc(n.body)}</pre><div class="muted small">Why: ${esc(n.why)}${n.reason ? ' · ' + esc(n.reason) : ''}</div></details>`).join('')}
    <h3>Verification requests</h3>
    ${i.requests.map(r => `<div class="small">${r.status === 'answered' ? '✓' : '⏳'} <b>${esc(r.party)}</b>: ${esc(r.what)}</div>`).join('')}
    <h3>Record a response</h3>
    <div class="ask"><select id="rParty"><option>merchant</option><option>buyer</option><option>paypal</option></select><input id="rMsg" placeholder="e.g. Charged $378 after coupon SAVE10, order #A-1"><button id="rBtn">Add</button></div>
    ${i.responses.map(r => `<div class="small">💬 <b>${esc(r.party)}</b> ${esc(r.at.slice(11, 19))}: ${esc(r.message)}</div>`).join('')}
    <h3>Workflow</h3>
    <div class="mini">
      <button data-s="under_review" ${i.status !== 'open' ? 'disabled' : ''}>Mark under review</button>
      <input id="resNote" placeholder="Resolution note (required)" style="width:auto;flex:1">
      <button data-s="resolved" ${i.status === 'resolved' ? 'disabled' : ''}>Resolve</button>
      <button id="esc" ${i.escalated || i.notifications.some(n => n.party === 'paypal') ? 'disabled' : ''}>Escalate to PayPal (authorized channel)</button>
    </div>
    ${i.resolution ? `<p class="small">✅ Resolved by ${esc(i.resolution.by)}: ${esc(i.resolution.note)}</p>` : ''}
    <p class="muted small">PACT flags discrepancies and requests verification. It never refunds, cancels, files a dispute or accuses anyone.</p>
    <h3>Incident timeline</h3>
    <div class="tl mono small">${i.timeline.map(t => `<div>${esc(t.at.slice(0, 19).replace('T', ' '))} <b>${esc(t.type)}</b> ${esc(t.actor)}${t.data.party ? ' → ' + esc(t.data.party) : ''}${t.data.to ? ' (' + esc(t.data.to) + ')' : ''}</div>`).join('')}</div>
    <p id="incErr" class="err"></p>`;
  const err = e => $('#incErr').textContent = '⛔ ' + e.message;
  $('#rBtn').onclick = () => api(`/api/incidents/${sel}/respond`, { method: 'POST', body: { party: $('#rParty').value, message: $('#rMsg').value } }).then(loadIncidents, err);
  document.querySelectorAll('[data-s]').forEach(b => b.onclick = () => api(`/api/incidents/${sel}/status`, { method: 'POST', body: { status: b.dataset.s, note: $('#resNote').value } }).then(loadIncidents, err));
  $('#esc').onclick = () => api(`/api/incidents/${sel}/escalate`, { method: 'POST' }).then(loadIncidents, err);
}
