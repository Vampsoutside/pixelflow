/** Small DOM and formatting helpers shared across every view. */

/** Creates an element. `attrs.class`, `attrs.text`, `attrs.html`, on* handlers. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  // Children may be nested arbitrarily deep (a map that returns rows, a
  // conditional that yields a list), so flatten rather than stringifying.
  const append = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(append); return; }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  [].concat(children).forEach(append);
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Escapes text for safe interpolation into an innerHTML template. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── time formatting ──────────────────────────────────────────────────────

/** Seconds -> mm:ss or h:mm:ss, for the timer ring. */
export function clock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Minutes -> '4h 00m'. Mirrors the server's formatMinutes. */
export function minutes(value) {
  const m = Math.max(0, Math.round(Number(value) || 0));
  if (m === 0) return '0m';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`;
}

/** Minutes -> '4h' / '45m' for compact spots. */
export function minutesShort(value) {
  const m = Math.max(0, Math.round(Number(value) || 0));
  if (m === 0) return '0m';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? (r ? `${h}h${r}m` : `${h}h`) : `${r}m`;
}

// ── hours entered by a person ───────────────────────────────────────────

/**
 * The number of minutes an hour figure stands for.
 *
 * Hours are the unit people think in, but every row in the database is whole
 * minutes, so this is the single place that conversion happens. Decimals are
 * the point: 5.5 is 330 minutes, not 5 or 6. Rounded to the nearest minute,
 * which is the finest grain the ledger can store — a study entry at 0.008h
 * would otherwise be rounded away by every reader that calls Math.round again.
 *
 * Returns null for anything that is not a usable number, so a caller can tell
 * "they typed nonsense" apart from "they typed zero". `maxHours` bounds the
 * result to a real day of study.
 */
export function hoursToMinutes(hours, { maxHours = 24 } = {}) {
  if (hours === null || hours === undefined || hours === '') return null;
  // Routed through the same reader as a typed field so '5,5' means 5.5 here
  // too — otherwise the form and the converter disagree about the same input.
  const minutes = parseHoursInput(hours);
  if (minutes === null || minutes < 0) return null;
  return Math.min(Math.round(maxHours * 60), minutes);
}

/** '5,5' -> 5.5. Number() alone returns NaN for a comma decimal. */
const decimal = (text) => Number(String(text).replace(',', '.'));

/**
 * Parses what somebody typed into an hours field.
 *
 * Accepts the shapes that come up in practice: '5.5', '5,5' (a comma decimal
 * separator), '5h30', '5h 30m', '2h', '90m', '5:30', and a bare number. Anything
 * it cannot read returns null so the field can reject it rather than silently
 * saving a wrong figure.
 */
export function parseHoursInput(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;

  const NUM = String.raw`\d+(?:[.,]\d+)?`;
  // An explicit minute part. The trailing 'm' is optional because people write
  // '5h30' as often as '5h30m', and making it mandatory silently rejected the
  // shorter form.
  const hm = text.match(new RegExp(`^(${NUM})\\s*h(?:ours?)?\\s*(${NUM})?\\s*m?(?:in(?:utes?)?)?$`));
  if (hm) {
    const h = decimal(hm[1]);
    const m = hm[2] === undefined ? 0 : decimal(hm[2]);
    return Math.round(h * 60 + m);
  }
  // Hours on their own: '2h', '2 hours'.
  const hOnly = text.match(new RegExp(`^(${NUM})\\s*h(?:ours?)?$`));
  if (hOnly) return Math.round(decimal(hOnly[1]) * 60);
  // Minutes on their own: '90m', '90 min'. The unit is REQUIRED here — making
  // it optional would make this pattern swallow every bare number too, and
  // read '6' as six minutes instead of six hours.
  const mOnly = text.match(new RegExp(`^(${NUM})\\s*(?:m|min|minute|minutes)$`));
  if (mOnly) return Math.round(decimal(mOnly[1]));

  // '5:30' — the clock shape people use for "five and a half".
  const colon = text.match(/^(\d+)\s*:\s*(\d{1,2})$/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);

  // A bare number, or a decimal with a comma in place of the point.
  const plain = text.match(new RegExp(`^(${NUM})$`));
  if (plain) return Math.round(decimal(plain[1]) * 60);

  return null;
}

/**
 * The text to put in an hours field for a given number of minutes.
 *
 * Whole hours show bare ('8'); anything with a remainder shows up to two
 * decimals, because 5.5 is exactly what somebody meant and 5.499999 is not.
 * Zero is '0' rather than blank so the field round-trips: an empty field is
 * ambiguous between "nothing" and "not filled in yet".
 */
export function minutesToHoursValue(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m === 0) return '0';
  // Two decimals is the most a person ever needs, and String() drops the
  // trailing zeros so '1.5' never renders as '1.50'.
  return String(Math.round((m / 60) * 100) / 100);
}

// ── local calendar days ──────────────────────────────────────────────────

/** Local 'YYYY-MM-DD' — deliberately not UTC, because these are study days. */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const monthKey = (date = new Date()) => dayKey(date).slice(0, 7);

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Monday of the week containing `date`, at local midnight. */
export function weekStart(date = new Date()) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

export function parseDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatRelative(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── toast ────────────────────────────────────────────────────────────────

let toastTimer = null;

export function toast(message, ms = 2400) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

// ── misc ─────────────────────────────────────────────────────────────────

export function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Loads a <script> once and resolves when it is on the page. */
const loaded = new Map();
export function loadScript(src) {
  if (loaded.has(src)) return loaded.get(src);
  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => { script.dataset.loaded = '1'; resolve(); });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
    document.head.append(script);
  });
  loaded.set(src, promise);
  return promise;
}
