// MAMS Prediction Market — front-end helpers (no dependencies).

const SVG_NS = 'http://www.w3.org/2000/svg';
// Timestamps from the server are school-time wall-clock strings ("2025-03-04 15:30:00"). Parsing them as UTC and
// formatting with timeZone "UTC" keeps that wall clock exactly, whatever the viewer's own time zone is.
const parseTime = s => Date.parse(s.replace(' ', 'T') + 'Z');
function wallNow(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
const fmt = n => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function svg(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// Price-over-time chart: one stepped line per outcome.
// `lines` limits how many outcomes are drawn (a Yes/No market only needs its Yes line).
function drawChart(el, history, allLabels, endTime, lines, tz) {
  if (!el || !history.length) return;
  const labels = allLabels.slice(0, lines || allLabels.length);
  const W = 640, H = 220, L = 36, R = 8, T = 10, B = 24;
  const pts = history.map(h => ({ t: parseTime(h.t), p: h.p }));
  const end = endTime ? parseTime(endTime) : wallNow(tz || 'America/New_York');
  pts.push({ t: Math.max(end, pts[pts.length - 1].t), p: pts[pts.length - 1].p });
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const x = t => L + (t - t0) / (t1 - t0) * (W - L - R);
  const y = p => T + (1 - p) * (H - T - B);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Price history chart' });
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    svg('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), class: 'grid' }, root);
    svg('text', { x: L - 6, y: y(g) + 4, class: 'axis', 'text-anchor': 'end' }, root).textContent = `${g * 100}%`;
  }
  // Time axis: clock times when the chart spans under a day, dates otherwise; the last tick says "now" while live.
  const shortSpan = t1 - t0 < 86400000;
  const tickFmt = new Intl.DateTimeFormat('en-US', shortSpan
    ? { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const TICKS = 4;
  let prevLabel = null;
  for (let i = 0; i < TICKS; i++) {
    const t = t0 + (t1 - t0) * i / (TICKS - 1);
    const last = i === TICKS - 1;
    const label = last && !endTime ? 'now' : tickFmt.format(t);
    if (!last && label === prevLabel) continue;  // a short span would repeat the same label
    if (last && label === prevLabel) { root.lastChild.remove(); }  // keep the end label, drop the duplicate before it
    prevLabel = label;
    svg('text', { x: x(t), y: H - 6, class: 'axis', 'text-anchor': i === 0 ? 'start' : last ? 'end' : 'middle' }, root).textContent = label;
  }

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
    tip.innerHTML = `<div class="muted small">${new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}</div>` +
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
  const snipeRate = parseFloat(form.dataset.snipeRate) || 0; // buys pay at least this x T x shares x P^2
  // always shown in the summary: Ⓜ0.00 until the last 2 hours before betting closes
  const lateRow = (r, late, sign = '') => late
    ? row(`Late fee (×${r.late_multiplier}${r.late_fee_to ? `, to ${r.late_fee_to}` : ''})`, `${sign}${money(late)}`, 'down')
    : row('Late fee', money(0));
  const minOut = form.querySelector('#min-out');
  let timer = null, ctrl = null, quoted = null;  // quoted = { key } of the quote the preview shows

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
    submit.classList.toggle('btn-buy', isBuy());
    submit.classList.toggle('btn-sell', !isBuy());
    requestQuote();
  }

  function setPreview(html, canSubmit, buttonText) {
    preview.innerHTML = html;
    submit.disabled = !canSubmit;
    submit.textContent = buttonText || defaultButton();
  }

  // A quote is only valid for the exact outcome|action|amount it was fetched for.
  const keyFor = v => `${selected().value}|${actionInput.value}|${v}`;
  const floor6 = n => Math.floor(n * 1e6) / 1e6;
  const floor2 = n => Math.floor(n * 100) / 100;
  const round2 = n => Math.round(n * 100) / 100;
  // Biggest bet you can afford. The late fee per coin bet is the larger of 0.07 x T x (1 - P) and snipeRate x T x P.
  // Buying pushes P up from the current price, so the first part is largest at the current price and the second
  // is at most snipeRate x T (P < 1). Using both bounds leaves enough room for the fee.
  const maxBuy = () => {
    const p = parseFloat(selected().dataset.price) || 0;
    const rate = Math.max(0.07 * lateT * (1 - p), snipeRate * lateT);
    return Math.max(0, floor2((balance - entryFee) / (1 + rate)));
  };

  function requestQuote() {
    clearTimeout(timer);
    if (ctrl) ctrl.abort();  // drop any quote still in flight
    minOut.value = '';
    preview.classList.remove('stale');
    const v = parseFloat(valueInput.value);
    if (!isBuy() && held() <= 0) {
      quoted = null;
      setPreview(`<span class="muted">You don't own any “${outcomeName()}” shares to sell.</span>`, false);
      return;
    }
    if (!(v > 0)) {
      quoted = null;
      setPreview(`<span class="muted">${isBuy() ? 'Enter an amount to see your payout.' : 'Enter shares to see what you get back.'}</span>`, false);
      return;
    }
    const key = keyFor(v);
    // Same outcome and action, new amount: keep the old numbers on screen but dim them until the new quote lands.
    const sameKind = quoted && quoted.key.split('|').slice(0, 2).join('|') === key.split('|').slice(0, 2).join('|');
    if (!sameKind) { preview.innerHTML = '<span class="muted">Getting a quote…</span>'; quoted = null; }
    preview.classList.toggle('stale', !!sameKind);
    submit.disabled = true;
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      const params = new URLSearchParams({ market: form.dataset.market, outcome: selected().value, action: actionInput.value, value: v });
      try {
        const res = await (await fetch(`${form.dataset.quote}?${params}`, { signal: ctrl.signal })).json();
        if (keyFor(parseFloat(valueInput.value)) !== key) return;  // the input moved on while we waited
        preview.classList.remove('stale');
        if (!res.ok) { quoted = null; setPreview(`<span class="down">${res.error || 'Can\'t quote that trade.'}</span>`, false); return; }
        quoted = { key };
        minOut.value = floor6((isBuy() ? res.shares : res.coins) * 0.98);  // refuse if the price moves >2% against you
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
      } catch (err) {
        if (err.name === 'AbortError') return;
        quoted = null;
        preview.classList.remove('stale');
        setPreview('<span class="muted">Quote unavailable. Try again.</span>', false);
      }
    }, 150);
  }

  form.querySelectorAll('.seg button').forEach(btn => btn.addEventListener('click', () => {
    form.querySelectorAll('.seg button').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    actionInput.value = btn.dataset.action;
    valueInput.value = '';
    valueInput.step = isBuy() ? '0.01' : 'any';
    refresh();
  }));
  form.querySelectorAll('input[name=outcome_id]').forEach(r => r.addEventListener('change', refresh));
  valueInput.addEventListener('input', requestQuote);
  maxBtn.addEventListener('click', () => {
    valueInput.value = isBuy() ? maxBuy() : floor6(held());
    requestQuote();
  });
  quick.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    valueInput.value = round2(Math.min((parseFloat(valueInput.value) || 0) + parseFloat(b.dataset.amt), maxBuy()));
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


// Loan offer form: show what the borrower would pay back.
document.querySelectorAll('[data-loan-form]').forEach(form => {
  const out = form.querySelector('[data-loan-summary]');
  const base = out.textContent;
  const update = () => {
    const amt = parseFloat(form.amount.value), rate = parseFloat(form.rate.value), days = parseInt(form.days.value, 10);
    if (!(amt > 0) || !(rate >= 0) || !(days > 0)) { out.textContent = base; return; }
    const back = Math.round(amt * (1 + rate / 100) * 100) / 100;
    const who = form.borrower.value.trim() || 'The borrower';
    out.textContent = `${who} would pay back Ⓜ${back.toFixed(2)} (Ⓜ${(back - amt).toFixed(2)} interest) within ${days} day${days === 1 ? '' : 's'}. ` + base;
  };
  form.addEventListener('input', update);
  update();
});

// Confirmation dialogs: any form with data-confirm="message" (and optionally data-confirm-title /
// data-confirm-label), or a submit button with its own data-confirm, asks first.
(function setupConfirm() {
  const dlg = document.getElementById('confirm-dialog');
  let pending = null;
  document.addEventListener('submit', e => {
    const form = e.target;
    const src = e.submitter && e.submitter.dataset.confirm ? e.submitter : form;
    const message = src.dataset.confirm;
    if (!message || form.dataset.confirmed) return;
    e.preventDefault();
    if (!dlg || !dlg.showModal) {
      if (window.confirm(message)) { form.dataset.confirmed = '1'; form.requestSubmit(e.submitter); }
      return;
    }
    pending = { form, submitter: e.submitter };
    dlg.querySelector('[data-title]').textContent = src.dataset.confirmTitle || 'Are you sure?';
    dlg.querySelector('[data-message]').textContent = message;
    dlg.querySelector('[data-ok]').textContent = src.dataset.confirmLabel || 'Confirm';
    dlg.showModal();
  });
  if (dlg) dlg.addEventListener('close', () => {
    const p = pending;
    pending = null;
    if (p && dlg.returnValue === 'ok') { p.form.dataset.confirmed = '1'; p.form.requestSubmit(p.submitter); }
    dlg.returnValue = '';
  });
})();


// Bottom "Bet" bar on phones: shows the current chance and scrolls to the trade panel; hidden while that panel is on screen.
function setupBetBar() {
  const bar = document.getElementById('bet-bar'), panel = document.getElementById('trade');
  if (!bar || !panel || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(([entry]) => { bar.hidden = entry.isIntersecting; }, { threshold: 0.15 }).observe(panel);
}

// Phone menu sheet.
(function setupMenu() {
  const btn = document.getElementById('menu-btn'), sheet = document.getElementById('menu-sheet');
  if (!btn || !sheet || !sheet.showModal) return;
  btn.addEventListener('click', () => sheet.showModal());
  sheet.addEventListener('click', e => {
    if (e.target === sheet || e.target.closest('[data-close-sheet]') || e.target.closest('a')) sheet.close();
  });
})();


// Home page filters: the server renders every market; tabs and topic chips just hide cards and update the URL
// (still shareable as ?status=&cat=) without a request. Without JS the links reload the page as before.
(function setupMarketFilters() {
  const bar = document.getElementById('market-filters'), grid = document.getElementById('market-grid');
  if (!bar || !grid) return;
  const cards = [...grid.querySelectorAll('.market-card')];
  const empty = document.getElementById('empty-state');
  const tabs = [...bar.querySelectorAll('[data-status]')], chips = [...bar.querySelectorAll('[data-cat]')];
  const params = new URLSearchParams(location.search);
  let status = tabs.some(t => t.dataset.status === params.get('status')) ? params.get('status') : 'open';
  let cat = chips.some(c => c.dataset.cat === params.get('cat')) ? params.get('cat') : '';
  const matches = (state, s) => s === 'all' || state === s || (s === 'closed' && ['closed', 'proposed', 'disputed'].includes(state));

  function apply() {
    let shown = 0;
    for (const card of cards) {
      const ok = matches(card.dataset.state, status) && (!cat || card.dataset.cat === cat);
      card.hidden = !ok;
      if (ok) shown++;
    }
    tabs.forEach(t => { const on = t.dataset.status === status; t.classList.toggle('active', on); t.setAttribute('aria-pressed', on); });
    chips.forEach(c => { const on = c.dataset.cat === cat; c.classList.toggle('active', on); c.setAttribute('aria-pressed', on); });
    const filtered = status !== 'open' || !!cat;
    empty.hidden = shown > 0;
    document.getElementById('empty-title').innerHTML = `<strong>${filtered ? 'No markets match these filters.' : 'No open markets right now.'}</strong>`;
    document.getElementById('empty-hint').textContent = filtered ? 'Try another topic or status.' : 'Check back soon, or propose one yourself.';
    document.getElementById('clear-filters').hidden = !filtered;
    const q = new URLSearchParams();
    if (status !== 'open') q.set('status', status);
    if (cat) q.set('cat', cat);
    history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : ''));
    // keep each link pointing at the right page for "open in new tab" and no-JS fallbacks
    tabs.forEach(t => { const p = new URLSearchParams(); p.set('status', t.dataset.status); if (cat) p.set('cat', cat); t.href = `/?${p}`; });
    chips.forEach(c => { const p = new URLSearchParams(); p.set('status', status); if (c.dataset.cat) p.set('cat', c.dataset.cat); c.href = `/?${p}`; });
  }
  bar.addEventListener('click', e => {
    const tab = e.target.closest('[data-status]'), chip = e.target.closest('[data-cat]');
    if (!tab && !chip || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (tab) status = tab.dataset.status; else cat = chip.dataset.cat;
    apply();
  });
  document.getElementById('clear-filters').addEventListener('click', e => { e.preventDefault(); status = 'open'; cat = ''; apply(); });
})();
