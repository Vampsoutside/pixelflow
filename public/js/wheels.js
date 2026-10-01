import { el, clamp } from './ui.js';

const CELL_H = 44;
const VIEWPORT_CELLS = 3;      // one above, the selection, one below
const SNAP_EPSILON = 0.35;     // fraction of a cell that still counts as "settled"
// The selector highlights the middle row of the viewport, not the first, so the
// strip is pushed down by one cell at rest. Without this, index 0 leaves "0" in
// the top row while the highlight — and therefore what reads as the value —
// sits on the next number.
const REST_OFFSET = CELL_H * ((VIEWPORT_CELLS - 1) / 2);

/**
 * A pixel-style vertical scroll wheel.
 *
 * Three ways to move it — pointer drag, mouse wheel / trackpad scroll, and
 * arrow keys — all feeding the same offset, so they stay in sync. The strip
 * follows the finger freely while dragging and springs to the nearest cell on
 * release; wheel and keyboard input animate straight to a cell.
 *
 * @param {object} opts
 * @param {number[]} opts.values       values in display order
 * @param {number}   [opts.index]      initially selected index
 * @param {string}   [opts.format]     (value) => label
 * @param {Function} [opts.onChange]   (index, value) => void
 * @param {string}   [opts.label]      small caption under the wheel
 * @param {string}   [opts.name]       accessible name
 */
export function createWheel({
  values,
  index = 0,
  format = (v) => String(v),
  onChange,
  label = '',
  name = 'value',
  accent = 'focus',
} = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('createWheel needs at least one value');
  }

  let current = clamp(index, 0, values.length - 1);
  let offset = current * CELL_H;   // pixels the strip is shifted up by
  let disabled = false;
  let dragging = false;
  let pointerId = null;
  let startY = 0;
  let startOffset = 0;
  let rafId = null;
  let target = offset;             // where the spring is heading
  let notified = current;          // last index handed to onChange

  const strip = el('div', { class: 'wheel-strip' });
  const viewport = el('div', { class: 'wheel-viewport' }, [strip]);
  const selector = el('div', { class: 'wheel-selector' });
  const column = el('div', { class: 'wheel-col' });
  const wheel = el('div', {
    class: 'wheel',
    'data-accent': accent,
    role: 'spinbutton',
    tabindex: '0',
    'aria-label': name,
    'aria-valuenow': String(values[current]),
    'aria-valuemin': String(values[0]),
    'aria-valuemax': String(values[values.length - 1]),
    'aria-disabled': 'false',
  }, [viewport, selector]);

  if (label) column.append(el('div', { class: 'wheel-label', text: label }));
  column.prepend(wheel);

  // ── cells ──────────────────────────────────────────────────────────────

  const cells = values.map((value, i) => {
    const cell = el('div', { class: 'wheel-cell', text: format(value) });
    strip.append(cell);
    return cell;
  });

  // ── rendering ──────────────────────────────────────────────────────────

  /** Paints the strip transform and the near/active cell classes. */
  function paint() {
    strip.style.transform = `translateY(${REST_OFFSET - offset}px)`;
    for (let i = 0; i < cells.length; i += 1) {
      const distance = Math.abs(offset / CELL_H - i);
      cells[i].classList.toggle('active', distance < SNAP_EPSILON);
      cells[i].classList.toggle('near', distance >= SNAP_EPSILON && distance < 1.6);
    }
    const nearest = clamp(Math.round(offset / CELL_H), 0, values.length - 1);
    wheel.setAttribute('aria-valuenow', String(values[nearest]));
    wheel.setAttribute('aria-valuetext', format(values[nearest]));
  }

  /** Animates toward a pixel offset, stopping early if the user grabs again. */
  function animateTo(pixels) {
    target = pixels;
    cancelAnimationFrame(rafId);
    const step = () => {
      const delta = target - offset;
      if (Math.abs(delta) < 0.5) {
        offset = target;
        paint();
        settle();
        return;
      }
      // Exponential ease gives the springy feel without a physics loop.
      offset += delta * 0.22;
      paint();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  /**
   * Snaps to the nearest cell and fires onChange if the value really moved.
   *
   * `current` is bumped synchronously by setIndex so rapid input keeps its
   * place, which means comparing against it here would never report a change.
   * `notified` is therefore the last value the listener actually saw, and it
   * is what change detection keys off.
   */
  function settle() {
    const next = clamp(Math.round(offset / CELL_H), 0, values.length - 1);
    offset = next * CELL_H;
    current = next;
    paint();
    if (next !== notified) {
      notified = next;
      onChange?.(next, values[next]);
    }
  }

  /** Clamps to [0, max] so the strip cannot scroll past either end. */
  function clampOffset(pixels) {
    return clamp(pixels, 0, (values.length - 1) * CELL_H);
  }

  // ── pointer drag ───────────────────────────────────────────────────────

  wheel.addEventListener('pointerdown', (event) => {
    if (disabled || event.button !== 0) return;
    cancelAnimationFrame(rafId);
    dragging = true;
    pointerId = event.pointerId;
    startY = event.clientY;
    startOffset = offset;
    wheel.setPointerCapture(pointerId);
    event.preventDefault();
  });

  wheel.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    // Dragging down reveals earlier values, so the offset moves the other way.
    offset = clampOffset(startOffset - (event.clientY - startY));
    paint();
  });

  function endDrag(event) {
    if (!dragging || (event && event.pointerId !== pointerId)) return;
    dragging = false;
    if (pointerId !== null && wheel.hasPointerCapture?.(pointerId)) {
      wheel.releasePointerCapture(pointerId);
    }
    pointerId = null;
    animateTo(clampOffset(Math.round(offset / CELL_H) * CELL_H));
  }

  wheel.addEventListener('pointerup', endDrag);
  wheel.addEventListener('pointercancel', endDrag);

  // ── wheel / trackpad ───────────────────────────────────────────────────

  let wheelAccum = 0;
  wheel.addEventListener('wheel', (event) => {
    if (disabled) return;
    event.preventDefault();
    cancelAnimationFrame(rafId);
    // Trackpads send many small deltas, so accumulate until they add up to a
    // meaningful distance rather than reacting to every jitter.
    wheelAccum += event.deltaY;
    if (Math.abs(wheelAccum) < 6) return;
    const steps = Math.trunc(wheelAccum / CELL_H) || Math.sign(wheelAccum);
    wheelAccum -= steps * CELL_H;
    setIndex(current + steps, { animate: true });
  }, { passive: false });

  // ── keyboard ───────────────────────────────────────────────────────────

  wheel.addEventListener('keydown', (event) => {
    if (disabled) return;
    const step = {
      ArrowUp: -1, ArrowDown: 1,
      PageUp: -5, PageDown: 5,
    }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      setIndex(current + step, { animate: true });
    } else if (event.key === 'Home') {
      event.preventDefault();
      setIndex(0, { animate: true });
    } else if (event.key === 'End') {
      event.preventDefault();
      setIndex(values.length - 1, { animate: true });
    }
  });

  // ── public API ─────────────────────────────────────────────────────────

  function setIndex(next, { animate = false, silent = false } = {}) {
    const clamped = clamp(Math.round(next), 0, values.length - 1);
    if (clamped === current && !silent) return;
    current = clamped;
    if (animate) {
      // settle() reports the change once the spring lands, so leaving
      // `notified` alone here is what keeps it from firing early.
      animateTo(current * CELL_H);
    } else {
      cancelAnimationFrame(rafId);
      offset = current * CELL_H;
      paint();
      if (!silent && clamped !== notified) {
        notified = clamped;
        onChange?.(clamped, values[clamped]);
      }
    }
  }

  function setValue(value, options) {
    const i = values.indexOf(value);
    if (i >= 0) setIndex(i, options);
  }

  function setDisabled(next) {
    disabled = Boolean(next);
    wheel.setAttribute('aria-disabled', String(disabled));
    wheel.tabIndex = disabled ? -1 : 0;
    if (disabled) endDrag();
  }

  paint();

  return {
    element: column,
    get index() { return current; },
    get value() { return values[current]; },
    setValue,
    setIndex,
    setDisabled,
    get disabled() { return disabled; },
  };
}

/** Hours wheel: 0–24 inclusive. */
export const HOUR_VALUES = Array.from({ length: 25 }, (_, i) => i);

/** Minutes wheel: 5-minute steps, so 0, 5, 10 … 55. */
export const MINUTE_VALUES = Array.from({ length: 12 }, (_, i) => i * 5);

/** Quick-set presets shown above the ring. 25 is here because the wheels step
 *  in fives, which would otherwise make the classic 25-minute pomodoro
 *  unreachable. */
export const QUICK_PRESETS = [25, 30, 60, 90, 120];
