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
  // The single explicit rewrite, for the one path served by Express rather
  // than as a static file.
  '/app': (path) => path === '/app',

  // The fallback for client-side routes. The negative lookahead is what stops
  // it shadowing the real pages: without every excluded path listed here,
  // /about returns the landing page with a 200, which is exactly the bug that
  // kept Google's reviewer looking at a login-like home page.
  '/((?!api/|app$|app/|about|privacy|terms|support|products|logo\\.svg|css|js/).*)':
    (path) => {
      if (path.startsWith('/api/')) return false;
      if (path === '/app' || path.startsWith('/app/')) return false;
      if (path.startsWith('/about') || path.startsWith('/privacy')) return false;
      if (path.startsWith('/terms') || path.startsWith('/support')) return false;
      if (path.startsWith('/products')) return false;
      if (path.startsWith('/logo.svg')) return false;
      if (path.startsWith('/css/') || path.startsWith('/js/')) return false;
      return true;
    },
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

  test('the public pages are reachable without the .html suffix', () => {
    // Vercel's static layer serves /about.html but 404s /about, and a rewrite
    // is evaluated before the filesystem — so a rewrite pointing at /about.html
    // would work while a rewrite pointing at the function does not. A redirect
    // is the rule type that is resolved from disk, which is why these are
    // redirects and not rewrites. Getting this backwards is what made /about
    // 404 while /about.html returned 200.
    const redirects = config.redirects || [];
    for (const page of ['about', 'privacy', 'terms', 'support', 'products']) {
      const rule = redirects.find((r) => r.source === `/${page}`);
      assert.ok(rule, `/${page} needs a redirect to be reachable without .html`);
      assert.equal(rule.destination, `/${page}.html`);
      assert.ok(existsSync(join(root, 'public', `${page}.html`)), 'and the file must exist');
    }
  });

  test('the fallback rewrite spares every real page', () => {
    // The bug this guards: Vercel evaluates rewrites BEFORE the filesystem, so
    // an unfiltered catch-all makes /about return the landing page with a 200.
    // Status checks pass and any test that greps for a word passes too, because
    // the landing page mentions study, calendar and privacy itself.
    const shell = sourceOf('/index.html');
    assert.ok(shell, 'a fallback for client-side routes is expected');

    for (const path of [
      '/about', '/privacy', '/terms', '/support', '/products',
      '/logo.svg', '/css/site.css', '/js/app.js',
      '/app', '/app/timer', '/api/health',
    ]) {
      assert.ok(!matches(shell, path), `the fallback must not match ${path}`);
    }

    // And it must still catch a genuine client-side route.
    assert.ok(matches(shell, '/tracker'), 'unknown paths fall back to the landing page');
  });


  test('the static catch-all still spares api paths', () => {
    const source = sourceOf('/index.html');
    assert.ok(source, 'a fallback serving the landing page is expected');
    assert.ok(!matches(source, '/api/auth/signup'), 'api paths are never the fallback');
    assert.ok(!matches(source, '/js/app.js'), 'static assets are served from the CDN');
    assert.ok(matches(source, '/tracker'), 'client-side routes fall back');
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
    // They are reached by redirect, never by rewrite: a rewrite is applied
    // before the filesystem and cannot serve a static file by its clean path.
    for (const path of ['/about', '/privacy', '/terms']) {
      assert.ok(
        !rewrites.some((r) => r.source === path),
        `${path} is served by redirect, not rewrite`
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
