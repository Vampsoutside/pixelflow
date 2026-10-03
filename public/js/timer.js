import { api } from './api.js';
import { store, settings, updateSetting, invalidateStudy, emit } from './store.js';
import { clock, toast, clamp } from './ui.js';
import { createWheel, HOUR_VALUES, MINUTE_VALUES, QUICK_PRESETS } from './wheels.js';
import { findPose } from './avatar.js';

const CIRC = 2 * Math.PI * 76;   // ring radius in the SVG viewBox

/**
 * A break is not a tag. It is the one topic that is never study time, so it is
 * kept out of the tag list and rendered as its own chip.
 */
export const BREAK = { id: null, name: 'Break', color: '#6bffda' };

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
  // Focus topics are the user's own tags, loaded from /api/tags. They used to
  // be a hardcoded list mutated in memory, so anything added was gone on the
  // next reload and nothing a session recorded could be analysed by subject.
  topics: [],
  topic: BREAK,
};

let ui = {};

// ── tags ─────────────────────────────────────────────────────────────────

/** Loads the user's tags and picks the active topic. Safe to call repeatedly. */
export async function loadTopics() {
  try {
    const { tags } = await api.get('/api/tags');
    timer.topics = tags;
  } catch {
    // Offline or an older server: the timer still runs, it just cannot file a
    // session under a tag.
    timer.topics = timer.topics || [];
  }
  syncTopicFromSettings();
  renderTopics();
}

/** Resolves the saved tag id, falling back to the first tag or a plain break. */
function syncTopicFromSettings() {
  const id = settings().activeTagId;
  timer.topic = timer.topics.find((t) => t.id === id) || timer.topics[0] || BREAK;
}

export function renderTopics() {
  if (!ui.topicRow) return;
  ui.topicRow.innerHTML = '';

  // Break first, because it is not a tag and cannot be deleted along with one.
  for (const topic of [BREAK, ...timer.topics]) {
    const active = topic === BREAK
      ? timer.kind === 'break'
      : timer.kind === 'focus' && topic.id === timer.topic?.id;
    const chip = document.createElement('button');
    chip.className = `topic-chip${active ? ' active' : ''}`;
    chip.style.background = active ? topic.color : '';
    chip.style.borderColor = active ? topic.color : '';
    // textContent, not innerHTML: the tag name is the user's own, stored and
    // returned verbatim, so `<img src=x onerror=...>` round-tripped through
    // POST /api/tags and executed here. Self-inflicted only, but a tag is
    // shared data the day someone else can see it, so it is not worth the risk.
    const label = document.createElement('span');
    label.textContent = topic.name;
    chip.append(label);
    chip.addEventListener('click', () => selectTopic(topic));
    ui.topicRow.append(chip);
  }

  const add = document.createElement('button');
  add.className = 'topic-chip add';
  add.textContent = '+ tag';
  add.title = 'Create a tag to file sessions under';
  add.addEventListener('click', () => {
    // Tags are owned by the Tasks panel, which creates them properly and keeps
    // them in the database. A prompt here would create something that vanishes
    // on reload — exactly the bug this replaced.
    document.querySelector('[data-section="tasks"]')?.click();
    toast('Create the tag in the Tasks panel, then come back');
  });
  ui.topicRow.append(add);
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

/**
 * Makes a tag (or Break) the active focus topic.
 *
 * Break is the one topic that is not a tag, so selecting it flips the session
 * kind instead of saving an id. Everything else persists its tag id, which is
 * what a finished session is filed under.
 */
function selectTopic(topic) {
  timer.kind = topic === BREAK ? 'break' : 'focus';
  if (topic !== BREAK) timer.topic = topic;
  renderTopics();
  paint();
  if (topic !== BREAK) updateSetting('activeTagId', topic.id).catch(() => {});
}

// ── painting ─────────────────────────────────────────────────────────────

function paint() {
  if (!ui.ringTime) return;

  const isStopwatch = timer.mode === 'stopwatch';
  const shown = isStopwatch ? timer.elapsed : timer.remaining;
  ui.ringTime.textContent = clock(shown);

  const label = timer.isBreak ? (timer.mode === 'pomodoro' ? 'BREAK' : 'REST') : (timer.topic?.name || 'Focus').toUpperCase();
  ui.ringSub.textContent = label;

  const color = timer.isBreak ? BREAK.color : (timer.topic?.color || 'var(--accent)');
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
  const topic = timer.isBreak ? 'Break' : (timer.topic?.name || '');

  try {
    const result = await api.post('/api/study/sessions', {
      focus_seconds: focusSeconds,
      topic,
      kind,
      // A break files no study time, so it sends no tag.
      tagId: kind === 'focus' ? timer.topicId : null,
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
