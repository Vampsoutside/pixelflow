/**
 * Where OAuth callbacks point.
 *
 * The bug this exists to prevent: both the Spotify and Google Calendar flows
 * used to fall back to http://127.0.0.1:<PORT>/... when no provider-specific
 * redirect variable was set. That is right on a laptop and wrong everywhere
 * else. On Vercel, PORT is an internal port, so the app cheerfully told Google
 * and Spotify that its callback lived at http://127.0.0.1:3000/... and the
 * provider rejected the request with redirect_uri_mismatch — a configuration
 * step that looked like it simply refused to work.
 *
 * The rule, for every provider: an explicit <PROVIDER>_REDIRECT_URI wins,
 * otherwise the callback is built from PUBLIC_ORIGIN, and only when neither
 * exists does it fall back to loopback for local development.
 *
 * These are computed at import time from the environment, so each case is a
 * separate import of the same module with different env — hence the cache-
 * busting query strings.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const SPOTIFY = '../server/routes/spotify.js';
const GCAL = '../server/routes/googlecalendar.js';

/** Imports a route module with a known environment, freshly each time. */
async function load(specifier, env, salt) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod = await import(`${specifier}?salt=${salt}`);
    return mod;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('spotify redirect uri', () => {
  test('is built from PUBLIC_ORIGIN when deployed', async () => {
    const { REDIRECT_URI } = await load(
      SPOTIFY,
      { PUBLIC_ORIGIN: 'https://stitch-flax.vercel.app', SPOTIFY_REDIRECT_URI: undefined, PORT: undefined },
      'puborigin'
    );
    assert.equal(REDIRECT_URI, 'https://stitch-flax.vercel.app/api/spotify/callback');
  });

  test('an explicit SPOTIFY_REDIRECT_URI still wins', async () => {
    const { REDIRECT_URI } = await load(
      SPOTIFY,
      {
        PUBLIC_ORIGIN: 'https://stitch-flax.vercel.app',
        SPOTIFY_REDIRECT_URI: 'https://elsewhere.example/cb',
        PORT: undefined,
      },
      'explicit'
    );
    assert.equal(REDIRECT_URI, 'https://elsewhere.example/cb');
  });

  test('falls back to loopback only when nothing is configured', async () => {
    const { REDIRECT_URI } = await load(
      SPOTIFY,
      { PUBLIC_ORIGIN: undefined, SPOTIFY_REDIRECT_URI: undefined, PORT: '5173' },
      'loopback'
    );
    assert.equal(REDIRECT_URI, 'http://127.0.0.1:5173/api/spotify/callback');
  });

  test('a trailing slash on PUBLIC_ORIGIN does not double up', async () => {
    const { REDIRECT_URI } = await load(
      SPOTIFY,
      { PUBLIC_ORIGIN: 'https://stitch-flax.vercel.app/', SPOTIFY_REDIRECT_URI: undefined, PORT: undefined },
      'slash'
    );
    assert.equal(REDIRECT_URI, 'https://stitch-flax.vercel.app/api/spotify/callback');
  });

  test('never points a deployed origin at localhost', async () => {
    // PORT is always set on Vercel. If this regresses, the callback silently
    // becomes unreachable in production while working fine locally.
    const { REDIRECT_URI } = await load(
      SPOTIFY,
      { PUBLIC_ORIGIN: 'https://stitch-flax.vercel.app', SPOTIFY_REDIRECT_URI: undefined, PORT: '3000' },
      'deployport'
    );
    assert.ok(!REDIRECT_URI.includes('127.0.0.1'), `deployed redirect must not be loopback: ${REDIRECT_URI}`);
  });
});

describe('google calendar redirect uri', () => {
  test('is built from PUBLIC_ORIGIN when deployed', async () => {
    const { REDIRECT_URI } = await load(
      GCAL,
      { PUBLIC_ORIGIN: 'https://stitch-flax.vercel.app', GOOGLE_CALENDAR_REDIRECT_URI: undefined, PORT: undefined },
      'puborigin'
    );
    assert.equal(REDIRECT_URI, 'https://stitch-flax.vercel.app/api/googlecalendar/callback');
  });

  test('an explicit GOOGLE_CALENDAR_REDIRECT_URI still wins', async () => {
    const { REDIRECT_URI } = await load(
      GCAL,
      {
        PUBLIC_ORIGIN: 'https://stitch-flax.vercel.app',
        GOOGLE_CALENDAR_REDIRECT_URI: 'https://elsewhere.example/gcb',
        PORT: undefined,
      },
      'explicit'
    );
    assert.equal(REDIRECT_URI, 'https://elsewhere.example/gcb');
  });

  test('falls back to loopback only when nothing is configured', async () => {
    const { REDIRECT_URI } = await load(
      GCAL,
      { PUBLIC_ORIGIN: undefined, GOOGLE_CALENDAR_REDIRECT_URI: undefined, PORT: '5173' },
      'loopback'
    );
    assert.equal(REDIRECT_URI, 'http://127.0.0.1:5173/api/googlecalendar/callback');
  });

  test('never points a deployed origin at localhost', async () => {
    const { REDIRECT_URI } = await load(
      GCAL,
      { PUBLIC_ORIGIN: 'https://stitch-flax.vercel.app', GOOGLE_CALENDAR_REDIRECT_URI: undefined, PORT: '3000' },
      'deployport'
    );
    assert.ok(!REDIRECT_URI.includes('127.0.0.1'), `deployed redirect must not be loopback: ${REDIRECT_URI}`);
  });
});

describe('the sign-in flows already had this right', () => {
  test('google sign-in uses PUBLIC_ORIGIN', async () => {
    const { redirectUri } = await import('../server/oauth.js');
    assert.equal(
      redirectUri('google'),
      `${(process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PORT || 5173}`).replace(/\/+$/, '')}/api/auth/google/callback`
    );
  });
});