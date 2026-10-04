import { el, toast, minutes } from '../ui.js';
import { api } from '../api.js';
import { store, updateSetting } from '../store.js';
import {
  spotifyConfig, spotifyStatus, initSpotify, paintDock, bindDock,
} from '../media/spotify.js';
import {
  SOUNDS, soundById, playSound, stopAll, setIntensity, setMasterVolume,
  currentSoundId, ensureContext,
} from '../media/sounds.js';

let host = null;
let panel = null;
/** The last link pasted into the "other media" pane, kept across tab switches. */
let mediaUrl = '';
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
      otherMediaPane(),
    ]),
    // The always-playable embed: present on a first visit with nothing set up,
    // and the same pane a saved playlist is loaded into.
    playlistPane(),
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

  // Shares the URL parsing with the "other media" pane, so a Spotify link
  // pasted here and one pasted there behave identically.
  const draw = (url) => {
    const embed = embedFor(url);
    frame.innerHTML = '';
    if (!embed || !embed.src || !embed.src.includes('open.spotify.com')) {
      frame.append(el('div', { class: 'media-placeholder', text: 'Paste a Spotify track, album or playlist link above to load it here.' }));
      return;
    }
    frame.append(el('div', { class: 'player-shell' }, [
      el('iframe', {
        src: embed.src,
        height: embed.height,
        frameborder: '0',
        allowfullscreen: '',
        allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
        title: 'Spotify player',
      }),
    ]));
  };
  draw(mediaUrl);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { mediaUrl = input.value; draw(mediaUrl); }
  });

  return el('div', {}, [
    el('div', { class: 'media-input-row' }, [
      input,
      el('button', {
        class: 'btn', text: 'Load',
        onclick: () => { mediaUrl = input.value; draw(mediaUrl); },
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

/**
 * The playlist the Media tab opens with.
 *
 * Shown before the visitor has connected anything or pasted a link of their
 * own, so the pane is never an empty box on a first visit. It is an ordinary
 * public embed and can be replaced below — see playlistPane().
 */
const DEFAULT_PLAYLIST = '3mqtl1bFazmX5lpULhjBkV';

/**
 * The user's own playlist or track, remembered between visits.
 *
 * Stored in their account settings rather than module state so it follows them
 * across devices, which is the same reason the rest of the app persists here.
 */
const savedPlaylist = () => (store.user?.settings?.spotifyPlaylist) || '';

function playlistPane() {
  const current = savedPlaylist() || DEFAULT_PLAYLIST;
  const frame = el('div');

  const draw = (id) => {
    const embed = id ? embedFor(`https://open.spotify.com/playlist/${id}`) : null;
    frame.innerHTML = '';
    if (!embed) {
      frame.append(el('div', { class: 'media-placeholder', text: 'That playlist link could not be read.' }));
      return;
    }
    frame.append(el('div', { class: 'player-shell' }, [
      el('iframe', {
        src: embed.src,
        height: '352',
        frameborder: '0',
        allowfullscreen: '',
        allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
        loading: 'lazy',
        title: 'Spotify playlist',
      }),
    ]));
  };

  /**
   * Accepts what people actually paste: a share link, a bare playlist or track
   * id, or an /embed/ URL. embedFor() does the parsing for everything else, so
   * a Spotify link is handled identically here and in Other Media.
   */
  const idFrom = (raw) => {
    const text = String(raw || '').trim();
    if (!text) return null;
    const full = embedFor(text);
    if (full?.src?.includes('open.spotify.com/embed')) {
      return full.src.match(/embed\/[^/]+\/([a-zA-Z0-9]+)/)?.[1] ?? null;
    }
    // A bare id, with no URL around it.
    const bare = text.match(/^([a-zA-Z0-9]{20,})$/);
    return bare ? bare[1] : null;
  };

  const input = el('input', {
    class: 'inp',
    placeholder: 'Paste a Spotify playlist or track link…',
    'aria-label': 'Spotify playlist or track link',
  });
  input.value = savedPlaylist();

  const load = async () => {
    const id = idFrom(input.value);
    if (!id) {
      toast('That does not look like a Spotify link', 3000);
      return;
    }
    // Remembered only once the link parses, so a typo cannot replace a
    // working playlist with something that will not load.
    try {
      await updateSetting('spotifyPlaylist', id);
      draw(id);
    } catch {
      draw(id);
      toast('Saved for now, but could not be stored on your account', 3200);
    }
  };

  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') load(); });

  draw(current);

  return el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'PLAYLIST' }),
      el('div', { class: 'sp-status' }, [
        el('div', { class: 'media-dot', style: { background: '#1db954', boxShadow: '0 0 6px #1db954' } }),
        document.createTextNode('SPOTIFY'),
      ]),
    ]),
    el('div', { class: 'pane-sub', style: { marginBottom: '10px' }, text: 'Playing here by default. Paste a link to swap it for your own — it is saved to your account.' }),
    el('div', { class: 'media-input-row' }, [
      input,
      el('button', { class: 'btn', text: 'Load', onclick: load }),
      savedPlaylist()
        ? el('button', {
          class: 'btn',
          text: 'Default',
          title: 'Go back to the playlist this tab opens with',
          onclick: async () => {
            input.value = '';
            try { await updateSetting('spotifyPlaylist', ''); } catch { /* still shown for now */ }
            draw(DEFAULT_PLAYLIST);
          },
        })
        : null,
    ]),
    frame,
  ]);
}

// ── other media ──────────────────────────────────────────────────────────

/**
 * Turns a pasted URL into an embeddable player.
 *
 * The pane used to be SoundCloud-only: any other link fell through the
 * soundcloud.com match and showed "paste a SoundCloud link", so YouTube, Vimeo,
 * Bandcamp and a plain MP3 all silently failed. Each host below is mapped to
 * the iframe it needs; the generic branch embeds an <audio> element, which is
 * the one case that plays a bare file rather than a hosted page.
 *
 * Returns null when nothing matches, so the caller can say so honestly instead
 * of rendering an empty shell.
 */
function embedFor(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  // Accept a pasted link with or without the scheme, which is what people
  // actually paste — "youtu.be/..." more often than the full URL.
  let href = raw;
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;

  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  // Only http(s), so a javascript: or data: URL can never reach an iframe src.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '');

  // YouTube: watch?v=, youtu.be/, /embed/, /shorts/
  const ytId = (() => {
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
      return m ? m[1] : null;
    }
    return null;
  })();
  if (ytId) {
    return {
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}`,
      height: '380',
      label: 'YouTube',
    };
  }

  // Vimeo: vimeo.com/123456, with the optional /<hash> private-path form.
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/\/(\d{6,})/);
    if (m) return { src: `https://player.vimeo.com/video/${m[1]}`, height: '380', label: 'Vimeo' };
  }

  // SoundCloud, including /sets/ and the resolve short link.
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com' || host === 'snd.sc') {
    const m = raw.match(/soundcloud\.com\/([^/\s]+\/[^/\s?#]+)/);
    if (m) {
      return {
        src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${m[1]}`)}&color=%23ff5500&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=false`,
        height: '166',
        label: 'SoundCloud',
      };
    }
  }

  // Spotify: the embed host differs from the share host.
  if (host === 'open.spotify.com') {
    const m = u.pathname.match(/\/(track|album|playlist|artist|show|episode)\/([a-zA-Z0-9]+)/);
    if (m) {
      return {
        src: `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator&theme=0`,
        height: m[1] === 'track' || m[1] === 'episode' ? '120' : '340',
        label: 'Spotify',
      };
    }
  }

  // A direct audio file: the one case that plays rather than embeds a page.
  if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(u.pathname)) {
    return { audio: u.href, height: '54', label: 'Audio file' };
  }

  return null;
}

function otherMediaPane() {
  const input = el('input', {
    class: 'inp',
    placeholder: 'Paste any link — SoundCloud, YouTube, Spotify, a track file…',
    'aria-label': 'Media link',
  });
  const frame = el('div');

  const draw = (url) => {
    const embed = embedFor(url);
    frame.innerHTML = '';
    if (!embed) {
      frame.append(el('div', {
        class: 'media-placeholder',
        text: 'That link could not be played here. Paste a SoundCloud, YouTube, Vimeo or Spotify link, or a direct .mp3/.m4a/.ogg file.',
      }));
      return;
    }
    frame.append(el('div', { class: 'player-shell' }, [
      embed.audio
        ? el('audio', { controls: '', src: embed.audio, style: { width: '100%' } })
        : el('iframe', {
          src: embed.src,
          height: embed.height,
          frameborder: '0',
          allowfullscreen: '',
          allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
          scrolling: 'no',
          title: `${embed.label} player`,
        }),
    ]));
  };
  draw(mediaUrl);

  const load = () => {
    mediaUrl = input.value;
    draw(mediaUrl);
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') load(); });

  return el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'OTHER MEDIA' }),
      el('div', { class: 'sp-status' }, [
        el('div', { class: 'media-dot', style: { background: '#ff8a3d', boxShadow: '0 0 6px #ff8a3d' } }),
        document.createTextNode('ANY LINK'),
      ]),
    ]),
    el('div', { class: 'pane-sub', style: { marginBottom: '10px' }, text: 'SoundCloud, YouTube, Vimeo, Spotify, or a direct audio file.' }),
    el('div', { class: 'media-input-row' }, [
      input,
      el('button', { class: 'btn', text: 'Load', onclick: load }),
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
