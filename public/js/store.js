import { api } from './api.js';

/**
 * The client-side mirror of the user's account.
 *
 * Deliberately thin: all study arithmetic lives on the server in
 * server/metrics.js, so this only caches what the UI needs to avoid a round
 * trip on every render (avatar, settings, the current topic).
 */

const listeners = new Set();

export const store = {
  user: null,
  /** Non-fatal errors collected from the last API call, shown once. */
  lastError: null,
  presenceState: 'online',
  spotify: {
    configured: false,
    connected: false,
    player: null,
    state: null,
    ready: false,
  },
  sounds: { current: null, intensity: 0.7, master: 0.6 },
  view: { month: null, chartMode: 'daily', selectedDay: null },
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try {
      fn(store);
    } catch (err) {
      console.error('[store] listener failed', err);
    }
  }
}

export const isSignedIn = () => Boolean(store.user);

export function setUser(user) {
  store.user = user;
  emit();
}

export function patchUser(patch) {
  if (!store.user) return;
  store.user = { ...store.user, ...patch };
  emit();
}

/** Persists avatar/settings changes and refreshes the cached user. */
export async function saveProfile(patch) {
  const { user } = await api.put('/api/me', patch);
  setUser(user);
  return user;
}

export const avatar = () => store.user?.avatar || {};
export const settings = () => store.user?.settings || {};

export async function updateSetting(key, value) {
  return saveProfile({ settings: { ...settings(), [key]: value } });
}

// ── study data cache ─────────────────────────────────────────────────────
//
// The Analytics pane is the only consumer, and it refetches the whole month
// overview on every mutation, so a one-entry cache is enough.

export const studyCache = { overview: null, dirty: false };

export function invalidateStudy() {
  studyCache.dirty = true;
}

export async function fetchOverview({ month, mode, date } = {}) {
  const params = new URLSearchParams();
  if (month) params.set('month', month);
  if (mode) params.set('mode', mode);
  // `date` moves the `today` block to another day in the same month, which is
  // how the Analytics date picker moves one box without refetching the week.
  if (date) params.set('date', date);
  const overview = await api.get(`/api/study/overview?${params}`);
  // Only a whole-overview read may replace the cached copy: a single-day read
  // answers the same shape but describes another day, and caching it would
  // make the footer stats show the wrong date.
  if (!date) {
    studyCache.overview = overview;
    studyCache.dirty = false;
  }
  return overview;
}

/**
 * The extra Analytics blocks: consistency heatmap, cumulative line and the
 * per-tag split. Cached beside the overview because they are invalidated by
 * exactly the same mutations — logging time, finishing a pomodoro, editing an
 * entry in the Logs feed.
 */
const insightsCache = { key: null, value: null };

export async function fetchInsights({ month } = {}) {
  const params = new URLSearchParams();
  if (month) params.set('month', month);
  const key = params.toString();
  if (!studyCache.dirty && insightsCache.key === key && insightsCache.value) {
    return insightsCache.value;
  }
  const insights = await api.get(`/api/study/insights?${params}`);
  insightsCache.key = key;
  insightsCache.value = insights;
  return insights;
}
