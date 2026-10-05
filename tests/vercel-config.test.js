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
  // The single explicit rewrite, for the one path that is served by Express
  // rather than as a static file.
  '/app': (path) => path === '/app',
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

  test('the api rewrite comes before anything else', () => {
    const shell = rewrites.find((r) => r.destination === '/index.html');
    // There is deliberately no catch-all now: every public page is a real file
    // and the app is served at /app, so nothing needs the SPA fallback. If one
    // is ever reintroduced it must come after /api and /app, or it will shadow
    // them. Asserted as "present rules are ordered", which is true either way.
    if (shell) {
      const at = rewrites.indexOf(shell);
      const api = rewrites.findIndex((r) => r.destination === '/api/index' && r.source.startsWith('/api'));
      assert.ok(api < at, '/api must be declared before any catch-all');
    }
  });

  test('there is no catch-all that could shadow a page', () => {
    // The bug this guards: Vercel evaluates rewrites BEFORE the filesystem, so
    // "/((?!api/).*)" -> /index.html made /about return the landing page with a
    // 200. Status checks pass, tests that only look for words pass, and the
    // page is simply the wrong document. With no catch-all, the real files win.
    const shell = rewrites.find((r) => r.destination === '/index.html');
    assert.ok(
      !shell,
      'no catch-all rewrite: every public page is a real file and the app is at /app'
    );
  });

  test('the api rewrite is the only rule besides /app', () => {
    assert.deepEqual(
      rewrites.map((r) => r.source).sort(),
      ['/api/(.*)', '/app'],
      'keep rewrites minimal — anything else shadows a static page'
    );
  });


  test('the static catch-all still spares api paths', () => {
    // Client-side routes are hash-based (#timer), so there is no server-side
    // route for them to serve. /tracker and /js/app.js resolve as files.
    assert.ok(!sourceOf('/index.html'), 'no catch-all; sections use hash routes');
    for (const asset of ['/js/app.js', '/css/site.css', '/logo.svg']) {
      assert.ok(existsSync(join(root, 'public', asset)), `public${asset} must exist`);
    }
  });

  test('static assets are served from public', () => {
    assert.equal(config.outputDirectory, 'public');
  });

  test('the app is served from the function, not a file', () => {
    // /app must reach Express so it can send app.html. If it were a plain file
    // path it would work too, but then the server would have no route for it
    // and local development would differ from production.
    const app = rewrites.find((r) => r.source === '/app');
    assert.ok(app, '/app needs its own rewrite to the function');
    assert.equal(app.destination, '/api/index');
  });

  test('the public pages exist as real files, not rewrites', () => {
    // /about, /privacy and /terms are static files now, so they need no rewrite
    // and must not be given one: a rewrite would send them to Express, which
    // does not know those paths.
    for (const file of ['about.html', 'privacy.html', 'terms.html',
      'support.html', 'products.html', 'logo.svg']) {
      assert.ok(existsSync(join(root, 'public', file)), `public/${file} must exist`);
    }
    for (const path of ['/about', '/privacy', '/terms']) {
      assert.ok(
        !rewrites.some((r) => r.source === path),
        `${path} is a static file and should not have a rewrite`
      );
    }
  });


  test('the landing page and the app are separate files', () => {
    // The whole point of the split: / must explain the app to a crawler, and
    // the login form must not be on it.
    assert.ok(existsSync(join(root, 'public', 'index.html')), 'landing page at /');
    assert.ok(existsSync(join(root, 'public', 'app.html')), 'app shell at /app');

    const landing = readFileSync(join(root, 'public', 'index.html'), 'utf8');
    assert.ok(!landing.includes('id="auth-overlay"'), '/ must not contain the login form');

    const app = readFileSync(join(root, 'public', 'app.html'), 'utf8');
    assert.ok(app.includes('id="auth-overlay"'), '/app keeps the login form');
  });
});
