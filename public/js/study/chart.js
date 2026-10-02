import { el, minutes } from '../ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

let tip = null;

function tooltip() {
  if (!tip) {
    tip = el('div', { class: 'chart-tip' });
    document.body.append(tip);
  }
  return tip;
}

function showTip(x, y, html) {
  const node = tooltip();
  node.innerHTML = html;
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.classList.add('show');
}

function hideTip() {
  tip?.classList.remove('show');
}

/**
 * Renders the monthly chart as inline SVG.
 *
 * The daily and weekly views deliberately share one renderer: the server
 * returns an identical point shape for both, so the toggle is a data switch
 * rather than a second drawing path.
 *
 * @param {HTMLElement} host
 * @param {{mode:string, points:Array, max:number, totals:object}} series
 */
export function drawChart(host, series, { height = 200 } = {}) {
  host.innerHTML = '';
  if (!series || !series.points?.length) {
    host.append(el('div', { class: 'empty', text: 'No data for this month yet.' }));
    return;
  }

  const width = Math.max(320, host.clientWidth || 640);
  const padTop = 14;
  const padBottom = 26;
  const padLeft = 38;
  const padRight = 8;
  const plotH = height - padTop - padBottom;
  const plotW = width - padLeft - padRight;

  const points = series.points;
  // Round the axis up to a friendly number so gridline labels read cleanly.
  const maxValue = niceMax(series.max || 1);
  const count = points.length;
  const slot = plotW / count;
  // Daily with 30+ days needs thin bars; weekly gets fat ones.
  const barWidth = Math.max(3, Math.min(38, slot * (count > 12 ? 0.6 : 0.46)));
  const y = (value) => padTop + plotH - (value / maxValue) * plotH;

  const svg = svgEl('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height: String(height),
    role: 'img',
    'aria-label': `${series.mode === 'weekly' ? 'Weekly' : 'Daily'} study hours for the month`,
  });

  // ── gridlines and y labels ─────────────────────────────────────────────
  const steps = 4;
  for (let i = 0; i <= steps; i += 1) {
    const value = (maxValue / steps) * i;
    const yy = y(value);
    svg.append(svgEl('line', {
      class: 'grid-line', x1: padLeft, x2: width - padRight, y1: yy, y2: yy,
    }));
    const label = svgEl('text', { class: 'axis-text', x: padLeft - 7, y: yy + 3, 'text-anchor': 'end' });
    label.textContent = String(Math.round(value));
    svg.append(label);
  }

  const plotGroup = svgEl('g', {});

  // ── columns ────────────────────────────────────────────────────────────
  const planPts = [];
  points.forEach((point, i) => {
    const cx = padLeft + slot * i + slot / 2;
    const group = svgEl('g', { class: 'chart-col' });

    // Invisible full-height hit area, so hovering is forgiving.
    const hit = svgEl('rect', {
      class: 'chart-col-bg',
      x: padLeft + slot * i, y: padTop, width: slot, height: plotH,
      fill: 'transparent',
    });
    group.append(hit);

    const barTop = y(point.value);
    const bar = svgEl('rect', {
      class: 'chart-bar',
      x: cx - barWidth / 2,
      y: barTop,
      width: barWidth,
      height: Math.max(point.value > 0 ? 2 : 0, padTop + plotH - barTop),
      rx: 2,
      fill: point.value > 0 ? 'url(#pf-bar)' : 'rgba(255,255,255,.05)',
    });
    group.append(bar);

    planPts.push([cx, y(point.planned)]);
    plotGroup.append(group);

    // X labels: thin out on long months so they never overlap.
    const everyNth = count > 20 ? Math.ceil(count / 15) : 1;
    if (series.mode === 'weekly' || i % everyNth === 0) {
      const label = svgEl('text', {
        class: 'axis-text', x: cx, y: height - 9, 'text-anchor': 'middle',
      });
      label.textContent = point.label;
      plotGroup.append(label);
    }
  });

  // ── planned overlay ────────────────────────────────────────────────────
  const planPath = planPts
    .map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`)
    .join(' ');
  svg.append(svgEl('path', { class: 'chart-plan-line', d: planPath }));

  // Markers on the planned line so each value is readable, not just connected.
  for (const [px, py] of planPts) {
    svg.append(svgEl('circle', {
      cx: px, cy: py, r: 2, fill: 'var(--accent4)', opacity: '.85',
    }));
  }

  svg.append(plotGroup);

  // ── gradient for the studied bars ──────────────────────────────────────
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'pf-bar', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(svgEl('stop', { offset: '0%', 'stop-color': '#6bffda' }));
  grad.append(svgEl('stop', { offset: '100%', 'stop-color': '#7c6fff' }));
  defs.append(grad);
  svg.append(defs);

  host.append(svg);

  // ── hover tooltips ─────────────────────────────────────────────────────
  // Delegated on the SVG so it survives the re-renders that follow.
  svg.addEventListener('mousemove', (event) => {
    const col = event.target.closest('.chart-col');
    if (!col) { hideTip(); return; }
    const index = [...plotGroup.querySelectorAll('.chart-col')].indexOf(col);
    const point = points[index];
    if (!point) return;
    const rows = [
      `<b>${series.mode === 'weekly' ? point.label : `Day ${point.label}`}</b>`,
      `<span class="tip-dim">${point.sub || ''}</span>`,
      `<div>${minutes(point.value)} studied</div>`,
      `<div class="tip-dim">${minutes(point.planned)} planned</div>`,
    ].join('');
    showTip(event.clientX, event.clientY, rows);
  });
  svg.addEventListener('mouseleave', hideTip);
}

/** Rounds an axis maximum up to 1/2/5 x a power of ten. */
function niceMax(value) {
  const v = Math.max(1, value);
  const magnitude = 10 ** Math.floor(Math.log10(v));
  const scaled = v / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Twelve weeks of daily cells, shaded by minutes studied.
 *
 * Columns are weeks and rows are weekdays, so a gap reads as a missing column
 * rather than a low bar. The point is consistency, not volume: the same 3 hours
 * every day is a full row of cells, a heroic single day is one bright square.
 *
 * @param {HTMLElement} host
 * @param {{points:Array<{key:string,minutes:number}>, max:number}} series
 */
export function drawHeatmap(host, series) {
  host.innerHTML = '';
  const points = series?.points || [];
  if (!points.length) {
    host.append(el('div', { class: 'empty', text: 'Nothing logged in this window yet.' }));
    return;
  }

  const max = Math.max(1, series.max || 1);
  // Pad the front to a Monday so the grid starts on a weekday, which is what
  // makes a vertical gap meaningful.
  const firstDate = new Date(`${points[0].key}T00:00:00`);
  const pad = (firstDate.getDay() + 6) % 7;
  const cells = [...Array.from({ length: pad }, () => null), ...points];

  const width = Math.max(320, host.clientWidth || 640);
  const gap = 3;
  const cell = Math.max(9, Math.min(18, (width - gap * (Math.ceil(cells.length / 7) + 2)) / Math.ceil(cells.length / 7)));
  const height = cell * 7 + gap * 6;

  const svg = svgEl('svg', {
    class: 'chart-svg heat-svg',
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height: String(height),
    role: 'img',
    'aria-label': 'Daily study minutes over the last twelve weeks',
  });

  const maxCells = Math.ceil(cells.length / 7);
  const leftPad = 30;
  const grid = svgEl('g', { transform: `translate(${leftPad},0)` });

  cells.forEach((point, i) => {
    const week = Math.floor(i / 7);
    const row = i % 7;
    const x = week * (cell + gap);
    const y = row * (cell + gap);
    if (!point) {
      grid.append(svgEl('rect', { class: 'heat-cell void', x, y, width: cell, height: cell, rx: 2 }));
      return;
    }
    // Five steps is enough to show the shape without banding every small change.
    const level = point.minutes <= 0 ? 0 : Math.min(5, Math.ceil((point.minutes / max) * 5));
    const rect = svgEl('rect', {
      class: `heat-cell lv${level}`,
      x, y, width: cell, height: cell, rx: 2,
    });
    grid.append(rect);
    svg.__cells = svg.__cells || [];
    svg.__cells.push([rect, point]);
  });

  svg.append(grid);

  // Weekday labels live in the SVG, not in an HTML column beside it: the cell
  // size is computed here, so a parallel DOM column would drift out of
  // alignment the moment the pane got narrower.
  //
  // Every row is labelled. Drawing only Mon/Wed/Fri — the GitHub convention —
  // left four of the seven rows unlabelled, so on a grid where only some cells
  // are filled it read as though the other days were missing from the chart.
  const LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // Rows are spaced one full (cell + gap) apart; the earlier `i * 2` stepped
  // two rows at a time, which only lined up because three labels were drawn.
  LABELS.forEach((name, i) => {
    const label = svgEl('text', {
      class: 'axis-text', x: leftPad - 7, y: i * (cell + gap) + cell / 2 + 3,
      'text-anchor': 'end',
    });
    label.textContent = name;
    svg.append(label);
  });

  host.append(svg);

  svg.addEventListener('mousemove', (event) => {
    const target = event.target.closest('.heat-cell');
    if (!target || target.classList.contains('void')) { hideTip(); return; }
    const hit = (svg.__cells || []).find(([rect]) => rect === target);
    if (!hit) { hideTip(); return; }
    const [, point] = hit;
    showTip(event.clientX, event.clientY, [
      `<b>${point.key}</b>`,
      `<div>${minutes(point.minutes)} studied</div>`,
    ].join(''));
  });
  svg.addEventListener('mouseleave', hideTip);
}

/**
 * Cumulative hours studied against cumulative hours planned.
 *
 * Drawn as two filled areas rather than bare lines: the gap between them is the
 * whole point, and it is only legible if both are shaded to the baseline.
 *
 * @param {HTMLElement} host
 * @param {{points:Array<{label:string,studied:number,planned:number}>}} series
 */
export function drawCumulative(host, series) {
  host.innerHTML = '';
  const points = series?.points || [];
  if (points.length === 0) {
    host.append(el('div', { class: 'empty', text: 'No data for this month yet.' }));
    return;
  }

  const width = Math.max(320, host.clientWidth || 640);
  const height = 180;
  const padTop = 14;
  const padBottom = 26;
  const padLeft = 38;
  const padRight = 8;
  const plotH = height - padTop - padBottom;
  const plotW = width - padLeft - padRight;

  const peak = Math.max(
    1,
    ...points.map((p) => Math.max(p.studied, p.planned)),
  );
  const maxValue = niceMax(peak);
  const step = plotW / Math.max(1, points.length - 1);
  const x = (i) => padLeft + step * i;
  const y = (v) => padTop + plotH - (v / maxValue) * plotH;

  const svg = svgEl('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height: String(height),
    role: 'img',
    'aria-label': 'Cumulative hours studied against cumulative hours planned',
  });

  const defs = svgEl('defs', {});
  for (const [id, from, to] of [['pf-studied', '#6bffda', '#6bffda00'], ['pf-planned', '#ffb347', '#ffb34700']]) {
    const grad = svgEl('linearGradient', { id, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.append(svgEl('stop', { offset: '0%', 'stop-color': from }));
    grad.append(svgEl('stop', { offset: '100%', 'stop-color': to }));
    defs.append(grad);
  }
  svg.append(defs);

  for (let i = 0; i <= 4; i += 1) {
    const value = (maxValue / 4) * i;
    const yy = y(value);
    svg.append(svgEl('line', { class: 'grid-line', x1: padLeft, x2: width - padRight, y1: yy, y2: yy }));
    const label = svgEl('text', { class: 'axis-text', x: padLeft - 7, y: yy + 3, 'text-anchor': 'end' });
    label.textContent = String(Math.round(value));
    svg.append(label);
  }

  /** Closes a line back down to the baseline so it can be filled. */
  const area = (key) => {
    const head = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`);
    return `${head.join(' ')} L${x(points.length - 1).toFixed(1)},${(padTop + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padTop + plotH).toFixed(1)} Z`;
  };

  svg.append(svgEl('path', { d: area('planned'), fill: 'url(#pf-planned)', opacity: '.55' }));
  svg.append(svgEl('path', { d: area('studied'), fill: 'url(#pf-studied)', opacity: '.65' }));

  for (const [key, color] of [['studied', '#6bffda'], ['planned', '#ffb347']]) {
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  }

  const everyNth = points.length > 20 ? Math.ceil(points.length / 15) : 1;
  points.forEach((point, i) => {
    if (i % everyNth !== 0 && i !== points.length - 1) return;
    const label = svgEl('text', { class: 'axis-text', x: x(i), y: height - 9, 'text-anchor': 'middle' });
    label.textContent = point.label;
    svg.append(label);
  });

  // A hit area per column, same forgiving approach as the bar chart.
  const overlay = svgEl('g', {});
  points.forEach((point, i) => {
    const group = svgEl('g', { class: 'chart-col' });
    group.append(svgEl('rect', {
      class: 'chart-col-bg',
      x: x(i) - step / 2, y: padTop, width: step, height: plotH, fill: 'transparent',
    }));
    overlay.append(group);
  });
  svg.append(overlay);

  host.append(svg);

  svg.addEventListener('mousemove', (event) => {
    const col = event.target.closest('.chart-col');
    if (!col) { hideTip(); return; }
    const index = [...overlay.querySelectorAll('.chart-col')].indexOf(col);
    const point = points[index];
    if (!point) return;
    showTip(event.clientX, event.clientY, [
      `<b>Day ${point.label}</b>`,
      `<div>${minutes(point.studied)} studied in total</div>`,
      `<div class="tip-dim">${minutes(point.planned)} planned in total</div>`,
    ].join(''));
  });
  svg.addEventListener('mouseleave', hideTip);
}
