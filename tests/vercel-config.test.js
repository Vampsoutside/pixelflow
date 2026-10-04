/**
 * Deployment configuration.
 *
 * These are assertions about `vercel.json`, not about the running app. They
 * exist because the failure they guard against is invisible locally: `vercel
 * dev` and `npm start` both serve every route, while a misconfigured Vercel
 * project answers 404 at the routing layer before Express is ever reached.
 *
 * The specific bug: Vercel maps a file in /api to the route matching its path,
 * so `api/index.js` serves `/api` and nothing else. Without the rewrite below,
 * `/api/auth/signup` 404s on the deployed site while working perfectly on a
 * developer's machine.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const rewrites = config.rewrites || [];

const sourceOf = (destination) => rewrites.find((r) => r.destination === destination)?.source;

/**
 * Would this rewrite source match a given path?
 *
 * Written out by hand rather than compiled: Vercel's `source` is not plain
 * regex, and a half-right translation would let a broken config pass. If the
 * config ever grows a pattern that is not listed here, the assertion below
 * fails loudly instead of quietly testing nothing.
 */
const MATCHERS = {
  '/api/(.*)': (path) => path === '/api' || path.startsWith('/api/'),
  '/((?!api/).*)': (path) => !path.startsWith('/api/'),
  // Explicit single-path rewrites to the function, for the pages that must not
  // be swallowed by the SPA catch-all.
  '/privacy': (path) => path === '/privacy',
  '/terms': (path) => path === '/terms',
};

function matches(source, path) {
  const match = MATCHERS[source];
  assert.ok(match, `no matcher for rewrite source "${source}" — add one if vercel.json changed`);
  return match(path);
}

describe('vercel.json', () => {
  test('sends every /api/* path to the function', () => {
    const source = sourceOf('/api/index');
    assert.ok(source, 'expected a rewrite forwarding /api to the function');

    // The paths that broke in production, plus the bare /api itself.
    for (const path of [
      '/api',
      '/api/health',
      '/api/me',
      '/api/auth/session',
      '/api/auth/signup',
      '/api/auth/login',
      '/api/auth/guest',
      '/api/auth/claim',
      '/api/auth/google/login',
      '/api/auth/google/callback',
      '/api/study/overview',
      '/api/tasks',
      '/api/friends/search',
    ]) {
      assert.ok(matches(source, path), `${path} would not reach the function`);
    }
  });

  test('the function is the only one declared', () => {
    const declared = Object.keys(config.functions || {});
    assert.deepEqual(declared, ['api/index.js']);
  });

  test('the api rewrite comes before the static catch-all', () => {
    // Order matters: the catch-all must not swallow API requests first.
    const apiAt = rewrites.findIndex((r) => r.destination === '/api/index');
    const htmlAt = rewrites.findIndex((r) => r.destination === '/index.html');
    assert.ok(apiAt !== -1 && htmlAt !== -1, 'expected both rewrites');
    assert.ok(apiAt < htmlAt, 'the /api rewrite must be listed first');
  });

  test('the static catch-all still spares api paths', () => {
    const source = sourceOf('/index.html');
    assert.ok(source, 'expected a rewrite serving the app shell');
    assert.ok(!matches(source, '/api/auth/signup'));
    assert.ok(matches(source, '/tracker'));
    assert.ok(matches(source, '/js/app.js'));
  });

  test('static assets are served from public', () => {
    assert.equal(config.outputDirectory, 'public');
  });

  test('the privacy policy is not swallowed by the SPA catch-all', () => {
    // Google requires a publicly reachable privacy policy at a URL on the
    // verified domain. The app-shell rewrite matches every non-API path, so
    // without an explicit rule ahead of it, /privacy returns the SPA HTML with
    // a 200 — which looks fine to a status check and fails review outright.
    const shell = sourceOf('/index.html');
    assert.ok(shell, 'expected the SPA catch-all');

    const legal = ['/privacy', '/terms'];
    for (const path of legal) {
      const explicit = rewrites.find((r) => r.source === path);
      assert.ok(explicit, `${path} needs its own rewrite to the function`);
      assert.equal(explicit.destination, '/api/index', `${path} should reach the server`);
    }

    // And the explicit rules must come first, or the catch-all wins.
    const firstShell = rewrites.findIndex((r) => r.destination === '/index.html');
    for (const path of legal) {
      const at = rewrites.findIndex((r) => r.source === path);
      assert.ok(at < firstShell, `${path} must be declared before the SPA catch-all`);
    }
  });

  test('the legal pages exist in the output directory', () => {
    // A rewrite pointing at a file that is not deployed serves nothing useful,
    // and the config test alone would still pass.
    for (const file of ['privacy.html', 'terms.html']) {
      const p = join(root, 'public', file);
      assert.ok(existsSync(p), `public/${file} must exist to be served`);
    }
  });
});
