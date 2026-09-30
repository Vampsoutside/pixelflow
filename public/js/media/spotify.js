import { api } from '../api.js';
import { store } from '../store.js';
import { toast, loadScript } from '../ui.js';

/**
 * Spotify Web Playback SDK integration.
 *
 * The SDK is a browser-only library that registers this account as a Spotify
 * Connect device, which is what makes real play/pause/next/seek possible from
 * the page. Three things it needs from us:
 *
 *   1. a registered app (client id + secret on the server)
 *   2. a valid OAuth access token, refreshed hourly by the server
 *   3. a Spotify **Premium** account — free accounts cannot play in-browser
 *
 * When no client id is configured every function here resolves to a disabled
 * player so the Media tab degrades to the simple embed player instead of
 * breaking.
 */

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
const sdkState = { loading: null };

export async function spotifyConfig() {
  try {
    const config = await api.get('/api/spotify/config');
    store.spotify.configured = config.configured;
    return config;
  } catch {
    store.spotify.configured = false;
    return { configured: false };
  }
}

export async function spotifyStatus() {
  try {
    const { connected } = await api.get('/api/spotify/status');
    store.spotify.connected = connected;
    return connected;
  } catch {
    return false;
  }
}

/**
 * Boots the SDK and connects a player.
 *
 * @param {object} callbacks
 * @param {(track: object|null) => void} callbacks.onState  called on every change
 * @param {(message: string) => void}    callbacks.onError
 * @param {() => void}                   callbacks.onReady
 */
export async function initSpotify({ onState, onError, onReady }) {
  if (!store.spotify.configured) {
    onError?.('Spotify is not configured on this server.');
    return null;
  }
  if (store.spotify.player) return store.spotify.player;
  if (sdkState.loading) return sdkState.loading;

  sdkState.loading = new Promise((resolve) => {
    // The SDK calls this global when it is ready to accept a Player.
    window.onSpotifyWebPlaybackSDKReady = () => {
      const player = new window.Spotify.Player({
        name: 'PixelFlow',
        volume: store.sounds.master,
        enableMediaSession: true,
        // Invoked on every connect and whenever the token looks stale, so it
        // must always be asynchronous and must never throw.
        getOAuthToken: (callback) => {
          api.get('/api/spotify/token')
            .then((data) => callback(data.access_token))
            .catch(() => onError?.('Spotify token refresh failed — reconnect your account.'));
        },
      });

      player.addListener('ready', ({ device_id: deviceId }) => {
        store.spotify.ready = true;
        store.spotify.deviceId = deviceId;
        onReady?.();
        // Spotify must be told to route playback through this device.
        player.connect().catch(() => {});
      });

      player.addListener('not_ready', () => {
        store.spotify.ready = false;
        onState?.(null);
      });

      player.addListener('player_state_changed', (state) => {
        store.spotify.state = state;
        onState?.(state);
      });

      player.addListener('authentication_error', (error) => {
        store.spotify.ready = false;
        onError?.(`Spotify rejected the login: ${error?.message || 'unknown error'}`);
      });

      player.addListener('account_error', (error) => {
        store.spotify.ready = false;
        onError?.(`Spotify playback needs a Premium account. (${error?.message || 'not premium'})`);
      });

      player.addListener('playback_error', (error) => {
        onError?.(`Playback problem: ${error?.message || 'unknown error'}`);
      });

      store.spotify.player = player;
      resolve(player);
    };

    loadScript(SDK_SRC).catch(() => {
      onError?.('Could not load the Spotify SDK — check your connection.');
      resolve(null);
    });
  });

  return sdkState.loading;
}

/** Renders the current track into the persistent dock. */
export function paintDock(state) {
  const dock = document.getElementById('spotify-dock');
  if (!dock) return;

  const track = state?.track_window?.current_track || null;
  dock.hidden = false;

  const playing = Boolean(state && !state.paused);

  document.getElementById('sp-play').textContent = playing ? '❚❚' : '▶';
  document.getElementById('sp-play').disabled = !store.spotify.ready;

  for (const id of ['sp-prev', 'sp-next', 'sp-shuffle', 'sp-repeat']) {
    const node = document.getElementById(id);
    if (node) node.disabled = !store.spotify.ready;
  }

  document.getElementById('sp-shuffle')?.classList.toggle('active', Boolean(state?.shuffle));
  document.getElementById('sp-repeat')?.classList.toggle('active', Boolean(state?.repeat_mode));

  if (!track) {
    setText('sp-track', 'Nothing playing');
    setText('sp-artist', 'Pick something to play on Spotify');
    document.getElementById('sp-art').style.backgroundImage = '';
    setWidth('sp-fill', 0);
    setText('sp-pos', '0:00');
    setText('sp-dur', '0:00');
    return;
  }

  setText('sp-track', track.name || 'Unknown track');
  setText('sp-artist', (track.artists || []).map((a) => a.name).join(', ') || 'Unknown artist');

  const art = document.getElementById('sp-art');
  const image = track.album?.images?.[0]?.url;
  if (image) {
    art.style.backgroundImage = `url("${image}")`;
    art.textContent = '';
  } else {
    art.style.backgroundImage = '';
    art.textContent = '♪';
  }

  const position = state.position || 0;
  const duration = track.duration || 0;
  setWidth('sp-fill', duration > 0 ? (position / duration) * 100 : 0);
  setText('sp-pos', stamp(position));
  setText('sp-dur', stamp(duration));
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}
function setWidth(id, percent) {
  const node = document.getElementById(id);
  if (node) node.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}
function stamp(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Wires the dock's buttons once, at boot. */
export function bindDock() {
  const player = () => store.spotify.player;
  const call = (fn, ...args) => {
    const p = player();
    if (!p) { toast('Spotify is not connected', 2500); return; }
    try {
      const result = fn.call(p, ...args);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* player mid-transition; the next state event will resync */ }
  };

  document.getElementById('sp-play')?.addEventListener('click', () => call((p) => p.togglePlay()));
  document.getElementById('sp-next')?.addEventListener('click', () => call((p) => p.nextTrack()));
  document.getElementById('sp-prev')?.addEventListener('click', () => call((p) => p.previousTrack()));
  document.getElementById('sp-shuffle')?.addEventListener('click', () => {
    const p = player();
    if (p) call((x) => x.setShuffle(!store.spotify.state?.shuffle));
  });
  document.getElementById('sp-repeat')?.addEventListener('click', () => {
    // 0 = off, 1 = context, 2 = track.
    const next = ((store.spotify.state?.repeat_mode || 0) + 1) % 3;
    call((p) => p.setRepeat(next));
  });

  document.getElementById('sp-volume')?.addEventListener('input', (event) => {
    const value = Number(event.target.value) / 100;
    store.sounds.master = value;
    call((p) => p.setVolume(value));
  });

  // Clicking the progress bar seeks to that point.
  document.getElementById('sp-progress')?.addEventListener('click', (event) => {
    const p = player();
    if (!p || !store.spotify.state?.track_window?.current_track?.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    call((x) => x.seek(ratio * store.spotify.state.track_window.current_track.duration));
  });

  // The progress bar only updates when Spotify tells us something changed, so
  // a light local interpolation keeps it moving between events.
  setInterval(() => {
    const state = store.spotify.state;
    if (!state || state.paused) return;
    const duration = state.track_window?.current_track?.duration || 0;
    if (!duration) return;
    store.spotify.state = { ...state, position: (state.position || 0) + 1000 };
    paintDock(store.spotify.state);
  }, 1000);
}
