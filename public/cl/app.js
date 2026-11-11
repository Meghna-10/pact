// CarbonLens India: every figure on this page comes from the API's calculation.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(p, method = 'GET', body) {
  const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : Array.isArray(j.detail) ? j.detail.map(d => d.msg).join('; ') : r.statusText);
  return j;
}
const toast = m => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), 2800); };
const inr = v => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const kg = v => v == null ? '—' : `${Number(v).toFixed(2)} kg CO₂e`;
const EV = q => `<span class="ev ev-${q}">${q === 'INSUFFICIENT' ? 'NO ESTIMATE' : q}</span>`;
const CAT_COLOR = { 'Rice & grains': '#8a6d3b', 'Wheat & millets': '#a3814a', 'Pulses & lentils': '#b9683f', Dairy: '#5f7f9a', Vegetables: '#4f7f4a', Fruits: '#c0832f', Staples: '#6f6a5a' };
let products = [], cfg = {}, basket = JSON.parse(localStorage.getItem('cl-basket') || '{}'), cat = 'All', calc = null;

function step(p) { return p.unit === 'litre' || p.unit === 'kg' ? 0.5 : 1; }
function save() { localStorage.setItem('cl-basket', JSON.stringify(basket)); }
const items = () => Object.entries(basket).filter(([, q]) => q > 0).map(([product_id, quantity]) => ({ product_id, quantity }));

function renderCatalogue() {
  const cats = ['All', ...new Set(products.map(p => p.category))];
  $('#tabs').innerHTML = cats.map(c => `<button aria-pressed="${c === cat}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  $$('[data-cat]').forEach(b => b.onclick = () => { cat = b.dataset.cat; renderCatalogue(); });
  $('#grid').innerHTML = products.filter(p => cat === 'All' || p.category === cat).map(p => `<article class="prod">
      <div class="pic" style="background:${CAT_COLOR[p.category] || '#6f6a5a'}" role="img" aria-label="${esc(p.name)} (placeholder image)">${esc(p.name.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join(''))}</div>
      <div class="n">${esc(p.name)}</div>
      <div class="meta"><span>${inr(p.price_inr)} / ${p.unit} <span title="Illustrative demo price">*</span></span>${EV(p.evidence_quality)}</div>
      <div class="f">${p.has_estimate ? `<b>${p.factor_kg_co2e_per_kg.toFixed(2)}</b> kg CO₂e per kg <span class="muted">(${esc(p.evidence.source_entity)}, global)</span>` : '<span class="muted">Insufficient evidence to calculate a reliable estimate.</span>'}</div>
      <button class="btn sm ${basket[p.id] ? '' : 'primary'}" data-add="${p.id}">${basket[p.id] ? `In basket · ${basket[p.id]} ${p.unit}` : 'Add to basket'}</button></article>`).join('');
  $$('[data-add]').forEach(b => b.onclick = () => { const p = products.find(x => x.id === b.dataset.add); basket[p.id] = +((basket[p.id] || 0) + (p.unit === 'kg' || p.unit === 'litre' ? 1 : 1)).toFixed(2); save(); refresh(); });
}

let timer;
function refresh() { renderCatalogue(); renderLines(); clearTimeout(timer); timer = setTimeout(recalc, 150); }

function renderLines() {
  const its = items();
  $('#count').textContent = `${its.length} item${its.length === 1 ? '' : 's'}`;
  if (!its.length) { $('#lines').innerHTML = '<p class="muted" style="padding:16px 18px;margin:0">Empty. Add groceries from the catalogue.</p>'; return; }
  $('#lines').innerHTML = its.map(({ product_id: id, quantity: q }) => { const p = products.find(x => x.id === id); const row = calc?.items.find(i => i.product_id === id);
    return `<div class="line"><span class="nm">${esc(p.name)}</span><span class="qty"><button aria-label="Less" data-dec="${id}">−</button><input aria-label="Quantity in ${p.unit}" data-qty="${id}" value="${q}" inputmode="decimal"><button aria-label="More" data-inc="${id}">+</button></span>
      <span class="sub"><span>${p.unit} · ${inr(q * p.price_inr)}</span><span>${row ? (row.estimated_emissions_kg_co2e != null ? kg(row.estimated_emissions_kg_co2e) : 'no estimate') : '…'} ${EV(p.evidence_quality)} <a href="#" data-rm="${id}">Remove</a></span></span></div>`; }).join('');
  const set = (id, q) => { if (q <= 0) delete basket[id]; else basket[id] = Math.min(100, +q.toFixed(2)); save(); refresh(); };
  $$('[data-dec]').forEach(b => b.onclick = () => { const p = products.find(x => x.id === b.dataset.dec); set(p.id, basket[p.id] - step(p)); });
  $$('[data-inc]').forEach(b => b.onclick = () => { const p = products.find(x => x.id === b.dataset.inc); set(p.id, basket[p.id] + step(p)); });
  $$('[data-rm]').forEach(a => a.onclick = e => { e.preventDefault(); set(a.dataset.rm, 0); });
  $$('[data-qty]').forEach(i => i.onchange = () => { const v = parseFloat(i.value); if (!(v > 0) || v > 100) { toast('Quantity must be between 0 and 100'); i.value = basket[i.dataset.qty]; return; } set(i.dataset.qty, v); });
}

async function recalc() {
  const its = items();
  $('#checkout').disabled = !its.length;
  if (!its.length) { calc = null; $('#tCo2').textContent = '—'; $('#tCov').textContent = ''; $('#tInr').textContent = '₹0'; $('#dash').innerHTML = '<p class="muted">Add groceries to see the estimate.</p>'; $('#evd').innerHTML = '<p class="muted">Each item in your basket gets an expandable evidence panel here.</p>'; $('#ai').innerHTML = ''; return; }
  try { calc = await api('/cl/api/basket/calculate', 'POST', { items: its }); } catch (e) { $('#dash').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const t = calc.totals;
  $('#tCo2').textContent = t.estimated_items ? kg(t.estimated_emissions_kg_co2e) : 'No estimate';
  $('#tCov').innerHTML = `${t.estimated_items} of ${t.estimated_items + t.unestimated_items} items estimated${t.unestimated_items ? ` · <b>${t.unestimated_items} not included</b>` : ''}`;
  $('#tInr').textContent = inr(t.price_inr);
  $('#fx').textContent = `Sandbox charge: about $${(t.price_inr / cfg.inr_per_usd_demo_rate).toFixed(2)} USD at an illustrative ₹${cfg.inr_per_usd_demo_rate} per USD.`;
  renderLines(); renderDash(); renderEvidence(); explain();
}

function renderDash() {
  const t = calc.totals, d = calc.evidence_distribution, n = Object.values(d).reduce((a, b) => a + b, 0);
  const est = calc.items.filter(i => i.status === 'estimated'), max = Math.max(...est.map(i => i.estimated_emissions_kg_co2e), 0.0001);
  const COL = { HIGH: '#1f5f3f', MEDIUM: '#c9b046', LOW: '#b9683f', INSUFFICIENT: '#cfcac0' };
  const cats = Object.entries(calc.categories).sort((a, b) => b[1].emissions_kg_co2e - a[1].emissions_kg_co2e);
  const cmax = Math.max(...cats.map(([, c]) => c.emissions_kg_co2e), 0.0001);
  $('#dash').innerHTML = `<div class="kpis card" style="border:0">${[['Estimated footprint', t.estimated_items ? kg(t.estimated_emissions_kg_co2e) : '—'], ['Items with evidence', `${t.estimated_items} / ${t.estimated_items + t.unestimated_items}`], ['Coverage by weight', t.coverage_by_weight != null ? Math.round(t.coverage_by_weight * 100) + '%' : '—'], ['Basket (illustrative)', inr(t.price_inr)]].map(([l, v]) => `<div><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
    <h3>Highest contributing items</h3><div class="bars">${est.length ? est.slice(0, 6).map(i => `<div class="b"><span>${esc(i.name)}</span><span class="t"><i class="${i.evidence_quality}" style="width:${(100 * i.estimated_emissions_kg_co2e / max).toFixed(1)}%"></i></span><span class="num">${i.estimated_emissions_kg_co2e.toFixed(2)}</span></div>`).join('') : '<p class="muted small">No item has an estimate.</p>'}</div>
    <h3>By category <span class="small muted">(kg CO₂e, estimated items only)</span></h3><div class="bars">${cats.map(([k, c]) => `<div class="b"><span>${esc(k)}${c.unestimated_items ? ` <span class="muted">+${c.unestimated_items} unestimated</span>` : ''}</span><span class="t"><i style="width:${(100 * c.emissions_kg_co2e / cmax).toFixed(1)}%;background:${CAT_COLOR[k]}"></i></span><span class="num">${c.emissions_kg_co2e.toFixed(2)}</span></div>`).join('')}</div>
    <h3>Data quality</h3><div class="dist" role="img" aria-label="${Object.entries(d).map(([k, v]) => `${k} ${v}`).join(', ')}">${Object.entries(d).filter(([, v]) => v).map(([k, v]) => `<span style="flex:${v};background:${COL[k]}" title="${k}: ${v}"></span>`).join('')}</div>
    <div class="small">${Object.entries(d).map(([k, v]) => `${EV(k)} ${v}`).join(' &nbsp; ')} <span class="muted">· evidence quality, not statistical confidence</span></div>
    ${calc.warnings.length ? `<h3>Evidence warnings</h3><ul class="small" style="margin:0;padding-left:18px">${calc.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
}

function renderEvidence() {
  $('#evd').innerHTML = calc.items.map(i => { const e = i.evidence;
    return `<details class="evd"><summary><span><b>${esc(i.name)}</b> · ${i.estimated_emissions_kg_co2e != null ? kg(i.estimated_emissions_kg_co2e) : 'no estimate'}</span>${EV(i.evidence_quality)}</summary>
      ${e ? `<dl><dt>Calculation</dt><dd>${i.quantity} ${i.unit}${i.unit !== 'kg' ? ` × ${(i.kg / i.quantity).toFixed(2)} kg/${i.unit}` : ''} × ${e.factor_kg_co2e_per_kg} kg CO₂e/kg = ${i.estimated_emissions_kg_co2e}</dd>
        <dt>Source entity</dt><dd>"${esc(e.source_entity)}"</dd><dt>Source</dt><dd><a href="${esc(e.source_url)}" target="_blank" rel="noopener">${esc(e.source_name)}</a></dd><dt>Dataset</dt><dd>${esc(e.dataset)}</dd>
        <dt>Geography</dt><dd>${esc(e.geography)}</dd><dt>Reference year</dt><dd>${e.reference_year}</dd><dt>Lifecycle boundary</dt><dd>${esc(e.lifecycle_boundary)}</dd>
        <dt>Stages (kg CO₂e/kg)</dt><dd>${Object.entries(e.stages || {}).map(([k, v]) => `${k.replace('_', ' ')} ${v.toFixed(3)}`).join(' · ')}</dd>
        <dt>Limitations</dt><dd>${i.limitations.map(esc).join(' ')}</dd></dl>`
      : `<p class="small" style="margin:10px 0 0"><b>Insufficient evidence to calculate a reliable estimate.</b> ${i.limitations.map(esc).join(' ')}</p>`}</details>`; }).join('');
}

async function explain(question) {
  if (!calc) return;
  try {
    const budget = parseFloat($('#budget').value) || undefined;
    const r = await api('/cl/api/ai/explain', 'POST', { items: items(), question, budget_inr: budget });
    $('#aiby').textContent = r.generated_by;
    $('#ai').innerHTML = `<p><b>${esc(r.summary)}</b></p>${r.points.map(p => `<p class="small">${esc(p)}</p>`).join('')}`;
    if (question) $('#ans').innerHTML = `<b>Answer:</b> ${esc(r.answer)}`;
  } catch (e) { $('#ai').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
$('#ask').onclick = () => explain($('#q').value.trim() || 'Which item contributes most to my estimated footprint?');
$$('[data-q]').forEach(a => a.onclick = e => { e.preventDefault(); $('#q').value = a.dataset.q; explain(a.dataset.q); });
$('#alts').onclick = async () => {
  if (!items().length) return toast('Add groceries first');
  try {
    const r = await api('/cl/api/ai/recommendations', 'POST', { items: items(), budget_inr: parseFloat($('#budget').value) || undefined });
    $('#altout').innerHTML = (r.alternatives.length ? r.alternatives.map(a => `<div class="alt"><div><b>${esc(a.from.name)}</b><div class="small muted">${a.from.quantity} ${a.from.unit} · ${inr(a.from.subtotal_inr)} · ${kg(a.from.estimated_emissions_kg_co2e)}</div></div><span aria-hidden="true">→</span>
        <div><b>${esc(a.to.name)}</b><div class="small muted">${a.to.quantity} ${a.to.unit} · ${inr(a.to.subtotal_inr)} · ${kg(a.to.estimated_emissions_kg_co2e)}</div></div>
        <div class="small" style="grid-column:1/-1">Price ${a.price_difference_inr >= 0 ? '+' : '−'}${inr(Math.abs(a.price_difference_inr))} · estimate ${a.emissions_difference_kg_co2e.toFixed(2)} kg CO₂e · ${EV(a.evidence_quality)}<br><span class="muted">${esc(a.reason)} ${esc(a.caution)}</span>
          <br><button class="btn sm" data-swap="${a.from.product_id}|${a.to.product_id}|${a.to.quantity}" style="margin-top:8px">Swap in basket</button></div></div>`).join('')
      : '<p class="small">No alternative is both comparable and meaningfully lower with supporting evidence' + (r.budget_inr ? ' within your budget' : '') + '.</p>')
      + (r.rejected.length ? `<details style="margin-top:8px"><summary class="small">Why other swaps were not suggested (${r.rejected.length})</summary><ul class="small">${r.rejected.map(x => `<li>${esc(x.from)} → ${esc(x.to)}: ${esc(x.reason)}</li>`).join('')}</ul></details>` : '')
      + `<p class="small muted">${esc(r.note)}</p>`;
    $$('[data-swap]').forEach(b => b.onclick = () => { const [f, t, q] = b.dataset.swap.split('|'); delete basket[f]; basket[t] = +(basket[t] || 0) + Number(q); save(); refresh(); toast('Swapped'); });
  } catch (e) { $('#altout').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
};

// ---------- PayPal Sandbox checkout ----------
$('#checkout').onclick = async () => {
  const box = $('#paybox');
  try {
    const b = await api('/cl/api/basket', 'POST', { items: items() });      // the server stores the basket and computes the amount
    if (!cfg.paypal_client_id) { box.innerHTML = '<div class="err">PayPal sandbox keys are not configured on the server.</div>'; return; }
    box.innerHTML = '<div id="ppb"></div><p class="small muted" style="margin:6px 0 0">Log in with a PayPal <b>sandbox</b> buyer account.</p>';
    await new Promise((ok, bad) => { if (window.paypal) return ok(); const s = document.createElement('script'); s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypal_client_id)}&currency=USD&intent=capture`; s.onload = ok; s.onerror = () => bad(new Error('could not load PayPal')); document.head.append(s); });
    let orderId;
    const capture = async () => { const r = await api('/cl/api/paypal/capture-order', 'POST', { order_id: orderId }); localStorage.removeItem('cl-basket'); location.href = `/cl/receipt.html?id=${r.receipt_id}`; };
    window.paypal.Buttons({
      createOrder: async () => { const o = await api('/cl/api/paypal/create-order', 'POST', { basket_id: b.basket_id }); orderId = o.order_id; return o.order_id; },
      onApprove: () => capture().catch(e => box.insertAdjacentHTML('beforeend', `<div class="err">${esc(e.message)}</div>`)),
      onCancel: () => capture().catch(() => box.insertAdjacentHTML('beforeend', '<p class="small">Payment cancelled. Nothing was charged and no receipt was issued.</p>')),
      onError: e => box.insertAdjacentHTML('beforeend', `<div class="err">PayPal error: ${esc(e?.message || e)}</div>`),
    }).render('#ppb');
  } catch (e) { box.insertAdjacentHTML('beforeend', `<div class="err">${esc(e.message)}</div>`); }
};

(async () => {
  try { [products, cfg] = await Promise.all([api('/cl/api/products'), api('/cl/api/config')]); }
  catch (e) { $('#grid').innerHTML = `<div class="err">Could not load the catalogue: ${esc(e.message)}</div>`; return; }
  for (const id of Object.keys(basket)) if (!products.find(p => p.id === id)) delete basket[id];
  refresh();
})();
