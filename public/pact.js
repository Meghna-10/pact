// PACT console. Every figure on screen is computed from API data; nothing is typed in.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
const post = (p, body) => api(p, { method: 'POST', body });

// ---------- formatting ----------
const usd = v => v == null || isNaN(v) ? '—' : (v < 0 ? '−' : '') + '$' + Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = v => v == null ? '—' : Number(v).toLocaleString('en-US');
const dt = s => s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const tm = s => s ? new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const ago = s => { const m = Math.round((Date.now() - new Date(s)) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const due = s => { const h = Math.round((new Date(s) - Date.now()) / 36e5); return h < 0 ? `overdue by ${-h} h` : h < 48 ? `due in ${h} h` : `due in ${Math.round(h / 24)} d`; };
const words = s => String(s || '').replace(/_/g, ' ');
const cap = s => { s = words(s); s = s.charAt(0).toUpperCase() + s.slice(1); return s.replace(/\bPaypal\b/g, 'PayPal'); };
const tidy = m => String(m || '').replace(/^DUPLICATE CAPTURE: /, 'Duplicate capture: ');
const pill = (state, label) => `<span class="pill s-${esc(state)}">${esc(label ?? cap(state))}</span>`;
const isSim = s => /simulat/i.test(s || '');
const srcTag = s => `<span class="src-tag ${isSim(s) ? 'sim' : ''}">${esc(s)}</span>`;
const STEP_WORD = { ok: 'Complete', warn: 'Check', pending: 'Pending', missing: 'Missing', blocked: 'Blocked', broken: 'Broken' };
const STEP_NAMES = ['Intent', 'Agent action', 'Consent', 'Merchant commitment', 'Payment', 'Outcome', 'Evidence'];
const miniChain = steps => `<span class="chain" role="img" aria-label="Chain: ${steps.map((s, i) => STEP_NAMES[i] + ' ' + s).join(', ')}">${steps.map(s => `<i class="${s}"></i>`).join('')}</span>`;
const STATUS_ORDER = ['verified', 'pending', 'mismatch', 'missing', 'unverified'];
const STATUS_COLOR = { verified: 'var(--positive)', pending: '#d99a2b', mismatch: 'var(--negative)', missing: '#e07a6f', unverified: 'var(--chart-muted)' };
const STATUS_WORD = { verified: 'Verified', pending: 'Pending', mismatch: 'Mismatch', missing: 'Missing', unverified: 'Unverified' };

function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 2600); }
const loading = (n = 3) => Array.from({ length: n }, (_, i) => `<div class="skeleton" style="width:${80 - i * 15}%"></div>`).join('');
const empty = (title, line, action = '') => `<div class="state"><b>${esc(title)}</b>${esc(line)}${action ? `<div style="margin-top:12px">${action}</div>` : ''}</div>`;
const errorBar = e => `<div class="errbar" role="alert">Could not load this view: ${esc(e.message)}. <a href="#" data-retry>Try again</a></div>`;

function topline(title, sub, actions = '') {
  return `<div class="topline"><div><button class="menu-btn" data-menu aria-label="Open navigation"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5"/></svg></button><div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div></div><div class="actions">${actions}</div></div>`;
}
const panel = (title, meta, body, cls = '') => `<section class="panel ${cls}"><header><h2>${esc(title)}</h2>${meta ? `<span class="meta">${meta}</span>` : ''}</header>${body}</section>`;

// ---------- shared data ----------
const cache = {};
async function load(keys) {
  const map = { txns: '/api/assurance', impact: '/api/impact', incidents: '/api/incidents', refunds: '/api/refunds', raw: '/api/events/raw', ledger: '/api/ledger',
    security: '/api/security/events', agents: '/api/agents', intents: '/api/intents', config: '/api/config' };
  const out = await Promise.all(keys.map(k => api(map[k])));
  keys.forEach((k, i) => (cache[k] = out[i]));
  return Object.fromEntries(keys.map((k, i) => [k, out[i]]));
}
async function refreshCounts() {
  try {
    const [t, i] = await Promise.all([api('/api/assurance'), api('/api/incidents')]);
    const recon = t.filter(x => x.mismatches > 0).length, open = i.incidents.filter(x => x.status !== 'resolved').length;
    const set = (id, n) => { const el = $(id); el.hidden = !n; el.textContent = n; };
    set('#c-recon', recon); set('#c-inc', open); set('#c-bell', open);
    const [h, r, d] = await Promise.all([api('/api/fin/holds'), api('/api/fin/refunds'), api('/api/fin/disputes')]);
    set('#c-holds', h.count); set('#c-refunds', r.totals.delayed + r.totals.pending); set('#c-disputes', d.filter(x => x.status === 'open').length);
  } catch { /* counts are optional */ }
}

// ---------- 01 Overview ----------
async function overview() {
  main.innerHTML = topline('Overview', 'Loading transaction health…') + `<div class="kpis">${loading(1)}</div>` + panel('Transaction status', '', loading());
  const { txns, impact, incidents, raw, config } = await load(['txns', 'impact', 'incidents', 'raw', 'config']);
  const [cf, fl, sb, dsp] = await Promise.all([api('/api/fin/cashflow'), api('/api/fin/failures'), api('/api/fin/subscriptions'), api('/api/fin/disputes')]);
  const finRow = `<div class="kpis" style="grid-template-columns:repeat(5,1fr)">${[
    ['Available now', usd(cf.balances.available), 'after fees, refunds and holds', '#cashflow'],
    ['On hold', usd(cf.balances.held), 'Money Recovery', '#money'],
    ['Refunds outstanding', usd(cf.balances.refunded >= 0 ? (await api('/api/fin/refunds')).totals.outstanding : 0), 'Refund Radar', '#refunds'],
    ['Failed payments', fl.total, `${fl.recovered} recovered · Payment Recovery`, '#failures'],
    ['Open disputes', dsp.filter(d => d.status === 'open').length, `${sb.flagged.length} subscription alert${sb.flagged.length === 1 ? '' : 's'}`, '#disputes']]
    .map(([l, v, n, href]) => `<a class="kpi" href="${href}" style="color:inherit;text-decoration:none"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${esc(n)} →</div></a>`).join('')}</div>`;
  const paid = txns.filter(t => t.captureId);
  const volume = paid.reduce((s, t) => s + Math.round(t.amount * 100), 0) / 100;
  const byStatus = Object.fromEntries(STATUS_ORDER.map(s => [s, paid.filter(t => t.txnStatus === s).length]));
  const investigate = byStatus.mismatch + byStatus.missing + byStatus.unverified;
  const open = incidents.incidents.filter(i => i.status !== 'resolved');
  const critical = open.filter(i => i.severity === 'critical');
  console.assert(STATUS_ORDER.reduce((s, k) => s + byStatus[k], 0) === paid.length, 'status mix must sum to transactions');

  const worst = paid.filter(t => ['mismatch', 'missing'].includes(t.txnStatus)).sort((a, b) => a.health - b.health)[0];
  const finding = !paid.length ? 'No transactions yet. Load the demo scenarios to see PACT reconcile payments, orders and fulfilment.'
    : investigate ? `${investigate} of ${paid.length} transactions need investigation${worst ? `. Lowest health: ${esc(worst.title)} at ${worst.health}/100, ${esc(((worst.statusReasons || [])[0] || '').split(' (')[0].replace(/^[A-Z ]+: /, m => m.charAt(0) + m.slice(1).toLowerCase()))}` : ''}.`
    : `All ${paid.length} transactions reconcile across buyer approval, merchant order and PayPal capture.`;

  const kpis = [
    ['Gross volume', usd(volume), `${paid.length} captured transactions`, 'lead'],
    ['Verified', `${byStatus.verified}<small> / ${paid.length}</small>`, 'records agree'],
    ['Needs investigation', investigate, investigate ? 'mismatch, missing or unverified' : 'nothing to investigate', '', investigate ? 'bad' : ''],
    ['Open incidents', open.length, critical.length ? `${critical.length} critical` : open.length ? 'none critical' : 'all resolved', '', critical.length ? 'bad' : ''],
    ['Refunds pending', impact.refundsAwaiting + impact.refundsOverdue, impact.refundsOverdue ? `${impact.refundsOverdue} past deadline` : 'none past deadline', '', impact.refundsOverdue ? 'bad' : ''],
  ];
  const mix = STATUS_ORDER.filter(s => byStatus[s]).map(s => `<span style="flex:${byStatus[s]};background:${STATUS_COLOR[s]}" title="${STATUS_WORD[s]} ${byStatus[s]}"></span>`).join('');

  main.innerHTML = topline('Overview', finding,
      `<span class="stamp hide-sm">Updated ${tm(new Date())}</span><button class="btn" data-refresh>Refresh</button>${open.length ? `<a class="btn primary" href="#incidents" style="display:inline-flex;align-items:center">Review ${open.length} incident${open.length > 1 ? 's' : ''}</a>` : `<button class="btn primary" data-seed>Load demo scenarios</button>`}`)
    + (config.paypalLive ? '' : `<div class="banner">${pill('draft', 'Demo data')} Payments in this workspace come from the PayPal simulator; merchant and webhook events are simulated and labelled as such. <button class="btn" data-seed>Reset &amp; load scenarios</button></div>`)
    + `<div class="kpis">${kpis.map(([l, v, n, lead, tone]) => `<div class="kpi"><div class="label">${l}</div><div class="value ${lead || ''}">${v}</div><div class="note ${tone || ''}">${esc(n)}</div></div>`).join('')}</div>`
    + `<h2 class="sect" style="margin:4px 0 8px">Financial health</h2>` + finRow
    + `<div class="grid g-2-1">`
    + panel('Transaction status', `${paid.length} transactions`, paid.length ? `<div class="body"><div class="mix" role="img" aria-label="${STATUS_ORDER.map(s => `${STATUS_WORD[s]} ${byStatus[s]}`).join(', ')}">${mix}</div>
        <div class="legend">${STATUS_ORDER.map(s => `<div><i style="background:${STATUS_COLOR[s]}"></i>${STATUS_WORD[s]}<b>${byStatus[s]}</b></div>`).join('')}</div>
        <h2 style="font-size:13px;font-weight:600;margin:22px 0 4px">Health by transaction <span class="dim" style="font-weight:400">· 0-100, oldest first</span></h2><div id="healthChart"></div></div>`
        : empty('No transactions yet', 'Captured payments will appear here.', '<button class="btn primary" data-seed>Load demo scenarios</button>'))
    + panel('Recent incidents', `<a href="#incidents">View all</a>`, open.length || incidents.incidents.length ? `<div class="rows">${incidents.incidents.slice(0, 5).map(i => `<div class="clickable" data-inc="${i.id}" style="cursor:pointer">
        <span class="t">${esc(cap(i.kind))}</span>${pill(i.status, cap(i.status))}<span class="d">${esc(i.title || '')} · ${i.status === 'resolved' ? 'resolved' : esc(due(i.dueAt))} · owner ${esc(i.owner)}</span></div>`).join('')}</div>`
        : empty('No incidents', 'PACT opens one when records disagree.'))
    + `</div><div class="grid g-1-1">`
    + panel('Latest payment events', `<a href="#audit">Event log</a>`, raw.length ? `<div class="body flush scroll-x"><table><thead><tr><th>Received</th><th>Event</th><th class="hide-sm">Transaction</th><th>Result</th></tr></thead><tbody>
        ${raw.slice(0, 6).map(e => `<tr><td class="dim">${tm(e.received_at)}</td><td>${esc(e.type)}<span class="line2">${esc(e.source)}${e.json?.amount != null ? ' · ' + usd(e.json.amount) : ''}</span></td><td class="id hide-sm">${esc((e.transaction_id || '—').slice(0, 12))}</td><td>${e.applied ? pill('ok', 'Applied') : pill('neutral', 'Stored')}</td></tr>`).join('')}</tbody></table></div>`
        : empty('No events received', 'PayPal webhooks and merchant events land here.'))
    + panel('Needs attention', `${paid.filter(t => t.txnStatus !== 'verified').length} transactions`, paid.filter(t => t.txnStatus !== 'verified').length ? `<div class="rows">${paid.filter(t => t.txnStatus !== 'verified').sort((a, b) => a.health - b.health).slice(0, 6).map(t => `<div data-txn="${t.intentId}" style="cursor:pointer">
        <span class="t">${esc(t.title)}</span>${pill(t.txnStatus, STATUS_WORD[t.txnStatus])}<span class="d">${usd(t.amount)} · ${esc(t.merchant)} · health ${t.health} · ${esc((t.statusReasons || [])[0] || '')}</span></div>`).join('')}</div>`
        : empty('Nothing needs attention', 'Every transaction is verified.'))
    + `</div>`;

  if (paid.length && window.Charts) {
    const ordered = [...paid].reverse();
    Charts.bars($('#healthChart'), { labels: ordered.map(t => t.title.split(' ').slice(0, 2).join(' ')), values: ordered.map(t => t.health),
      yTicks: [0, 25, 50, 75, 100], format: v => String(Math.round(v)), height: 170,
      reference: { value: 80, label: 'Review below 80' } });
  }
}

// ---------- 02 Transactions ----------
let txFilter = 'all', txQuery = '';
async function transactions() {
  main.innerHTML = topline('Transactions', 'Every payment with its buyer approval, merchant order and fulfilment linked.') + panel('All transactions', '', loading(4));
  const { txns } = await load(['txns']);
  const counts = Object.fromEntries(['all', ...STATUS_ORDER].map(s => [s, s === 'all' ? txns.length : txns.filter(t => t.txnStatus === s).length]));
  const rows = txns.filter(t => (txFilter === 'all' || t.txnStatus === txFilter) && (!txQuery || `${t.intentId} ${t.title} ${t.merchant} ${t.orderId} ${t.captureId}`.toLowerCase().includes(txQuery.toLowerCase())));
  main.innerHTML = topline('Transactions', `${txns.length} transactions · ${counts.verified} verified · ${counts.mismatch + counts.missing} need investigation`)
    + `<section class="panel"><div class="toolbar"><input class="search" type="search" placeholder="Search item, merchant, PayPal order or capture" value="${esc(txQuery)}" aria-label="Search transactions" data-q>
      <div class="seg" role="group" aria-label="Filter by status">${['all', ...STATUS_ORDER].map(s => `<button aria-pressed="${txFilter === s}" data-f="${s}">${s === 'all' ? 'All' : STATUS_WORD[s]} ${counts[s]}</button>`).join('')}</div></div>
      <div class="body flush scroll-x">${rows.length ? `<table><thead><tr><th>Transaction</th><th>Item</th><th class="hide-sm">Initiated by</th><th class="hide-sm">Chain</th><th>Status</th><th class="num">Health</th><th class="num">Amount</th><th class="num hide-sm">Created</th></tr></thead><tbody>
      ${rows.map(t => `<tr class="clickable" data-txn="${t.intentId}" tabindex="0"><td class="id">${esc(t.intentId)}<span class="line2">${esc((t.orderId || '').slice(0, 14))}</span></td><td><div class="trunc">${esc(t.title)}</div><span class="line2">${esc(t.merchant)}</span></td>
        <td class="hide-sm">${esc(t.initiator === 'AI agent' ? 'AI agent' : 'Buyer')}<span class="line2">${esc(t.agentId)}</span></td><td class="hide-sm">${miniChain(t.steps)}</td><td>${pill(t.txnStatus, STATUS_WORD[t.txnStatus])}</td>
        <td class="num">${t.health}</td><td class="num">${usd(t.amount)}</td><td class="num dim hide-sm">${dt(t.createdAt)}</td></tr>`).join('')}</tbody></table>`
      : txns.length ? empty('No transactions match', 'Clear the search or choose another status.') : empty('No transactions yet', 'Load the demo scenarios from the Overview.', '<button class="btn primary" data-seed>Load demo scenarios</button>')}</div></section>`
    + (txns.length ? `<div class="grid g-1-1" style="margin-top:var(--gap)">` + breakdown('By merchant', txns, t => t.merchant) + breakdown('By initiator', txns, t => t.initiator === 'AI agent' ? 'AI agent' : 'Human buyer') + `</div>` : '');
  const q = $('[data-q]'); q.oninput = () => { txQuery = q.value; clearTimeout(q._t); q._t = setTimeout(async () => { await transactions(); const n = $('[data-q]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
  $$('[data-f]').forEach(b => b.onclick = () => { txFilter = b.dataset.f; transactions(); });
}

function breakdown(title, txns, key) {
  const groups = {};
  for (const t of txns) (groups[key(t)] ||= []).push(t);
  const rows = Object.entries(groups).map(([k, a]) => ({ k, n: a.length, gross: a.reduce((s, t) => s + Math.round(t.amount * 100), 0) / 100, ok: a.filter(t => t.txnStatus === 'verified').length })).sort((a, b) => b.gross - a.gross);
  const head = title.replace('By ', '');
  return panel(title, `${rows.length} ${head === 'merchant' ? 'merchants' : 'groups'}`, `<div class="body flush"><table><thead><tr><th>${cap(head)}</th><th class="num">Transactions</th><th class="num">Verified</th><th class="num">Gross</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.k)}</td><td class="num">${r.n}</td><td class="num">${r.ok}</td><td class="num">${usd(r.gross)}</td></tr>`).join('')}</tbody></table></div>`);
}

// ---------- 03 Reconciliation ----------
let reconSel = null;
async function reconciliation() {
  main.innerHTML = topline('Reconciliation', 'Buyer approval, merchant order and PayPal gross capture, side by side.') + panel('Transactions', '', loading(4));
  const { txns } = await load(['txns']);
  const paid = txns.filter(t => t.captureId || t.orderId).sort((a, b) => (b.mismatches - a.mismatches) || (a.health - b.health));
  if (!paid.length) { main.innerHTML = topline('Reconciliation', '') + panel('Transactions', '', empty('Nothing to reconcile', 'Captured payments appear here.', '<button class="btn primary" data-seed>Load demo scenarios</button>')); return; }
  if (!paid.find(t => t.intentId === reconSel)) reconSel = paid[0].intentId;
  const c = await api(`/api/assurance/${reconSel}`);
  const r = c.reconciliation;
  const ref = r.rows.find(x => x.label === 'Buyer-approved amount')?.value;
  const COMPARED = ['Merchant committed price', 'PayPal order amount', 'PayPal gross capture', 'Agent-reported amount'];
  const LABEL = { 'Buyer-approved amount': 'Buyer approval', 'Merchant committed price': 'Merchant order', 'PayPal order amount': 'PayPal order', 'PayPal gross capture': 'PayPal gross capture',
    'Agent-reported amount': 'Agent claim', 'Refunded / reversed': 'Refunded', 'PayPal fee (not compared)': 'PayPal fee', 'Gross after refunds': 'Gross after refunds', 'Merchant net after fees': 'Merchant net' };
  const cols = r.rows.filter(x => LABEL[x.label]);
  const main4 = cols.filter(x => x.label === 'Buyer-approved amount' || COMPARED.includes(x.label));
  const after = cols.filter(x => !main4.includes(x));
  const cell = x => { const off = COMPARED.includes(x.label) && x.value != null && ref != null && x.value !== ref;
    return `<div class="${off ? 'off' : ''} ${x.label === 'Buyer-approved amount' ? 'ref' : ''}"><div class="label">${esc(LABEL[x.label])}${x.label === 'Buyer-approved amount' ? ' · reference' : ''}</div>
      <div class="value">${usd(x.value)}</div><div class="src">${x.value == null ? 'no record' : esc(x.source)}</div>${off ? `<div class="small" style="color:var(--negative);margin-top:4px">${usd(x.value - ref)} vs approval</div>` : ''}</div>`; };

  main.innerHTML = topline('Reconciliation', `${txns.filter(t => t.mismatches).length} of ${paid.length} transactions have conflicting records. Gross capture is compared; fees are shown, never compared.`)
    + `<div class="grid g-1-2 top">`
    + panel('Transactions', 'mismatches first', `<div class="body flush"><table><thead><tr><th>Item</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
      ${paid.map(t => `<tr class="clickable ${t.intentId === reconSel ? 'sel' : ''}" data-recon="${t.intentId}" tabindex="0"><td><div class="trunc" style="max-width:130px">${esc(t.title)}</div><span class="line2">${esc(t.intentId)}</span></td><td>${pill(t.txnStatus, STATUS_WORD[t.txnStatus])}</td><td class="num">${usd(t.amount)}</td></tr>`).join('')}</tbody></table></div>`)
    + panel(c.title, `${esc(c.intentId)} · ${esc(c.initiator)}`, `<div class="body">
        <div class="compare c${main4.length}">${main4.map(cell).join('')}</div>
        ${r.mismatches.length ? `<div class="finding"><b>${r.mismatches.length} discrepanc${r.mismatches.length > 1 ? 'ies' : 'y'} found</b>${r.mismatches.map(m => `<p>${esc(tidy(m))}</p>`).join('')}<p class="dim small">Suggested action: ${r.mismatches.some(m => /DUPLICATE/.test(m)) ? 'confirm with the merchant how many orders were fulfilled; if one, the merchant refunds the extra capture through PayPal.' : 'verify order modifications and capture records with the merchant.'}</p></div>`
          : `<div class="finding ok"><b>Records agree</b><p class="dim">${esc(c.statusReasons.join(' · '))}</p></div>`}
        ${after.length ? `<h2 style="font-size:13px;font-weight:600;margin:16px 0 8px">After capture</h2><div class="compare c${after.length}">${after.map(cell).join('')}</div>` : ''}
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-txn="${c.intentId}">Open transaction</button><a class="btn" href="#evidence" data-evsel="${c.intentId}" style="display:inline-flex;align-items:center">Evidence</a></div>
      </div>`)
    + `</div>`;
  $$('[data-recon]').forEach(r => r.onclick = () => { reconSel = r.dataset.recon; reconciliation(); });
}

// ---------- 04 Incident Center ----------
let incFilter = 'active';
async function incidents() {
  main.innerHTML = topline('Incident Center', '') + panel('Incidents', '', loading(4));
  const { incidents: d } = await load(['incidents']);
  const list = d.incidents.filter(i => incFilter === 'all' || (incFilter === 'active' ? i.status !== 'resolved' : i.status === 'resolved'));
  const active = d.incidents.filter(i => i.status !== 'resolved');
  const overdue = active.filter(i => i.overdue).length;
  const ch = d.channels;
  main.innerHTML = topline('Incident Center', active.length ? `${active.length} active · ${active.filter(i => i.severity === 'critical').length} critical${overdue ? ` · ${overdue} overdue` : ''}. PACT flags and requests verification; it never refunds, cancels or files disputes.` : 'No active incidents.',
      `<button class="btn" data-scan>Run detection</button>`)
    + `<div class="banner">Delivery: email ${ch.email ? pill('ok', 'Connected') : pill('outbox', 'Outbox only')} · buyer address ${ch.buyerEmail ? pill('ok', 'Set') : pill('neutral', 'Not set')} · PayPal ${ch.paypalReporting ? pill('ok', 'Authorized integration') : pill('draft', 'Drafts only, no authorized channel')}</div>`
    + `<section class="panel"><div class="toolbar"><div class="seg" role="group" aria-label="Filter incidents">${[['active', 'Active', active.length], ['resolved', 'Resolved', d.incidents.length - active.length], ['all', 'All', d.incidents.length]].map(([k, l, n]) => `<button aria-pressed="${incFilter === k}" data-if="${k}">${l} ${n}</button>`).join('')}</div></div>
    <div class="body flush scroll-x">${list.length ? `<table><thead><tr><th>Incident</th><th>Problem</th><th>Severity</th><th>Stage</th><th class="hide-sm">Owner</th><th class="hide-sm">Notified</th><th class="num">Due</th></tr></thead><tbody>
      ${list.map(i => `<tr class="clickable" data-inc="${i.id}" tabindex="0"><td class="id">${esc(i.id)}</td><td>${esc(cap(i.kind))}<span class="line2 trunc">${esc(i.title || '')}</span></td><td>${pill(i.severity)}</td>
        <td>${pill(i.status === 'resolved' ? 'resolved' : i.stage, cap(i.stage))}</td><td class="hide-sm">${esc(cap(i.owner))}</td>
        <td class="hide-sm small">${i.notified.map(n => { const [p, s] = n.split(':'); return `${esc(cap(p))} <span class="dim">${esc(s)}</span>`; }).join('<br>')}</td>
        <td class="num ${i.overdue ? '' : 'dim'}" style="${i.overdue ? 'color:var(--negative)' : ''}">${i.status === 'resolved' ? '—' : esc(due(i.dueAt))}</td></tr>`).join('')}</tbody></table>`
      : empty(incFilter === 'active' ? 'No active incidents' : 'No incidents here', 'PACT opens one when records disagree.')}</div></section>`
    + panel('Who is notified', 'routing rules', `<div class="body flush scroll-x"><table><thead><tr><th>Problem</th><th>Severity</th><th>Buyer</th><th>Merchant</th><th>PayPal</th></tr></thead><tbody>
      ${Object.entries(d.routing).map(([k, r]) => `<tr><td>${esc(cap(k))}</td><td>${pill(r.severity)}</td><td>Always</td><td>${esc(cap(r.merchant))}</td><td>${r.paypal === 'no' ? '<span class="dim">Never</span>' : esc(cap(r.paypal))}</td></tr>`).join('')}</tbody></table></div>`);
  $$('[data-if]').forEach(b => b.onclick = () => { incFilter = b.dataset.if; incidents(); });
}

// ---------- 05 Evidence & Disputes ----------
let evSel = null;
async function evidence() {
  main.innerHTML = topline('Evidence & Disputes', '') + panel('Evidence', '', loading(4));
  const { txns } = await load(['txns']);
  const paid = txns.filter(t => t.captureId).sort((a, b) => a.evidence - b.evidence);
  if (!paid.length) { main.innerHTML = topline('Evidence & Disputes', '') + panel('Evidence', '', empty('No paid transactions', 'Evidence is assembled once a payment is captured.')); return; }
  if (!paid.find(t => t.intentId === evSel)) evSel = paid[0].intentId;
  const c = await api(`/api/assurance/${evSel}`);
  const avg = Math.round(paid.reduce((s, t) => s + t.evidence, 0) / paid.length);
  main.innerHTML = topline('Evidence & Disputes', `Average evidence completeness ${avg}% across ${paid.length} paid transactions. Drafts only: nothing is submitted to PayPal, nothing is fabricated.`)
    + `<div class="grid g-1-2 top">`
    + panel('Transactions', 'least complete first', `<div class="body flush"><table><thead><tr><th>Item</th><th class="num">Evidence</th></tr></thead><tbody>
      ${paid.map(t => `<tr class="clickable ${t.intentId === evSel ? 'sel' : ''}" data-ev="${t.intentId}" tabindex="0"><td><div class="trunc" style="max-width:200px">${esc(t.title)}</div><span class="line2">${esc(t.intentId)} · ${esc(t.merchant)}</span></td><td class="num">${t.evidence}%<div class="meter" style="width:72px;margin-left:auto;margin-top:4px"><i style="width:${t.evidence}%"></i></div></td></tr>`).join('')}</tbody></table></div>`)
    + `<div>` + panel(c.title, `${c.evidence.score}% complete`, `<div class="body">
        <div class="chain-full">${c.steps.map(s => `<div class="${s.state}"><b>${esc(s.name)}</b>${esc(STEP_WORD[s.state] || cap(s.state))}</div>`).join('')}</div>
        <ul class="checks" style="margin-top:12px">${c.evidence.items.map(i => `<li class="${i.have ? '' : 'no'}">${esc(i.label)}</li>`).join('')}</ul>
        <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;align-items:center"><label class="small dim" for="claim">Claim type</label>
          <select id="claim"><option value="not_received">Item not received</option><option value="unauthorized">Unauthorized transaction</option><option value="not_as_described">Not as described</option><option value="refund_not_received">Refund not received</option></select>
          <button class="btn primary" data-pkg>Prepare evidence package</button></div><div id="pkg"></div></div>`)
    + panel('Investigation timeline', `${c.timeline.length} events · hash-chained`, `<div class="body"><ol class="tl">${c.timeline.map(e => `<li><time>${tm(e.at)}</time><span>${esc(cap(e.type))}</span>${srcTag(e.source)}</li>`).join('')}</ol></div>`)
    + `</div></div>`;
  $$('[data-ev]').forEach(r => r.onclick = () => { evSel = r.dataset.ev; evidence(); });
  $('[data-pkg]').onclick = async () => {
    const out = $('#pkg'); out.innerHTML = loading(2);
    try {
      const p = await post(`/api/assurance/${evSel}/dispute`, { claim: $('#claim').value });
      out.innerHTML = `<div class="finding ${p.canContest ? 'ok' : ''}"><b>${p.canContest ? 'Evidence supports the merchant' : 'Do not contest with this evidence'}</b><p>${esc(p.recommendation)}</p></div>
        <h3 style="font-size:13px;margin:12px 0 6px">Facts on record</h3><ol class="small" style="padding-left:18px;margin:0">${p.facts.map(f => `<li style="margin-bottom:4px">${esc(f)}</li>`).join('')}</ol>
        ${p.missing.length ? `<p class="small" style="color:var(--negative)">Missing: ${p.missing.map(esc).join(', ')}</p>` : ''}<p class="small dim">Sources: ${p.sources.map(esc).join(' · ')}</p>`;
    } catch (e) { out.innerHTML = errorBar(e); }
  };
}

// ---------- 06 Agentic Commerce ----------
async function agentic() {
  main.innerHTML = topline('Agentic Commerce', '') + panel('Agents', '', loading(4));
  const { agents, intents: all, txns } = await load(['agents', 'intents', 'txns']);
  const acct = await api('/api/intel-accountability');
  const agentTx = txns.filter(t => t.initiator === 'AI agent' && t.captureId), humanTx = txns.filter(t => t.initiator !== 'AI agent' && t.captureId);
  const blocked = all.filter(i => i.status === 'blocked');
  const sum = a => a.reduce((s, t) => s + Math.round(t.amount * 100), 0) / 100;
  const ver = a => a.filter(t => t.txnStatus === 'verified').length;
  const machines = agents.filter(a => !a.human);
  main.innerHTML = topline('Agentic Commerce', `${agentTx.length} AI-agent and ${humanTx.length} human purchases captured. ${blocked.length} agent attempts were stopped before payment.`,
      `<button class="btn" data-attack>Run attack simulation</button><a class="btn" href="classic.html" style="display:inline-flex;align-items:center">Buyer console</a>`)
    + `<div class="kpis" style="grid-template-columns:repeat(4,1fr)">${[
      ['AI-agent volume', usd(sum(agentTx)), `${agentTx.length} purchases · ${ver(agentTx)} verified`],
      ['Human volume', usd(sum(humanTx)), `${humanTx.length} purchases · ${ver(humanTx)} verified`],
      ['Stopped before payment', blocked.length, 'by the authorization firewall'],
      ['Active agents', machines.filter(a => a.status === 'active').length, `${machines.filter(a => a.status !== 'active').length} revoked`]].map(([l, v, n], i) => `<div class="kpi"><div class="label">${l}</div><div class="value ${i === 0 ? 'lead' : ''}">${v}</div><div class="note">${esc(n)}</div></div>`).join('')}</div>`
    + panel('Agent permissions', `${machines.length} agents`, machines.length ? `<div class="body flush scroll-x"><table><thead><tr><th>Agent</th><th>Status</th><th class="num">Per purchase</th><th class="num">Spent today</th><th class="hide-sm">Scope</th><th class="num hide-sm">Expires</th><th></th></tr></thead><tbody>
      ${machines.map(a => `<tr><td>${esc(a.name)}<span class="line2 id">${esc(a.id)} · policy v${a.policyVersion}</span></td><td>${pill(a.status)}</td><td class="num">${usd(a.permissions.maxPerTxn)}<span class="line2">approval over ${usd(a.permissions.approvalAbove)}</span></td>
        <td class="num">${usd(a.spentToday)}<span class="line2">of ${usd(a.permissions.dailyBudget)}</span></td><td class="hide-sm small">${esc(a.permissions.allowedCategories.join(', ') || 'Any category')}<span class="line2">${esc(a.permissions.allowedMerchants.join(', ') || 'Any merchant')}</span></td>
        <td class="num dim hide-sm">${dt(a.permissions.expiresAt)}</td><td class="num">${a.status === 'active' ? `<button class="btn danger" data-revoke="${a.id}">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No agents registered', 'Register one in the buyer console.'))
    + panel('Agent accountability', 'measured behaviour, not a universal trust score', acct.length ? `<div class="body flush scroll-x"><table><thead><tr><th>Agent</th><th class="num">Score</th><th>Confidence</th><th class="num">Proposals</th><th class="num">Blocked</th><th class="num">Price deviations</th><th class="num">Duplicates</th><th class="num">Paid</th><th class="num">Reconciled</th><th class="num">Fulfilled</th></tr></thead><tbody>${acct.map(a => `<tr><td>${esc(a.name)}<span class="line2 id">${esc(a.agentId)}</span></td><td class="num"><span class="score">${a.score ?? '—'}</span></td><td>${pill(a.confidence === 'high' ? 'ok' : a.confidence === 'medium' ? 'pending' : 'neutral', cap(a.confidence) + ' · ' + a.basis)}</td><td class="num">${a.metrics.proposals}</td><td class="num">${a.metrics.blocked}</td><td class="num">${a.metrics.priceDeviations}</td><td class="num">${a.metrics.duplicateAttempts}</td><td class="num">${a.metrics.paid}</td><td class="num">${a.metrics.reconciled}</td><td class="num">${a.metrics.fulfilled}</td></tr>`).join('')}</tbody></table><p class="small dim" style="padding:0 18px">Score = ${esc(acct[0].formula)}.</p></div>` : empty('No agents', ''))
    + `<div class="grid g-1-1" style="margin-top:var(--gap)">`
    + panel('Agent purchases', 'authorization → payment → commitment', agentTx.length ? `<div class="body flush scroll-x"><table><thead><tr><th>Item</th><th>Chain</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
      ${agentTx.map(t => `<tr class="clickable" data-txn="${t.intentId}" tabindex="0"><td><div class="trunc" style="max-width:190px">${esc(t.title)}</div><span class="line2">${esc(t.agentId)}</span></td><td>${miniChain(t.steps)}</td><td>${pill(t.txnStatus, STATUS_WORD[t.txnStatus])}</td><td class="num">${usd(t.amount)}</td></tr>`).join('')}</tbody></table></div>` : empty('No agent purchases', 'Captured agent purchases appear here.'))
    + panel('Stopped before payment', `${blocked.length} attempts`, blocked.length ? `<div class="rows">${blocked.slice(0, 6).map(i => `<div><span class="t">${esc(i.title || i.proposal?.productId)} · ${usd(i.amount)}</span>${pill('block', 'Blocked')}<span class="d">${esc(i.agentId)} · ${esc((i.preflight.failed[0] || '').replace(/_/g, ' '))}</span></div>`).join('')}</div>`
      : empty('Nothing stopped yet', 'Run the attack simulation to test the firewall.'))
    + `</div>`;
}

// ---------- 07 Audit & Event Logs ----------
let auditTab = 'raw';
async function audit() {
  main.innerHTML = topline('Audit & Event Logs', '') + panel('Events', '', loading(5));
  const { raw, ledger, security, impact } = await load(['raw', 'ledger', 'security', 'impact']);
  const integ = ledger.integrity;
  const ev = impact.events;
  main.innerHTML = topline('Audit & Event Logs', `${int(ev.received)} events received · ${int(ev.duplicates)} duplicate deliveries ignored · ${int(ev.unmatched)} held for a later transaction. Audit chain ${integ.ok ? `verified across ${int(integ.length)} entries` : `BROKEN at entry ${integ.brokenAt}`}.`)
    + `<div class="banner">${integ.ok ? pill('ok', 'Hash chain intact') : pill('broken', 'Hash chain broken')} Each audit entry stores the SHA-256 of the previous one, so any edit to history is detectable.</div>`
    + `<section class="panel"><div class="toolbar"><div class="seg" role="group" aria-label="Log">${[['raw', 'Raw events', raw.length], ['ledger', 'Audit ledger', ledger.events.length], ['security', 'Security events', security.events.length]].map(([k, l, n]) => `<button aria-pressed="${auditTab === k}" data-at="${k}">${l} ${n}</button>`).join('')}</div></div>
    <div class="body flush scroll-x">${auditTab === 'raw' ? (raw.length ? `<table><thead><tr><th>Event ID</th><th>Type</th><th>Source</th><th class="hide-sm">Transaction</th><th>Signature</th><th>Applied</th><th class="num">Received</th></tr></thead><tbody>
      ${raw.map(e => `<tr><td class="id">${esc(e.event_id.slice(0, 18))}</td><td>${esc(e.type)}${e.json?.amount != null ? `<span class="line2">${usd(e.json.amount)}</span>` : ''}</td><td>${esc(cap(e.source))}</td><td class="id hide-sm">${esc((e.transaction_id || '—').slice(0, 14))}</td>
        <td>${e.verified ? pill('ok', 'Verified') : pill('neutral', 'Not verified')}</td><td>${e.applied ? pill('ok', 'Applied') : pill('neutral', 'Stored only')}</td><td class="num dim">${tm(e.received_at)}</td></tr>`).join('')}</tbody></table>` : empty('No raw events', 'Webhooks and merchant events are stored here first.'))
      : auditTab === 'ledger' ? `<table><thead><tr><th class="num">#</th><th>Entry</th><th>Actor</th><th class="hide-sm">Reference</th><th class="hide-sm">Hash</th><th class="num">Time</th></tr></thead><tbody>
      ${ledger.events.slice(0, 120).map(e => `<tr><td class="num dim">${e.seq}</td><td>${esc(cap(e.type))}</td><td>${esc(e.actor)}</td><td class="id hide-sm">${esc(String(e.ref || '—').slice(0, 14))}</td><td class="id hide-sm">${esc(e.hash.slice(0, 12))}…</td><td class="num dim">${tm(e.at)}</td></tr>`).join('')}</tbody></table>`
      : (security.events.length ? `<table><thead><tr><th>Kind</th><th>Agent</th><th>Detail</th><th class="num">Time</th></tr></thead><tbody>
      ${security.events.map(e => `<tr><td>${pill('block', cap(e.kind))}</td><td class="id">${esc(e.agentId)}</td><td class="small">${esc(e.detail)}</td><td class="num dim">${tm(e.at)}</td></tr>`).join('')}</tbody></table>` : empty('No security events', 'Blocked attempts and duplicate captures are logged here.'))}</div></section>`;
  $$('[data-at]').forEach(b => b.onclick = () => { auditTab = b.dataset.at; audit(); });
}

// ---------- Transaction Intelligence: graph + investigation + replay ----------
let intelSel = null, intelReplay = null, intelNode = null;
const NODE_STATE = { ok: 'ok', conflict: 'mismatch', missing: 'missing', pending: 'pending' };
const NODE_WORD = { ok: 'Matches', conflict: 'Conflict', missing: 'Missing', pending: 'Waiting' };
function graphHTML(g) {
  return `<div class="graph" role="list">${g.nodes.map((n, i) => {
    const e = g.edges[i];
    return `<button class="gnode g-${n.status} ${intelNode === n.id ? 'gsel' : ''}" role="listitem" data-node="${n.id}" aria-label="${esc(n.label)}: ${NODE_WORD[n.status]}">
        <span class="gl">${esc(n.label)}</span><span class="ga">${n.amount != null ? usd(n.amount) : '&nbsp;'}</span><span class="gs">${esc(NODE_WORD[n.status])}</span>${n.note ? `<span class="gn">${esc(n.note)}</span>` : ""}</button>`
      + (e ? `<span class="gedge e-${e.status}" aria-hidden="true">${e.note ? `<em>${esc(e.note)}</em>` : ''}</span>` : '');
  }).join('')}</div>`;
}
function nodeHTML(n) {
  if (!n) return '<p class="dim small" style="margin:0">Click any step in the graph to see the original record behind it.</p>';
  const rec = n.record == null ? '<p class="dim small">No record exists for this step.</p>'
    : `<dl class="kv">${Object.entries(Array.isArray(n.record) ? Object.fromEntries(n.record.map((r, i) => [`event ${i + 1}`, `${r.type} · ${(r.at || '').slice(0, 10)} · ${r.source}`])) : n.record)
        .filter(([, v]) => v != null && typeof v !== 'object').slice(0, 12).map(([k, v]) => `<dt>${esc(cap(k))}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap"><b>${esc(n.label)}</b>${pill(NODE_STATE[n.status], NODE_WORD[n.status])}${srcTag(n.source)}</div>
    <p style="margin:0 0 10px">${esc(n.detail)}</p>${rec}
    <h3 style="font-size:13px;margin:12px 0 6px">Proof in the audit ledger</h3>
    ${n.evidence.length ? `<ol class="tl">${n.evidence.map(e => `<li><time>#${e.seq > 1e8 ? '—' : e.seq}</time><span>${esc(cap(e.type))}<span class="line2 id">${e.replay ? 'replay, not saved' : 'hash ' + esc(e.hash) + '…'}</span></span>${srcTag(e.source)}</li>`).join('')}</ol>` : '<p class="dim small" style="margin:0">No ledger entry for this step.</p>'}`;
}
// One purchase, every party's version: buyer, agent, merchant, PayPal. Contradictions in red.
function truthPanel(t) {
  const h = t.headline, s = t.summary;
  return panel(`Transaction truth · ${t.title}`, pill(s.status, STATUS_WORD[s.status]), `<div class="body">
    <div class="truth">${t.parties.map(p => { const off = t.expected != null && p.says != null && Math.round(p.says * 100) !== Math.round(t.expected * 100);
      return `<div class="${off ? 'off' : ''}"><div class="p">${esc(p.party)} says</div><div class="v">${p.says == null ? '—' : usd(p.says)}</div><div class="r">${esc(p.record)}</div><div class="r">${srcTag(p.source)}</div></div>`; }).join('')}</div>
    ${h ? `<div class="diff"><b>${h.difference > 0 ? '+' : '−'}${usd(Math.abs(h.difference))}</b><span>between the buyer's approved ${usd(h.expected)} and ${esc(h.party)}'s ${usd(h.actual)} (${esc(h.record)}). Investigation required.</span>
      <a class="btn primary" href="#investigate?id=${t.intentId}" style="margin-left:auto;display:inline-flex;align-items:center">Investigate</a></div>`
      : t.contradictions.length ? `<div class="diff"><span>${t.contradictions.map(c => `${esc(c.party)}: ${esc(c.kind || 'amount')} (${esc(String(c.actual))})`).join(' · ')}</span><a class="btn primary" href="#investigate?id=${t.intentId}" style="margin-left:auto;display:inline-flex;align-items:center">Investigate</a></div>`
      : `<div class="finding ok"><b>All parties agree</b><p class="dim">No party's record contradicts the buyer's approval.</p></div>`}
    <div class="tsum"><span><b>${s.connectedRecords}</b>connected records</span><span><b>${s.verifiedRelationships}/${s.totalRelationships}</b>relationships verified</span><span><b>${s.conflictingRecords}</b>conflicting</span><span><b>${s.missingRecords}</b>missing</span>${t.captures.length > 1 ? `<span><b>${t.captures.length}</b>captures for one order: ${t.captures.map(c => esc(c.id)).join(', ')}</span>` : ''}</div>
  </div>`);
}
const cites = ev =>ev.map(c => `<button class="cite" data-node="${c.node}">${esc(c.label)}${c.ledger.length ? ' #' + c.ledger.slice(0, 3).join(',') : ''}</button>`).join('');

async function intel() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  main.innerHTML = topline('Transaction Intelligence', '') + panel('Transaction', '', loading(4));
  const { txns } = await load(['txns']);
  const paid = txns.filter(t => t.captureId);
  if (!paid.length) { main.innerHTML = topline('Transaction Intelligence', '') + panel('Transaction', '', empty('No paid transactions yet', 'Make a purchase or load the demo scenarios.', '<button class="btn primary" data-seed>Load demo scenarios</button>')); return; }
  if (q.get('id') && q.get('id') !== intelSel) { intelSel = q.get('id'); intelReplay = null; intelNode = null; }
  if (!paid.find(t => t.intentId === intelSel)) { intelSel = (paid.find(t => t.txnStatus !== 'verified') || paid[0]).intentId; intelReplay = null; intelNode = null; }
  const [inv, inj, tr] = await Promise.all([api(`/api/intel/${intelSel}/investigate`), api('/api/intel-injections'), api(`/api/intel/${intelSel}/truth`)]);
  const g = intelReplay ? intelReplay.final : inv.graph;
  const nodeObj = g.nodes.find(n => n.id === intelNode);
  const SECT = [['whatHappened', 'What happened'], ['disagreements', 'Which records disagree'], ['whyFlagged', 'Why it was flagged'], ['missingEvidence', 'What evidence is missing'], ['nextSteps', 'What to do next']];

  main.innerHTML = topline('Transaction Intelligence', 'One purchase as linked records, from the buyer\'s approval to PayPal\'s capture and the delivery. Every step links to the record that proves it.',
      `<select aria-label="Choose transaction" data-intelsel>${paid.map(t => `<option value="${t.intentId}" ${t.intentId === intelSel ? 'selected' : ''}>${esc(t.title.slice(0, 34))} · ${usd(t.amount)} · ${STATUS_WORD[t.txnStatus]}</option>`).join('')}</select>`)
    + (intelReplay ? `<div class="banner">${pill('draft', 'Replay view')} Showing the transaction after: ${intelReplay.injected.map(esc).join(', ')}. Nothing was saved. <button class="btn" data-replay-off>Back to the real transaction</button></div>` : '')
    + (intelReplay ? '' : truthPanel(tr))
    + panel(intelReplay ? inv.title + ' · replay' : 'Transaction relationship graph', `${pill(g.status, STATUS_WORD[g.status])}`, `<div class="body"><p class="small dim" style="margin:0 0 10px">PACT connects records across the purchase lifecycle to identify inconsistencies between what was approved, ordered, paid and delivered.</p>${graphHTML(g)}<div class="gdetail">${nodeHTML(nodeObj)}</div></div>`)
    + `<div class="grid g-2-1 top" style="margin-top:var(--gap)">`
    + panel('Investigation', esc(inv.summarySource), `<div class="body"><div class="finding ${inv.status === 'verified' ? 'ok' : ''}" style="margin-top:0"><p>${esc(inv.summary)}</p></div>
        ${SECT.map(([k, t]) => `<h3 class="sect">${t} <span class="dim">${inv.sections[k].length}</span></h3>${inv.sections[k].length ? `<ul class="stmts">${inv.sections[k].map(s => `<li>${esc(s.text)}<span class="cites">${cites(s.evidence)}</span></li>`).join('')}</ul>` : '<p class="dim small" style="margin:0 0 6px">Nothing here.</p>'}`).join('')}
        <p class="dim small">${esc(inv.guardrail)}</p></div>`)
    + panel('What if…', 'replay on a copy', `<div class="body"><p class="small" style="margin:0 0 10px">Inject a problem into this purchase and watch which event changes its status. The real transaction is never changed.</p>
        <div class="inj">${Object.entries(inj).map(([k, l]) => `<label><input type="checkbox" value="${k}" ${intelReplay?.keys?.includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
        <button class="btn primary" data-replay style="margin-top:12px;width:100%">Replay</button>
        ${intelReplay ? `<ol class="tl" style="margin-top:14px">${intelReplay.steps.map(s => `<li class="${s.triggered ? 'trig' : ''}"><time>${s.triggered ? 'Trigger' : ''}</time><span>${esc(s.event)}</span>${s.after ? pill(s.after, STATUS_WORD[s.after]) : ''}</li>`).join('')}</ol>
          ${intelReplay.trigger ? `<div class="finding"><b>The event that changed the status</b><p>${esc(intelReplay.trigger)}</p></div>` : '<p class="small dim">No injected event changed the status.</p>'}` : ''}</div>`)
    + `</div>`;

  $('[data-intelsel]').onchange = e => { location.hash = `intel?id=${e.target.value}`; };
  $$('[data-node]').forEach(b => b.onclick = () => { intelNode = b.dataset.node; intel(); });
  $('[data-replay]').onclick = async () => {
    const keys = $$('.inj input:checked').map(i => i.value);
    if (!keys.length) return toast('Choose at least one problem to inject');
    try { intelReplay = { ...(await post(`/api/intel/${intelSel}/replay`, { inject: keys })), keys }; intelNode = null; intel(); } catch (e) { toast(e.message); }
  };
  $('[data-replay-off]')?.addEventListener('click', () => { intelReplay = null; intel(); });
}

// ---------- AI Investigation workspace ----------
let invSel = null, invCache = null;
async function investigate() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  main.innerHTML = topline('AI Investigation', '') + panel('Cases', '', loading(4));
  const [{ txns }, { incidents: d }] = [await load(['txns']), await load(['incidents'])];
  const open = d.incidents;
  const flagged = txns.filter(t => t.captureId && t.txnStatus !== 'verified');
  if (q.get('id')) { invSel = q.get('id'); invCache = null; }
  const ids = [...new Set([...open.map(i => i.intentId), ...flagged.map(t => t.intentId)])];
  if (!ids.length) { main.innerHTML = topline('AI Investigation', 'Nothing to investigate.') + panel('Cases', '', empty('No incidents or flagged transactions', 'PACT opens a case when records disagree.')); return; }
  if (!ids.includes(invSel)) { invSel = ids[0]; invCache = null; }
  if (!invCache || invCache.intentId !== invSel) invCache = await api(`/api/intel/${invSel}/forensics`);
  const f = invCache, r = f.report, inc = open.filter(i => i.intentId === invSel);
  const caseRow = id => { const t = txns.find(x => x.intentId === id), i = open.find(x => x.intentId === id && x.status !== 'resolved') || open.find(x => x.intentId === id);
    return `<button class="${id === invSel ? 'on' : ''}" data-inv="${id}"><div class="t">${esc(i ? cap(i.kind) : 'Flagged transaction')}</div><div class="d">${esc(t?.title || id)} · ${i ? esc(i.severity) + ' · ' + esc(cap(i.status)) : esc(STATUS_WORD[t?.txnStatus] || '')}</div></button>`; };
  const stmt = s => `<li>${esc(s.text)}<span class="cites">${(s.evidence || []).map(c => `<a class="cite" href="#intel?id=${f.intentId}">${esc(c.label)}${c.ledger?.length ? ' #' + c.ledger.slice(0, 3).join(',') : ''}</a>`).join('')}</span></li>`;
  main.innerHTML = topline('AI Investigation', `${esc(f.title)} · ${STATUS_WORD[f.status] || f.status}. ${esc(f.confidence)}.`,
      `<button class="btn" data-inv-refresh>Refresh evidence</button><a class="btn" href="/api/intel/${f.intentId}/report.md" download style="display:inline-flex;align-items:center">Export report</a>`)
    + `<div class="grid g3 top">`
    + panel('Cases', `${ids.length}`, `<div class="qlist">${ids.map(caseRow).join('')}</div>`)
    + `<div>` + panel('Investigation report', esc(f.summarySource), `<div class="body">
        <div class="finding ${f.status === 'verified' ? 'ok' : ''}" style="margin-top:0"><p>${esc(f.summary)}</p></div>
        <h3 class="sect">What was expected</h3><p style="margin:0">${esc(r.expected)}</p>
        <h3 class="sect">What actually happened</h3><p style="margin:0">${esc(r.actual)}</p>
        <h3 class="sect">Each party's version</h3><div class="truth tight">${f.truth.parties.map(p => { const off = f.truth.expected != null && p.says != null && Math.round(p.says * 100) !== Math.round(f.truth.expected * 100); return `<div class="${off ? 'off' : ''}"><div class="p">${esc(p.party)}</div><div class="v" style="font-size:18px">${p.says == null ? '—' : usd(p.says)}</div><div class="r">${esc(p.record)}</div></div>`; }).join('')}</div>
        <h3 class="sect">Which records disagree <span class="dim">${r.disagreements.length}</span></h3>${r.disagreements.length ? `<ul class="stmts">${r.disagreements.map(stmt).join('')}</ul>` : '<p class="dim small" style="margin:0">None.</p>'}
        <h3 class="sect">What happened (confirmed facts)</h3><ul class="stmts">${r.whatHappened.map(stmt).join('')}</ul>
        <h3 class="sect">Possible explanations <span class="pill s-draft" style="margin-left:6px">Hypotheses, not verified</span></h3>${r.hypotheses.length ? `<ul class="stmts hyp">${r.hypotheses.map(h => `<li>${esc(h.text)}</li>`).join('')}</ul>` : '<p class="dim small" style="margin:0">None needed.</p>'}
        <p class="dim small">${esc(f.guardrail)}</p></div>`)
    + panel('Chronology', `${f.chronology.length} ledger entries`, `<div class="body"><ol class="tl">${f.chronology.map(c => `<li><time>${tm(c.at)}</time><span>${esc(cap(c.event))}<span class="line2 id">#${c.seq} · ${esc(c.hash)}…</span></span>${srcTag(c.source)}</li>`).join('')}</ol></div>`) + `</div>`
    + `<div>` + panel('Recommended actions', '', `<div class="body"><ul class="stmts">${r.nextSteps.map(s => `<li>${esc(s.text)}</li>`).join('')}</ul>
        ${inc.filter(i => i.status !== 'resolved').map(i => `<div style="border-top:1px solid var(--rule-2);padding-top:10px;margin-top:10px"><div class="small"><b>${esc(i.id)}</b> · owner ${esc(i.owner)} · ${esc(cap(i.status))}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn" data-assign="${i.id}">Assign investigator</button>${i.status === 'open' ? `<button class="btn" data-review="${i.id}">Mark under review</button>` : ''}<button class="btn" data-inc="${i.id}">Open case</button></div></div>`).join('') || '<p class="small dim">No open incident for this transaction.</p>'}</div>`)
    + panel('Missing evidence', `${r.missingEvidence.length}`, `<div class="body">${r.missingEvidence.length ? `<ul class="checks" style="grid-template-columns:1fr">${r.missingEvidence.map(s => `<li class="no">${esc(s.text.replace(' is not on record.', ''))}</li>`).join('')}</ul>` : '<p class="small dim" style="margin:0">Nothing missing.</p>'}</div>`)
    + panel('Investigation checklist', '', `<div class="body"><ul class="checks" style="grid-template-columns:1fr">
        <li class="${r.evidence.length ? '' : 'no'}">Related records collected (${r.evidence.length})</li><li class="${f.chronology.length ? '' : 'no'}">Chronology rebuilt from the ledger</li>
        <li>Each party's version compared</li><li class="${r.missingEvidence.length ? 'no' : ''}">All expected evidence present</li><li class="${inc.some(i => i.status === 'resolved') ? '' : 'no'}">Case resolved</li></ul></div>`) + `</div></div>`;
  $$('[data-inv]').forEach(b => b.onclick = () => { invSel = b.dataset.inv; invCache = null; investigate(); });
  $('[data-inv-refresh]').onclick = () => { invCache = null; investigate(); };
  $$('[data-assign]').forEach(b => b.onclick = () => confirmModal('Assign investigator', 'Name of the person who owns this case:', true, async v => { await post(`/api/incidents/${b.dataset.assign}/assign`, { owner: v }); toast('Assigned to ' + v); investigate(); }));
  $$('[data-review]').forEach(b => b.onclick = () => confirmModal('Mark under review?', 'The case moves from Open to Under review. This is recorded in the audit ledger.', false, async () => { await post(`/api/incidents/${b.dataset.review}/status`, { status: 'under_review' }); toast('Marked under review'); refreshCounts(); investigate(); }));
}

// ---------- Transaction Simulator (digital twin) ----------
let simState = { key: 'price_changed', id: null, run: null, shown: 0, timer: null };
async function simulator() {
  clearInterval(simState.timer);
  main.innerHTML = topline('Transaction Simulator', '') + panel('Scenario', '', loading(4));
  const [{ txns }, sc] = [await load(['txns']), await api('/api/intel-scenarios')];
  const paid = txns.filter(t => t.captureId);
  if (!paid.length) { main.innerHTML = topline('Transaction Simulator', '') + panel('Scenario', '', empty('No paid transaction to replay', 'Make a purchase or load the demo scenarios.', '<button class="btn primary" data-seed>Load demo scenarios</button>')); return; }
  if (!paid.find(t => t.intentId === simState.id)) simState.id = (paid.find(t => !t.simulated) || paid[0]).intentId;
  if (!simState.run && !simState.auto) { simState.auto = true; try { simState.run = await post(`/api/intel/${simState.id}/simulate`, { scenario: simState.key }); simState.shown = simState.run.steps.length; } catch {} }
  const R = simState.run, d = R?.detection;
  main.innerHTML = topline('Transaction Simulator', 'Replay a real purchase and inject one controlled problem. Runs on a copy: nothing is saved, nothing goes to PayPal, no incident is created.')
    + `<div class="grid g3 top">`
    + panel('Scenario', '', `<div class="body" style="display:grid;gap:10px">
        <label class="small dim">Transaction<select data-simtx style="width:100%;margin-top:4px">${paid.map(t => `<option value="${t.intentId}" ${t.intentId === simState.id ? 'selected' : ''}>${esc(t.title.slice(0, 30))} · ${usd(t.amount)}${t.simulated ? '' : ' · sandbox'}</option>`).join('')}</select></label>
        <div role="radiogroup" aria-label="Scenario" style="display:grid;gap:6px">${Object.entries(sc).map(([k, s]) => `<label class="small" style="display:flex;gap:8px;align-items:flex-start;cursor:pointer"><input type="radio" name="sc" value="${k}" ${k === simState.key ? 'checked' : ''} style="height:auto;margin-top:3px">${esc(s.label)}</label>`).join('')}</div>
        <p class="small dim" style="margin:0">${esc(sc[simState.key].desc)}</p>
        <button class="btn primary" data-simrun>Run simulation</button></div>`)
    + panel('Event timeline', R ? `${R.steps.length} events` : '', R ? `<div class="body"><div class="sim-controls"><button class="btn" data-sim="play">Start</button><button class="btn" data-sim="pause">Pause</button><button class="btn" data-sim="step">Step forward</button><button class="btn" data-sim="restart">Restart</button><button class="btn" data-sim="reset">Reset scenario</button></div>
        <ol class="tl simsteps">${R.steps.map((s, i) => `<li class="${i < simState.shown ? 'shown' : ''} ${s.changed ? 'trig' : ''}"><time>${tm(s.at)}</time><span>${esc(s.label)}${s.newIssues?.length ? `<span class="line2" style="color:var(--negative-ink)">${esc(s.newIssues[0])}</span>` : ''}</span>${pill(s.status, STATUS_WORD[s.status] || cap(s.status))}</li>`).join('')}</ol>
        <p class="small dim">${esc(R.note)}</p></div>` : empty('Choose a scenario and run it', 'The events appear here one by one.'))
    + panel('Detection', '', R && simState.shown >= R.steps.length ? (d ? `<div class="body">
        <div class="finding" style="margin-top:0"><b>${esc(d.anomaly)}</b></div>
        <h3 class="sect">Triggered by</h3><p class="small" style="margin:0">${esc(d.trigger)}</p>
        <h3 class="sect">Why it was flagged</h3><ul class="stmts">${d.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
        ${d.evidence.length ? `<h3 class="sect">Evidence</h3><ul class="stmts">${d.evidence.map(e => `<li><b>${esc(e.label)}</b> (${esc(e.status)}): ${esc(e.detail)}</li>`).join('')}</ul>` : ''}
        ${d.incident ? `<h3 class="sect">Incident that would open</h3><p class="small" style="margin:0">${pill(d.incident.severity)} ${esc(cap(d.incident.kind))} · notifies ${d.incident.notifies.map(esc).join(', ')}</p><p class="small dim">${esc(d.incident.note)}</p>` : ''}
        <h3 class="sect">Recommended next action</h3><p class="small" style="margin:0">${esc(d.next)}</p></div>`
        : `<div class="body"><div class="finding ok" style="margin-top:0"><b>No anomaly</b><p class="dim">Every record agrees: ${esc(STATUS_WORD[R.finalStatus] || R.finalStatus)}.</p></div></div>`)
        : empty(R ? 'Playing…' : 'No result yet', R ? 'The verdict appears when the timeline finishes.' : 'Run a scenario to see what PACT detects.'))
    + `</div>`;
  $('[data-simtx]').onchange = e => { simState.id = e.target.value; simState.run = null; simulator(); };
  $$('input[name=sc]').forEach(r => r.onchange = () => { simState.key = r.value; simState.run = null; simulator(); });
  $('[data-simrun]').onclick = async () => { try { simState.run = await post(`/api/intel/${simState.id}/simulate`, { scenario: simState.key }); simState.shown = 0; simulator(); play(); } catch (e) { toast(e.message); } };
  const play = () => { clearInterval(simState.timer); simState.timer = setInterval(() => { if (simState.shown >= simState.run.steps.length) { clearInterval(simState.timer); return simulator(); } simState.shown++; $$('.simsteps li').forEach((li, i) => li.classList.toggle('shown', i < simState.shown)); if (simState.shown >= simState.run.steps.length) { clearInterval(simState.timer); simulator(); } }, 700); };
  $$('[data-sim]').forEach(b => b.onclick = () => {
    const a = b.dataset.sim;
    if (a === 'play') play();
    if (a === 'pause') clearInterval(simState.timer);
    if (a === 'step') { clearInterval(simState.timer); simState.shown = Math.min(simState.run.steps.length, simState.shown + 1); simulator(); }
    if (a === 'restart') { simState.shown = 0; simulator(); play(); }
    if (a === 'reset') { simState.run = null; simulator(); }
  });
}

// ---------- Settings (read-only status, never secrets) ----------
async function settings() {
  main.innerHTML = topline('Settings', '') + panel('Configuration', '', loading(5));
  const s = await api('/api/settings');
  const st = v => /^configured|^set|^Sandbox|^Claude|^Resend|^SQLite|^from|^always|^never|^signatures/.test(String(v)) ? pill('ok', String(v)) : /missing|none|not set|needs|Simulator/.test(String(v)) ? pill('neutral', String(v)) : esc(v);
  const block = (title, obj) => panel(title, '', `<div class="body settings"><dl class="kv">${Object.entries(obj).map(([k, v]) => `<dt>${esc(cap(k.replace(/([A-Z])/g, ' $1').toLowerCase()))}</dt><dd>${typeof v === 'boolean' ? (v ? pill('ok', 'Yes') : pill('broken', 'No')) : typeof v === 'number' ? int(v) : st(v)}</dd>`).join('')}</dl></div>`);
  main.innerHTML = topline('Settings', 'Read-only status of this installation. Secrets are never shown; change them in the server\'s .env file and restart.')
    + `<div class="banner">${pill(s.environment === 'sandbox' ? 'pending' : 'neutral', s.environment === 'sandbox' ? 'Sandbox' : 'Simulator')} Live mode is ${s.live ? 'on' : 'not configured'}. All payments here use PayPal test money.</div>`
    + `<div class="grid g-1-1 top">` + block('PayPal', s.paypal) + block('Webhooks', s.webhooks) + `</div>`
    + `<div class="grid g-1-1 top">` + block('AI provider', s.ai) + block('Email notifications', { ...s.email, paypalReporting: s.paypalReporting }) + `</div>`
    + `<div class="grid g-1-1 top">` + block('Database', s.database) + block('Security', s.security) + `</div>`;
}

// ---------- confirmation modal ----------
function confirmModal(title, text, withInput, onOk) {
  openDrawer(`<header><h2 id="drawer-title">${esc(title)}</h2><button class="x" aria-label="Close">×</button></header><section><p>${esc(text)}</p>${withInput ? '<input type="text" id="cm-in" style="width:100%" aria-label="Value">' : ''}
    <div style="display:flex;gap:8px;margin-top:14px"><button class="btn primary" id="cm-ok">Confirm</button><button class="btn" id="cm-no">Cancel</button></div><p class="small" id="cm-err" style="color:var(--negative)"></p></section>`);
  $('#cm-no').onclick = closeDrawer;
  $('#cm-ok').onclick = async () => { const v = withInput ? $('#cm-in').value.trim() : true; if (withInput && !v) return ($('#cm-err').textContent = 'Please enter a value.'); try { await onOk(v); closeDrawer(); } catch (e) { $('#cm-err').textContent = e.message; } };
  if (withInput) $('#cm-in').focus();
}

// =====================================================================
// Financial intelligence: six modules on one shared engine (/api/fin/*)
// =====================================================================
const SRC_WORD = { 'paypal-sandbox': 'PayPal sandbox', 'paypal-simulator': 'Simulator', computed: 'Computed', user: 'Entered by you', sample: 'Sample data', estimate: 'Estimate' };
const srcPill = s => { const k = /sandbox/i.test(s) ? 'paypal-sandbox' : /simulat/i.test(s) ? 'paypal-simulator' : s; return `<span class="srcpill src-${esc(k)}">${esc(SRC_WORD[k] || s)}</span>`; };
const daysWord = n => n == null ? '—' : n === 0 ? 'today' : n > 0 ? `in ${n} day${n === 1 ? '' : 's'}` : `${-n} day${n === -1 ? '' : 's'} ago`;
const sampleBar = (anySample, what) => `<div class="banner">${anySample ? srcPill("sample") + ` <span>Rows marked Sample data are demo records.</span>` : `<span>No sample data loaded.</span>`}
  PayPal's sandbox API does not expose ${what} to this integration, so real entries come from you or from PayPal events PACT received.
  <span style="margin-left:auto;display:flex;gap:6px"><button class="btn" data-finsample>${anySample ? 'Reload sample data' : 'Load sample data'}</button>${anySample ? '<button class="btn" data-finclear>Remove sample data</button>' : ''}</span></div>`;
function bindSample(again) {
  $('[data-finsample]')?.addEventListener('click', async () => { await post('/api/fin/sample'); toast('Sample data loaded (labelled)'); refreshCounts(); again(); });
  $('[data-finclear]')?.addEventListener('click', async () => { await api('/api/fin/sample', { method: 'DELETE' }); toast('Sample data removed'); refreshCounts(); again(); });
}

// ---------- Money Recovery ----------
async function money() {
  main.innerHTML = topline('Money Recovery', '') + panel('Held funds', '', loading(4));
  const d = await api('/api/fin/holds'), { txns } = await load(['txns']);
  const held = d.holds.filter(h => h.status === 'held');
  main.innerHTML = topline('Money Recovery', held.length ? `${usd(d.held)} is on hold across ${held.length} payment${held.length > 1 ? 's' : ''}. Each hold below has its checklist and next step.` : 'No money on hold.')
    + sampleBar(d.holds.some(h => h.source === 'sample'), 'hold reasons')
    + `<div class="kpis" style="grid-template-columns:repeat(3,1fr)"><div class="kpi"><div class="label">On hold</div><div class="value lead">${usd(d.held)}</div><div class="note">${held.length} payments</div></div>
       <div class="kpi"><div class="label">Longest hold</div><div class="value">${held.length ? Math.max(...held.map(h => h.daysHeld)) + '<small> days</small>' : '—'}</div><div class="note">since the hold was placed</div></div>
       <div class="kpi"><div class="label">Released</div><div class="value">${d.holds.filter(h => h.status === 'released').length}</div><div class="note">marked released by you</div></div></div>`
    + (d.holds.length ? d.holds.map(h => panel(`${usd(h.amount)} · ${h.reasonLabel}`, `${srcPill(h.source)} ${pill(h.status === 'held' ? 'pending' : 'ok', h.status === 'held' ? `Held ${h.daysHeld} days` : 'Released')}`, `<div class="body">
        <div class="grid g-1-1 top" style="margin:0">
          <div><p style="margin:0 0 8px"><b>Next step:</b> ${esc(h.nextStep)}</p>
            <p class="small dim" style="margin:0 0 10px">${h.typicalDays ? `PayPal typically releases holds of this kind within about ${h.typicalDays} days (expected around ${esc(h.expectedRelease.slice(0, 10))}, an estimate).` : 'No typical release time for this reason; follow PayPal\'s instructions.'}${h.note ? ' · ' + esc(h.note) : ''}</p>
            ${h.intentId ? `<p class="small" style="margin:0">Transaction <a href="#intel?id=${h.intentId}">${esc(h.intentId)}</a></p>` : ''}
            <div class="formrow" style="margin-top:10px">${h.status === 'held' ? `<button class="btn" data-hold-release="${h.id}">Mark released</button><button class="btn" data-hold-remind="${h.id}">Remind me in 3 days</button>` : ''}</div></div>
          <div><ul class="checks" style="grid-template-columns:1fr">
            ${h.checklist.steps.map(s => `<li class="${s.done ? '' : 'no'}"><a href="#" data-hold-step="${h.id}" data-v="${esc(s.item)}" style="color:inherit">${esc(s.item)}</a></li>`).join('')}
            ${h.checklist.docs.map(s => `<li class="${s.done ? '' : 'no'}"><a href="#" data-hold-doc="${h.id}" data-v="${esc(s.item)}" style="color:inherit">Document: ${esc(s.item)}</a></li>`).join('')}
            ${h.checklist.shipment.map(s => `<li class="${s.done ? '' : 'no'}">${esc(s.item)} ${srcPill('computed')}</li>`).join('')}</ul>
            <p class="small dim" style="margin:6px 0 0">Click an item to mark it done.</p></div></div>
        <details style="margin-top:10px"><summary class="small">History (${h.history.length})</summary><ol class="tl">${h.history.map(x => `<li><time>${esc(x.at.slice(5, 10))}</time><span>${esc(x.event)}</span><span></span></li>`).join('')}</ol></details></div>`)).join('')
      : panel('Held funds', '', empty('No holds recorded', 'Add one from a PayPal hold notice, or load sample data.')))
    + panel('Record a hold from a PayPal notice', 'entered by you', `<div class="body"><form class="formrow" id="holdForm">
        <label class="small">Amount $ <input type="number" step="0.01" min="0.01" name="amount" required style="width:110px"></label>
        <select name="reason" aria-label="Reason"><option value="new_seller">New seller</option><option value="unusual_activity">Unusual activity</option><option value="high_risk_category">Higher-risk category</option><option value="dispute_open">Open dispute</option><option value="account_review">Account review</option><option value="unknown">Not stated</option></select>
        <select name="intentId" aria-label="Transaction"><option value="">No linked transaction</option>${txns.filter(t => t.captureId).map(t => `<option value="${t.intentId}">${esc(t.title.slice(0, 30))} · ${usd(t.amount)}</option>`).join('')}</select>
        <button class="btn primary">Add hold</button></form><p class="small dim">${esc(d.note)}</p></div>`);
  bindSample(money);
  $('#holdForm').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await post('/api/fin/holds', f); toast('Hold recorded'); refreshCounts(); money(); } catch (x) { toast(x.message); } };
  const upd = (hid, body, msg) => post(`/api/fin/holds/${hid}`, body).then(() => { toast(msg); refreshCounts(); money(); });
  $$('[data-hold-release]').forEach(b => b.onclick = () => confirmModal('Mark this hold as released?', 'Do this only after PayPal shows the money as available.', false, () => upd(b.dataset.holdRelease, { status: 'released' }, 'Marked released')));
  $$('[data-hold-remind]').forEach(b => b.onclick = () => upd(b.dataset.holdRemind, { remindAt: new Date(Date.now() + 3 * 864e5).toISOString() }, 'Reminder set'));
  $$('[data-hold-step]').forEach(a => a.onclick = e => { e.preventDefault(); upd(a.dataset.holdStep, { doneStep: a.dataset.v }, 'Marked done'); });
  $$('[data-hold-doc]').forEach(a => a.onclick = e => { e.preventDefault(); upd(a.dataset.holdDoc, { doneDoc: a.dataset.v }, 'Marked ready'); });
}

// ---------- Refund Radar ----------
async function refunds() {
  main.innerHTML = topline('Refund Radar', '') + panel('Refunds', '', loading(4));
  const d = await api('/api/fin/refunds'), t = d.totals;
  const STATE = { completed: ['ok', 'Completed'], partial: ['pending', 'Partly refunded'], pending: ['pending', 'Pending'], delayed: ['missing', 'Delayed'] };
  main.innerHTML = topline('Refund Radar', d.refunds.length ? `${usd(t.outstanding)} still owed across ${t.pending + t.delayed} refund${t.pending + t.delayed === 1 ? '' : 's'}${t.delayed ? `, ${t.delayed} past the deadline` : ''}.` : 'No refunds owed or issued.')
    + `<div class="kpis" style="grid-template-columns:repeat(4,1fr)">${[['Owed to buyers', usd(t.owed), 'from cancellations and promises'], ['Refunded', usd(t.refunded), 'PayPal refund events received'], ['Outstanding', usd(t.outstanding), 'owed minus refunded'], ['Delayed', t.delayed, 'past the refund deadline']].map(([l, v, n], i) => `<div class="kpi"><div class="label">${l}</div><div class="value ${i === 2 ? 'lead' : ''}">${v}</div><div class="note ${i === 3 && t.delayed ? 'bad' : ''}">${n}</div></div>`).join('')}</div>`
    + panel('Refund lifecycle', `${d.refunds.length}`, d.refunds.length ? `<div class="body flush scroll-x"><table><thead><tr><th>Transaction</th><th>State</th><th class="num">Captured</th><th class="num">Owed</th><th class="num">Refunded</th><th class="hide-sm">Back to</th><th class="hide-sm">Typical time</th><th class="num">Due</th></tr></thead><tbody>
      ${d.refunds.map(r => `<tr class="clickable" data-txn="${r.intentId}" tabindex="0"><td>${esc(r.title)}<span class="line2">${esc(r.merchant)} · ${srcPill(r.source)}</span></td><td>${pill(...STATE[r.state])}${r.overRefund ? ' ' + pill('mismatch', 'More than captured') : ''}</td>
        <td class="num">${usd(r.capture)}</td><td class="num">${usd(r.owed)}</td><td class="num">${usd(r.refunded)}</td><td class="hide-sm">${esc(r.originalMethod)}</td><td class="hide-sm">${esc(r.estimate)} ${srcPill('estimate')}</td>
        <td class="num" style="${r.state === 'delayed' ? 'color:var(--negative-ink)' : ''}">${r.deadline ? (r.state === 'delayed' ? `${r.daysOverdue} d late` : esc(r.deadline.slice(0, 10))) : '—'}</td></tr>`).join('')}</tbody></table></div>`
      : empty('No refunds to track', 'Cancel an order in the Simulator demo or on the shopping page to see one.'))
    + (d.refunds.some(r => r.escalation.length) ? panel('Escalation checklist', 'for delayed refunds', `<div class="body"><ol class="small" style="margin:0;padding-left:18px">${d.refunds.find(r => r.escalation.length).escalation.map(s => `<li style="margin-bottom:4px">${esc(s)}</li>`).join('')}</ol></div>`) : '');
}

// ---------- Subscription Guardian ----------
async function subscriptions() {
  main.innerHTML = topline('Subscription Guardian', '') + panel('Subscriptions', '', loading(4));
  const d = await api('/api/fin/subscriptions');
  const active = d.subscriptions.filter(s => s.status === 'active');
  main.innerHTML = topline('Subscription Guardian', active.length ? `${usd(d.monthlyTotal)} a month across ${active.length} subscription${active.length > 1 ? 's' : ''}${d.flagged.length ? `; ${d.flagged.length} need${d.flagged.length > 1 ? '' : 's'} a look` : ''}.` : 'No subscriptions tracked.')
    + sampleBar(d.subscriptions.some(s => s.source === 'sample'), 'PayPal automatic payments')
    + `<div class="kpis" style="grid-template-columns:repeat(4,1fr)"><div class="kpi"><div class="label">Monthly cost</div><div class="value lead">${usd(d.monthlyTotal)}</div><div class="note">yearly plans ÷ 12</div></div>
       <div class="kpi"><div class="label">Active</div><div class="value">${active.length}</div><div class="note">subscriptions</div></div>
       <div class="kpi"><div class="label">Renewing in 7 days</div><div class="value">${d.upcoming.length}</div><div class="note">${d.upcoming.map(s => esc(s.merchant)).join(', ') || 'none'}</div></div>
       <div class="kpi"><div class="label">Flagged</div><div class="value">${d.flagged.length}</div><div class="note ${d.flagged.length ? 'bad' : ''}">duplicates or price changes</div></div></div>`
    + panel('Subscriptions', `${d.subscriptions.length}`, d.subscriptions.length ? `<div class="body flush scroll-x"><table><thead><tr><th>Merchant</th><th>Plan</th><th class="num">Amount</th><th class="num">Next charge</th><th>Check</th><th></th></tr></thead><tbody>
      ${d.subscriptions.map(s => `<tr><td>${esc(s.merchant)}<span class="line2">${srcPill(s.source)} ${s.charges.length} charges</span></td><td>${esc(s.plan)}<span class="line2">${esc(s.interval)}</span></td><td class="num">${usd(s.amount)}<span class="line2">${usd(s.monthlyCost)}/mo</span></td>
        <td class="num">${s.status === 'active' ? (s.nextCharge ? esc(s.nextCharge.slice(0, 10)) + `<span class="line2">${esc(daysWord(s.dueInDays))}</span>` : '—') : '—'}</td>
        <td>${s.issues.length ? s.issues.map(i => `<div class="small" style="color:var(--negative-ink)">${esc(i.msg)}</div>`).join('') : pill('ok', 'No issues')}</td>
        <td class="num">${s.status === 'active' ? `<button class="btn" data-subcancel="${s.id}">How to cancel</button>` : pill('pending', 'Cancel requested')}</td></tr>`).join('')}</tbody></table></div>`
      : empty('No subscriptions', 'Add one or load sample data.'))
    + panel('Possible recurring charges in your transactions', 'computed', d.detected.length ? `<div class="rows">${d.detected.map(x => `<div><span class="t">${esc(x.merchant)} · ${usd(x.amount)} × ${x.count}</span>${srcPill('computed')}<span class="d">${esc(x.dates.join(', '))} · ${esc(x.note)}</span></div>`).join('')}</div>` : empty('None found', 'PACT flags the same merchant and amount charged more than once.'));
  bindSample(subscriptions);
  $$('[data-subcancel]').forEach(b => b.onclick = () => { const s = d.subscriptions.find(x => x.id === b.dataset.subcancel);
    confirmModal(`Cancel ${s.merchant}?`, `${s.cancel} PACT cannot cancel it for you; confirming only marks it as "cancel requested" here.`, false, async () => { await post(`/api/fin/subscriptions/${s.id}/cancel`); toast('Marked as cancel requested'); subscriptions(); }); });
}

// ---------- Payment Failure Recovery ----------
async function failures() {
  main.innerHTML = topline('Payment Recovery', '') + panel('Failed payments', '', loading(4));
  const d = await api('/api/fin/failures');
  const RT = { safe: ['ok', 'Safe to retry'], buyer: ['pending', 'Buyer must act'], 'after-approval': ['pending', 'Retry after approval'], never: ['broken', 'Never retry'], no: ['broken', 'Do not retry'], review: ['neutral', 'Review first'] };
  main.innerHTML = topline('Payment Recovery', d.total ? `${d.total} failed payment attempt${d.total > 1 ? 's' : ''}, ${d.recovered} later recovered. Each failure is explained with a safe next step.` : 'No failed payments recorded.')
    + sampleBar(d.failures.some(f => f.source === 'sample'), 'other merchants\' failure history')
    + `<div class="grid g-2-1 top">`
    + panel('Failed payments', `${d.total}`, d.total ? `<div class="body flush scroll-x"><table><thead><tr><th>When</th><th>What failed</th><th>Retry?</th><th class="num">Amount</th></tr></thead><tbody>
      ${d.failures.map(f => `<tr><td class="dim">${dt(f.at)}<span class="line2">${srcPill(f.source)}</span></td><td><b>${esc(f.category)}</b> <span class="id">${esc(f.code)}</span>${f.recovered ? ' ' + pill('ok', 'Recovered') : ''}<span class="line2">${esc(f.meaning)} ${esc(f.action)}</span><span class="line2 dim">Stage: ${esc(f.stage)} · ${esc(f.message.slice(0, 90))}</span></td>
        <td>${pill(...(RT[f.retry] || RT.review))}</td><td class="num">${f.amount != null ? usd(f.amount) : '—'}</td></tr>`).join('')}</tbody></table></div>` : empty('No failures', 'Real PayPal errors from checkout appear here automatically.'))
    + `<div>` + panel('By category', '', Object.keys(d.byCategory).length ? `<div class="rows">${Object.entries(d.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div><span class="t">${esc(k)}</span><b>${v}</b></div>`).join('')}</div>` : empty('Nothing yet', ''))
    + panel('Repeated attempts', '', d.repeated.length ? `<div class="rows">${d.repeated.map(r => `<div><span class="t">${esc(r.key)}</span>${pill('missing', r.count + ' failures')}<span class="d">${esc(r.codes.join(', '))}</span></div>`).join('')}</div>` : `<div class="body small dim">No transaction failed 3 or more times.</div>`)
    + panel('Merchant recovery', '', d.byMerchant.length ? `<div class="rows">${d.byMerchant.map(m => `<div><span class="t">${esc(m.merchant)}</span><span>${m.recovered}/${m.failed} recovered</span></div>`).join('')}</div>` : `<div class="body small dim">No merchant data yet.</div>`) + `</div></div>`
    + panel('Error guide', 'PayPal Orders API error names', `<div class="body flush scroll-x"><table><thead><tr><th>Code</th><th>Meaning</th><th>Safe action</th></tr></thead><tbody>${Object.entries(d.codes).map(([k, c]) => `<tr><td class="id">${esc(k)}</td><td>${esc(c.meaning)}</td><td class="small">${esc(c.action)}</td></tr>`).join('')}</tbody></table></div>`);
  bindSample(failures);
}

// ---------- Cashflow Forecast ----------
async function cashflow() {
  main.innerHTML = topline('Cashflow Forecast', '') + panel('Balances', '', loading(4));
  const d = await api('/api/fin/cashflow'), b = d.balances;
  main.innerHTML = topline('Cashflow Forecast', `${usd(b.available)} available now after fees, refunds and holds. ${d.alerts[0] ? esc(d.alerts[0]) : ''}`)
    + `<div class="kpis" style="grid-template-columns:repeat(5,1fr)">${[['Available', usd(b.available), 'computed', 'lead'], ['Gross received', usd(b.gross), 'PayPal captures'], ['PayPal fees', usd(b.fees), 'from capture responses'], ['Held', usd(b.held), 'Money Recovery'], ['Pending', usd(b.pending), 'approved, not captured']].map(([l, v, n, lead]) => `<div class="kpi"><div class="label">${l}</div><div class="value ${lead || ''}">${v}</div><div class="note">${n}</div></div>`).join('')}</div>`
    + panel('Projection', `${srcPill('estimate')} based on ${d.observedDays} days at ${usd(d.dailyNetInflow)} net a day`, `<div class="body"><div class="proj">${d.projections.map(p => `<div><div class="small dim">Next ${p.days} days</div><div class="mid">${usd(p.expected)}</div><div class="rng"><span>Worst ${usd(p.worst)}</span><span>Best ${usd(p.best)}</span></div>
        <div class="small dim" style="margin-top:8px">+${usd(p.inflow)} inflow · +${usd(p.release)} hold releases · −${usd(p.outflow)} refunds &amp; subscriptions${p.disputeRisk ? ` · ${usd(p.disputeRisk)} at risk in disputes` : ''}</div></div>`).join('')}</div>
        <div id="cfChart" style="margin-top:18px"></div><p class="small dim">${esc(d.note)}</p></div>`)
    + panel('Cashflow alerts', `${d.alerts.length}`, d.alerts.length ? `<div class="rows">${d.alerts.map(a => `<div><span class="t" style="white-space:normal">${esc(a)}</span>${pill('pending', 'Alert')}</div>`).join('')}</div>` : empty('No alerts', 'Nothing threatens your cashflow right now.'));
  if (window.Charts) Charts.bars($('#cfChart'), { labels: ['Now', ...d.projections.map(p => `${p.days} days`)], values: [b.available, ...d.projections.map(p => Math.max(0, p.expected))], format: v => '$' + Math.round(v).toLocaleString('en-US'), height: 170, highlight: 0 });
}

// ---------- Dispute Intelligence ----------
async function disputes() {
  main.innerHTML = topline('Dispute Intelligence', '') + panel('Disputes', '', loading(4));
  const [list, { txns }] = [await api('/api/fin/disputes'), await load(['txns'])];
  const open = list.filter(d => d.status === 'open');
  const RS = { not_received: 'Item not received', not_as_described: 'Not as described', unauthorized: 'Unauthorized', refund_not_received: 'Refund not received' };
  main.innerHTML = topline('Dispute Intelligence', open.length ? `${open.length} open dispute${open.length > 1 ? 's' : ''}${open.some(d => d.deadlineState !== 'ok') ? `; ${open.filter(d => d.deadlineState !== 'ok').length} due within 3 days` : ''}. PACT drafts responses from recorded evidence and never submits them.` : 'No open disputes.')
    + sampleBar(list.some(d => d.source === 'sample'), 'PayPal disputes (Disputes API not connected)')
    + (list.length ? list.map(d => panel(`${RS[d.reason]} · ${d.title}`, `${srcPill(d.source)} ${pill(d.deadlineState === 'ok' ? 'pending' : 'missing', d.daysLeft < 0 ? 'Deadline missed' : `Respond ${daysWord(d.daysLeft)}`)}`, `<div class="body">
        <div class="grid g-1-1 top" style="margin:0"><div>
          <div class="finding ${d.canContest ? 'ok' : ''}" style="margin-top:0"><b>${d.canContest ? 'Evidence supports the merchant' : 'Evidence is not enough to contest'}</b><p>${esc(d.recommendation)}</p></div>
          <h3 class="sect">Evidence on record</h3><ol class="small" style="padding-left:18px;margin:0">${d.facts.map(f => `<li style="margin-bottom:3px">${esc(f)}</li>`).join('')}</ol>
          ${d.missing.length ? `<p class="small" style="color:var(--negative-ink)">Missing: ${d.missing.map(esc).join(', ')}</p>` : ''}</div>
          <div><h3 class="sect" style="margin-top:0">Response draft <span class="pill s-draft" style="margin-left:6px">Draft, not submitted</span></h3><pre class="answer small" style="white-space:pre-wrap;background:var(--raised);padding:10px;border-radius:6px;margin:0">${esc(d.draft)}</pre>
          <div class="formrow" style="margin-top:10px"><a class="btn" href="/api/intel/${d.intentId}/report.md" download style="display:inline-flex;align-items:center">Export evidence</a><a class="btn" href="#intel?id=${d.intentId}" style="display:inline-flex;align-items:center">Transaction graph</a><button class="btn" data-copy="${d.id}">Copy draft</button></div></div></div>
        <p class="small dim" style="margin:10px 0 0">${usd(d.amount)} · opened ${esc(d.openedAt.slice(0, 10))} · respond by ${esc(d.respondBy.slice(0, 10))} · ${esc(d.id)}</p></div>`)).join('')
      : panel('Disputes', '', empty('No disputes', 'Record one from a PayPal notice, or load sample data.')))
    + panel('Record a dispute from a PayPal notice', 'entered by you', `<div class="body"><form class="formrow" id="dspForm">
        <select name="intentId" aria-label="Transaction" required>${txns.filter(t => t.captureId).map(t => `<option value="${t.intentId}">${esc(t.title.slice(0, 32))} · ${usd(t.amount)}</option>`).join('')}</select>
        <select name="reason" aria-label="Reason">${Object.entries(RS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <label class="small">Respond by <input type="date" name="respondBy"></label><button class="btn primary">Add dispute</button></form></div>`);
  bindSample(disputes);
  $$('[data-copy]').forEach(b => b.onclick = async () => { await navigator.clipboard.writeText(list.find(x => x.id === b.dataset.copy).draft); toast('Draft copied'); });
  $('#dspForm').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); if (f.respondBy) f.respondBy = new Date(f.respondBy).toISOString(); else delete f.respondBy;
    try { await post('/api/fin/disputes', f); toast('Dispute recorded'); refreshCounts(); disputes(); } catch (x) { toast(x.message); } };
}

// ---------- Merchant Intelligence ----------
async function merchants() {
  main.innerHTML = topline('Merchant Intelligence', '') + panel('Merchants', '', loading(4));
  const m = await api('/api/merchants');
  main.innerHTML = topline('Merchant Intelligence', `${m.length} merchants scored on listing completeness, risk and how agent purchases with them turned out.`)
    + panel('Merchant trust', 'from listing data and PACT activity', `<div class="body flush scroll-x"><table><thead><tr><th>Merchant</th><th class="num">AI readiness</th><th class="num">Listing completeness</th><th class="num">Risk</th><th class="num">Agent attempts</th><th class="num">Blocked</th><th class="num">Paid</th><th>What to fix</th></tr></thead><tbody>
      ${m.map(x => `<tr><td><b>${esc(x.merchant)}</b><span class="line2">rated ${x.rating}/5 · ${x.ageDays} days old</span></td><td class="num">${x.aiReadiness}<div class="meter" style="width:64px;margin:4px 0 0 auto"><i style="width:${x.aiReadiness}%"></i></div></td><td class="num">${x.listingCompleteness}%</td>
        <td class="num">${x.riskScore >= 50 ? `<span style="color:var(--negative-ink)">${x.riskScore}</span>` : x.riskScore}</td><td class="num">${x.agentAttempts}</td><td class="num">${x.blocked}</td><td class="num">${x.paid}</td><td class="small">${esc(x.gaps.join(' · ') || 'Nothing: AI-commerce ready')}</td></tr>`).join('')}</tbody></table></div>`);
}

// ---------- drawers ----------
const drawer = $('#drawer'), scrim = $('#scrim');
let lastFocus = null;
function openDrawer(html) { lastFocus = document.activeElement; drawer.innerHTML = html; drawer.classList.add('open'); scrim.classList.add('open'); $('.x', drawer)?.focus(); }
function closeDrawer() { drawer.classList.remove('open'); scrim.classList.remove('open'); lastFocus?.focus?.(); }
scrim.onclick = closeDrawer;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer(); });

async function txnDrawer(id) {
  openDrawer(`<header><h2 id="drawer-title">Transaction</h2><button class="x" aria-label="Close">×</button></header>${loading(5)}`);
  try {
    const c = await api(`/api/assurance/${id}`);
    const t = c.commitment.terms;
    openDrawer(`<header><div><h2 id="drawer-title">${esc(c.title)}</h2><div class="small dim">${esc(c.intentId)} · ${esc(c.initiator)} · ${usd(c.amount)}</div></div><button class="x" aria-label="Close">×</button></header>
      <section><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">${pill(c.txnStatus, STATUS_WORD[c.txnStatus])}<span class="small dim">health ${c.health}/100 · dispute risk ${esc(c.disputeRisk.level)}</span></div>
        <p class="small" style="margin:0 0 12px">${esc(c.statusReasons.join(' · '))}</p>
        <div class="chain-full">${c.steps.map(s => `<div class="${s.state}"><b>${esc(s.name)}</b>${esc(s.detail)}</div>`).join('')}</div></section>
      <section><h3>Reconciliation</h3><dl class="kv">${c.reconciliation.rows.map(r => `<dt>${esc(r.label)}</dt><dd>${usd(r.value)} ${r.value != null ? srcTag(r.source) : ''}</dd>`).join('')}</dl>
        ${c.reconciliation.mismatches.map(m => `<div class="finding"><p>${esc(m)}</p></div>`).join('')}</section>
      ${t ? `<section><h3>Merchant commitment</h3><dl class="kv"><dt>Merchant</dt><dd>${esc(t.merchant)}</dd><dt>Price</dt><dd>${usd(t.price)}</dd><dt>Deliver by</dt><dd>${esc(t.deliveryBy.slice(0, 10))}</dd><dt>Returns</dt><dd>${t.returns ? `${t.returnWindowDays} days` : 'No returns'}</dd><dt>Warranty</dt><dd>${esc(t.warranty || '—')}</dd></dl>
        ${c.commitment.issues.map(i => `<div class="finding"><p>${esc(i.msg)}</p></div>`).join('')}
        ${c.commitment.refund ? `<p class="small">Refund ${pill(c.commitment.refund.state)} ${usd(c.commitment.refund.refunded)} of ${usd(c.commitment.refund.expected)}, due ${esc(c.commitment.refund.deadline.slice(0, 10))}</p>` : ''}</section>` : ''}
      <section><h3>Recommended next steps</h3>${c.disputeRisk.actions.length ? `<ul class="small" style="padding-left:18px;margin:0">${c.disputeRisk.actions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '<p class="small dim" style="margin:0">None. Commitments met so far.</p>'}</section>
      <section><h3>Timeline</h3><ol class="tl">${c.timeline.map(e => `<li><time>${tm(e.at)}</time><span>${esc(cap(e.type))}</span>${srcTag(e.source)}</li>`).join('')}</ol></section>`);
  } catch (e) { drawer.insertAdjacentHTML('beforeend', `<section>${errorBar(e)}</section>`); }
}

async function incDrawer(id) {
  openDrawer(`<header><h2 id="drawer-title">Incident</h2><button class="x" aria-label="Close">×</button></header>${loading(5)}`);
  try {
    const i = await api(`/api/incidents/${id}`);
    const resolved = i.status === 'resolved';
    openDrawer(`<header><div><h2 id="drawer-title">${esc(cap(i.kind))}</h2><div class="small dim">${esc(i.id)} · ${esc(i.title || '')} · <a href="#" data-txn="${i.intentId}">${esc(i.intentId)}</a></div></div><button class="x" aria-label="Close">×</button></header>
      <section><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${pill(i.severity)}${pill(resolved ? 'resolved' : i.stage, cap(i.stage))}<span class="small dim">owner ${esc(i.owner)} · ${resolved ? 'resolved ' + dt(i.resolution?.at) : esc(due(i.dueAt))}</span></div>
        <p style="margin:0 0 10px">${esc(i.detail)}</p><div class="finding ok" style="margin:0"><b>Recommended action</b><p>${esc(i.recommendedAction)}</p></div></section>
      <section><h3>Notifications</h3>${i.notifications.map(n => `<details class="msg"><summary><b>${esc(cap(n.party))}</b>${pill(n.status === 'sent' ? 'ok' : n.status, cap(n.status))}<span class="dim">${esc(n.subject)}</span></summary><pre>${esc(n.body)}</pre><div class="small dim">To ${esc(n.to || '—')} · ${esc(n.channel)}${n.reason ? ' · ' + esc(n.reason) : ''}</div></details>`).join('')}</section>
      <section><h3>Verification requests</h3><ul class="checks" style="grid-template-columns:1fr">${i.requests.map(r => `<li class="${r.status === 'answered' ? '' : 'no'}">${esc(cap(r.party))}: ${esc(r.what)}</li>`).join('')}</ul>
        ${i.responses.length ? `<h3 style="margin-top:14px">Responses</h3>${i.responses.map(r => `<p class="small" style="margin:0 0 6px"><b>${esc(cap(r.party))}</b> · ${tm(r.at)}: ${esc(r.message)}${r.evidence ? ` <span class="dim">(evidence: ${esc(r.evidence)})</span>` : ''}</p>`).join('')}` : ''}</section>
      ${resolved ? `<section><h3>Resolution</h3><p class="small" style="margin:0">${esc(i.resolution.by)}: ${esc(i.resolution.note)}</p></section>` : `<section><h3>Record a response</h3>
        <div style="display:grid;gap:8px"><div style="display:flex;gap:8px"><select id="rp" aria-label="Party"><option value="merchant">Merchant</option><option value="buyer">Buyer</option><option value="paypal">PayPal</option></select><input type="text" id="rev" placeholder="Evidence reference (optional)" style="flex:1" aria-label="Evidence reference"></div>
        <textarea id="rm" rows="2" placeholder="What did they say?" aria-label="Response"></textarea><div><button class="btn" data-respond>Add response</button></div></div></section>
      <section><h3>Workflow</h3><div style="display:grid;gap:8px"><textarea id="rn" rows="2" placeholder="Resolution note (required to resolve)" aria-label="Resolution note"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-resolve>Resolve</button>${i.status === 'open' ? '<button class="btn" data-review>Mark under review</button>' : ''}
        <button class="btn" data-escalate ${i.escalated || i.notifications.some(n => n.party === 'paypal') ? 'disabled' : ''}>Escalate to PayPal</button></div><p class="small dim" id="wf-err" style="margin:0"></p></div></section>`}
      <section><h3>Incident timeline</h3><ol class="tl">${i.timeline.map(t => `<li><time>${tm(t.at)}</time><span>${esc(cap(t.type))}${t.data.party ? ' · ' + esc(t.data.party) : ''}</span><span class="src-tag">${esc(t.actor)}</span></li>`).join('')}</ol></section>`);
    const act = async (fn, msg) => { try { await fn(); toast(msg); await incDrawer(id); refreshCounts(); if (location.hash === '#incidents' || location.hash === '#overview' || !location.hash) route(); } catch (e) { $('#wf-err').textContent = e.message; $('#wf-err').style.color = 'var(--negative)'; } };
    $('[data-respond]', drawer)?.addEventListener('click', () => act(() => post(`/api/incidents/${id}/respond`, { party: $('#rp').value, message: $('#rm').value, evidence: $('#rev').value || undefined }), 'Response recorded'));
    // Important state changes need a second click: the button turns into "Confirm …" first.
    const twoStep = (sel, label, fn, msg) => { const b = $(sel, drawer); if (!b) return; b.addEventListener('click', () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = `Confirm: ${label}`; b.classList.add('danger'); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = label; b.classList.remove('danger'); } }, 5000); return; }
      act(fn, msg); }); };
    twoStep('[data-resolve]', 'Resolve', () => post(`/api/incidents/${id}/status`, { status: 'resolved', note: $('#rn').value }), 'Incident resolved');
    twoStep('[data-review]', 'Mark under review', () => post(`/api/incidents/${id}/status`, { status: 'under_review' }), 'Marked under review');
    twoStep('[data-escalate]', 'Escalate to PayPal', () => post(`/api/incidents/${id}/escalate`), 'Escalation prepared for the authorized PayPal channel');
  } catch (e) { drawer.insertAdjacentHTML('beforeend', `<section>${errorBar(e)}</section>`); }
}

// ---------- routing + global actions ----------
const ROUTES = { overview, intel, transactions, reconciliation, incidents, investigate, evidence, agentic, simulator, audit, settings, money, refunds, subscriptions, failures, cashflow, disputes, merchants };
async function route() {
  const name = (location.hash.slice(1) || 'overview').split('?')[0];
  const fn = ROUTES[name] || overview;
  $$('.nav a').forEach(a => { if (a.getAttribute('href') === '#' + (ROUTES[name] ? name : 'overview')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#side').classList.remove('open');
  try { await fn(); } catch (e) { main.insertAdjacentHTML('afterbegin', errorBar(e)); }
}
window.addEventListener('hashchange', route);

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-txn],[data-inc],[data-seed],[data-refresh],[data-retry],[data-menu],[data-scan],[data-attack],[data-revoke],[data-evsel],.x');
  if (!t) return;
  if (t.matches('.x')) return closeDrawer();
  if (t.dataset.evsel) { evSel = t.dataset.evsel; return; }
  e.preventDefault();
  if (t.dataset.txn) return txnDrawer(t.dataset.txn);
  if (t.dataset.inc) return incDrawer(t.dataset.inc);
  if (t.hasAttribute('data-menu')) return $('#side').classList.toggle('open');
  if (t.hasAttribute('data-refresh') || t.hasAttribute('data-retry')) return route();
  const busy = async (fn, msg) => { t.disabled = true; const old = t.textContent; t.textContent = 'Working…'; try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg); } catch (err) { toast('Failed: ' + err.message); } finally { t.disabled = false; t.textContent = old; await refreshCounts(); await route(); } };
  if (t.hasAttribute('data-seed')) return busy(() => post('/api/demo/seed'), r => `Scenarios loaded: ${r.passed}/${r.total} passed`);
  if (t.hasAttribute('data-scan')) return busy(() => post('/api/incidents/scan', {}), r => `${r.length} incident${r.length === 1 ? '' : 's'} checked`);
  if (t.hasAttribute('data-attack')) return busy(() => post('/api/security/simulate'), r => `${r.summary.blockedAttacks}/${r.summary.attackAttempts} attacks stopped; legitimate payment ${r.summary.legitimatePayment}`);
  if (t.dataset.revoke) return busy(() => post(`/api/agents/${t.dataset.revoke}/revoke`), 'Agent revoked');
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('tr[tabindex]')) e.target.click(); });

(async () => {
  try {
    const c = await api('/api/config');
    const e = $('#envline'); e.textContent = c.paypalLive ? 'Sandbox' : 'Simulator'; e.title = c.paypalLive ? 'PayPal sandbox (test money). Live mode is not configured.' : 'PayPal simulator: no keys configured'; e.classList.toggle('sim', !c.paypalLive);
  } catch { $('#envline').textContent = 'Server unreachable'; }
  refreshCounts();
  route();
})();

// Global search: incident IDs open the case; anything else filters the transaction explorer.
$('#gsearch')?.addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#gq').value.trim(); if (!v) return;
  if (/^INC-/i.test(v)) return incDrawer(v.toUpperCase());
  txQuery = v; txFilter = 'all';
  if (location.hash === '#transactions') route(); else location.hash = 'transactions';
});
