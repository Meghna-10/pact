// TermsTrace app. Every number and record on screen comes from the API.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(p, method = 'GET', body) {
  const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { data: j });
  return j;
}
const toast = m => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), 2800); };
const money = (v, c = 'USD') => v == null ? '—' : `$${Number(v).toFixed(2)}${c && c !== 'USD' ? ' ' + c : ''}`;
const when = s => s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const OUT = o => o ? `<span class="badge o-${o.split(' ')[0]}">${esc(o)}</span>` : '<span class="badge o-none">NOT COMPARED</span>';
const SRC = s => { const k = /LIVE/.test(s) ? 'live' : /FIXTURE/.test(s) ? 'fixture' : /MANUAL/.test(s) ? 'manual' : /CUSTOMER|REVIEWER/.test(s) ? 'customer' : 'rules'; return `<span class="src src-${k}">${esc(s)}</span>`; };
const IV = v => ({ MONTH: 'Monthly', YEAR: 'Yearly', WEEK: 'Weekly', DAY: 'Daily' })[v] || (v ? String(v) : '—');
const FV = (f, v) => v == null ? '—' : f === 'amount' || f === 'payment' ? money(v) : f === 'billing_interval' ? IV(v) : f === 'trial_days' ? `${v} day${v === 1 ? '' : 's'}` : f === 'additional_fees' ? (Array.isArray(v) ? (v.length ? v.join(', ') : 'None') : v === 0 ? 'None' : `${v}`) : esc(v);
const empty = (t, s, a = '') => `<div class="empty"><b>${esc(t)}</b>${esc(s)}${a ? `<div style="margin-top:12px">${a}</div>` : ''}</div>`;
const head = (t, s, actions = '') => `<div class="head"><div><h1>${esc(t)}</h1>${s ? `<p class="sub">${s}</p>` : ''}</div><div class="row">${actions}</div></div>`;
let status = {};

// ---------------- Dashboard ----------------
async function dashboard() {
  main.innerHTML = head('Dashboard', 'Loading…');
  const [list, events] = await Promise.all([api('/tt/api/agreements'), api('/tt/api/events')]);
  const n = o => list.filter(a => a.outcome === o).length;
  const incomplete = list.filter(a => !a.outcome || /NEEDS|NOT/.test(a.outcome)).length;
  main.innerHTML = head('Dashboard', list.length ? `${list.length} agreement${list.length > 1 ? 's' : ''} tracked. ${n('MISMATCH') ? `<b>${n('MISMATCH')} no longer match${n('MISMATCH') > 1 ? '' : 'es'} what the customer agreed to.</b>` : 'No mismatches.'}` : 'Capture the terms a customer agreed to, then compare them with what PayPal shows.',
      `<a class="btn primary" href="#/new">New agreement</a>`)
    + `<div class="stats">${[['Tracked agreements', list.length], ['Matching', n('MATCH')], ['Mismatches to review', n('MISMATCH')], ['Incomplete evidence', incomplete]].map(([l, v]) => `<div><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>`
    + `<section class="panel"><header><h2>Agreements</h2><span class="small muted">counts come from stored records only</span></header>${list.length ? `<table><thead><tr><th>Agreement</th><th>Agreed</th><th>Result</th><th>Compared against</th><th>Reviewed</th></tr></thead><tbody>
      ${list.map(a => `<tr class="click" data-go="#/agreement/${a.id}"><td><b>${esc(a.merchant || 'Unnamed')}</b> <span class="muted small">${esc(a.plan || '')}</span><div class="small muted mono">${esc(a.id)}</div></td><td>${money(a.amount, a.currency)}</td><td>${a.status === 'draft' ? '<span class="badge o-none">AWAITING CONFIRMATION</span>' : OUT(a.outcome)}</td><td>${a.source ? SRC(a.source) : '<span class="muted small">—</span>'}</td><td>${a.reviewed ? '✓' : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>`
      : empty('No agreements yet', 'Start with the StreamBox sample agreement.', '<a class="btn primary" href="#/new">Capture an agreement</a>')}</section>`
    + `<section class="panel"><header><h2>Recent subscription events</h2><span class="small muted">webhooks and labelled test fixtures, as received</span></header>${events.length ? `<table><thead><tr><th>Received</th><th>Event</th><th>Source</th><th>Signature</th><th>Applied</th></tr></thead><tbody>
      ${events.slice(0, 8).map(e => `<tr><td class="small">${when(e.received_at)}</td><td class="mono">${esc(e.type)}</td><td>${e.source === 'test-fixture' ? SRC('TEST FIXTURE') : SRC('LIVE SANDBOX EVENT')}</td><td>${e.verified ? '✓ verified' : '<span class="muted">not verified</span>'}</td><td>${e.applied ? '✓' : '<span class="muted">stored only</span>'}</td></tr>`).join('')}</tbody></table>`
      : empty('No events yet', 'Verified PayPal webhooks and test fixtures appear here.')}</section>`;
  $$('[data-go]').forEach(r => r.onclick = () => (location.hash = r.dataset.go));
}

// ---------------- New agreement ----------------
async function newAgreement() {
  main.innerHTML = head('Capture an agreement', 'Upload or paste the terms the customer saw when subscribing. The text is fingerprinted (SHA-256) and the terms are extracted for the customer to review.')
    + `<section class="panel"><div class="body">
      <div class="row" style="margin-bottom:12px"><label class="btn" for="file">Upload .txt / .md / .html</label><input type="file" id="file" accept=".txt,.md,.html,.htm,.pdf,.png,.jpg,.jpeg" hidden>
        <button class="btn" id="sample">Use the StreamBox sample</button><span class="small muted" id="fname">or paste the text below</span></div>
      <textarea id="text" placeholder="Paste the subscription terms here" aria-label="Agreement text"></textarea>
      <div id="msg"></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="go">Extract terms</button></div>
      <p class="small muted">PDF and image text extraction needs an OCR/AI provider, which is not configured. Such files are rejected rather than guessed; paste their text instead.</p></div></section>`;
  let fileName = 'pasted text', mime = 'text/plain';
  $('#sample').onclick = async () => { $('#text').value = await (await fetch('/tt/api/sample')).text(); fileName = 'streambox-agreement.txt'; $('#fname').textContent = fileName; };
  $('#file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    if (/pdf|image/.test(f.type)) { $('#msg').innerHTML = `<div class="err">${esc(f.name)}: PDF/image extraction is not available in this build. Paste the agreement text instead.</div>`; return; }
    $('#text').value = await f.text(); fileName = f.name; mime = f.type || 'text/plain'; $('#fname').textContent = f.name; $('#msg').innerHTML = '';
  };
  $('#go').onclick = async () => {
    try { const a = await api('/tt/api/agreements', 'POST', { text: $('#text').value, fileName, mime }); location.hash = `#/agreement/${a.id}`; }
    catch (e) { $('#msg').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

// ---------------- Agreement detail ----------------
const FIELDS = [['merchant_name', 'Merchant', 'text'], ['subscription_name', 'Plan', 'text'], ['amount', 'Price', 'number'], ['currency', 'Currency', 'text'], ['billing_interval', 'Billing interval', 'interval'],
  ['trial_days', 'Free trial (days)', 'number'], ['additional_fees', 'Additional fees', 'fees'], ['cancellation_terms', 'Cancellation terms', 'text']];
const MIRROR = [['amount', 'Price'], ['currency', 'Currency'], ['billing_interval', 'Billing'], ['trial_days', 'Free trial'], ['additional_fees', 'Extra fees']];

function mirrorHTML(a) {
  const c = a.comparisons.at(-1), o = c && a.observations.find(x => x.id === c.observationId);
  const row = f => c?.rows.find(r => r.field === f);
  const sym = s => ({ match: ['eq', '='], mismatch: ['ne', '≠'], needs_review: ['q', '?'], not_enough_evidence: ['na', '·'] })[s] || ['na', '·'];
  const pay = row('payment');
  return `<div class="mirror" role="table" aria-label="Agreement Mirror">
    <div class="col"><div class="side-h">What the customer agreed to</div>${MIRROR.map(([f, l]) => `<div class="mrow ${['mismatch', 'needs_review'].includes(row(f)?.status) ? 'diff left' : ''}" role="row"><span class="k">${l}</span><span class="v">${FV(f, a.confirmed[f])}</span></div>`).join('')}
      <div class="src-line">Confirmed by the customer ${when(a.confirmed.confirmedAt)}</div></div>
    <div class="mid" aria-hidden="true"><div></div>${MIRROR.map(([f]) => { const [k, s] = sym(row(f)?.status); return `<div class="${k}">${s}</div>`; }).join('')}</div>
    <div class="col right"><div class="side-h">What the latest verified data shows</div>${MIRROR.map(([f, l]) => `<div class="mrow ${['mismatch', 'needs_review'].includes(row(f)?.status) ? 'diff' : ''}" role="row"><span class="k">${l}</span><span class="v">${o ? FV(f, o.terms[f]) : '—'}</span></div>`).join('')}
      <div class="src-line">${o ? `${SRC(o.label)} ${o.terms.plan_name ? `plan "${esc(o.terms.plan_name)}"` : ''} · ${when(o.at)}` : 'Nothing observed yet'}</div></div>
  </div>
  ${c ? `<p class="small" style="margin:12px 2px 0">${pay ? `<b>Charge:</b> ${pay.status === 'match' ? `a payment of ${money(pay.observed)} matches the agreed price.` : `a payment of ${money(pay.observed)} was observed (${esc(pay.note)}).`}` : '<b>Charge:</b> no payment event confirms a charge at the new terms yet. The difference is in the plan, not in a charge.'}</p>` : ''}`;
}

async function agreement(id) {
  main.innerHTML = head('Agreement', 'Loading…');
  let a;
  try { a = await api(`/tt/api/agreements/${id}`); } catch (e) { main.innerHTML = head('Agreement', '') + `<div class="err">${esc(e.message)}</div>`; return; }
  const c = a.comparisons.at(-1), x = a.explanation;
  const draft = a.status === 'draft';
  const fieldInput = (f, type, v) => type === 'interval' ? `<select name="${f}">${['MONTH', 'YEAR', 'WEEK', 'DAY'].map(k => `<option value="${k}" ${v === k ? 'selected' : ''}>${IV(k)}</option>`).join('')}<option value="" ${v ? '' : 'selected'}>Not stated</option></select>`
    : `<input type="${type === 'number' ? 'number' : 'text'}" step="any" name="${f}" value="${esc(type === 'fees' ? (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : '') : v ?? '')}">`;
  const hi = (ev, v) => { if (!ev) return '<span class="muted">not found in the document</span>'; const s = String(Array.isArray(v) ? '' : v ?? ''); return esc(ev).replace(esc(s).length > 1 ? esc(s) : '\u0000', m => `<mark>${m}</mark>`); };

  main.innerHTML = head(`${a.confirmed?.merchant_name || a.extracted.merchant_name.value || 'Agreement'} · ${a.confirmed?.subscription_name || a.extracted.subscription_name.value || ''}`,
      `${esc(a.id)} · document <span class="mono">${esc(a.document.name)}</span> · SHA-256 <span class="mono">${esc(a.document.sha256.slice(0, 20))}…</span>`,
      `${draft ? '<span class="badge o-none">AWAITING CONFIRMATION</span>' : OUT(c?.outcome)}<a class="btn" href="/tt/api/agreements/${a.id}/export.json" download>Export JSON</a><button class="btn" id="print">Print / save PDF</button>`)
    // 1. Agreement Mirror (signature)
    + (a.confirmed ? `<section class="panel"><header><h2>The Agreement Mirror</h2>${c ? `${OUT(c.outcome)}` : ''}</header><div class="body">${mirrorHTML(a)}
        ${x && x.whatChanged.length ? `<h3>What changed</h3><ul>${x.whatChanged.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${x ? `<div class="grid2" style="margin-top:6px"><div><h3>What the customer agreed to</h3><p class="small" style="margin:0">${esc(x.agreed)}</p></div><div><h3>What the latest verified data shows</h3><p class="small" style="margin:0">${esc(x.latest || 'Nothing observed yet.')}</p></div></div>
          <h3>Evidence behind this result</h3><ul class="small">${x.evidence.map(e => `<li class="mono" style="font-size:12px">${esc(e)}</li>`).join('')}</ul>
          <h3>What to review next</h3><ul class="small">${x.next.map(e => `<li>${esc(e)}</li>`).join('')}</ul><p class="small muted">${esc(x.disclaimer)}</p>` : ''}
      </div></section>` : '')
    // 2. Extraction review / confirmation
    + `<section class="panel"><header><h2>${draft ? 'Step 2 · Review the extracted terms' : 'Confirmed terms'}</h2><span class="small muted">${esc(a.extractionMethod)}</span></header><div class="body">
        ${draft ? '<p class="note" style="margin-top:0">These values were read from the document by rules. They are <b>not</b> treated as the customer\'s agreement until confirmed. Correct anything that is wrong.</p>' : ''}
        <form id="xform">${FIELDS.map(([f, l, type]) => { const ex = a.extracted[f]; const v = a.confirmed ? a.confirmed[f] : ex.value;
          return `<div class="xrow"><label class="f">${l}<span class="conf conf-${String(ex.confidence).split(' ')[0]}">${esc(ex.confidence)}</span></label>
            <div>${draft ? fieldInput(f, type, v) : `<b>${FV(f, v)}</b>${a.corrections.some(k => k.field === f) ? ' <span class="small muted">(corrected by customer)</span>' : ''}`}</div>
            <div class="ev">${hi(ex.evidence, ex.value)}</div></div>`; }).join('')}</form>
        ${draft ? '<div id="cmsg"></div><div class="row" style="margin-top:14px"><button class="btn primary" id="confirm">Customer confirms these terms</button></div>' : `<p class="small muted" style="margin-bottom:0">Confirmed ${when(a.confirmed.confirmedAt)} · ${a.corrections.length} correction${a.corrections.length === 1 ? '' : 's'}</p>`}
      </div></section>`
    // 3. PayPal connection
    + (a.confirmed ? `<section class="panel"><header><h2>Step 3 · Compare with PayPal</h2><span class="small muted">PayPal ${esc(status.paypal || '')}</span></header><div class="body">
        <div class="grid2"><div>
          <label class="f">PayPal plan ID<input type="text" id="planId" value="${esc(a.paypal.planId || '')}" placeholder="P-XXXXXXXXXXXX"></label>
          <label class="f" style="margin-top:10px">PayPal subscription ID (optional)<input type="text" id="subId" value="${esc(a.paypal.subscriptionId || '')}" placeholder="I-XXXXXXXXXX"></label>
          <div class="row" style="margin-top:12px"><button class="btn" id="link">Save link</button><button class="btn primary" id="fetch" ${a.paypal.planId || a.paypal.subscriptionId ? '' : 'disabled'}>Read from PayPal &amp; compare</button></div>
        </div><div>
          <p class="small" style="margin-top:0"><b>StreamBox sandbox demo.</b> Creates (once) a real sandbox product with two real plans: the <b>$9.99</b> plan the customer was shown and the <b>$19.99</b> plan the merchant's checkout uses now.</p>
          <div class="row"><button class="btn" id="demo">Set up demo plans</button><button class="btn" data-plan="advertisedPlanId" ${status.demo ? '' : 'disabled'}>Use $9.99 plan</button><button class="btn" data-plan="currentPlanId" ${status.demo ? '' : 'disabled'}>Use $19.99 plan</button></div>
          <div class="row" style="margin-top:10px"><button class="btn" id="sub" ${a.paypal.planId ? '' : 'disabled'}>Create sandbox subscription</button><button class="btn" id="tpc" ${a.paypal.planId ? '' : 'disabled'}>Try a price change on PayPal</button></div>
          <div id="pmsg"></div>
        </div></div>
        <details style="margin-top:14px"><summary class="small"><b>Test fixture or manual data</b> (labelled, never shown as a PayPal event)</summary>
          <div class="row" style="margin-top:10px"><select id="fxType" style="width:auto"><option>BILLING.PLAN.PRICING-CHANGE.ACTIVATED</option><option>PAYMENT.SALE.COMPLETED</option></select><input type="number" id="fxAmt" value="19.99" step="0.01" style="width:110px" aria-label="Amount"><button class="btn" id="fx" ${a.paypal.planId ? '' : 'disabled'}>Send test fixture</button></div>
          <div class="row" style="margin-top:10px"><input type="number" id="mAmt" placeholder="price" step="0.01" style="width:110px" aria-label="Manual price"><select id="mInt" style="width:auto"><option value="MONTH">Monthly</option><option value="YEAR">Yearly</option></select><input type="number" id="mTrial" placeholder="trial days" style="width:120px" aria-label="Manual trial days"><button class="btn" id="man">Compare with manual data</button></div>
        </details>
      </div></section>` : '')
    // 4. Review
    + (c ? `<section class="panel"><header><h2>Review</h2>${a.review ? `<span class="small">Reviewed ${when(a.review.at)}</span>` : ''}</header><div class="body">
        ${a.review?.note ? `<p class="small" style="margin-top:0"><b>Note:</b> ${esc(a.review.note)}</p>` : ''}<div class="row"><input type="text" id="rnote" placeholder="Reviewer note (what you checked, who you contacted)" style="flex:1;min-width:240px"><button class="btn primary" id="rev">Mark as reviewed</button></div></div></section>` : '')
    // 5. Evidence timeline
    + `<section class="panel"><header><h2>Evidence timeline</h2><span class="small ${a.ledger.length === a.timeline.length ? 'muted' : ''}">${a.ledger.length} ledger entries · tamper-evident hash chain</span></header><div class="body"><ol class="tl">
        ${a.ledger.map(e => `<li><time>${when(e.at)}</time><div>${SRC(e.source)}</div><div><div class="t">${esc(e.type.replace(/_/g, ' '))}</div><div class="small muted mono">${esc(e.hash.slice(0, 24))}…</div><details><summary>Raw record</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details></div></li>`).join('')}</ol></div></section>`
    + `<section class="panel"><header><h2>Original document</h2><span class="small muted">${a.document.bytes} bytes</span></header><div class="body"><pre class="mono" style="white-space:pre-wrap;margin:0;max-height:340px;overflow:auto">${esc(a.document.text)}</pre></div></section>`;

  // actions
  const act = async (fn, ok, box = '#pmsg') => { try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); route(); } catch (e) { const el = $(box); if (el) el.innerHTML = `<div class="err">${esc(e.message)}${e.data?.note ? '<br>' + esc(e.data.note) : ''}</div>`; else toast(e.message); } };
  $('#print').onclick = () => window.print();
  $('#confirm')?.addEventListener('click', () => { const f = Object.fromEntries(new FormData($('#xform'))); act(() => api(`/tt/api/agreements/${id}/confirm`, 'POST', f), 'Agreement confirmed by the customer', '#cmsg'); });
  $('#link')?.addEventListener('click', () => act(() => api(`/tt/api/agreements/${id}/link`, 'POST', { planId: $('#planId').value.trim() || undefined, subscriptionId: $('#subId').value.trim() || undefined }), 'PayPal link saved'));
  $('#fetch')?.addEventListener('click', () => act(() => api(`/tt/api/agreements/${id}/fetch`, 'POST'), r => `Read from PayPal: ${r.comparison.outcome}`));
  $('#demo')?.addEventListener('click', () => act(async () => { const d = await api('/tt/api/demo/plans', 'POST'); status.demo = d; return d; }, 'Sandbox demo plans ready'));
  $$('[data-plan]').forEach(b => b.addEventListener('click', () => act(() => api(`/tt/api/agreements/${id}/link`, 'POST', { planId: status.demo[b.dataset.plan] }), 'Plan linked. Now read it from PayPal.')));
  $('#sub')?.addEventListener('click', () => act(async () => { const s = await api(`/tt/api/agreements/${id}/subscribe`, 'POST'); if (s.approveUrl) window.open(s.approveUrl, '_blank', 'noopener'); return s; }, s => `Subscription ${s.subscriptionId} created (${s.status}). Approve it in the PayPal tab with the sandbox buyer.`));
  $('#tpc')?.addEventListener('click', () => act(() => api(`/tt/api/agreements/${id}/try-price-change`, 'POST', { amount: 19.99 }), 'PayPal accepted the price change'));
  $('#fx')?.addEventListener('click', () => act(() => api(`/tt/api/agreements/${id}/fixture`, 'POST', { eventType: $('#fxType').value, amount: $('#fxAmt').value }), r => r.duplicate ? 'Duplicate event ignored' : `Test fixture recorded: ${r.outcome}`));
  $('#man')?.addEventListener('click', () => act(() => api(`/tt/api/agreements/${id}/manual`, 'POST', { amount: $('#mAmt').value, billing_interval: $('#mInt').value, trial_days: $('#mTrial').value, currency: 'USD' }), r => `Manual data compared: ${r.comparison.outcome}`));
  $('#rev')?.addEventListener('click', () => act(() => api(`/tt/api/agreements/${id}/review`, 'POST', { note: $('#rnote').value }), 'Marked as reviewed'));
}

// ---------------- Review centre ----------------
async function reviewCentre() {
  main.innerHTML = head('Review centre', 'Loading…');
  const list = (await api('/tt/api/agreements')).filter(a => a.outcome && a.outcome !== 'MATCH');
  const full = await Promise.all(list.map(a => api(`/tt/api/agreements/${a.id}`)));
  main.innerHTML = head('Review centre', full.length ? `${full.filter(a => !a.review).length} waiting for review. Each case shows what changed and the evidence behind it.` : 'Nothing to review.')
    + (full.length ? full.map(a => `<section class="panel"><header><h2>${esc(a.confirmed.merchant_name || a.id)} · ${esc(a.confirmed.subscription_name || '')}</h2><div class="row">${OUT(a.explanation.outcome)}${SRC(a.explanation.source || '')}${a.review ? '<span class="badge o-MATCH">REVIEWED</span>' : ''}</div></header><div class="body">
        <ul style="margin-top:0">${a.explanation.whatChanged.map(w => `<li>${esc(w)}</li>`).join('') || '<li class="muted">Evidence incomplete</li>'}</ul>
        <p class="small muted">${esc(a.explanation.charged || '')}</p><div class="row"><a class="btn primary" href="#/agreement/${a.id}">Open the Agreement Mirror</a></div></div></section>`).join('')
      : `<section class="panel">${empty('Nothing to review', 'Mismatches and incomplete comparisons appear here.')}</section>`);
}

// ---------------- Integration settings ----------------
async function settings() {
  const s = await api('/tt/api/status');
  main.innerHTML = head('Integration', 'PayPal Developer Sandbox connection and webhook setup. Secrets stay on the server and are never shown here.')
    + `${s.paypal !== 'sandbox' ? '<div class="err">PayPal sandbox keys are not configured. Only manual demo data and test fixtures will work. Copy .env.example to .env and add the sandbox Client ID and Secret.</div>' : ''}`
    + `<div class="grid2"><section class="panel"><header><h2>Status</h2></header><div class="body"><table><tbody>
        <tr><td>PayPal</td><td>${s.paypal === 'sandbox' ? '<span class="badge o-MATCH">SANDBOX CONNECTED</span>' : '<span class="badge o-NOT">NOT CONFIGURED</span>'}</td></tr>
        <tr><td>Live mode</td><td><span class="badge o-none">OFF</span> <span class="small muted">sandbox only</span></td></tr>
        <tr><td>Webhook signature check</td><td>${s.webhooks === 'configured' ? '<span class="badge o-MATCH">CONFIGURED</span>' : '<span class="badge o-NEEDS">NOT CONFIGURED</span>'}</td></tr>
        <tr><td>Evidence ledger</td><td>${s.database.ledger.ok ? `<span class="badge o-MATCH">INTACT</span> <span class="small muted">${s.database.ledger.entries} entries</span>` : '<span class="badge o-MISMATCH">BROKEN</span>'}</td></tr>
        <tr><td>Demo sandbox plans</td><td class="small mono">${s.demo ? `${esc(s.demo.advertisedPlanId)} ($9.99)<br>${esc(s.demo.currentPlanId)} ($19.99)` : 'not created yet'}</td></tr></tbody></table></div></section>
      <section class="panel"><header><h2>Webhook setup</h2></header><div class="body small">
        <ol style="padding-left:18px;margin-top:0"><li>Expose TermsTrace on a public HTTPS URL (deploy it, or use a tunnel).</li><li>In the PayPal developer dashboard, open your sandbox app → Webhooks → Add webhook: <span class="mono">https://YOUR-HOST/api/webhooks/paypal</span>.</li>
        <li>Subscribe to BILLING.SUBSCRIPTION.*, BILLING.PLAN.UPDATED, BILLING.PLAN.PRICING-CHANGE.ACTIVATED, PAYMENT.SALE.COMPLETED / REFUNDED / REVERSED.</li><li>Put the webhook ID in <span class="mono">PAYPAL_WEBHOOK_ID</span> and restart. Unverified events are stored but never applied.</li></ol>
        <p class="muted">Without a public URL, use "Read from PayPal" (a live API read) or a labelled test fixture.</p></div></section></div>`;
}

// ---------------- router ----------------
async function route() {
  const h = location.hash || '#/';
  $$('.side a.nav').forEach(a => a.toggleAttribute('aria-current', false));
  const m = h.match(/^#\/agreement\/([\w-]+)/);
  const nav = m ? '#/' : h; $$('.side a.nav').forEach(a => { if (a.getAttribute('href') === nav) a.setAttribute('aria-current', 'page'); });
  try {
    status = await api('/tt/api/status'); $('#env').textContent = status.paypal === 'sandbox' ? 'PAYPAL SANDBOX' : 'NO PAYPAL KEYS';
    if (m) return await agreement(m[1]);
    if (h.startsWith('#/new')) return await newAgreement();
    if (h.startsWith('#/review')) return await reviewCentre();
    if (h.startsWith('#/settings')) return await settings();
    return await dashboard();
  } catch (e) { main.insertAdjacentHTML('afterbegin', `<div class="err">Could not load: ${esc(e.message)}</div>`); }
}
window.addEventListener('hashchange', route);
route();
