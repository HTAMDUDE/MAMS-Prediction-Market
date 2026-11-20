// MAMS Prediction Market — front-end helpers (no dependencies).

const SVG_NS = 'http://www.w3.org/2000/svg';
const parseTime = s => new Date(s.replace(' ', 'T')).getTime();
const fmt = n => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function svg(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// Price-over-time chart: one stepped line per outcome.
function drawChart(el, history, labels, endTime) {
  if (!el || !history.length) return;
  const W = 640, H = 220, L = 36, R = 8, T = 10, B = 24;
  const pts = history.map(h => ({ t: parseTime(h.t), p: h.p }));
  const end = endTime ? parseTime(endTime) : Date.now();
  pts.push({ t: Math.max(end, pts[pts.length - 1].t), p: pts[pts.length - 1].p });
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const x = t => L + (t - t0) / (t1 - t0) * (W - L - R);
  const y = p => T + (1 - p) * (H - T - B);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Price history chart' });
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    svg('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), class: 'grid' }, root);
    svg('text', { x: L - 6, y: y(g) + 4, class: 'axis', 'text-anchor': 'end' }, root).textContent = `${g * 100}%`;
  }
  const dateFmt = { month: 'short', day: 'numeric' };
  svg('text', { x: L, y: H - 6, class: 'axis' }, root).textContent = new Date(t0).toLocaleDateString(undefined, dateFmt);
  svg('text', { x: W - R, y: H - 6, class: 'axis', 'text-anchor': 'end' }, root).textContent =
    endTime ? new Date(t1).toLocaleDateString(undefined, dateFmt) : 'now';

  labels.forEach((_, i) => {
    let d = '';
    pts.forEach((pt, k) => {
      const px = x(pt.t).toFixed(1), py = y(pt.p[i]).toFixed(1);
      d += k === 0 ? `M${px},${py}` : `H${px}V${py}`;
    });
    svg('path', { d, class: 'line', style: `stroke: var(--c${i})` }, root);
    const last = pts[pts.length - 1];
    svg('circle', { cx: x(last.t), cy: y(last.p[i]), r: 3.5, style: `fill: var(--c${i})` }, root);
  });
  el.appendChild(root);

  // Hover/touch readout: a guide line plus each outcome's price at that moment.
  const guide = svg('line', { y1: T, y2: H - B, class: 'guide', visibility: 'hidden' }, root);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  el.style.position = 'relative';
  el.appendChild(tip);
  const priceAt = t => {
    let cur = pts[0];
    for (const pt of pts) { if (pt.t <= t) cur = pt; else break; }
    return cur.p;
  };
  const hide = () => { guide.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  root.addEventListener('pointermove', e => {
    const box = root.getBoundingClientRect();
    const vx = (e.clientX - box.left) / box.width * W;
    if (vx < L || vx > W - R) return hide();
    const t = t0 + (vx - L) / (W - L - R) * (t1 - t0);
    const p = priceAt(t);
    guide.setAttribute('x1', vx); guide.setAttribute('x2', vx); guide.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<div class="muted small">${new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>` +
      labels.map((name, i) => `<div><i style="background: var(--c${i})"></i>${name.replace(/</g, '&lt;')} <b>${(p[i] * 100).toFixed(1)}%</b></div>`).join('');
    const left = vx / W * box.width;
    tip.style.left = `${Math.min(Math.max(left + 12, 0), box.width - tip.offsetWidth)}px`;
  });
  root.addEventListener('pointerleave', hide);
}

// Buy/sell panel with a live quote from /api/quote.
function setupTradeForm(form) {
  if (!form) return;
  const actionInput = form.querySelector('input[name=action]');
  const valueInput = form.querySelector('#value');
  const valueLabel = form.querySelector('#value-label');
  const preview = form.querySelector('#preview');
  const submit = form.querySelector('#submit-btn');
  const maxBtn = form.querySelector('#max-btn');
  const quick = form.querySelector('#quick');
  const balance = parseFloat(maxBtn.dataset.balance);
  let timer = null, seq = 0;

  const selected = () => form.querySelector('input[name=outcome_id]:checked');
  const outcomeName = () => selected().dataset.label;
  const held = () => parseFloat(selected().dataset.held) || 0;
  const isBuy = () => actionInput.value === 'buy';

  function refresh() {
    valueLabel.textContent = isBuy() ? 'Amount (Ⓜ)' : `Shares to sell (you own ${fmt(held())})`;
    quick.hidden = !isBuy();
    submit.textContent = `${isBuy() ? 'Buy' : 'Sell'} “${outcomeName()}”`;
    requestQuote();
  }

  function setPreview(html, canSubmit) {
    preview.innerHTML = html;
    submit.disabled = !canSubmit;
  }

  function requestQuote() {
    clearTimeout(timer);
    seq++;  // drop any quote still in flight
    const v = parseFloat(valueInput.value);
    if (!isBuy() && held() <= 0) {
      setPreview(`<span class="muted">You don't own any “${outcomeName()}” shares to sell.</span>`, false);
      return;
    }
    if (!(v > 0)) {
      setPreview(`<span class="muted">${isBuy() ? 'Enter an amount to see your payout.' : 'Enter shares to see what you get back.'}</span>`, false);
      return;
    }
    submit.disabled = true;
    timer = setTimeout(async () => {
      const my = ++seq;
      const params = new URLSearchParams({ market: form.dataset.market, outcome: selected().value, action: actionInput.value, value: v });
      try {
        const res = await (await fetch(`${form.dataset.quote}?${params}`)).json();
        if (my !== seq) return;
        if (!res.ok) { setPreview(`<span class="down">${res.error || 'Can\'t quote that trade.'}</span>`, false); return; }
        const newPct = (res.new_price * 100).toFixed(1);
        const avg = `Ⓜ${res.avg_price.toFixed(2)}`;
        if (isBuy()) {
          setPreview(
            `<div><span>Shares</span><b>${fmt(res.shares)}</b></div>
             <div><span>Avg price</span><b>${avg}</b></div>
             <div><span>Pays if right</span><b class="up">Ⓜ${fmt(res.shares)} (+${fmt(res.shares - res.coins)})</b></div>
             <div><span>New price</span><b>${newPct}%</b></div>`, true);
        } else {
          setPreview(
            `<div><span>You receive</span><b class="up">Ⓜ${fmt(res.coins)}</b></div>
             <div><span>Avg price</span><b>${avg}</b></div>
             <div><span>New price</span><b>${newPct}%</b></div>`, true);
        }
      } catch { if (my === seq) setPreview('<span class="muted">Quote unavailable.</span>', false); }
    }, 150);
  }

  form.querySelectorAll('.seg button').forEach(btn => btn.addEventListener('click', () => {
    form.querySelectorAll('.seg button').forEach(b => b.classList.toggle('active', b === btn));
    actionInput.value = btn.dataset.action;
    valueInput.value = '';
    valueInput.step = isBuy() ? '0.01' : 'any';
    refresh();
  }));
  form.querySelectorAll('input[name=outcome_id]').forEach(r => r.addEventListener('change', refresh));
  valueInput.addEventListener('input', requestQuote);
  maxBtn.addEventListener('click', () => {
    valueInput.value = isBuy() ? Math.floor(balance * 100) / 100 : held();
    requestQuote();
  });
  quick.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const next = (parseFloat(valueInput.value) || 0) + parseFloat(b.dataset.amt);
    valueInput.value = Math.min(next, Math.floor(balance * 100) / 100);
    requestQuote();
  }));
  refresh();
}
