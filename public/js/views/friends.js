import { el, toast, minutesShort, debounce } from '../ui.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { drawPose } from '../avatar.js';

const PRESENCE_LABEL = { online: 'online', away: 'away', offline: 'offline' };
let subTab = 'friends';
let host = null;
let panel = null;
let onChange = () => {};

/**
 * A tiny pixel avatar so friend rows look like the user's own avatar rather
 * than a generic emoji.
 */
function avatarNode(user, size = 40) {
  const holder = el('div', { class: 'f-avatar', style: { width: `${size}px`, height: `${size}px` } });
  const canvas = document.createElement('canvas');
  canvas.width = 26 * 3;
  canvas.height = 34 * 3;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${Math.round((size * 34) / 26)}px`;
  drawPose(canvas, user?.avatar || {}, user?.avatar?.focusPose || 'desk', 0);
  holder.append(canvas);
  return holder;
}

function withPresence(holder, presence) {
  holder.append(el('div', {
    class: `f-dot ${presence?.state || 'offline'}`,
    title: `${PRESENCE_LABEL[presence?.state] || 'offline'}${presence?.activity ? ` — ${presence.activity}` : ''}`,
  }));
  return holder;
}

let poll = null;

export const friendsSection = {
  async mount(container, ctx = {}) {
    host = container;
    onChange = ctx.onChange || (() => {});
    await load();
    // Polling keeps the online dots and "studying now" lines current.
    clearInterval(poll);
    poll = setInterval(() => load({ silent: true }), 10000);
  },
  unmount() { clearInterval(poll); },
  reload: load,
  sidePanel: friendsSidePanel,
};

async function load({ silent = false } = {}) {
  if (!host) return;
  if (!silent) host.innerHTML = '';
  let data;
  try {
    data = await api.get('/api/friends');
  } catch (err) {
    if (!silent) host.append(el('div', { class: 'pane' }, [el('div', { class: 'empty', text: err.message || 'Could not load friends.' })]));
    return;
  }

  host.innerHTML = '';
  host.append(tabsRow(data));
  if (subTab === 'friends') host.append(friendsPane(data));
  else if (subTab === 'requests') host.append(requestsPane(data));
  else host.append(leaderboardPane(data));

  if (panel) renderSidePanel(data);
}

function tabsRow(data) {
  const make = (id, label, badge) => el('button', {
    class: `chart-toggle` === '' ? '' : '',
    style: {
      padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: '700',
      letterSpacing: '.6px', cursor: 'pointer',
      background: subTab === id ? 'var(--accent)' : 'var(--surface)',
      border: '1px solid var(--border)', color: subTab === id ? '#fff' : 'var(--muted)',
    },
    onclick: () => { subTab = id; load(); },
  }, [document.createTextNode(label), badge ? el('span', { style: { marginLeft: '6px', opacity: '.8' }, text: `(${badge})` }) : null]);

  return el('div', { class: 'chart-head', style: { marginBottom: '14px' } }, [
    el('div', { class: 'pane-title', text: 'FRIENDS' }),
    el('div', { style: { display: 'flex', gap: '6px' } }, [
      make('friends', 'FRIENDS', data.friends.length || null),
      make('requests', 'REQUESTS', data.requests.length || null),
      make('leaderboard', 'LEADERBOARD'),
    ]),
  ]);
}

// ── friends ──────────────────────────────────────────────────────────────

function friendsPane(data) {
  const pane = el('div', { class: 'pane' });

  if (data.friends.length === 0) {
    pane.append(el('div', { class: 'friend-empty' }, [
      el('div', { class: 'friend-empty-icon', text: '👥' }),
      el('div', { class: 'friend-empty-title', text: 'No friends yet' }),
      el('div', {
        class: 'friend-empty-text',
        text: 'Search for another PixelFlow user in the panel on the right and send a request. Their study hours, streak and pomodoros will appear here.',
      }),
    ]));
    return pane;
  }

  pane.append(el('div', { class: 'friend-grid' }, data.friends.map(friendCardNode)));
  return pane;
}

function friendCardNode(friend) {
  const holder = avatarNode(friend, 44);
  withPresence(holder, friend.presence);

  const weekRatio = friend.week.planned > 0
    ? Math.min(1, friend.week.minutes / friend.week.planned) : 0;
  const studying = friend.presence?.state === 'online' && friend.presence.activity;

  return el('div', { class: 'friend-card' }, [
    el('div', { class: 'friend-top' }, [
      holder,
      el('div', { class: 'f-info' }, [
        el('div', { class: 'f-name' }, [
          document.createTextNode(friend.username),
          el('span', { class: 'f-level', text: `LV ${friend.level}` }),
        ]),
        el('div', { class: `f-status${studying ? ' studying' : ''}` }, [
          el('span', { text: studying ? friend.presence.activity : PRESENCE_LABEL[friend.presence?.state] }),
        ]),
      ]),
      el('button', {
        class: 'f-remove', text: '×', 'aria-label': `Unfriend ${friend.username}`,
        title: 'Unfriend',
        onclick: async () => {
          if (!window.confirm(`Remove ${friend.username} from your friends?`)) return;
          try {
            await api.del(`/api/friends/${friend.id}`);
            await load();
            onChange();
          } catch (err) {
            toast(err.message || 'Could not remove that friend', 3000);
          }
        },
      }),
    ]),
    el('div', { class: 'f-stats' }, [
      stat(minutesShort(friend.today.minutes), 'today', friend.today.minutes > 0),
      stat(friend.streak, 'day streak', friend.streak > 0),
      stat(friend.pomodoros, 'pomodoros'),
    ]),
    el('div', { class: 'bar f-week-bar' }, [
      el('div', { class: `bar-fill${weekRatio >= 1 ? ' met' : ''}`, style: { width: `${weekRatio * 100}%` } }),
    ]),
    el('div', { class: 'f-week-nums' }, [
      el('span', { text: `${friend.week.text} studied this week` }),
      el('span', { text: friend.week.planned > 0 ? `of ${minutesShort(friend.week.planned)}` : '' }),
    ]),
  ]);
}

function stat(value, label, highlight = false) {
  return el('div', { class: 'f-stat' }, [
    el('div', { class: 'f-stat-val', style: highlight ? { color: 'var(--accent3)' } : {}, text: String(value) }),
    el('div', { class: 'f-stat-lbl', text: label }),
  ]);
}

// ── requests ─────────────────────────────────────────────────────────────

function requestsPane(data) {
  const pane = el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'REQUESTS' }),
      el('div', { class: 'pane-sub', text: `${data.requests.length} waiting · ${data.outgoing.length} sent` }),
    ]),
  ]);

  if (data.requests.length === 0 && data.outgoing.length === 0) {
    pane.append(el('div', { class: 'empty', text: 'No pending requests.' }));
    return pane;
  }

  for (const req of data.requests) {
    pane.append(el('div', { class: 'request-row incoming' }, [
      avatarNode({ avatar: {} }, 36),
      el('div', { class: 'f-info' }, [
        el('div', { class: 'f-name' }, [
          document.createTextNode(req.username),
          el('span', { class: 'f-level', text: `LV ${req.level}` }),
        ]),
        el('div', { class: 'f-stat', text: 'wants to study with you' }),
      ]),
      el('div', { class: 'request-actions' }, [
        el('button', {
          class: 'btn accept', text: 'Accept',
          onclick: async () => {
            try {
              await api.post('/api/friends/respond', { requestId: req.requestId, accept: true });
              await load();
              onChange();
              toast(`You and ${req.username} are now friends`);
            } catch (err) { toast(err.message || 'Could not accept', 3000); }
          },
        }),
        el('button', {
          class: 'btn decline', text: 'Ignore',
          onclick: async () => {
            try {
              await api.post('/api/friends/respond', { requestId: req.requestId, accept: false });
              await load();
            } catch (err) { toast(err.message || 'Could not decline', 3000); }
          },
        }),
      ]),
    ]));
  }

  for (const out of data.outgoing) {
    pane.append(el('div', { class: 'request-row' }, [
      avatarNode({ avatar: {} }, 36),
      el('div', { class: 'f-info' }, [
        el('div', { class: 'f-name', text: out.username }),
        el('div', { class: 'f-stat', text: 'request sent — waiting for them' }),
      ]),
      el('div', { class: 'request-actions' }, [
        el('button', {
          class: 'btn decline', text: 'Cancel',
          onclick: async () => {
            try {
              await api.del(`/api/friends/${out.id}`);
              await load();
            } catch (err) { toast(err.message || 'Could not cancel', 3000); }
          },
        }),
      ]),
    ]));
  }

  return pane;
}

// ── leaderboard ──────────────────────────────────────────────────────────

function leaderboardPane(data) {
  const pane = el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'LEADERBOARD' }),
      el('div', { class: 'pane-sub', text: 'Ranked by hours studied this week' }),
    ]),
  ]);

  if (data.leaderboard.length === 0) {
    pane.append(el('div', { class: 'empty', text: 'Add a friend to see a leaderboard.' }));
    return pane;
  }

  for (const row of data.leaderboard) {
    const ratio = row.week.planned > 0 ? Math.min(1, row.week.minutes / row.week.planned) : 0;
    pane.append(el('div', { class: `lb-row${row.me ? ' me' : ''}` }, [
      el('div', { class: 'lb-rank', text: `#${row.rank}` }),
      el('div', {}, [
        el('div', { class: 'lb-name' }, [
          document.createTextNode(row.username),
          row.me ? el('span', { class: 'f-level', style: { background: 'rgba(255,255,255,.14)' }, text: 'YOU' }) : null,
          el('span', { class: 'f-dot ' + (row.presence?.state || 'offline'), style: { position: 'static', width: '8px', height: '8px', borderWidth: '1.5px' } }),
        ]),
        el('div', { class: 'lb-sub', text: `${row.streak} day streak · ${row.pomodoros} pomodoros · ${minutesShort(row.week.planned)} planned` }),
        el('div', { class: 'bar', style: { marginTop: '6px', height: '5px' } }, [
          el('div', { class: `bar-fill${ratio >= 1 ? ' met' : ''}`, style: { width: `${ratio * 100}%` } }),
        ]),
      ]),
      el('div', {}, [
        el('div', { class: 'lb-hours', text: row.week.text }),
        el('div', { class: 'lb-hours-lbl', text: 'this week' }),
      ]),
    ]));
  }

  return pane;
}

// ── right panel: search and add ──────────────────────────────────────────

let searchResults = [];

async function renderSidePanel(data) {
  const body = panel;
  body.innerHTML = '';

  body.append(el('div', { class: 'sect-hd', text: 'FIND PEOPLE' }));
  const input = el('input', {
    class: 'inp',
    placeholder: 'Search by username…',
    oninput: debounce(async (event) => {
      const q = event.target.value.trim();
      if (q.length < 2) { searchResults = []; drawResults(); return; }
      try {
        const res = await api.get(`/api/friends/search?q=${encodeURIComponent(q)}`);
        searchResults = res.users;
        drawResults();
      } catch { searchResults = []; drawResults(); }
    }, 280),
  });
  body.append(input);

  const results = el('div');
  body.append(results);

  function drawResults() {
    results.innerHTML = '';
    if (searchResults.length === 0) return;
    results.append(el('div', { class: 'sect-hd', text: 'RESULTS' }));
    for (const user of searchResults) {
      results.append(el('div', { class: 'search-row' }, [
        avatarNode({ avatar: {} }, 30),
        el('div', { class: 'search-body' }, [
          el('div', { class: 'search-name', text: user.username }),
        ]),
        el('span', { class: `relation-badge ${user.relation}` , text: relationLabel(user.relation) }),
        user.relation === 'none' || user.relation === 'incoming'
          ? el('button', {
            class: 'btn small primary', text: user.relation === 'incoming' ? 'Accept' : 'Add',
            onclick: async () => {
              try {
                await api.post('/api/friends/request', { userId: user.id });
                toast(`Friend request sent to ${user.username}`);
                await load();
              } catch (err) { toast(err.message || 'Could not send that request', 3000); }
            },
          })
          : null,
      ]));
    }
  }

  if (data.requests.length > 0) {
    body.append(el('div', { class: 'sect-hd', text: `PENDING (${data.requests.length})` }));
    for (const req of data.requests) {
      body.append(el('div', { class: 'search-row' }, [
        el('div', { class: 'search-body' }, [el('div', { class: 'search-name', text: req.username })]),
        el('button', {
          class: 'btn small accept', text: 'Accept',
          onclick: async () => {
            try {
              await api.post('/api/friends/respond', { requestId: req.requestId, accept: true });
              await load();
            } catch (err) { toast(err.message || 'Could not accept', 3000); }
          },
        }),
      ]));
    }
  }

  body.append(el('div', { class: 'sect-hd', text: `YOUR FRIENDS (${data.friends.length})` }));
  if (data.friends.length === 0) {
    body.append(el('div', { class: 'empty', text: 'Nobody yet.' }));
    return;
  }
  for (const friend of data.friends) {
    body.append(el('div', { class: 'search-row' }, [
      avatarNode(friend, 30),
      el('div', { class: 'search-body' }, [
        el('div', { class: 'search-name', text: friend.username }),
        el('div', { class: 'lb-sub', text: `${friend.week.text} this week · ${friend.streak}d streak` }),
      ]),
      el('span', { class: `f-dot ${friend.presence?.state || 'offline'}`, style: { position: 'static', borderColor: 'transparent' } }),
    ]));
  }
}

function relationLabel(relation) {
  return { none: 'Add', outgoing: 'Pending', incoming: 'Wants you', friends: 'Friends' }[relation] || relation;
}

export function friendsSidePanel(body) {
  panel = body;
  load({ silent: true });
}

// ── presence heartbeat ───────────────────────────────────────────────────

let beat = null;

/** Reports the tab's visibility and what is happening in it. */
export function startPresence() {
  const beatOnce = () => {
    // Hidden tabs report "offline" so friends never see a ghost online.
    // api.post carries the CSRF header, which a raw sendBeacon cannot.
    api.post('/api/friends/presence', {
      state: document.visibilityState === 'hidden'
        ? 'offline'
        : (document.hasFocus() ? 'online' : 'away'),
      activity: store.presenceActivity || '',
    }).catch(() => {});
  };

  clearInterval(beat);
  beat = setInterval(beatOnce, 30000);
  beatOnce();

  document.addEventListener('visibilitychange', beatOnce);
  window.addEventListener('blur', beatOnce);
  window.addEventListener('focus', beatOnce);
}
