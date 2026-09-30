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
