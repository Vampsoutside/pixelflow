import { el, clock, toast } from '../ui.js';
import { settings, updateSetting } from '../store.js';
import { timer, mountTimerView, setMode, toggle, reset, skipToBreak, loadTopics } from '../timer.js';
import { createWheel, HOUR_VALUES, MINUTE_VALUES } from '../wheels.js';

const NS = 'http://www.w3.org/2000/svg';
const RADIUS = 76;

function buildRing() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 176 176');

  const bg = document.createElementNS(NS, 'circle');
  bg.setAttribute('class', 'ring-bg');
  for (const attr of ['cx', 'cy']) bg.setAttribute(attr, '88');
  bg.setAttribute('r', String(RADIUS));

  const fill = document.createElementNS(NS, 'circle');
  fill.setAttribute('class', 'ring-fill');
  for (const attr of ['cx', 'cy']) fill.setAttribute(attr, '88');
  fill.setAttribute('r', String(RADIUS));
  fill.style.strokeDasharray = String(2 * Math.PI * RADIUS);
  fill.style.strokeDashoffset = '0';

  svg.append(bg, fill);
  return { svg, fill };
}

export const timerSection = {
  /**
   * The wheels are the single source of truth for a countdown length while
   * the timer is stopped, and read-only once it is running.
   */
  mount(host) {
    const { svg, fill } = buildRing();

    const hourWheel = createWheel({
      values: HOUR_VALUES,
      index: 0,
      label: 'HOURS',
      name: 'Hours',
      format: (v) => String(v).padStart(2, '0'),
      onChange: preview,
    });
    const minuteWheel = createWheel({
      values: MINUTE_VALUES,
      index: 5,          // 25 minutes
      label: 'MINUTES',
      name: 'Minutes',
      format: (v) => String(v).padStart(2, '0'),
      onChange: preview,
    });

    // Moving a wheel while stopped updates the ring straight away, so the
    // duration is visible before anything is started.
    function preview() {
      if (timer.running) return;
      let mins = (hourWheel.value * 60) + minuteWheel.value;
      if (mins <= 0) {
        // 0h 00m is not a session. Rather than leave the ring showing a stale
        // length, nudge the minute wheel to the shortest real one.
        minuteWheel.setValue(MINUTE_VALUES[1], { silent: true });
        mins = minuteWheel.value;
      }
      timer.target = mins;
      timer.remaining = mins;
      timer.elapsed = 0;
      ringTime.textContent = clock(mins);
    }

    const ringTime = el('div', { id: 'ring-time', class: 'ring-time', text: '25:00' });
    const ringSub = el('div', { id: 'ring-sub', class: 'ring-sub', text: 'STUDY' });
    const playBtn = el('button', {
      id: 'play-btn', class: 'play-ctrl', title: 'Start or pause', text: '▶', onclick: () => toggle(),
    });

    const autoBreakBtn = el('button', {
      class: 'ctrl',
      title: 'Toggle whether a break starts automatically',
      text: '🔁',
      style: { fontSize: '13px' },
    });
    autoBreakBtn.addEventListener('click', () => {
      const next = !settings().autoStartBreak;
      updateSetting('autoStartBreak', next)
        .then(() => {
          autoBreakBtn.style.color = next ? 'var(--accent3)' : '';
          toast(`Auto-start break ${next ? 'on' : 'off'}`);
        })
        .catch(() => toast('Could not save that setting', 3000));
    });
    autoBreakBtn.style.color = settings().autoStartBreak ? 'var(--accent3)' : '';

    const modeTabs = el('div', { class: 'mode-tabs' }, [
      el('button', { class: 'mode-tab active', 'data-mode': 'pomodoro', text: 'POMODORO', onclick: () => setMode('pomodoro') }),
      el('button', { class: 'mode-tab', 'data-mode': 'countdown', text: 'COUNTDOWN', onclick: () => setMode('countdown') }),
      el('button', { class: 'mode-tab', 'data-mode': 'stopwatch', text: 'STOPWATCH', onclick: () => setMode('stopwatch') }),
    ]);

    const quickRow = el('div', { class: 'quick-row' });
    const wheelSet = el('div', { class: 'wheel-set' }, [
      hourWheel.element,
      el('div', { class: 'wheel-sep', text: ':' }),
      minuteWheel.element,
    ]);
    const wheelLock = el('div', { class: 'wheel-lock', hidden: true }, [
      el('span', { text: '🔒' }),
      el('span', { text: 'Stop the timer to change the duration' }),
    ]);
    const topicRow = el('div', { class: 'topic-row' });
    const dots = el('div', { class: 'pom-dots' },
      Array.from({ length: 4 }, () => el('div', { class: 'pom-dot' })));

    const card = el('div', { id: 'timer-card' }, [
      modeTabs,
      quickRow,
      wheelSet,
      wheelLock,
      el('div', { class: 'ring-wrap' }, [
        svg,
        el('div', { class: 'ring-inner' }, [ringTime, ringSub]),
      ]),
      dots,
      el('div', { class: 'controls' }, [
        el('button', { class: 'ctrl', title: 'Reset', text: '↺', onclick: () => reset() }),
        el('button', { class: 'ctrl', title: 'Skip to the break', text: '⏭', onclick: () => skipToBreak() }),
        playBtn,
        autoBreakBtn,
      ]),
      el('div', { class: 'sect-hd', style: { marginTop: '18px' }, text: 'FOCUS TOPIC' }),
      topicRow,
      el('div', { class: 'timer-note' }, [
        el('span', { text: 'Drag or scroll the wheels to set any duration. Pick a tag to file the session under — it also sets the avatar pose, and never changes the length.' }),
      ]),
    ]);

    host.append(el('div', { class: 'timer-wrap' }, [card]));

    // Re-runnable so switching tabs and back resyncs the widgets.
    mountTimerView({
      modeTabs, wheelSet, quickRow, wheelLock, topicRow,
      ringFill: fill, ringTime, ringSub, dots, playBtn, card,
      avaTag: document.getElementById('ava-tag'),
      hourWheel, minuteWheel,
    });

    // The focus topics are the user's tags, so they have to come from the
    // server. mountTimerView has already painted with whatever was cached;
    // this redraws the row once the real list arrives.
    loadTopics();
  },
};
