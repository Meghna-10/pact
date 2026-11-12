// PACT Judge Mode. Renders only what the backend returns; nothing is marked green before the server confirms it.
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = n => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const TAG = { live: 'LIVE PAYPAL SANDBOX', sim: 'PAYPAL SIMULATOR', attack: 'SIMULATED ATTACK', merchant: 'SIMULATED MERCHANT EVENT', rule: 'RULE-BASED DECISION', ai: 'AI-ASSISTED EXPLANATION', manual: 'MANUAL DEMO DATA' };
const tag = (k, text) => `<span class="tag ${k === 'attack' || k === 'merchant' ? 'sim' : k}">${esc(text || TAG[k])}</span>`;
let cfg = {}, run = null;

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}
const busy = (el, text = 'Waiting for the backend…') => { el.innerHTML = `<p class="loading">${esc(text)}</p>`; };
const fail = (el, e) => el.insertAdjacentHTML('beforeend', `<div class="err">Backend returned ${esc(e.status || 'an error')}: ${esc(e.message)}</div>`);

function flow(state) { for (const li of document.querySelectorAll('#flow li')) { const s = state[li.dataset.k]; li.className = s?.[0] || ''; li.innerHTML = `${li.dataset.k === 'agent' ? 'AI agent' : li.dataset.k === 'firewall' ? 'PACT firewall' : li.dataset.k[0].toUpperCase() + li.dataset.k.slice(1)}${s?.[1] ? `<small>${esc(s[1])}</small>` : ''}`; } }

function renderModes() {
  $('#modes').innerHTML = [cfg.paypalLive ? tag('live', 'PAYPAL: LIVE SANDBOX AVAILABLE') : tag('manual', 'PAYPAL: SIMULATOR ONLY'),
    cfg.llm ? tag('ai', 'AI EXPLANATIONS: ON') : tag('rule', 'AI: OFF · RULE-BASED TEXT'), run ? tag('rule', `RUN ${run.id}`) : ''].join(' ');
}

function render() {
  renderModes();
  document.querySelectorAll('[data-act],#arun,.ex').forEach(b => { b.disabled = !run?.passport?.authorized; });
  if (!run) return;
  $('#runinfo').innerHTML = `Run <b class="mono">${esc(run.id)}</b> · started ${esc(new Date(run.createdAt).toLocaleTimeString())} · ledger ${run.ledger.ok ? `verified (${run.ledger.length} entries)` : `<b style="color:var(--bad)">BROKEN at ${run.ledger.brokenAt}</b>`}`;
  const P = run.passport, S = run.stages, st = {};
  // A
  if (!P) $('#A-body').innerHTML = '<div class="err">This run\'s agent no longer exists. Start a clean run.</div>';
  else {
    $('#A-body').innerHTML = `<div class="grid">
      <div class="kv"><span>Agent</span><b>${esc(P.name)}</b><br><code>${esc(P.agentId)}</code></div>
      <div class="kv"><span>Status</span><b>${esc(P.status)}</b></div>
      <div class="kv"><span>Permission credential</span><b>${P.credential.valid ? 'valid' : 'INVALID'}</b><br><small class="muted">${esc(P.credential.reason)}</small></div>
      <div class="kv"><span>Credential fingerprint</span><code>sha256:${esc(P.credential.fingerprint)}…</code><br><small class="muted">signed token stays on the server</small></div>
      <div class="kv"><span>Max per transaction</span><b>${usd(P.limits.maxPerTxn)}</b></div>
      <div class="kv"><span>Daily limit</span><b>${usd(P.limits.dailyBudget)}</b> <small class="muted">(${usd(P.limits.spentToday)} spent)</small></div>
      <div class="kv"><span>Buyer approval above</span><b>${usd(P.limits.approvalAbove)}</b></div>
      <div class="kv"><span>Allowed categories</span><b>${esc(P.limits.allowedCategories.join(', ') || 'any')}</b></div>
      <div class="kv"><span>Allowed merchants</span><b>${esc(P.limits.allowedMerchants.join(', ') || 'any')}</b></div>
      <div class="kv"><span>Credential expiry</span><b>${esc(new Date(P.credential.expiresAt).toLocaleString())}</b></div>
      <div class="kv"><span>Policy version</span><b>v${esc(P.credential.policyVersion)}</b> <small class="muted">(credential claims v${esc(P.credential.claimPolicyVersion)})</small></div>
    </div>
    <div class="quote buyer" style="margin-top:12px">Buyer: “Buy one 27-inch office monitor from OfficeWorks for under $450.”</div>
    <div class="verdict ${P.authorized ? 'ok' : 'bad'}">${P.authorized ? 'Agent is authorized to propose purchases within these limits.' : 'Agent is NOT authorized: ' + esc(P.credential.reason)} ${tag('rule')}</div>`;
    st.buyer = ['ok', 'request recorded']; st.agent = [P.authorized ? 'ok' : 'bad', P.authorized ? 'passport valid' : 'not authorized'];
  }
  // B
  const B = S.attack;
  if (B) {
    $('#B-body').innerHTML = `<div class="grid"><div><span class="muted">Original buyer request</span><div class="quote buyer">${esc(B.buyerRequest)}</div></div>
      <div><span class="muted">Untrusted listing content ${tag('attack')}</span><div class="quote">${esc(B.listing)}</div></div></div>
      <p><b>Injection indicators detected:</b> ${B.scan.injection ? B.scan.patterns.map(p => `<code>${esc(p)}</code>`).join(' ') : 'none'}</p>
      <p><b>Agent proposal</b> (the demo agent obeys the listing on purpose): ${esc(B.agentProposal.quantity)} units · ${usd(B.agentProposal.amount)} · ${esc(B.agentProposal.merchant)}</p>
      <table><tr><th>Firewall check</th><th>Detail</th></tr>${B.checks.map(c => `<tr class="${c.pass ? 'pass' : c.hard ? 'fail' : ''}"><td>${esc(c.name)}${c.hard ? '' : ' <small class="muted">(advisory)</small>'}</td><td>${esc(c.detail)}</td></tr>`).join('')}</table>
      <div class="verdict ${B.decision === 'block' ? 'bad' : 'wait'}">Firewall decision: <b>${esc(B.decision.toUpperCase())}</b> · intent <code>${esc(B.intentId)}</code> ${tag('rule')}<br>
      ${B.failed.map(f => `<small>• ${esc(f)}</small>`).join('<br>')}<br><small class="muted">The decision comes from deterministic policy code. No language model was consulted.</small></div>`;
    st.firewall = [B.decision === 'block' ? 'bad' : 'wait', `attack ${B.decision === 'block' ? 'blocked' : B.decision}`];
  }
  // C
  const C = S.tamper;
  if (C) {
    $('#C-body').innerHTML = `<div class="grid"><div class="kv"><span>Buyer-approved amount</span><b>${usd(C.approved.amount)}</b></div><div class="kv"><span>New checkout amount ${tag('merchant')}</span><b>${usd(C.checkoutAmount)}</b></div>
      <div class="kv"><span>Approval binding (fingerprint)</span><code>${esc(C.approved.fingerprint)}…</code></div><div class="kv"><span>Intent</span><code>${esc(C.intentId)}</code> · ${esc(C.intent?.status)}</div></div>
      <ol class="steps" style="margin-top:12px">${C.steps.map(s => `<li class="${s.source ? 'simstep' : ''}"><b>${esc(s.step)}</b> → ${esc(s.result)} ${s.source ? tag('merchant') : ''}<br><small class="muted">${esc(s.detail)}</small></li>`).join('')}</ol>
      <div class="verdict ${C.capture.refused ? 'bad' : 'wait'}">${C.capture.refused ? `Capture refused: ${esc(C.capture.detail)}` : 'Capture was NOT refused. Check the backend.'} ${tag('rule')}<br>
      <small>Buyer consent was bound to the original transaction. A changed checkout cannot reuse that approval.</small></div>`;
    st.merchant = ['bad', 'price changed → refused'];
  }
  // D
  const D = S.purchase, it = D?.intent;
  if (it) {
    const paid = it.status === 'captured' && it.payment, isSim = paid ? it.payment.simulated : it.orderId?.startsWith('SIM-');
    let actions = '';
    if (it.status === 'pending_approval') actions = `<button class="btn primary" id="buyerOk">Buyer approves ${usd(it.amount)}</button>`;
    else if (it.status === 'approved') actions = `<button class="btn primary" id="payLive" ${cfg.paypalLive ? '' : 'disabled'}>Pay with ${TAG.live}</button><button class="btn" id="paySim">Run ${TAG.sim}</button>
      ${cfg.paypalLive ? '' : `<small class="muted">${esc(run.paypal.note)}</small>`}<div id="ppb" style="width:100%;max-width:420px"></div>`;
    $('#D-body').innerHTML = `<div class="grid"><div class="kv"><span>Intent</span><code>${esc(it.id)}</code></div><div class="kv"><span>Status</span><b>${esc(it.status)}</b></div>
      <div class="kv"><span>Amount</span><b>${usd(it.amount)}</b> USD</div><div class="kv"><span>Merchant commitment</span><b>${esc(it.commitment?.merchant)}</b> · delivery by ${esc(it.commitment ? new Date(it.commitment.deliveryBy).toLocaleDateString() : '—')}</div>
      ${it.approval ? `<div class="kv"><span>Buyer approval</span><code>${esc(it.approval.fingerprint)}…</code></div>` : ''}${it.orderId ? `<div class="kv"><span>PayPal order ID ${isSim ? tag('sim') : tag('live')}</span><code>${esc(it.orderId)}</code></div>` : ''}</div>
      <div class="row">${actions}</div>
      ${paid ? `<div class="verdict ok">Captured by ${isSim ? 'the PayPal simulator (not a real PayPal transaction)' : 'PayPal Sandbox'} ${isSim ? tag('sim') : tag('live')}<br>
        <span class="mono">order ${esc(it.orderId)} · capture ${esc(it.payment.captureId)} · ${esc(it.payment.amount)} ${esc(it.payment.currency)} · ${esc(it.payment.status)}</span></div>` : ''}`;
    st.paypal = paid ? ['ok', isSim ? 'simulator capture' : 'sandbox capture'] : it.orderId ? ['wait', 'awaiting buyer'] : ['wait', it.status];
    $('#buyerOk')?.addEventListener('click', () => act('approve'));
    $('#paySim')?.addEventListener('click', paySim);
    $('#payLive')?.addEventListener('click', payLive);
    if (paid) loadInvestigation(it.id); else ['E', 'F', 'G'].forEach(k => { $(`#${k}-body`).innerHTML = '<p class="muted">Available after a captured payment in stage D.</p>'; });
  }
  flow(st);
}

async function act(name, body) {
  const box = { attack: '#B-body', tamper: '#C-body', purchase: '#D-body', approve: '#D-body' }[name];
  busy($(box));
  try { run = await api(`/api/judge/runs/${run.id}/${name}`, 'POST', body); render(); } catch (e) { $(box).innerHTML = ''; fail($(box), e); }
}

async function capture(intentId) { await api(`/api/intents/${intentId}/capture`, 'POST'); run = await api(`/api/judge/runs/${run.id}`); render(); }
async function paySim() {
  const box = $('#D-body');
  try { await api(`/api/judge/runs/${run.id}/order`, 'POST', { mode: 'simulator' }); await capture(run.stages.purchase.intentId); } catch (e) { fail(box, e); }
}
async function payLive() {
  const ppb = $('#ppb');
  ppb.innerHTML = '<p class="loading">Loading PayPal… log in with a PayPal sandbox buyer account.</p>';
  try {
    if (!window.paypal) await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypalClientId)}&currency=USD&intent=capture`; s.onload = ok; s.onerror = () => bad(new Error('could not load the PayPal SDK')); document.head.append(s); });
    ppb.innerHTML = '';
    window.paypal.Buttons({
      createOrder: async () => (await api(`/api/judge/runs/${run.id}/order`, 'POST', { mode: 'live' })).orderId,
      onApprove: () => capture(run.stages.purchase.intentId).catch(e => fail($('#D-body'), e)),
      onCancel: () => ppb.insertAdjacentHTML('beforeend', '<p class="muted">Buyer cancelled in PayPal. Nothing was captured.</p>'),
      onError: e => fail($('#D-body'), e),
    }).render('#ppb');
  } catch (e) { fail($('#D-body'), e); }
}

let investigated = null;
async function loadInvestigation(id) {
  if (investigated === id) return; investigated = id;
  busy($('#E-body')); busy($('#G-body'));
  try {
    const t = await api(`/api/intel/${id}/truth`);
    $('#E-body').innerHTML = `<table><tr><th>Party</th><th>Record says</th><th>Expected</th><th>Record</th><th>Source</th></tr>${t.parties.map(p => {
      const bad = p.says != null && t.expected != null && Number(p.says).toFixed(2) !== Number(t.expected).toFixed(2);
      return `<tr class="${p.says == null ? '' : bad ? 'fail' : 'pass'}"><td>${esc(p.party)}</td><td>${p.says == null ? '<i class="muted">missing</i>' : usd(p.says)}</td><td>${usd(t.expected)}</td><td class="mono">${esc(p.record)}</td><td>${esc(p.source)}</td></tr>`; }).join('')}</table>
      <div class="verdict ${t.contradictions.length ? 'wait' : 'ok'}">${t.contradictions.length ? `${t.contradictions.length} contradiction(s): ${t.contradictions.map(c => `${esc(c.party)} ${esc(c.kind || 'amount')} (${esc(c.actual)} vs ${esc(c.expected)})`).join('; ')}. A contradiction is evidence for investigation, not proof of fraud.` : 'All available records agree with the buyer approval.'} ${tag('rule')}</div>`;
    st2('evidence', t.contradictions.length ? 'wait' : 'ok', t.contradictions.length ? 'contradictions' : 'records agree');
  } catch (e) { $('#E-body').innerHTML = ''; fail($('#E-body'), e); }
  $('#F-body').innerHTML = `<p>Replay a hypothetical event on a <b>copy</b> of <code>${esc(id)}</code>. The real transaction and its audit history are never changed.</p>
    <div class="row">${[['price_changed', 'Price changed after approval'], ['duplicate_capture', 'Duplicate capture'], ['late_delivery', 'Late delivery'], ['missing_payment', 'Missing payment confirmation']].map(([k, l]) => `<button class="btn" data-sc="${k}">${l}</button>`).join('')}</div><div id="twin"></div>`;
  document.querySelectorAll('[data-sc]').forEach(b => b.addEventListener('click', () => twin(id, b.dataset.sc)));
  loadEvidence();
}
const st2 = (k, c, t) => { const li = document.querySelector(`#flow li[data-k="${k}"]`); li.className = c; li.innerHTML = `Evidence<small>${esc(t)}</small>`; };

async function twin(id, sc) {
  const out = $('#twin'); busy(out, 'Replaying on a copy…');
  try {
    const before = await api(`/api/transactions/${id}/audit`);
    const r = await api(`/api/intel/${id}/simulate`, 'POST', { scenario: sc });
    const after = await api(`/api/transactions/${id}/audit`);
    out.innerHTML = `<div class="twin"><h3>SIMULATED REPLAY · ${esc(r.label)} <span class="tag sim">HYPOTHETICAL</span></h3><p class="muted">${esc(r.description)}</p>
      <ol class="steps">${r.steps.map(s => `<li class="${s.simulated ? 'simstep' : ''}">${esc(s.label)}<br><small class="muted">status → <b>${esc(s.status)}</b>${s.newIssues?.length ? ' · ' + esc(s.newIssues.join('; ')) : ''}</small></li>`).join('')}</ol>
      ${r.detection ? `<div class="verdict wait"><b>${esc(r.detection.anomaly)}</b><br><small>Why: ${esc((r.detection.why || []).join('; '))}</small>${r.detection.next ? `<br><small>Next step: ${esc(r.detection.next)}</small>` : ''}</div>` : ''}
      <p class="muted" style="margin-bottom:0">${esc(r.note)} Original audit history: ${before.events.length} entries before, ${after.events.length} after ${before.events.length === after.events.length ? '(unchanged)' : '(CHANGED: report this)'}.</p></div>`;
  } catch (e) { out.innerHTML = ''; fail(out, e); }
}

async function loadEvidence() {
  const box = $('#G-body');
  try {
    const ev = await api(`/api/judge/runs/${run.id}/evidence.json`);
    const src = s => s === 'LIVE PAYPAL SANDBOX' ? tag('live') : s === 'PAYPAL SIMULATOR' ? tag('sim') : s === 'RULE-BASED DECISION' ? tag('rule') : s === 'SIMULATED' ? tag('sim', 'SIMULATED') : tag('manual', s);
    box.innerHTML = `<div class="grid">
      <div class="kv"><span>Buyer approval</span>${ev.buyerApproval ? `${usd(ev.buyerApproval.amount)} by ${esc(ev.buyerApproval.by)}<br><code>${esc(ev.buyerApproval.hash.slice(0, 20))}…</code>` : 'none'}</div>
      <div class="kv"><span>Agent proposal</span>${esc(ev.agentProposal.proposal.quantity)} × ${esc(ev.agentProposal.proposal.productId)} · ${usd(ev.agentProposal.proposal.amount)}<br><small class="muted">firewall: ${esc(ev.agentProposal.firewall.decision)}</small></div>
      <div class="kv"><span>Merchant commitment</span>${usd(ev.merchantCommitment?.price)} · ${esc(ev.merchantCommitment?.merchant)}</div>
      <div class="kv"><span>PayPal ${src(ev.paypal.source)}</span><code>${esc(ev.paypal.orderId)}</code><br><code>${esc(ev.paypal.captureId)}</code> · ${esc(ev.paypal.amount)} ${esc(ev.paypal.currency)} ${esc(ev.paypal.status)}</div>
      <div class="kv"><span>Ledger verification</span><b>${ev.ledger.ok ? `verified · ${ev.ledger.length} entries` : `BROKEN at entry ${ev.ledger.brokenAt}`}</b></div></div>
      <table><tr><th>#</th><th>Time</th><th>Event</th><th>Actor</th><th>Source</th><th>Hash</th></tr>${ev.chronology.map(e => `<tr><td>${e.seq}</td><td class="mono">${esc(e.at.slice(11, 19))}</td><td>${esc(e.event.replace(/_/g, ' '))}</td><td>${esc(e.actor)}</td><td>${src(e.source)}</td><td class="mono">${esc(e.hash)}</td></tr>`).join('')}</table>
      <div class="verdict ${ev.findings.status === 'ok' || ev.findings.status === 'healthy' ? 'ok' : 'wait'}">${esc(ev.findings.summary)} ${/ai|claude|llm/i.test(ev.findings.summarySource || '') ? tag('ai') : tag('rule', 'DETERMINISTIC TEMPLATE')}</div>
      ${ev.findings.missingEvidence?.length ? `<p><b>Missing evidence:</b> ${ev.findings.missingEvidence.map(x => esc(x.text ?? x)).join('; ')}</p>` : ''}
      ${ev.findings.nextSteps?.length ? `<p><b>Recommended next steps:</b> ${ev.findings.nextSteps.map(x => esc(x.text ?? x)).join('; ')}</p>` : ''}
      <p class="muted"><small>${esc(ev.ledger.meaning)}</small></p>
      <div class="row"><a class="btn primary" href="/api/judge/runs/${esc(run.id)}/evidence.json" download style="display:inline-grid;place-items:center">Export evidence (JSON)</a><a class="btn" href="/api/intel/${esc(ev.transaction)}/report.md" download style="display:inline-grid;place-items:center">Investigation report (Markdown)</a><a class="btn" id="rcpt" href="/api/judge/runs/${esc(run.id)}/receipt.html?view=1" target="_blank" style="display:inline-grid;place-items:center">Open verifiable receipt</a><a class="btn" href="/api/judge/runs/${esc(run.id)}/receipt.html" download style="display:inline-grid;place-items:center">Download receipt (works offline)</a></div>
      <p class="muted"><small>The receipt is one HTML file. It recomputes every ledger hash in the reader's browser with no PACT server, so the buyer, merchant or PayPal can check it without trusting PACT.</small></p>
      <details><summary>Raw evidence JSON</summary><pre>${esc(JSON.stringify(ev, null, 2))}</pre></details>`;
  } catch (e) { box.innerHTML = ''; fail(box, e); }
}

$('#newrun').addEventListener('click', async () => {
  $('#newrun').disabled = true; investigated = null;
  try { run = await api('/api/judge/runs', 'POST'); localStorage.setItem('pact-judge-run', run.id); ['B', 'C', 'D', 'E', 'F', 'G'].forEach(k => { $(`#${k}-body`).innerHTML = ''; }); $('#trials').innerHTML = ''; render(); }
  catch (e) { fail($('#A-body'), e); } finally { $('#newrun').disabled = false; }
});
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
document.querySelectorAll('[data-ex]').forEach(b => b.addEventListener('click', () => { $('#atxt').value = b.dataset.ex; customAttack(); }));
$('#arun').addEventListener('click', customAttack);
async function customAttack() {
  if (!run) return;
  const out = $('#trials');
  out.insertAdjacentHTML('afterbegin', '<p class="loading" id="tl">The agent is reading your listing…</p>');
  try {
    const t = await api(`/api/judge/runs/${run.id}/custom-attack`, 'POST', { text: $('#atxt').value });
    $('#tl')?.remove();
    const cls = t.decision === 'block' ? 'bad' : t.decision === 'allow' ? 'ok' : 'wait';
    const word = t.decision === 'block' ? 'BLOCKED' : t.decision === 'allow' ? 'ALLOWED' : t.decision === 'hold' ? 'HELD' : 'NEEDS BUYER APPROVAL';
    out.insertAdjacentHTML('afterbegin', `<div class="trial"><div class="q">“${esc(t.text)}”</div>
      <p style="margin:8px 0 4px"><b>Injection scanner:</b> ${t.scan.injection ? `flagged ${t.scan.patterns.length} pattern(s)` : '<span style="color:var(--warn)">did not flag this wording</span>'}
      · <b>Agent followed:</b> ${t.followed.length ? esc(t.followed.join(', ')) : 'nothing (proposes the normal purchase)'}</p>
      <p style="margin:0" class="mono">Agent proposal: ${esc(t.proposal.quantity)} × monitor · ${usd(t.proposal.amount)} · ${esc(t.proposal.merchant)}</p>
      <div class="verdict ${cls}">Firewall: <b>${word}</b> ${tag('rule')}${t.failed.length ? '<br>' + t.failed.map(f => `<small>• ${esc(f)}</small>`).join('<br>') : ''}
      <br><small class="muted">${t.caughtBy === 'structured checks' ? 'Caught by the structured checks, whatever the wording.' : t.caughtBy === 'buyer approval gate' ? 'No hard rule failed; the buyer still has to approve this exact amount before anything is paid.' : 'Nothing stopped this proposal.'}</small></div></div>`);
  } catch (e) { $('#tl')?.remove(); fail(out, e); }
}

(async () => {
  cfg = await api('/api/config').catch(() => ({}));
  const saved = localStorage.getItem('pact-judge-run');
  if (saved) run = await api(`/api/judge/runs/${saved}`).catch(() => null);
  render();
})();
