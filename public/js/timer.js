import { api } from './api.js';
import { store, settings, updateSetting, invalidateStudy, emit } from './store.js';
import { clock, toast, clamp } from './ui.js';
import { createWheel, HOUR_VALUES, MINUTE_VALUES, QUICK_PRESETS } from './wheels.js';
import { findPose } from './avatar.js';

const CIRC = 2 * Math.PI * 76;   // ring radius in the SVG viewBox
const DEFAULT_TOPICS = ['Study', 'Work', 'Assignment', 'Break', 'Custom'];
const TOPIC_COLORS = ['#7c6fff', '#ff6b9d', '#6bffda', '#ffb347', '#44aaff', '#aaffaa', '#ffaaff'];

/**
 * The timer.
 *
 * Modes decide only what *kind* of clock runs — never a preset length:
 *   pomodoro / countdown  count down from the wheels (pomodoro pins the
 *                         focus length to settings.focusMins)
 *   stopwatch             counts up, wheels hidden
 */
export const timer = {
  mode: 'pomodoro',
  kind: 'focus',            // focus | break
  running: false,
  remaining: 25 * 60,
  elapsed: 0,
  target: 25 * 60,
  interval: null,
  handle: null,             // the server-side timer_session row
  pomodoros: 0,
  topics: [...DEFAULT_TOPICS],
  topic: 'Study',

  // ── derived ────────────────────────────────────────────────────────────

  get durationMinutes() {
    return Math.max(1, Math.round(this.target / 60));
  },
  get isBreak() { return this.kind === 'break'; },
};

let ui = {};

// ── topic colours ────────────────────────────────────────────────────────

function topicColor(name) {
  const i = Math.max(0, timer.topics.indexOf(name));
  return TOPIC_COLORS[i % TOPIC_COLORS.length];
}

// ── view wiring (called by the timer section renderer) ───────────────────

export function mountTimerView(refs) {
  ui = refs;
  timer.target = Math.max(5, settings().focusMins || 25) * 60;
  timer.remaining = timer.target;
  timer.kind = 'focus';
  syncTopicFromSettings();
  renderModeTabs();
  renderTopics();
  syncWheels();
  lockWheels(false);
  paint();
}

/**
 * The wheels are the single source of truth for the countdown length while
 * stopped, and read-only while running so a live session cannot be changed
 * underneath the person doing it.
 */
function syncWheels() {
  if (!ui.hourWheel || !ui.minuteWheel) return;
  const mins = timer.durationMinutes;
  // Round minutes down to the nearest 5 so the wheel always has a cell to sit on.
  const minuteIndex = clamp(Math.round((mins % 60) / 5), 0, MINUTE_VALUES.length - 1);
  ui.hourWheel.setValue(clamp(Math.floor(mins / 60), 0, 24), { silent: true });
  ui.minuteWheel.setValue(MINUTE_VALUES[minuteIndex], { silent: true });
  renderQuickChips(mins);
}

function lockWheels(locked) {
  ui.hourWheel?.setDisabled(locked);
  ui.minuteWheel?.setDisabled(locked);
  ui.wheelLock?.toggleAttribute('hidden', !locked);
}

function renderModeTabs() {
  ui.modeTabs?.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === timer.mode);
  });
  // The stopwatch has no duration to set, so the wheels step out of the way.
  const showWheels = timer.mode !== 'stopwatch';
  ui.wheelSet?.toggleAttribute('hidden', !showWheels);
  ui.quickRow?.toggleAttribute('hidden', !showWheels);
  renderQuickChips(timer.durationMinutes);
}

function renderQuickChips(active) {
  if (!ui.quickRow) return;
  ui.quickRow.innerHTML = '';
  for (const preset of QUICK_PRESETS) {
    const btn = document.createElement('button');
    btn.className = `quick-chip${active === preset ? ' active' : ''}`;
    btn.textContent = `${preset}m`;
    btn.disabled = timer.running;
    btn.title = `Set ${preset} minutes`;
    btn.addEventListener('click', () => {
      stop();
      timer.target = preset * 60;
      timer.remaining = preset * 60;
      timer.elapsed = 0;
      syncWheels();
      paint();
    });
    ui.quickRow.append(btn);
  }
}

function syncTopicFromSettings() {
  const active = settings().activeTopic;
  if (active && timer.topics.includes(active)) timer.topic = active;
  else timer.topic = timer.topics[0];
}

export function renderTopics() {
  if (!ui.topicRow) return;
  ui.topicRow.innerHTML = '';
  for (const name of timer.topics) {
    const color = topicColor(name);
    const chip = document.createElement('button');
    chip.className = `topic-chip${name === timer.topic ? ' active' : ''}`;
    chip.style.background = name === timer.topic ? color : '';
    chip.style.borderColor = name === timer.topic ? color : '';
    chip.innerHTML = `<span>${name}</span>`;
    chip.addEventListener('click', () => selectTopic(name));

    if (timer.topics.length > 1) {
      const x = document.createElement('span');
      x.className = 'tc-x';
      x.textContent = '×';
      x.title = `Remove “${name}”`;
      x.addEventListener('click', (event) => {
        event.stopPropagation();
        removeTopic(name);
      });
      chip.append(x);
    }
    ui.topicRow.append(chip);
  }

  const add = document.createElement('button');
  add.className = 'topic-chip add';
  add.textContent = '+ topic';
  add.addEventListener('click', addTopic);
  ui.topicRow.append(add);
}

function selectTopic(name) {
  timer.topic = name;
  timer.kind = name === 'Break' ? 'break' : 'focus';
  renderTopics();
  paint();
  updateSetting('activeTopic', name).catch(() => {});
}

async function addTopic() {
  const name = window.prompt('New focus topic (this is the label the session logs under)');
  const trimmed = String(name || '').trim().slice(0, 24);
  if (!trimmed) return;
  if (timer.topics.includes(trimmed)) {
    selectTopic(trimmed);
    return;
  }
  timer.topics.push(trimmed);
  renderTopics();
  selectTopic(trimmed);
}

function removeTopic(name) {
  timer.topics = timer.topics.filter((t) => t !== name);
  if (timer.topic === name) {
    timer.topic = timer.topics[0];
    updateSetting('activeTopic', timer.topic).catch(() => {});
  }
  renderTopics();
  paint();
}

// ── painting ─────────────────────────────────────────────────────────────

function paint() {
  if (!ui.ringTime) return;

  const isStopwatch = timer.mode === 'stopwatch';
  const shown = isStopwatch ? timer.elapsed : timer.remaining;
  ui.ringTime.textContent = clock(shown);

  const label = timer.isBreak ? (timer.mode === 'pomodoro' ? 'BREAK' : 'REST') : timer.topic.toUpperCase();
  ui.ringSub.textContent = label;

  const color = timer.isBreak ? 'var(--accent3)' : topicColor(timer.topic);
  ui.ringFill.style.stroke = color;

  let ratio;
  if (isStopwatch) {
    // Stopwatch fills once per hour so the ring always means something.
    ratio = (timer.elapsed % 3600) / 3600;
  } else {
    ratio = timer.target > 0 ? 1 - timer.remaining / timer.target : 0;
  }
  ui.ringFill.style.strokeDashoffset = String(CIRC * (1 - clamp(ratio, 0, 1)));

  ui.dots?.querySelectorAll('.pom-dot').forEach((dot, i) => {
    const completed = timer.pomodoros % (settings().pomsBefore || 4);
    dot.className = `pom-dot${i < completed ? (timer.isBreak ? ' break-lit' : ' lit') : ''}`;
  });

  ui.playBtn.textContent = timer.running ? '❚❚' : '▶';
  ui.playBtn.classList.toggle('break', timer.isBreak);
  ui.card?.classList.toggle('running', timer.running);

  // The avatar swaps to the matching pose group and tag.
  const pose = findPose(timer.isBreak ? 'break' : 'focus',
    timer.isBreak ? store.user?.avatar?.breakPose : store.user?.avatar?.focusPose);
  ui.avaTag && (ui.avaTag.textContent = timer.running
    ? (timer.isBreak ? 'ON BREAK ☕' : 'STUDYING ✦')
    : 'READY');
  emit();

  if (!timer.running) syncWheels();
  renderQuickChips(timer.durationMinutes);
}

// ── run control ──────────────────────────────────────────────────────────

export function setMode(mode) {
  if (mode === timer.mode) return;
  stop();
  timer.mode = mode;
  timer.elapsed = 0;

  if (mode === 'stopwatch') {
    timer.remaining = 0;
    timer.target = 60 * 60;
  } else {
    // Both count-down modes start from the configured focus length; the wheels
    // then adjust it for this session.
    timer.target = Math.max(5, settings().focusMins || 25) * 60;
    timer.remaining = timer.target;
  }
  renderModeTabs();
  // Re-seat the wheels on the new length, otherwise the ring and the wheels
  // disagree about the current session.
  if (mode !== 'stopwatch') syncWheels();
  lockWheels(timer.running);
  paint();
}

/**
 * Re-points a stopped timer at the configured focus length.
 *
 * The wheels are authoritative for a session once someone has dialled one in,
 * so this is only called when the setting itself is what just changed.
 */
export function applyFocusLength() {
  if (timer.running) return;
  const mins = Math.max(5, settings().focusMins || 25);
  timer.target = mins * 60;
  timer.remaining = timer.target;
  timer.elapsed = 0;
  syncWheels();
  paint();
}

export function toggle() {
  if (timer.running) stop();
  else start();
}

export function start() {
  if (timer.mode === 'stopwatch') {
    // A stopwatch only ever accumulates, so a second press is a reset first.
    if (timer.elapsed > 0) timer.elapsed = 0;
  } else if (timer.mode !== 'pomodoro') {
    // Countdown: read the wheels as the target right before running.
    timer.target = Math.max(60, (ui.hourWheel.value * 60) + ui.minuteWheel.value);
    timer.remaining = timer.target;
    timer.elapsed = 0;
  } else {
    timer.remaining = timer.target;
    timer.elapsed = 0;
  }

  timer.running = true;
  lockWheels(true);
  timer.interval = setInterval(tick, 1000);

  api.post('/api/logs', {
    kind: 'timer',
    message: `Started a ${timer.durationMinutes}-minute ${timer.isBreak ? 'break' : timer.topic.toLowerCase()} session`,
  }).catch(() => {});

  paint();
}

export function stop() {
  timer.running = false;
  clearInterval(timer.interval);
  timer.interval = null;
  lockWheels(false);
  paint();
}

export function reset() {
  stop();
  if (timer.mode === 'stopwatch') timer.elapsed = 0;
  else {
    timer.remaining = timer.target;
    timer.elapsed = 0;
  }
  paint();
  toast('Timer reset');
}

/** Dev/testing hook so the seconds display can be driven directly. */
export function setRemaining(seconds) {
  timer.remaining = Math.max(0, seconds);
  paint();
}

function tick() {
  if (timer.mode === 'stopwatch') {
    timer.elapsed += 1;
  } else if (timer.remaining > 0) {
    timer.remaining -= 1;
    timer.elapsed += 1;
  } else {
    void complete();
    return;
  }
  paint();
}

// ── session completion ───────────────────────────────────────────────────

async function complete() {
  stop();

  const kind = timer.isBreak ? 'break' : 'focus';
  const focusSeconds = timer.elapsed;
  const topic = timer.isBreak ? 'Break' : timer.topic;

  try {
    const result = await api.post('/api/study/sessions', {
      focus_seconds: focusSeconds,
      topic,
      kind,
    });
    if (kind === 'focus') {
      timer.pomodoros += 1;
      toast(`Session complete — ${result.loggedMinutes > 0
        ? `${Math.round(result.loggedMinutes)}m added to today`
        : '+50 XP'}`);
    } else {
      toast('Break over — back to it');
    }
  } catch {
    // Never lose the completion just because the network blipped.
    if (kind === 'focus') timer.pomodoros += 1;
    toast('Session complete (saved locally)');
  }

  invalidateStudy();
  window.dispatchEvent(new CustomEvent('pixelflow:stats'));

  if (kind === 'break') {
    // Back to a focus session at the pomodoro length.
    timer.kind = 'focus';
    timer.target = Math.max(5, settings().focusMins || 25) * 60;
    timer.remaining = timer.target;
    timer.elapsed = 0;
    paint();
    return;
  }

  // Focus just finished. Chain into a break only if the user wants that.
  if (timer.mode === 'pomodoro') {
    const isLong = timer.pomodoros % (settings().pomsBefore || 4) === 0;
    const breakMins = isLong ? (settings().longBreak || 15) : (settings().shortBreak || 5);
    timer.kind = 'break';
    timer.target = breakMins * 60;
    timer.remaining = timer.target;
    timer.elapsed = 0;
    paint();

    if (settings().autoStartBreak) {
      toast(isLong ? '☕ Long break — you earned it' : '⏳ Short break');
      start();
    } else {
      toast(isLong ? '☕ Long break ready — press play' : '⏳ Short break ready — press play');
    }
  }
}

export function skipToBreak() {
  stop();
  timer.kind = 'break';
  timer.target = Math.max(60, (settings().shortBreak || 5) * 60);
  timer.remaining = timer.target;
  timer.elapsed = 0;
  paint();
}

export const currentPoseId = () => (timer.isBreak
  ? store.user?.avatar?.breakPose
  : store.user?.avatar?.focusPose);

export { createWheel, HOUR_VALUES, MINUTE_VALUES, QUICK_PRESETS };
