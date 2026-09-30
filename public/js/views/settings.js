import { el, toast } from '../ui.js';
import { api } from '../api.js';
import { store, settings, updateSetting, setUser } from '../store.js';
import { timer, skipToBreak, applyFocusLength } from '../timer.js';
import { spotifyConfig, spotifyStatus } from '../media/spotify.js';

const THEMES = [
  { label: 'Night', c1: '#0d0d1a', c2: '#12122a' },
  { label: 'Cozy', c1: '#1a0d0d', c2: '#2a1512' },
  { label: 'Forest', c1: '#0a1a0a', c2: '#0f2212' },
  { label: 'Ocean', c1: '#0a1520', c2: '#0a1e30' },
  { label: 'Cyber', c1: '#1a0d1a', c2: '#220d2a' },
  { label: 'Desert', c1: '#1c1a0a', c2: '#2a2610' },
  { label: 'Sakura', c1: '#1a0d12', c2: '#2a1020' },
  { label: 'Arctic', c1: '#0d1220', c2: '#0a1828' },
  { label: 'Minimal', c1: '#111111', c2: '#1a1a1a' },
];

const STORE_KEY = 'pixelflow:theme';
let theme = THEMES[0];
try { theme = THEMES[Number(localStorage.getItem(STORE_KEY))] || THEMES[0]; } catch { /* private mode */ }

function applyTheme(next) {
  theme = next;
  document.getElementById('bg-canvas').style.background = `
    radial-gradient(ellipse 80% 60% at 15% 50%, rgba(124,111,255,0.10) 0%, transparent 60%),
    radial-gradient(ellipse 60% 50% at 85% 15%, rgba(107,255,218,0.07) 0%, transparent 55%),
    linear-gradient(145deg, ${next.c1} 0%, ${next.c2} 100%)
  `;
  try { localStorage.setItem(STORE_KEY, String(THEMES.indexOf(next))); } catch { /* ignore */ }
}

let host = null;
let panel = null;

export const settingsSection = {
  async mount(container, ctx = {}) {
    host = container;
    panel = ctx.panel || null;
    await render();
  },
  sidePanel: settingsSidePanel,
};

async function render() {
  const [config, connected] = await Promise.all([spotifyConfig(), spotifyStatus()]);
  const s = settings();

  host.innerHTML = '';
  host.append(
    el('div', { class: 'pane' }, [
      el('div', { class: 'pane-hd' }, [
        el('div', { class: 'pane-title', text: 'POMODORO' }),
        el('div', { class: 'pane-sub', text: 'The focus length Pomodoro mode starts from. The wheels can still set any other length per session.' }),
      ]),
      stepper('Focus length', s.focusMins, 5, 120, 5, 'min', 'focusMins',
        'Between 5 and 120 minutes, so sub-hour sessions are fine.'),
      stepper('Short break', s.shortBreak, 1, 30, 1, 'min', 'shortBreak',
        'Runs automatically after a focus session when auto-start is on.'),
      stepper('Long break', s.longBreak, 5, 60, 5, 'min', 'longBreak',
        'Runs after every N completed focus sessions.'),
      stepper('Sessions before a long break', s.pomsBefore, 1, 8, 1, '', 'pomsBefore',
        'Also the number of progress dots under the timer.'),
      toggle('Start the break automatically', s.autoStartBreak, 'autoStartBreak',
        'When on, finishing a focus session immediately chains into its break. When off, the timer waits for you.'),
      toggle('Add finished sessions to today', s.autoLogStudy, 'autoLogStudy',
        'Focus time is written into the day’s total in the tracker. Break time is never counted.'),
    ]),

    el('div', { class: 'pane' }, [
      el('div', { class: 'pane-hd' }, [
        el('div', { class: 'pane-title', text: 'NOTIFICATIONS' }),
      ]),
      toggle('Sound alerts', s.sound, 'sound', 'Play a chime when a session ends.'),
      toggle('Desktop notifications', s.notifs, 'notifs', 'Ask the browser for permission to notify you.'),
      toggle('Friend activity', s.friendActivity, 'friendActivity', 'Show what your friends are studying.'),
    ]),

    el('div', { class: 'pane' }, [
      el('div', { class: 'pane-hd' }, [
        el('div', { class: 'pane-title', text: 'BACKGROUND' }),
      ]),
      el('div', { class: 'bg-grid' }, THEMES.map((t) => el('div', {
        class: `bg-tile${t.label === theme.label ? ' active' : ''}`,
        style: { background: `linear-gradient(135deg,${t.c1},${t.c2})` },
        onclick: () => { applyTheme(t); render(); },
      }, [el('span', { text: t.label })]))),
    ]),

    el('div', { class: 'pane' }, [
      el('div', { class: 'pane-hd' }, [
        el('div', { class: 'pane-title', text: 'SPOTIFY' }),
      ]),
      el('div', { class: 'sp-connect-text' }, [
        document.createTextNode(config.configured
          ? (connected ? 'Spotify is connected and can play inside the app.' : 'Configured on this server, but not connected to an account yet.')
          : 'No Spotify client ID is configured, so the app is showing the paste-a-link embed player instead of the real one.'),
      ]),
      !config.configured
        ? el('div', { class: 'sp-note' }, [
          el('b', { text: 'Redirect URI: ' }),
          el('code', { text: config.redirectUri || 'http://127.0.0.1:5173/auth/callback' }),
          document.createTextNode(' — register exactly this in the Spotify developer dashboard. Spotify rejects "localhost".'),
        ])
        : null,
      connected
        ? el('button', {
          class: 'btn', text: 'Disconnect Spotify',
          onclick: async () => {
            try {
              await api.post('/api/spotify/disconnect');
              toast('Spotify disconnected');
              await render();
            } catch (err) { toast(err.message || 'Could not disconnect', 3000); }
          },
        })
        : el('a', {
          class: 'btn primary', href: '/api/spotify/login', text: 'Connect Spotify',
          style: { display: 'inline-block', textDecoration: 'none' },
        }),
    ]),

    el('div', { class: 'pane' }, [
      el('div', { class: 'pane-hd' }, [
        el('div', { class: 'pane-title', text: 'ACCOUNT' }),
      ]),
      el('div', { class: 'setting-row' }, [
        el('div', { class: 'setting-info' }, [
          el('div', { class: 'setting-label', text: store.user?.username || '—' }),
          el('div', { class: 'setting-hint', text: store.user?.email || '' }),
        ]),
        el('div', { class: 'f-level', text: `LV ${store.user?.level || 1}` }),
      ]),
      el('div', { class: 'setting-row' }, [
        el('div', { class: 'setting-info' }, [
          el('div', { class: 'setting-label', text: 'Total XP' }),
          el('div', { class: 'setting-hint', text: 'Every 100 XP is a level.' }),
        ]),
        el('div', { class: 'setting-val', text: String(store.user?.xp || 0) }),
      ]),
      // A guest has no password, so this is the one chance to set one. Without
      // it the session still works, but nothing can be signed back into.
      store.user?.isGuest ? claimForm() : null,
      el('button', {
        class: 'btn danger block', text: 'Sign out', style: { marginTop: '14px' },
        onclick: async () => {
          try {
            await api.post('/api/auth/logout');
          } finally {
            window.location.reload();
          }
        },
      }),
    ]),
  );

  if (panel) settingsSidePanel(panel);
}

/**
 * Lets a guest give their account a username, email and password, keeping
 * everything they have already logged.
 */
function claimForm() {
  const fields = {};
  const input = (key, attrs) => {
    fields[key] = el('input', { class: 'inp', ...attrs });
    return fields[key];
  };
  const status = el('div', { class: 'auth-error', hidden: true });
  const submit = el('button', { class: 'btn primary block', text: 'Save my account' });

  submit.addEventListener('click', async () => {
    status.hidden = true;
    submit.disabled = true;
    try {
      const { user } = await api.post('/api/auth/claim', {
        username: fields.username.value.trim(),
        email: fields.email.value.trim(),
        password: fields.password.value,
      });
      setUser(user);
      toast('Account saved — you can sign in now.');
      await render();
    } catch (err) {
      status.textContent = err.message || 'Could not save your account.';
      status.hidden = false;
      submit.disabled = false;
    }
  });

  return el('div', { class: 'sp-note', style: { marginTop: '12px', display: 'grid', gap: '8px' } }, [
    el('b', { text: 'You are using PixelFlow as a guest.' }),
    el('span', { text: 'Set a username and password to keep this progress and sign back in later.' }),
    input('username', { type: 'text', placeholder: 'Username', autocomplete: 'username' }),
    input('email', { type: 'email', placeholder: 'Email', autocomplete: 'email' }),
    input('password', { type: 'password', placeholder: 'Password (min 8 chars)', autocomplete: 'new-password' }),
    status,
    submit,
  ]);
}

function stepper(label, value, min, max, increment, unit, key, hint) {
  const valueNode = el('div', { class: 'setting-val', text: `${value}${unit ? ` ${unit}` : ''}` });

  const bump = async (dir) => {
    const next = Math.min(max, Math.max(min, settings()[key] + (dir * increment)));
    if (next === settings()[key]) return;
    try {
      await updateSetting(key, next);
      valueNode.textContent = `${next}${unit ? ` ${unit}` : ''}`;
      // This is the length Pomodoro mode starts from, so re-sync the wheels
      // unless a session length has already been dialled in for this view.
      if (key === 'focusMins') applyFocusLength();
    } catch (err) {
      toast(err.message || 'Could not save', 3000);
    }
  };

  return el('div', { class: 'setting-row' }, [
    el('div', { class: 'setting-info' }, [
      el('div', { class: 'setting-label', text: label }),
      hint ? el('div', { class: 'setting-hint', text: hint }) : null,
    ]),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } }, [
      el('button', { class: 'btn small', text: '−', 'aria-label': `Decrease ${label}`, onclick: () => bump(-1) }),
      valueNode,
      el('button', { class: 'btn small', text: '+', 'aria-label': `Increase ${label}`, onclick: () => bump(1) }),
    ]),
  ]);
}

function toggle(label, value, key, hint) {
  const wrap = el('div', {
    class: `toggle-wrap ${value ? 'on' : 'off'}`,
    role: 'switch',
    tabindex: '0',
    'aria-checked': String(value),
    'aria-label': label,
  }, [el('div', { class: 'toggle-thumb' })]);

  const flip = async () => {
    const next = !settings()[key];
    wrap.className = `toggle-wrap ${next ? 'on' : 'off'}`;
    wrap.setAttribute('aria-checked', String(next));
    try {
      await updateSetting(key, next);
    } catch (err) {
      wrap.className = `toggle-wrap ${settings()[key] ? 'on' : 'off'}`;
      toast(err.message || 'Could not save', 3000);
    }
  };
  wrap.addEventListener('click', flip);
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); }
  });

  return el('div', { class: 'setting-row' }, [
    el('div', { class: 'setting-info' }, [
      el('div', { class: 'setting-label', text: label }),
      hint ? el('div', { class: 'setting-hint', text: hint }) : null,
    ]),
    wrap,
  ]);
}

// ── right panel: a quick status summary ──────────────────────────────────

export function settingsSidePanel(body) {
  panel = body;
  body.innerHTML = '';
  const s = settings();
  body.append(el('div', { class: 'sect-hd', text: 'AT A GLANCE' }));
  body.append(el('div', { class: 'kpi' }, [
    row('Focus length', `${s.focusMins} min`),
    row('Short break', `${s.shortBreak} min`),
    row('Long break', `${s.longBreak} min`),
    row('Auto-start break', s.autoStartBreak ? 'On' : 'Off'),
    row('Auto-log study', s.autoLogStudy ? 'On' : 'Off'),
  ]));

  body.append(el('div', { class: 'sect-hd', text: 'QUICK ACTIONS' }));
  body.append(el('button', {
    class: 'btn block', text: 'Skip to the break now',
    onclick: () => skipToBreak(),
  }));

  body.append(el('div', { class: 'sect-hd', text: 'DATA' }));
  body.append(el('div', { class: 'pane-sub', style: { lineHeight: '1.7' }, text: 'Everything you log — study entries, tasks, tags, friends, sessions and settings — is stored in a local SQLite database on this machine and synced to your account. Nothing is sent anywhere except Spotify, if you connect it.' }));
}

function row(label, value) {
  return el('div', { class: 'kpi-row' }, [
    el('div', { class: 'kpi-label', text: label }),
    el('div', { class: 'kpi-value', style: { fontSize: '18px' }, text: value }),
  ]);
}

applyTheme(theme);
