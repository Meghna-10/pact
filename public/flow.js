// PACT simple flow: 1) ask the AI  2) approve & pay with PayPal  3) PACT checks it.
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = s => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { data: j });
  return j;
}

let cfg = {}, session = null, intentId = null;
const step = (n, state) => { const el = $('#s' + n); el.classList.remove('locked', 'done'); if (state) el.classList.add(state); };

// ---------- step 1 ----------
document.querySelectorAll('.ideas a').forEach(a => a.onclick = e => { e.preventDefault(); $('#what').value = a.textContent; });
$('#askForm').onsubmit = async e => {
  e.preventDefault();
  const max = Number($('#max').value) || 100;
  $('#go').disabled = true; $('#s1status').textContent = 'The AI is comparing shops, checking sellers and looking for discounts…';
  step(2, 'locked'); step(3, 'locked'); $('#pick').innerHTML = '<p class="muted">Searching…</p>';
  $('#check').innerHTML = '<p class="muted">After you pay, PACT compares what you approved, what the shop promised and what PayPal charged.</p>';
  try {
    const cat = $('#cat')?.value;
    const { id } = await api('/api/sessions', { text: `${$('#what').value} under $${max}`, policy: { maxPerItem: max, totalBudget: max * 3, ...(cat ? { allowedCategories: cat } : {}) } });
    // Live research feed: the agents' own messages streamed from the server (nothing invented here).
    const AG = { passport: 'Checking spending permission', research: 'Research agent', trust: 'Trust agent', negotiation: 'Negotiation agent', policy: 'Policy check', decision: 'Decision', firewall: 'Firewall' };
    $('#s1status').innerHTML = '<ol class="feed" id="feed"></ol>';
    const es = new EventSource(`/api/sessions/${id}/events`);
    es.onmessage = m => { const ev = JSON.parse(m.data); if (ev.agent === 'system') return;
      $('#feed')?.insertAdjacentHTML('beforeend', `<li><b>${esc(AG[ev.agent] || ev.agent)}</b> ${esc(ev.msg.length > 140 ? ev.msg.slice(0, 140) + '…' : ev.msg)}</li>`); };
    for (let i = 0; i < 60; i++) { session = await api(`/api/sessions/${id}`); if (session.status !== 'running') break; await sleep(250); }
    await sleep(300); es.close();
    showPick(max);
  } catch (err) { $('#s1status').innerHTML = `<span class="alert bad" style="display:block">Something went wrong: ${esc(err.message)}</span>`; }
  finally { $('#go').disabled = false; }
};

const REASON = (v, max) => ({ maxPerItem: `costs more than your ${usd(max)} limit`, totalBudget: 'over your total budget', minMerchantRating: 'seller has a low rating',
  maxRiskScore: 'risky seller (very new shop, or no returns)', blockedMerchants: 'seller is blocked', allowedCategories: 'not in an allowed category' }[v.rule] || v.msg);

// ---------- step 2 ----------
function showPick(max) {
  const all = session.candidates || [];
  const top = all.find(c => c.id === session.recommendation?.id);
  const skipped = all.filter(c => !c.policy.allowed);
  step(1, 'done');
  if (!all.length) { $('#s1status').textContent = 'The AI found nothing for that. Try different words.'; step(1); return; }
  $('#s1status').insertAdjacentHTML('beforeend', `<p class="done-line">The AI looked at ${all.length} options${skipped.length ? ` and skipped ${skipped.length} for your safety` : ''}.</p>`);
  step(2);
  if (!top) {
    $('#pick').innerHTML = `<div class="alert bad">None of the ${all.length} options is safe within ${usd(max)}. Try a higher limit.</div>${skippedList(skipped, max)}`;
    return;
  }
  renderPick(top, all.filter(c => c.policy.allowed && c.id !== top.id).slice(0, 2), skipped, max);
}
function renderPick(top, alts, skipped, max) {
  const trust = Math.max(0, 100 - top.riskScore);
  const days = d => new Date(Date.now() + d * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  $('#pick').innerHTML = `<div class="pick"><div class="row"><div><div class="title">${esc(top.title)}</div><div class="seller">from ${esc(top.merchant)}</div></div><div class="price">${usd(top.finalPrice)}${top.savings ? `<small class="saved">saved ${usd(top.savings)}</small>` : ''}</div></div>
      <dl class="facts"><div><dt>Merchant trust</dt><dd>${trust}/100</dd></div><div><dt>Rating</dt><dd>${top.merchantRating} / 5</dd></div><div><dt>Delivery</dt><dd>by ${days(top.shippingDays)}</dd></div>
        <div><dt>Returns</dt><dd>${top.returns ? '30 days' : 'No returns'}</dd></div><div><dt>Warranty</dt><dd>${esc(top.warranty || 'Not stated')}</dd></div></dl>
      ${session.recommendation?.explanation ? `<p class="explain"><b>Why the AI chose this:</b> ${esc(session.recommendation.explanation)}</p>` : ''}</div>
    ${alts.length ? `<div class="alts"><span>Other safe options:</span>${alts.map(a => `<button class="alt" data-alt="${a.id}">${esc(a.title.split(' ').slice(0, 4).join(' '))} · ${usd(a.finalPrice)} · ${esc(a.merchant)}</button>`).join('')}</div>` : ''}
    ${skippedList(skipped, max)}
    <div class="paybox" id="paybox"><button class="btn primary big" id="approve">Approve ${usd(top.finalPrice)} and pay</button>
      <p class="note">Nothing is charged until you confirm in PayPal. PACT locks the price, so the shop cannot change it afterwards.</p></div>`;
  $('#approve').onclick = () => approve(top);
  document.querySelectorAll('[data-alt]').forEach(b => b.onclick = () => { const c = session.candidates.find(x => x.id === b.dataset.alt); renderPick(c, session.candidates.filter(x => x.policy.allowed && x.id !== c.id).slice(0, 2), skipped, max); });
}
const skippedList = (s, max) => s.length ? `<details class="skipped"><summary>${s.length} option${s.length > 1 ? 's' : ''} skipped for your safety</summary><ul>${s.map(c => `<li>${esc(c.title)} (${usd(c.finalPrice)}): ${esc(REASON(c.policy.violations[0], max))}</li>`).join('')}</ul></details>` : '';

async function approve(top) {
  const box = $('#paybox');
  box.innerHTML = '<p class="muted">Preparing a PayPal order for exactly ' + usd(top.finalPrice) + '…</p>';
  try {
    const o = await api(`/api/sessions/${session.id}/approve`, { candidateId: top.id });
    intentId = o.intentId;
    // Safety panel: the firewall's real checks for this exact purchase, in plain words.
    const PLAIN = { credential: 'Spending permission valid', daily_budget: 'Budget available', max_per_txn: 'Within the per-purchase limit', merchant_allowlist: 'Merchant allowed',
      merchant_blocklist: 'Merchant not blocked', price_integrity: 'Price matches the shop', merchant_identity: 'Real seller confirmed', category_scope: 'Category allowed', currency: 'Currency is USD' };
    const sc = o.preflight.scores;
    const safety = `<ul class="safety">${o.preflight.checks.filter(c => PLAIN[c.name]).map(c => `<li class="${c.pass ? '' : 'no'}">${esc(PLAIN[c.name])}</li>`).join('')}
      <li class="${sc.behaviorAnomaly < 25 ? '' : 'no'}">Behaviour check ${sc.behaviorAnomaly < 25 ? 'passed' : 'flagged'}</li><li>Price lock active: ${usd(o.amount)}</li></ul>`;
    box.insertAdjacentHTML('beforebegin', safety);
    if (o.simulated) {
      box.innerHTML = `<button class="btn big sim-pay" id="simpay">Pay ${usd(o.amount)} with PayPal (test mode)</button><p class="note">Test mode: PayPal keys are not set, so this payment is simulated.</p>`;
      $('#simpay').onclick = capture;
    } else {
      box.innerHTML = `<div id="ppbtn"></div><p class="note">Log in with your PayPal <b>sandbox personal (buyer)</b> account. Order ${esc(o.orderId)} · exactly ${usd(o.amount)}.</p>`;
      await loadPayPal();
      window.paypal.Buttons({ style: { layout: 'vertical', label: 'pay' }, createOrder: () => o.orderId, onApprove: capture,
        // The popup can close without onApprove firing even when the buyer approved. Ask the server:
        // it captures only if PayPal itself reports the order as APPROVED, otherwise nothing happens.
        onCancel: async () => {
          box.insertAdjacentHTML('beforeend', '<p class="muted" id="chk">Checking with PayPal…</p>');
          try { await api(`/api/intents/${intentId}/capture`, {}); $('#chk')?.remove(); box.innerHTML = '<div class="alert good">PayPal confirmed your approval.</div>'; step(2, 'done'); step(3); await showCheck(); }
          catch { $('#chk')?.remove(); box.insertAdjacentHTML('beforeend', '<div class="alert warn">Payment cancelled. Nothing was charged.</div>'); }
        },
        onError: err => box.insertAdjacentHTML('beforeend', `<div class="alert bad">PayPal error: ${esc(err?.message || err)}</div>`) }).render('#ppbtn');
    }
  } catch (err) {
    box.innerHTML = `<div class="alert bad">PACT stopped this payment: ${esc(err.message)}${err.data?.failed ? '<br>' + err.data.failed.map(esc).join('<br>') : ''}</div>`;
  }
}
function loadPayPal() {
  if (window.paypal) return Promise.resolve();
  return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypalClientId)}&currency=USD&intent=capture`; s.onload = ok; s.onerror = () => bad(new Error('could not load PayPal')); document.head.appendChild(s); });
}

async function capture() {
  const box = $('#paybox');
  box.innerHTML = '<p class="muted">Confirming the payment with PayPal…</p>';
  try {
    const t = await api(`/api/intents/${intentId}/capture`, {});
    box.innerHTML = `<div class="alert good">Paid ${usd(t.amount)}. PayPal confirmation: ${esc(t.captureId)}</div>`;
    step(2, 'done'); step(3);
    await showCheck();
  } catch (err) { box.insertAdjacentHTML('beforeend', `<div class="alert bad">${esc(err.message)}</div>`); }
}

// ---------- step 3 ----------
async function showCheck(note = '') {
  const c = await api(`/api/assurance/${intentId}`);
  const rec = c.reconciliation, com = c.commitment, t = com.terms;
  const charged = rec.rows.find(r => r.label === 'PayPal gross capture')?.value;
  const delivered = (com.status === 'fulfilled');
  const lateIssue = com.issues.find(i => /late_delivery|delivery_date_changed|not_delivered|not_shipped/.test(i.kind));
  const priceIssue = com.issues.find(i => i.kind === 'price');
  const items = [
    ['ok', `You approved ${usd(c.amount)}`, 'Your approval is locked to this item, shop and price.'],
    rec.reconciled ? ['ok', `PayPal charged exactly ${usd(charged)}`, 'Matches what you approved.'] : ['bad', 'The amounts do not match', rec.mismatches.map(m => m.replace(/^DUPLICATE CAPTURE: /, 'Charged twice: ')).join(' · ')],
    priceIssue ? ['bad', 'The shop changed its price', priceIssue.msg] : ['ok', `${t.merchant} kept its price of ${usd(t.price)}`, ''],
    delivered && !lateIssue ? ['ok', 'Delivered on time', ''] : lateIssue ? ['bad', 'Delivery is late', lateIssue.msg] : ['wait', `Delivery expected by ${day(t.deliveryBy)}`, 'PACT will alert you if it is late.'],
  ];
  const inc = (await api('/api/incidents')).incidents.filter(i => i.intentId === intentId && i.status !== 'resolved');
  const real = c.steps && !/simulator/.test(c.steps[4]?.detail || '');
  const WORDS = { intent_created: 'AI agent selected the product', intent_approved: 'Buyer approved', intent_auto_approved: 'Approved within the agent\'s limit', merchant_commitment_recorded: 'Merchant confirmed the order',
    checkout_confirmed: 'Merchant checkout matched the approval', order_created: 'PayPal order created', payment_captured: 'PayPal captured the payment', paypal_webhook: 'PayPal payment event',
    merchant_shipped: 'Merchant shipped', merchant_delivered: 'Merchant delivered', merchant_delivery_date_changed: 'Merchant changed the delivery date', merchant_cancelled: 'Merchant cancelled', agent_reported: 'Agent reported the payment' };
  const ST = { verified: ['ok', 'VERIFIED'], mismatch: ['bad', 'MISMATCH'], missing: ['bad', 'MISSING'], pending: ['wait', 'PENDING'], unverified: ['wait', 'UNVERIFIED'] }[c.txnStatus] || ['wait', c.txnStatus];
  const tl = c.timeline.filter(e => WORDS[e.type]);
  $('#check').innerHTML = `${note}
    <div class="verdict ${ST[0]}"><b>${ST[1]}</b><span>${esc(c.statusReasons[0] || '')}</span></div>
    <ol class="ftl">${tl.map(e => `<li><time>${new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time><span>${esc(WORDS[e.type])}${/simulat/i.test(e.source) ? ' <em class="simtag">simulated</em>' : ''}</span><small>${esc(e.source)}</small></li>`).join('')}
      <li><time>now</time><span>PACT reconciled the transaction: ${ST[1]}</span><small>PACT rules</small></li></ol>
    <ul class="checks-big">${items.map(([s, h, sub]) => `<li><span class="ic ${s}">${s === 'ok' ? '✓' : s === 'bad' ? '!' : '…'}</span><div>${esc(h)}${sub ? `<small>${esc(sub)}</small>` : ''}</div></li>`).join('')}</ul>
    ${inc.length ? `<div class="alert warn">PACT opened ${inc.length === 1 ? 'a case' : inc.length + ' cases'} (${inc.map(i => esc(i.id)).join(', ')}) and notified you and the shop to sort it out. PACT never refunds or cancels by itself. <a href="/console.html#incidents">See the case</a></div>` : ''}
    <p class="receipt">${real ? "Real PayPal sandbox payment" : "Test-mode payment"} · ${esc(c.steps?.[4]?.detail || "")}</p>
    <a class="btn primary big" href="/console.html#intel?id=${esc(intentId)}" style="display:flex;align-items:center;justify-content:center;margin-top:12px">Open Transaction Intelligence</a>
    <div class="try"><p>See PACT catch a problem (these events are simulated for the demo):</p><div class="btns">
      <button class="btn" data-ev="late">Shop delays delivery by 5 days</button>
      <button class="btn" data-ev="amount">PayPal reports a different amount</button>
      <button class="btn" data-ev="deliver">Shop delivers with tracking</button></div></div>`;
  document.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => simulate(b.dataset.ev, t, c.amount));
  updateProblems();
}

async function simulate(kind, t, amount) {
  try {
    if (kind === 'late') await api(`/api/assurance/${intentId}/merchant-event`, { type: 'delivery_date_changed', estimatedDelivery: new Date(new Date(t.deliveryBy).getTime() + 5 * 864e5).toISOString() });
    if (kind === 'amount') await api(`/api/assurance/${intentId}/paypal-event-sim`, { event_type: 'PAYMENT.CAPTURE.COMPLETED', amount: Math.round(amount * 0.9 * 100) / 100 });
    if (kind === 'deliver') await api(`/api/assurance/${intentId}/merchant-event`, { type: 'delivered', tracking: 'TRK-' + Date.now().toString().slice(-6), carrier: 'DemoPost' });
    await showCheck();
  } catch (err) { $('#check').insertAdjacentHTML('afterbegin', `<div class="alert bad">${esc(err.message)}</div>`); }
}

async function updateProblems() {
  try { const n = (await api('/api/incidents')).incidents.filter(i => i.status !== 'resolved').length; $('#problems').textContent = n ? `${n} open problem${n > 1 ? 's' : ''} across all purchases` : 'No open problems'; } catch {}
}

$('#restart').onclick = e => { e.preventDefault(); session = intentId = null; step(1); step(2, 'locked'); step(3, 'locked'); $('#s1status').textContent = ''; $('#pick').innerHTML = '<p class="muted">The AI\'s choice will appear here.</p>'; $('#check').innerHTML = '<p class="muted">After you pay, PACT compares what you approved, what the shop promised and what PayPal charged.</p>'; $('#what').focus(); };

(async () => {
  try { cfg = await api('/api/config'); $('#mode').textContent = cfg.paypalLive ? 'PayPal sandbox connected' : 'Test mode (PayPal simulated)'; } catch { $('#mode').textContent = 'Server not reachable'; }
  updateProblems();
})();
