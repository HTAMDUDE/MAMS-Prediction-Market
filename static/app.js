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
// `lines` limits how many outcomes are drawn (a Yes/No market only needs its Yes line).
function drawChart(el, history, allLabels, endTime, lines) {
  if (!el || !history.length) return;
  const labels = allLabels.slice(0, lines || allLabels.length);
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
  const entryFee = parseFloat(form.dataset.entryFee) || 0;  // charged on your first bet in this market
  const lateT = parseFloat(form.dataset.lateT) || 0;        // late-trading multiplier T (0 = no fee)
  // Biggest bet you can afford. The late fee is 0.07 x T x bet x (1 - P), and buying only pushes P up from the
  // current price, so using the current price leaves just enough room for the fee.
  const maxBet = () => {
    const p = parseFloat(selected().dataset.price) || 0;
    return Math.max(0, Math.floor((balance - entryFee) / (1 + 0.07 * lateT * (1 - p)) * 100) / 100);
  };
  // always shown in the summary: Ⓜ0.00 until the last 2 hours before betting closes
  const lateRow = (r, late, sign = '') => late
    ? row(`Late fee (×${r.late_multiplier}${r.late_fee_to ? `, to ${r.late_fee_to}` : ''})`, `${sign}${money(late)}`, 'down')
    : row('Late fee', money(0));
  let timer = null, seq = 0;

  const selected = () => form.querySelector('input[name=outcome_id]:checked');
  const outcomeName = () => selected().dataset.label;
  const held = () => parseFloat(selected().dataset.held) || 0;
  const paid = () => parseFloat(selected().dataset.paid) || 0;  // what you spent on the shares you still hold
  const row = (label, value, cls = '') => `<div class="${cls}"><span>${label}</span><b>${value}</b></div>`;
  const money = n => `Ⓜ${fmt(n)}`;
  const signed = n => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
  const defaultButton = () => `${isBuy() ? 'Buy' : 'Sell'} “${outcomeName()}”`;
  const isBuy = () => actionInput.value === 'buy';

  function refresh() {
    valueLabel.textContent = isBuy() ? 'Amount to spend (Ⓜ)' : `Shares to sell (you own ${fmt(held())})`;
    quick.hidden = !isBuy();
    submit.textContent = defaultButton();
    requestQuote();
  }

  function setPreview(html, canSubmit, buttonText) {
    preview.innerHTML = html;
    submit.disabled = !canSubmit;
    submit.textContent = buttonText || defaultButton();
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
        const newPct = `${(res.new_price * 100).toFixed(1)}%`;
        const name = outcomeName();
        if (isBuy()) {
          const fee = res.entry_fee || 0, late = res.late_fee || 0;
          const total = res.coins + fee + late;
          setPreview(
            row('You pay', money(total), 'total down') +
            row('Bet', money(res.coins)) +
            (fee ? row(`Entry fee (first bet${res.creator ? `, to ${res.creator}` : ''})`, money(fee)) : '') +
            lateRow(res, late) +
            row('You get', `${fmt(res.shares)} shares`) +
            row('Avg price per share', money(res.avg_price)) +
            row('If it wins', `you get ${money(res.shares)} (${signed(res.shares - total)})`, 'up') +
            (res.est_bonus ? row('<span title="Your share of the money that would be left in the pot if this outcome won right now. It changes as people trade.">+ est. pot bonus</span>',
                                 `~${money(res.est_bonus)}`, 'up') : '') +
            row('If it loses', `you lose ${money(total)}`, 'down') +
            row('Balance after', money(balance - total)) +
            row('New price', newPct),
            true, `Pay ${money(total)} for “${name}”`);
        } else {
          const costOfThese = held() > 0 ? paid() * Math.min(res.shares / held(), 1) : 0;
          const late = res.late_fee || 0, got = res.coins - late;
          setPreview(
            row('You receive', money(got), 'total up') +
            row('Sale value', money(res.coins)) +
            lateRow(res, late, '−') +
            row('You sell', `${fmt(res.shares)} of your ${fmt(held())} shares`) +
            row('Avg price per share', money(res.avg_price)) +
            row('You paid for these', money(costOfThese)) +
            row('Profit / loss', signed(got - costOfThese), got >= costOfThese ? 'up' : 'down') +
            row('Balance after', money(balance + got)) +
            row('New price', newPct),
            true, `Sell for ${money(got)}`);
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
    valueInput.value = isBuy() ? maxBet() : held();
    requestQuote();
  });
  quick.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const next = (parseFloat(valueInput.value) || 0) + parseFloat(b.dataset.amt);
    valueInput.value = Math.min(next, maxBet());
    requestQuote();
  }));
  refresh();
}

// Market form (propose / review / admin create): Yes/No vs multiple-choice toggle and a live preview card.
function setupMarketForm(form) {
  const kindInputs = form.querySelectorAll('input[name=kind]');
  const multiOnly = form.querySelector('[data-multi-only]');
  const ouOnly = form.querySelectorAll('[data-ou-only]');
  const ouInputs = form.querySelectorAll('input[name=ou_line], input[name=ou_unit]');
  const outcomes = form.querySelector('textarea[name=outcomes]');
  const rulesLabel = form.querySelector('[data-rules-label]');
  const stakePick = form.querySelector('[data-stake-pick]');
  const rules = form.querySelector('textarea[name=description]');
  const preview = document.querySelector('#market-preview .preview-body');
  const field = name => (form.querySelector(`[name=${name}]`) || {}).value || '';
  const kind = () => (form.querySelector('input[name=kind]:checked') || {}).value || 'multi';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function ouText() {
    const line = field('ou_line').trim() || '?';
    const unit = field('ou_unit').trim();
    return line + (unit && /^[A-Za-z0-9]/.test(unit) ? ' ' + unit : unit);
  }

  function render() {
    const k = kind();
    const yesno = k === 'yesno', ou = k === 'overunder', multi = k === 'multi';
    if (multiOnly) multiOnly.hidden = !multi;
    ouOnly.forEach(e => { e.hidden = !ou; });
    ouInputs.forEach(i => { i.disabled = !ou; });
    const lineInput = form.querySelector('input[name=ou_line]');
    if (lineInput) lineInput.required = ou;
    if (outcomes) {
      outcomes.disabled = !multi;
      outcomes.required = multi;
      if (multi && /^\s*yes\s*\n\s*no\s*$/i.test(outcomes.value)) outcomes.value = 'Option A\nOption B';
    }
    if (stakePick) {
      // the creator's opening bet can be on any of the market's outcomes
      const names = yesno ? ['Yes', 'No']
        : ou ? [`Over ${ouText()}`, `Under ${ouText()}`]
        : (outcomes ? outcomes.value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 8) : []);
      const keep = stakePick.options.length ? stakePick.value : stakePick.dataset.selected;
      const current = Array.from(stakePick.options).map(o => o.textContent);
      if (current.join('\n') !== names.join('\n')) {
        stakePick.replaceChildren(...names.map((n, i) => { const o = el('option', '', n); o.value = i; return o; }));
        stakePick.value = Number(keep) < names.length ? keep : 0;
      }
    }
    const heading = { yesno: 'Resolves YES if…', overunder: 'What number is measured, and how', multi: 'How the winner is decided' }[k];
    if (rulesLabel) rulesLabel.textContent = heading;
    if (rules) rules.placeholder = rules.dataset[k + 'Placeholder'] || '';
    if (!preview) return;

    preview.replaceChildren();
    const card = el('div', 'preview-market');
    card.append(el('h3', '', field('question').trim() || 'Your question will show up here'));
    if (yesno || ou) {
      const row = el('div', 'chance-row');
      const chance = el('div', 'chance');
      chance.append(el('span', 'chance-pct', '50%'), document.createTextNode(' '), el('span', 'muted', 'chance'));
      const yn = el('div', 'yn');
      yn.append(el('span', 'yn-yes', `${ou ? 'Over' : 'Yes'} 50¢`), el('span', 'yn-no', `${ou ? 'Under' : 'No'} 50¢`));
      row.append(chance, yn);
      if (ou) card.append(el('div', 'ou-line', `Over / Under ${ouText()}`));
      card.append(row);
    } else {
      const labels = field('outcomes').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 8);
      const list = el('ul', 'odds');
      labels.forEach((name, i) => {
        const li = el('li');
        const bar = el('span', 'bar'), fill = el('span');
        fill.style.width = `${100 / Math.max(labels.length, 1)}%`;
        fill.style.background = `var(--c${i})`;
        bar.append(fill);
        li.append(el('span', 'odds-label', name), bar, el('span', 'odds-pct', `${Math.round(100 / labels.length)}%`));
        list.append(li);
      });
      card.append(list);
    }
    const box = el('div', 'rules');
    box.append(el('h4', '', heading.replace('…', '')),
               el('p', '', field('description').trim() || '…'));
    if (field('rules_source').trim()) box.append(el('h4', '', 'Source'), el('p', '', field('rules_source').trim()));
    if (field('rules_otherwise').trim()) box.append(el('h4', '', 'Otherwise'), el('p', '', field('rules_otherwise').trim()));
    const closes = field('closes_at');
    if (closes && !isNaN(new Date(closes))) {
      box.append(el('h4', '', 'Betting closes'), el('p', '', new Date(closes).toLocaleString(undefined,
        { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })));
    }
    card.append(box);
    preview.append(card);
  }

  form.addEventListener('input', render);
  form.addEventListener('change', render);
  render();
}

document.querySelectorAll('form[data-market-form]').forEach(setupMarketForm);
