import { api, ApiError } from './api.js';
import { consentDecided, openConsentBanner } from './consent.js';
import { reportOAuthReturn } from './gcal.js';
import { store, setUser, subscribe, fetchOverview } from './store.js';
import { el, $, $$, toast, minutesShort, formatRelative } from './ui.js';
import { drawPose } from './avatar.js';
import { timer } from './timer.js';

import { timerSection } from './views/timer.js';
import { analyticsSection, analyticsSidePanel } from './views/analytics.js';
import { tasksSection, tasksSidePanel } from './views/tasks.js';
import { friendsSection, friendsSidePanel, startPresence } from './views/friends.js';
import { mediaSection, mediaSidePanel } from './views/media.js';
import { avatarSection, avatarSidePanel } from './views/avatar.js';
import { calendarSection, calendarSidePanel } from './views/calendar.js';
import { logsSection, logsSidePanel } from './views/logs.js';
import { settingsSection, settingsSidePanel } from './views/settings.js';

const SECTIONS = {
  timer: { view: timerSection, title: 'TIMER', side: null, tabs: () => [] },
  tasks: { view: tasksSection, title: 'TASKS', side: tasksSidePanel, tabs: () => [] },
  friends: { view: friendsSection, title: 'FRIENDS', side: friendsSidePanel, tabs: () => [] },
  media: { view: mediaSection, title: 'MEDIA', side: mediaSidePanel, tabs: () => [] },
  avatar: { view: avatarSection, title: 'AVATAR', side: avatarSidePanel, tabs: () => [] },
  calendar: { view: calendarSection, title: 'CALENDAR', side: calendarSidePanel, tabs: () => [] },
  logs: { view: logsSection, title: 'LOGS', side: logsSidePanel, tabs: () => [] },
  analytics: { view: analyticsSection, title: 'ANALYTICS', side: analyticsSidePanel, tabs: () => [] },
  settings: { view: settingsSection, title: 'SETTINGS', side: settingsSidePanel, tabs: () => [] },
};

let current = 'timer';
let onStats = () => {};
/** Bumped per navigation so a slow mount cannot paint over a newer one. */
let navToken = 0;

// ═══════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════

// ── cookie consent ────────────────────────────────────────────────────

/**
 * Shows the consent banner on a first visit.
 *
 * It does not gate the app: the session cookie is set by the server the moment
 * the page loads, and saying otherwise would be a lie. What the visitor decides
 * here is everything outside that essential set. Mounted before the session
 * check so it appears whether or not anybody is signed in.
 */
function wireConsent() {
  if (consentDecided()) return;
  openConsentBanner();
}

async function boot() {
  initParticles();
  // Before anything renders: strips the ?gcal= marker Google sent us back with
  // and says what happened, so the message is the first thing seen rather than
  // arriving after the calendar has painted.
  reportOAuthReturn();
  wireSidebar();
  wireAvatarChrome();

  // Read before the session check: a successful provider callback signs the
  // person in, so the interesting case is the one where a user *is* found.
  wireConsent();
  await reportAuthResult();

  const { user } = await api.get('/api/auth/session').catch(() => ({ user: null }));
  if (!user) {
    $('#auth-overlay').hidden = false;
    wireAuth();
    loadProviders();
    return;
  }
  setUser(user);
  await enterApp();
}

async function enterApp() {
  $('#auth-overlay').hidden = true;
  $('#shell').hidden = false;
  wireRightPanel();
  startPresence();
  // Honour the deep link. navigate() writes the current section into the hash,
  // so a reload — or a bookmark, or arriving back from a provider callback —
  // has to come back to the section it was left on rather than always resetting
  // to the timer. An unknown or absent hash falls through to the timer.
  const wanted = location.hash.replace('#', '');
  await navigate(SECTIONS[wanted] ? wanted : 'timer');
  await refreshStats();
  setInterval(refreshStats, 60_000);

  // Any section that finishes work can ask for the footer numbers to update.
  window.addEventListener('pixelflow:stats', refreshStats);
  // Redraw the floating avatar whenever the timer changes what it is doing.
  subscribe(() => drawFloatingAvatar());
}

// ── auth overlay ──────────────────────────────────────────────────────────

let authMode = 'login';

// Official marks, inlined so the sign-in screen needs no network request.
const PROVIDER_ICONS = {
  google: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>',
  microsoft: '<svg viewBox="0 0 18 18" aria-hidden="true"><path class="ms-yellow" d="M0 0h8.5v8.5H0z"/><path class="ms-teal" d="M9.5 0H18v8.5H9.5z"/><path d="M0 9.5h8.5V18H0z"/><path class="ms-blue" d="M9.5 9.5H18V18H9.5z"/></svg>',
};

/**
 * Shows a provider button per provider the server actually has credentials
 * for, so an unconfigured provider never appears to work and then fail.
 */
async function loadProviders() {
  const wrap = $('#auth-providers');
  const list = $('#auth-provider-list');
  if (!wrap || !list) return;

  let providers = [];
  try {
    ({ providers = [] } = await api.get('/api/auth/providers'));
  } catch {
    return; // offline or older server: keep the password form only
  }

  list.innerHTML = '';
  for (const { name, label } of providers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'auth-provider-btn';
    btn.dataset.provider = name;
    btn.innerHTML = `${PROVIDER_ICONS[name] || ''}<span>Continue with ${label}</span>`;
    // A top-level navigation, so the provider owns the whole page and our
    // CSRF cookie is irrelevant — this is why it is a link, not a fetch.
    btn.addEventListener('click', () => {
      window.location.assign(`/api/auth/${name}/login`);
    });
    list.appendChild(btn);
  }
  wrap.hidden = providers.length === 0;
}

/** Reads ?auth=… left by the provider callback and reports the outcome. */
async function reportAuthResult() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('auth');
  if (!code) return;

  const provider = params.get('provider');
  const names = { google: 'Google', microsoft: 'Microsoft' };
  const messages = {
    welcome: `Welcome! Your ${names[provider] || 'provider'} account is ready.`,
    ok: 'Signed in.',
    linked: `${names[provider] || 'Provider'} account connected.`,
    'already-linked': 'That account is already connected.',
    denied: 'Sign-in cancelled.',
    'bad-state': 'That sign-in attempt expired. Please try again.',
    unconfigured: 'That sign-in method is not configured on this server.',
    'unknown-provider': 'Unknown sign-in method.',
    failed: 'Sign-in failed. Please try again.',
  };
  if (messages[code]) toast(messages[code], 4200);

  // Leave the marker behind so a reload does not replay the message.
  const clean = new URL(window.location.href);
  clean.searchParams.delete('auth');
  clean.searchParams.delete('provider');
  window.history.replaceState({}, '', clean);
}

/** Paints the form for the current mode. */
function applyMode() {
  const signup = authMode === 'signup';
  const emailField = $('#a-email');
  $('#auth-submit').textContent = signup ? 'Create account' : 'Sign In';
  $('#auth-toggle').textContent = signup ? 'Sign in instead' : 'Create an account';
  $('#auth-mode-hint').textContent = signup ? 'Already have one?' : 'New here?';
  $('#auth-tab-login').classList.toggle('active', !signup);
  $('#auth-tab-signup').classList.toggle('active', signup);
  $('#auth-tab-login').setAttribute('aria-selected', String(!signup));
  $('#auth-tab-signup').setAttribute('aria-selected', String(signup));
  // Email is only collected when creating an account.
  emailField.required = signup;
  emailField.toggleAttribute('hidden', !signup);
  // The hint line is now redundant — the tabs above say the same thing.
  $('#auth-switch').hidden = true;
}

function setMode(mode) {
  authMode = mode;
  $('#auth-error').hidden = true;
  applyMode();
}

/**
 * Adds a "no account? create one" escape hatch under a failed sign-in,
 * carrying the username across so it is not retyped.
 */
function offerSignup() {
  if ($('#auth-recover')) return;
  const link = document.createElement('a');
  link.id = 'auth-recover';
  link.className = 'auth-recover';
  link.textContent = 'No account yet? Create one';
  link.addEventListener('click', () => {
    const username = $('#a-user').value.trim();
    setMode('signup');
    if (username) $('#a-user').value = username;
    $('#a-pass').value = '';
    $('#a-email').focus();
  });
  $('#auth-error').after(link);
}

function wireAuth() {
  const form = $('#auth-form');
  const error = $('#auth-error');
  const submit = $('#auth-submit');
  applyMode();

  // Both tabs are always visible, so nobody has to guess which mode they are
  // in or discover that they needed to switch.
  $('#auth-tab-login').addEventListener('click', () => setMode('login'));
  $('#auth-tab-signup').addEventListener('click', () => setMode('signup'));
  $('#auth-toggle').addEventListener('click', () =>
    setMode(authMode === 'login' ? 'signup' : 'login'));

  $('#auth-guest').addEventListener('click', async () => {
    error.hidden = true;
    const btn = $('#auth-guest');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const { user } = await api.post('/api/auth/guest', {});
      setUser(user);
      toast('You are browsing as a guest.');
      await enterApp();
    } catch (err) {
      error.textContent = err.message || 'Could not start a guest session.';
      error.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Continue as guest';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = authMode === 'signup' ? 'Creating…' : 'Signing in…';
    try {
      const payload = {
        username: $('#a-user').value.trim(),
        password: $('#a-pass').value,
      };
      if (authMode === 'signup') payload.email = $('#a-email').value.trim();
      const { user } = await api.post(`/api/auth/${authMode}`, payload);
      setUser(user);
      toast(`Welcome${user.username ? `, ${user.username}` : ''}!`);
    } catch (err) {
      error.textContent = err.message || 'Could not sign in.';
      error.hidden = false;
      submit.disabled = false;
      applyMode();
      // A failed sign-in is exactly when someone who has no account yet gets
      // stuck, so offer the way out rather than making them find it.
      if (authMode === 'login') offerSignup();
      return;
    }
    // Rendering failures after a successful sign-in are a different problem
    // from bad credentials, so they get their own message.
    try {
      await enterApp();
    } catch (err) {
      console.error('[pixelflow] failed to open the app', err);
      error.textContent = `Signed in, but the app failed to start: ${err.message}`;
      error.hidden = false;
      $('#auth-overlay').hidden = false;
      $('#shell').hidden = true;
    } finally {
      submit.disabled = false;
      applyMode();
    }
  });
}

// ── navigation ───────────────────────────────────────────────────────────

function wireSidebar() {
  $$('#sidebar .sb-btn[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.section));
  });
  $('#sb-account')?.addEventListener('click', () => {
    // This used to pop the sign-in overlay, which read as "you have been
    // logged out" — it is an account link, so go to the account section.
    navigate('settings');
  });
}

// ── collapsible right panel ──────────────────────────────────────────────

const RP_KEY = 'pixelflow:rp-collapsed';
let rpWired = false;

function wireRightPanel() {
  if (rpWired) return;
  rpWired = true;
  const collapse = $('#rp-collapse');
  const restore = $('#rp-restore');

  const apply = (collapsed) => {
    // On <body>, not on #shell. The Spotify dock and the stats bar are
    // siblings of #shell, so a class set on it could never reach them — which
    // is why collapsing the panel used to leave both inset by the width of a
    // panel that was no longer there. Setting the custom property on <body>
    // cascades into the #shell grid and the two fixed bars alike.
    document.body.classList.toggle('rp-collapsed', collapsed);
    restore.hidden = !collapsed;
    collapse.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem(RP_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
  };

  collapse.addEventListener('click', () => apply(true));
  restore.addEventListener('click', () => apply(false));

  // Remembered, so the panel does not reappear on every reload.
  let startCollapsed = false;
  try { startCollapsed = localStorage.getItem(RP_KEY) === '1'; } catch { /* ignore */ }
  apply(startCollapsed);
}

async function navigate(section) {
  if (!SECTIONS[section]) return;

  // Tear the previous section down before the next one mounts. Several views
  // hold live resources in unmount() — Friends polls /api/friends every 10s,
  // Avatar animates on a 120ms ticker, Tasks drops its panel reference — and
  // without this they outlived the tab. The Friends poll then fired into
  // whatever host the *next* section had mounted, replacing the Settings
  // sidebar with "FIND PEOPLE", which is where the intermittent tracebacks
  // and the phantom jumps came from.
  const previous = SECTIONS[current];
  if (previous && previous !== SECTIONS[section]) {
    try { previous.view.unmount?.(); } catch { /* a broken teardown must not block navigation */ }
  }

  // A slow mount can still be in flight when the next click lands. Whichever
  // finishes last wins the DOM, so stamp the section we are mounting and let
  // the losers bail rather than paint over a newer view.
  const token = ++navToken;
  current = section;

  $$('#sidebar .sb-btn[data-section]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });

  const entry = SECTIONS[section];
  $('#rp-title').textContent = entry.title;

  const host = $('#section-host');
  host.hidden = false;
  host.innerHTML = '';

  const panelBody = $('#rp-body');
  const tabs = $('#rp-tabs');
  tabs.innerHTML = '';

  // The right panel is secondary on wide screens; hide it when a section has
  // nothing to put there, and collapse it entirely on narrow ones anyway.
  panelBody.innerHTML = '';
  panelBody.hidden = !entry.side;
  if (entry.side) entry.side(panelBody);

  try {
    await entry.view.mount(host, {
      panel: entry.side ? panelBody : null,
      onChange: () => { refreshStats(); },
    });
  } catch (err) {
    // A newer navigation already happened while this one was loading; its
    // error is stale and must not overwrite the section now on screen.
    if (token !== navToken) return;
    host.append(el('div', { class: 'pane' }, [
      el('div', { class: 'empty', text: err.message || 'This section failed to load.' }),
      el('button', { class: 'btn block', text: 'Reload section', style: { marginTop: '12px' }, onclick: () => navigate(section) }),
    ]));
    console.error(`[pixelflow] ${section} failed to mount`, err);
    return;
  }

  // Reflect the section in the URL without pushing a history entry per tab.
  // `location.hash = section` added one, so three tab clicks left six entries
  // and the browser's Back button — or a swipe-back gesture on a phone —
  // walked back through the tab history and jumped to Friends for no visible
  // reason. replaceState keeps the deep link without the trap.
  history.replaceState({}, '', `#${section}`);
}

// ── floating avatar ──────────────────────────────────────────────────────

let avaFrame = 0;

function wireAvatarChrome() {
  const wrap = document.getElementById('ava-wrap');
  const canvas = document.getElementById('ava-canvas');
  const resize = document.getElementById('ava-resize');
  const minimize = document.getElementById('ava-minimize');
  const expand = document.getElementById('ava-expand');

  const setCollapsed = (collapsed) => {
    wrap.classList.toggle('min', collapsed);
    // The resize handler writes inline width/height; clear them so the CSS
    // collapsed size (#ava-wrap.min #ava-canvas) actually applies.
    if (collapsed) { canvas.style.width = ''; canvas.style.height = ''; }
  };

  // Clicking the minimise button shrinks the avatar to a tiny pixel square;
  // the expand button on its right restores it. State is purely local and
  // never touches the server, so it survives a session only as the default.
  minimize.addEventListener('click', () => {
    minimize.setAttribute('aria-pressed', 'true');
    expand.style.display = 'block';
    setCollapsed(true);
  });
  expand.addEventListener('click', () => {
    expand.style.display = 'none';
    minimize.setAttribute('aria-pressed', 'false');
    setCollapsed(false);
  });

  // Drag
  let dragging = false;
  let ox = 0;
  let oy = 0;
  wrap.addEventListener('mousedown', (event) => {
    if (event.target === resize) return;
    dragging = true;
    ox = event.clientX - wrap.offsetLeft;
    oy = event.clientY - wrap.offsetTop;
    wrap.style.transition = 'none';
  });
  document.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    wrap.style.left = `${event.clientX - ox}px`;
    wrap.style.top = `${event.clientY - oy}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // Resize
  let resizing = false;
  let startX = 0;
  let startW = 0;
  resize.addEventListener('mousedown', (event) => {
    resizing = true;
    startX = event.clientX;
    startW = canvas.offsetWidth;
    event.stopPropagation();
  });
  document.addEventListener('mousemove', (event) => {
    if (!resizing) return;
    const width = Math.max(50, Math.min(220, startW + (event.clientX - startX)));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${Math.round((width * 34) / 26)}px`;
  });
  document.addEventListener('mouseup', () => { resizing = false; });

  // Continuous idle animation, matching the prototype's cadence.
  setInterval(() => {
    avaFrame += 1;
    drawFloatingAvatar();
  }, 120);
}

function drawFloatingAvatar() {
  const canvas = document.getElementById('ava-canvas');
  const tag = document.getElementById('ava-tag');
  if (!canvas || !store.user) return;

  const avatar = store.user.avatar || {};
  const pose = timer.isBreak ? (avatar.breakPose || 'coffee') : (avatar.focusPose || 'desk');
  drawPose(canvas, avatar, pose, avaFrame);

  if (tag) {
    tag.textContent = timer.running
      ? (timer.isBreak ? 'ON BREAK ☕' : 'STUDYING ✦')
      : 'READY ✦';
  }
}

// ── footer stats ─────────────────────────────────────────────────────────

async function refreshStats() {
  if (!store.user) return;
  try {
    const overview = await fetchOverview({});
    const user = store.user;

    setText('s-today', overview.today.studiedText);
    setText('s-week', overview.week.studiedText);
    setText('s-level', `LVL ${user.level}`);

    // Streak counts consecutive days ending today (or yesterday).
    let streak = 0;
    const cursor = new Date();
    for (let i = 0; i < 400; i += 1) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      const day = overview.month.days && overview.chart.mode === 'daily'
        ? overview.chart.points.find((p) => p.key === key)
        : null;
      const studied = day ? day.value : null;
      if (studied === null || studied === 0) {
        // The month window only covers the visible month; stop when we run out.
        if (cursor.getMonth() !== overview.month.month) break;
        if (i > 0 && studied === 0) break;
        if (i === 0) { cursor.setDate(cursor.getDate() - 1); continue; }
        break;
      }
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    setText('s-streak', `${streak} day${streak === 1 ? '' : 's'}`);

    const levelProgress = (user.xp % 100) / 100;
    $('#xp-bar').style.width = `${levelProgress * 100}%`;
    setText('s-xp', `${user.xp % 100} / 100 XP toward LV ${user.level + 1}`);

    // Pomodoros come from the logs feed rather than a dedicated endpoint.
    $('#s-poms').textContent = String(store.pomodoros ?? '—');

    if (current === 'analytics') analyticsSidePanel($('#rp-body'));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    console.warn('[pixelflow] stats refresh failed', err.message);
  }
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

// ── background particles ─────────────────────────────────────────────────

function initParticles() {
  const canvas = document.getElementById('bg-particles');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener('resize', resize);

  const particles = Array.from({ length: 60 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    r: Math.random() * 1.5 + 0.3,
    vx: (Math.random() - 0.5) * 0.2,
    vy: (Math.random() - 0.5) * 0.2,
    alpha: Math.random() * 0.5 + 0.2,
  }));

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200,195,255,${p.alpha})`;
      ctx.fill();
    }
    if (!reduced) requestAnimationFrame(draw);
  }
  draw();
}

// ── Spotify redirect feedback ────────────────────────────────────────────

function reportSpotifyRedirect() {
  const status = new URLSearchParams(location.search).get('spotify');
  if (!status) return;
  const messages = {
    connected: ['Spotify connected ♫', 2600],
    denied: ['Spotify connection cancelled', 2600],
    unconfigured: ['Spotify is not configured on this server', 3600],
    'bad-state': ['Spotify sign-in expired — try again', 3600],
    'exchange-failed': ['Spotify token exchange failed — check your credentials', 4200],
  };
  const [message, ms] = messages[status] || [`Spotify: ${status}`, 3000];
  setTimeout(() => toast(message, ms), 400);
  // Drop the marker so a reload does not replay it, but keep the hash: this
  // replaces the whole URL with location.pathname, which used to throw away the
  // section somebody was on and drop them back at the timer.
  const clean = new URL(window.location.href);
  clean.searchParams.delete('spotify');
  history.replaceState({}, '', `${clean.pathname}${clean.search}${clean.hash}`);
}

// ── go ───────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const overlay = $('#auth-overlay');
    if (!overlay.hidden && store.user) overlay.hidden = true;
  }
  // Space toggles the timer unless a field has focus.
  if (event.code === 'Space' && !event.repeat && store.user) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (current === 'timer') {
      event.preventDefault();
      document.getElementById('play-btn')?.click();
    }
  }
});

window.addEventListener('hashchange', () => {
  const section = location.hash.replace('#', '');
  if (SECTIONS[section] && section !== current && store.user) navigate(section);
});

reportSpotifyRedirect();
boot().catch((err) => {
  console.error('[pixelflow] boot failed', err);
  document.body.append(el('div', {
    style: {
      position: 'fixed', inset: '0', display: 'grid', placeItems: 'center',
      padding: '40px', textAlign: 'center', fontFamily: 'sans-serif', zIndex: '200',
      background: '#0d0d1a', color: '#e8e6ff',
    },
    text: `PixelFlow could not start: ${err.message}`,
  }));
});
