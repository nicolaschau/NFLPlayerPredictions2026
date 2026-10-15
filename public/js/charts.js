// Small hand-rolled SVG charts. Every mark with a data-tip attribute gets a hover tooltip.

const NS = 'http://www.w3.org/2000/svg';
const tipEl = () => document.getElementById('tooltip');

export function el(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

// Column with a 4px rounded top and a square base.
function colPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

export function attachTips(container) {
  if (container.dataset.tips) return;
  container.dataset.tips = '1';
  const t = tipEl();
  let active = null;
  const show = (e) => {
    const target = e.target.closest('[data-tip]');
    if (active && active !== target) active.classList.remove('active');
    if (!target) { t.hidden = true; active = null; return; }
    active = target;
    target.classList.add('active');
    t.innerHTML = target.dataset.tip;
    t.hidden = false;
    const r = t.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY - r.height - 10;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
    if (y < 8) y = e.clientY + 16;
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  };
  container.addEventListener('pointermove', show);
  container.addEventListener('pointerdown', show);
  container.addEventListener('pointerleave', () => { t.hidden = true; active?.classList.remove('active'); active = null; });
}

function frame(container, height) {
  container.innerHTML = '';
  const width = Math.max(260, container.clientWidth || 520);
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  container.appendChild(svg);
  attachTips(container);
  return { svg, width, height };
}

function yAxis(svg, { x0, x1, y, max, ticks = 4, fmt }) {
  const step = niceStep(max / ticks);
  const top = Math.ceil(max / step) * step;
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = y(v, top);
    svg.appendChild(el('line', { x1: x0, x2: x1, y1: yy, y2: yy, class: v === 0 ? 'base' : 'grid' }));
    svg.appendChild(el('text', { x: x0 - 6, y: yy + 3.5, 'text-anchor': 'end' }, fmt(v)));
  }
  return top;
}

/** Probability mass of the projected outcome, with the region at/above the line highlighted. */
export function distChart(container, { dist, line, statLabel, continuous }) {
  const { svg, width, height } = frame(container, 230);
  const m = { l: 40, r: 10, t: 22, b: 28 };
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  let bins = [];
  if (dist.type === 'count') {
    const maxK = Math.max(dist.quantile(0.995), Math.ceil(line) + 1, 3);
    for (let k = 0; k <= maxK; k++) bins.push({ lo: k, hi: k + 1, label: `${k}`, p: dist.pmf(k), hit: k >= line });
  } else if (dist.type === 'gamma') {
    const upper = Math.max(dist.quantile(0.995), line * 1.15);
    const w = niceStep(upper / 28);
    const cc = continuous ? 0 : 0.5;
    // Align bin edges with the line so the highlighted region starts exactly there.
    let lo = line - Math.ceil(line / w) * w;
    while (lo < upper) {
      const a = Math.max(0, lo), b = lo + w;
      if (b > 0) bins.push({ lo: a, hi: b, p: dist.cdf(b - cc) - (a === 0 ? 0 : dist.cdf(a - cc)), hit: a >= line });
      lo = b;
    }
  } else {
    bins = [{ lo: 0, hi: 1, label: '0', p: 1, hit: line <= 0 }];
  }
  const maxP = Math.max(...bins.map((b) => b.p), 0.01);
  const y = (v, top) => m.t + ih - (v / top) * ih;
  const top = yAxis(svg, { x0: m.l, x1: width - m.r, y, max: maxP, fmt: (v) => `${+(v * 100).toFixed(1)}%` });
  const slot = iw / bins.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const isCount = dist.type === 'count';
  const tickEvery = Math.max(1, Math.ceil(bins.length / Math.floor(iw / 46)));
  bins.forEach((b, i) => {
    const x = m.l + i * slot + (slot - bw) / 2;
    const h = (b.p / top) * ih;
    const range = isCount ? `Exactly ${b.lo}` : `${fmtNum(b.lo)}–${fmtNum(b.hi)}`;
    const g = el('g', { class: 'hot', 'data-tip': `<b>${range}</b> ${statLabel}<br>${pct(b.p, 1)} chance` });
    g.appendChild(el('rect', { x: m.l + i * slot, y: m.t, width: slot, height: ih, fill: 'transparent' }));
    g.appendChild(el('path', { d: colPath(x, m.t + ih - h, bw, h), class: b.hit ? 'hit' : 'miss' }));
    svg.appendChild(g);
    if (i % tickEvery === 0) {
      const tx = isCount ? x + bw / 2 : m.l + i * slot;
      svg.appendChild(el('text', { x: tx, y: height - 10, 'text-anchor': 'middle' }, isCount ? b.label : fmtNum(b.lo)));
    }
  });
  // Line marker at the threshold (bin boundary).
  const idx = bins.findIndex((b) => b.hit);
  if (idx >= 0) {
    const lx = isCount ? m.l + idx * slot + 1 : m.l + idx * slot;
    svg.appendChild(el('line', { x1: lx, x2: lx, y1: m.t - 6, y2: m.t + ih, class: 'line-mark' }));
    const anchor = lx > width - 120 ? 'end' : 'start';
    svg.appendChild(el('text', { x: lx + (anchor === 'start' ? 5 : -5), y: m.t - 8, 'text-anchor': anchor, class: 'lbl-strong' }, `${fmtNum(line)}+ → ${pct(dist.pAtLeast(line))}`));
  }
  legend(container, [['var(--accent)', `At or above ${fmtNum(line)}`], ['var(--miss)', 'Below']]);
}

/** One column per past game, colored by whether it cleared the line. */
export function logChart(container, { games, key, line, statLabel, season }) {
  const { svg, width, height } = frame(container, 230);
  if (!games.length) { container.innerHTML = '<p class="empty">No games yet.</p>'; return; }
  const m = { l: 40, r: 10, t: 22, b: 28 };
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  const seasonGap = 14;
  const hasSplit = games.some((g) => g.season !== season) && games.some((g) => g.season === season);
  const slot = (iw - (hasSplit ? seasonGap : 0)) / games.length;
  const bw = Math.min(24, Math.max(3, slot - 2));
  const maxV = Math.max(line * 1.2, ...games.map((g) => g.s[key]), 1);
  const y = (v, top) => m.t + ih - (Math.max(0, v) / top) * ih;
  const top = yAxis(svg, { x0: m.l, x1: width - m.r, y, max: maxV, fmt: fmtNum });
  let xCursor = m.l, prevSeason = games[0].season;
  games.forEach((g, i) => {
    if (g.season !== prevSeason) {
      xCursor += seasonGap;
      prevSeason = g.season;
    }
    const v = g.s[key];
    const x = xCursor + (slot - bw) / 2;
    const h = (Math.max(0, v) / top) * ih;
    const hit = v >= line;
    const grp = el('g', { class: 'hot', 'data-tip': `<b>${g.season} Wk ${g.week}</b> ${g.home ? 'vs' : '@'} ${g.opp}<br>${fmtNum(v)} ${statLabel} ${hit ? '✓ cleared' : '✗ fell short'}` });
    grp.appendChild(el('rect', { x: xCursor, y: m.t, width: slot, height: ih, fill: 'transparent' }));
    grp.appendChild(el('path', { d: colPath(x, m.t + ih - h, bw, Math.max(h, v === 0 ? 0 : 1)), class: hit ? 'hit' : 'miss' }));
    svg.appendChild(grp);
    if (i === 0 || games[i - 1].season !== g.season) {
      svg.appendChild(el('text', { x: xCursor, y: height - 10, 'text-anchor': 'start' }, `${g.season}`));
    }
    xCursor += slot;
  });
  const ly = y(line, top);
  svg.appendChild(el('line', { x1: m.l, x2: width - m.r, y1: ly, y2: ly, class: 'line-mark' }));
  svg.appendChild(el('text', { x: width - m.r, y: ly - 5, 'text-anchor': 'end', class: 'lbl-strong' }, `Line ${fmtNum(line)}`));
  legend(container, [['var(--accent)', 'Cleared'], ['var(--miss)', 'Fell short']]);
}

/** Reliability diagram: predicted probability vs observed frequency, per decile bin. */
export function reliabilityChart(container, bins) {
  const { svg, width } = frame(container, 300);
  const height = 300;
  const m = { l: 44, r: 14, t: 14, b: 38 };
  const size = Math.min(width - m.l - m.r, height - m.t - m.b);
  const x = (v) => m.l + v * size, y = (v) => m.t + size - v * size;
  for (let v = 0; v <= 1.0001; v += 0.25) {
    svg.appendChild(el('line', { x1: x(0), x2: x(1), y1: y(v), y2: y(v), class: v === 0 ? 'base' : 'grid' }));
    svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, `${v * 100}%`));
    svg.appendChild(el('text', { x: x(v), y: m.t + size + 16, 'text-anchor': 'middle' }, `${v * 100}%`));
  }
  svg.appendChild(el('line', { x1: x(0), y1: y(0), x2: x(1), y2: y(1), class: 'base', 'stroke-dasharray': null }));
  svg.appendChild(el('text', { x: m.l + size / 2, y: m.t + size + 34, 'text-anchor': 'middle' }, 'Predicted probability'));
  const pts = bins.filter((b) => b.n);
  svg.appendChild(el('polyline', { points: pts.map((b) => `${x(b.predicted)},${y(b.observed)}`).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  for (const b of pts) {
    const g = el('g', { class: 'hot', 'data-tip': `<b>Predicted ${pct(b.predicted, 1)}</b><br>Actually happened ${pct(b.observed, 1)}<br>${b.n.toLocaleString()} predictions` });
    g.appendChild(el('circle', { cx: x(b.predicted), cy: y(b.observed), r: 12, fill: 'transparent' }));
    g.appendChild(el('circle', { cx: x(b.predicted), cy: y(b.observed), r: 5, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 }));
    svg.appendChild(g);
  }
  const lt = el('text', { x: m.l - 32, y: m.t + size / 2, 'text-anchor': 'middle', transform: `rotate(-90 ${m.l - 32} ${m.t + size / 2})` }, 'Observed frequency');
  svg.appendChild(lt);
}

/** Horizontal bars comparing scores (lower is better). */
export function scoreBars(container, rows) {
  const rowH = 34;
  const { svg, width } = frame(container, rows.length * rowH + 8);
  const labelW = Math.min(190, width * 0.42);
  const max = Math.max(...rows.map((r) => r.value)) * 1.08;
  rows.forEach((r, i) => {
    const yy = i * rowH + 4;
    const w = ((width - labelW - 56) * r.value) / max;
    svg.appendChild(el('text', { x: 0, y: yy + 17, class: r.strong ? 'lbl-strong' : null }, r.label));
    const g = el('g', { class: 'hot', 'data-tip': `<b>${r.label}</b><br>Brier ${r.value.toFixed(4)}${r.note ? `<br>${r.note}` : ''}` });
    g.appendChild(el('rect', { x: labelW, y: yy, width: width - labelW, height: rowH - 6, fill: 'transparent' }));
    g.appendChild(el('rect', { x: labelW, y: yy + 6, width: w, height: 16, rx: 4, fill: r.strong ? 'var(--accent)' : 'var(--miss)' }));
    svg.appendChild(g);
    svg.appendChild(el('text', { x: labelW + w + 6, y: yy + 18, class: r.strong ? 'lbl-strong' : null }, r.value.toFixed(4)));
  });
}

function legend(container, items) {
  const d = document.createElement('div');
  d.className = 'chart-legend';
  d.innerHTML = items.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');
  container.appendChild(d);
}

export function pct(p, digits = 0) {
  if (p == null || Number.isNaN(p)) return '–';
  const v = p * 100;
  if (digits === 0 && v > 0 && v < 1) return '<1%';
  if (digits === 0 && v < 100 && v > 99) return '>99%';
  return `${v.toFixed(digits)}%`;
}

export function fmtNum(v, d) {
  if (v == null || Number.isNaN(v)) return '–';
  if (d != null) return v.toFixed(d);
  return Number.isInteger(v) ? `${v}` : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1);
}
