import { el, toast, minutes } from '../ui.js';
import { api } from '../api.js';
import { store } from '../store.js';
import {
  spotifyConfig, spotifyStatus, initSpotify, paintDock, bindDock,
} from '../media/spotify.js';
import {
  SOUNDS, soundById, playSound, stopAll, setIntensity, setMasterVolume,
  currentSoundId, ensureContext,
} from '../media/sounds.js';

let host = null;
let panel = null;
let soundcloudUrl = '';
let onChange = () => {};

export const mediaSection = {
  async mount(container, ctx = {}) {
    host = container;
    onChange = ctx.onChange || (() => {});
    bindDock();
    await render();
  },
  sidePanel: mediaSidePanel,
};

async function render() {
  const [config, connected] = await Promise.all([spotifyConfig(), spotifyStatus()]);
  store.spotify.connected = connected;

  host.innerHTML = '';
  host.append(
    el('div', { class: 'media-split' }, [
      spotifyPane(config, connected),
      soundcloudPane(),
    ]),
    soundPane(),
  );

  if (connected) connectPlayer();
  else paintDock(null);
}

// ── Spotify ──────────────────────────────────────────────────────────────

function spotifyPane(config, connected) {
  const status = el('div', { class: `sp-status${connected ? ' connected' : ''}` }, [
    el('div', { class: 'media-dot' }),
    document.createTextNode(connected ? 'SPOTIFY CONNECTED' : 'SPOTIFY'),
  ]);

  const body = connected
    ? el('div', {}, [
      el('div', { class: 'pane-sub', text: 'Use the player in the bar at the bottom of the screen. It keeps playing while you switch tabs.' }),
      el('div', { class: 'sp-note' }, [
        el('b', { text: 'Requires Premium. ' }),
        document.createTextNode('In-browser playback through the Web Playback SDK is a Premium feature; a free account will show an error in the player bar.'),
      ]),
      el('button', {
        class: 'btn block', text: 'Disconnect', style: { marginTop: '12px' },
        onclick: async () => {
          try {
            await api.post('/api/spotify/disconnect');
            store.spotify.connected = false;
            toast('Spotify disconnected');
            await render();
          } catch (err) { toast(err.message || 'Could not disconnect', 3000); }
        },
      }),
    ])
    : unconfiguredOrConnect(config);

  return el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'SPOTIFY' }),
      status,
    ]),
    body,
  ]);
}

function unconfiguredOrConnect(config) {
  if (!config.configured) {
    return el('div', {}, [
      el('div', { class: 'sp-connect-box' }, [
        el('div', { class: 'sp-connect-title', text: 'Spotify is not configured' }),
        el('div', { class: 'sp-connect-text' }, [
          document.createTextNode('Add your credentials to '),
          el('code', { text: '.env' }),
          document.createTextNode(' and restart the server to enable the real in-app player.'),
        ]),
      ]),
      el('div', { class: 'sp-note' }, [
        el('b', { text: 'To set it up: ' }),
        document.createTextNode('register an app at developer.spotify.com choosing “Web Playback SDK”, add its Client ID and Secret to .env, and register the redirect URI '),
        el('code', { text: config.redirectUri || 'http://127.0.0.1:5173/auth/callback' }),
        document.createTextNode('. Spotify rejects '),
        el('code', { text: 'localhost' }),
        document.createTextNode(' — you must use the explicit IP loopback.'),
      ]),
      el('div', { class: 'sect-hd', text: 'FALLBACK: PASTE A LINK' }),
      spotifyFallback(),
    ]);
  }
  return el('div', {}, [
    el('div', { class: 'sp-connect-box' }, [
      el('div', { class: 'sp-connect-title', text: 'Play your own playlists' }),
      el('div', {
        class: 'sp-connect-text',
        text: 'Connect your Spotify account to play, pause, skip and seek from inside PixelFlow, and see the current track in the bar at the bottom of the screen.',
      }),
      el('a', {
        class: 'btn primary', href: '/api/spotify/login', text: 'Connect Spotify',
        style: { display: 'inline-block', textDecoration: 'none' },
      }),
    ]),
    el('div', { class: 'sp-note' }, [
      el('b', { text: 'Premium required. ' }),
      document.createTextNode('Spotify only allows in-browser playback on Premium accounts.'),
    ]),
    el('div', { class: 'sect-hd', text: 'OR PASTE A LINK' }),
    spotifyFallback(),
  ]);
}

/** The always-available embed player, used when the SDK is not connected. */
function spotifyFallback() {
  const input = el('input', { class: 'inp', placeholder: 'Spotify track, album or playlist URL…' });
  const frame = el('div');

  const draw = (url) => {
    const match = String(url).match(/\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
    frame.innerHTML = '';
    if (!match) {
      frame.append(el('div', { class: 'media-placeholder', text: 'Paste a Spotify link above to load it here.' }));
      return;
    }
    frame.append(el('div', { class: 'player-shell' }, [
      el('iframe', {
        src: `https://open.spotify.com/embed/${match[1]}/${match[2]}?utm_source=generator&theme=0`,
        height: match[1] === 'track' ? '80' : '260',
        frameborder: '0',
        allowfullscreen: '',
        allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
      }),
    ]));
  };
  draw(soundcloudUrl);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { soundcloudUrl = input.value; draw(soundcloudUrl); }
  });

  return el('div', {}, [
    el('div', { class: 'media-input-row' }, [
      input,
      el('button', {
        class: 'btn', text: 'Load',
        onclick: () => { soundcloudUrl = input.value; draw(soundcloudUrl); },
      }),
    ]),
    frame,
  ]);
}

function connectPlayer() {
  initSpotify({
    onState: (state) => paintDock(state),
    onReady: () => {
      paintDock(store.spotify.state);
      if (panel) renderSidePanel();
    },
    onError: (message) => toast(message, 4200),
  }).catch((err) => toast(err.message || 'Spotify failed to start', 4200));
}

// ── SoundCloud ───────────────────────────────────────────────────────────

function soundcloudPane() {
  const input = el('input', { class: 'inp', placeholder: 'soundcloud.com/… URL' });
  const frame = el('div');

  const draw = (url) => {
    const match = String(url).match(/soundcloud\.com\/([^\/\s]+\/[^\/\s]+)/);
    frame.innerHTML = '';
    if (!match) {
      frame.append(el('div', { class: 'media-placeholder', text: 'Paste a SoundCloud link above to load the player.' }));
      return;
    }
    frame.append(el('div', { class: 'player-shell' }, [
      el('iframe', {
        src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${match[1]}`)}&color=%23ff5500&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=false`,
        height: '166',
        frameborder: '0',
        allow: 'autoplay',
        scrolling: 'no',
      }),
    ]));
  };
  draw(soundcloudUrl);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { soundcloudUrl = input.value; draw(soundcloudUrl); }
  });

  return el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'SOUNDCLOUD' }),
      el('div', { class: 'sp-status' }, [
        el('div', { class: 'media-dot', style: { background: '#ff5500', boxShadow: '0 0 6px #ff5500' } }),
        document.createTextNode('SOUNDCLOUD'),
      ]),
    ]),
    el('div', { class: 'media-input-row' }, [
      input,
      el('button', {
        class: 'btn', text: 'Load',
        onclick: () => { soundcloudUrl = input.value; draw(soundcloudUrl); },
      }),
    ]),
    frame,
  ]);
}

// ── sound library ────────────────────────────────────────────────────────

function soundPane() {
  const groups = ['Nature', 'Focus'];
  return el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'SOUND LIBRARY' }),
      el('div', { class: 'pane-sub', text: 'Generated live with the Web Audio API — no audio files, works offline.' }),
    ]),
    ...groups.map((group) => [
      el('div', { class: 'sect-hd', text: group.toUpperCase() }),
      el('div', { class: 'sound-grid' }, SOUNDS.filter((s) => s.group === group).map(soundCard)),
    ]),
  ]);
}

function soundCard(sound) {
  const slider = el('input', {
    class: 'intensity',
    type: 'range', min: '0', max: '100',
    value: String(Math.round(store.sounds.intensity * 100)),
    'aria-label': `${sound.name} intensity`,
  });

  const card = el('button', {
    class: 'sound-card',
    'aria-pressed': String(currentSoundId() === sound.id),
  }, [
    el('div', { class: 'sound-head' }, [
      el('span', { class: 'sound-icon', text: sound.icon }),
      el('span', {}, [
        el('div', { class: 'sound-name', text: sound.name }),
        el('div', { class: 'sound-group', text: sound.group }),
      ]),
    ]),
    el('div', { class: 'wave' }, Array.from({ length: 7 }, () => el('i'))),
    slider,
  ]);

  slider.addEventListener('click', (event) => event.stopPropagation());
  slider.addEventListener('input', (event) => {
    event.stopPropagation();
    setIntensity(sound.id, Number(event.target.value) / 100);
  });

  card.addEventListener('click', async () => {
    const playing = currentSoundId() === sound.id;
    try {
      if (playing) {
        stopAll();
      } else {
        // ensureContext() must run inside this gesture or autoplay blocks it.
        await playSound(sound.id, Number(slider.value) / 100);
      }
      paintSounds();
      if (panel) renderSidePanel();
    } catch (err) {
      toast(err.message || 'Could not start audio', 3500);
    }
  });

  return card;
}

function paintSounds() {
  const playing = currentSoundId();
  host?.querySelectorAll('.sound-card').forEach((card) => {
    const name = card.querySelector('.sound-name')?.textContent;
    const sound = SOUNDS.find((s) => s.name === name);
    if (!sound) return;
    card.classList.toggle('playing', sound.id === playing);
    card.setAttribute('aria-pressed', String(sound.id === playing));
  });
}

// ── right panel: the master mixer ────────────────────────────────────────

export function mediaSidePanel(body) {
  panel = body;
  renderSidePanel();
}

async function renderSidePanel() {
  if (!panel) return;
  panel.innerHTML = '';

  const playing = currentSoundId();
  const sound = playing ? soundById(playing) : null;

  if (sound) {
    panel.append(el('div', { class: 'now-playing-sound' }, [
      el('span', { class: 'np-glyph', text: sound.icon }),
      el('div', {}, [
        el('div', { class: 'now-playing-name', text: sound.name }),
        el('div', { class: 'now-playing-sub', text: 'playing in the background' }),
      ]),
      el('button', {
        class: 'btn small', text: 'Stop', style: { marginLeft: 'auto' },
        onclick: () => { stopAll(); paintSounds(); renderSidePanel(); },
      }),
    ]));
  } else {
    panel.append(el('div', { class: 'empty', text: 'No sound playing. Pick one from the library — it keeps playing while you work.' }));
  }

  const value = el('div', { class: 'master-val', text: `${Math.round(store.sounds.master * 100)}` });
  panel.append(el('div', { class: 'master-mixer', style: { marginTop: '12px' } }, [
    el('div', { class: 'sect-hd', style: { marginTop: '0' }, text: 'MASTER VOLUME' }),
    el('div', { class: 'master-row' }, [
      el('span', { class: 'master-glyph', text: '🔊' }),
      el('input', {
        type: 'range', min: '0', max: '100',
        value: String(Math.round(store.sounds.master * 100)),
        'aria-label': 'Master volume',
        oninput: (event) => {
          const v = Number(event.target.value);
          value.textContent = String(v);
          setMasterVolume(v / 100);
          const p = store.spotify.player;
          if (p) { try { p.setVolume(v / 100); } catch { /* mid-transition */ } }
        },
      }),
      value,
    ]),
  ]));

  panel.append(el('div', { class: 'sect-hd', text: 'ABOUT THESE SOUNDS' }));
  panel.append(el('div', { class: 'pane-sub', style: { lineHeight: '1.7' } }, [
    document.createTextNode('Every sound here is synthesised in the browser from filtered noise and oscillators — there are no audio files to download, and nothing to attribute. Each card’s slider controls that sound’s intensity.'),
  ]));
}
