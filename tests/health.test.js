/**
 * The health endpoint has to survive a database that cannot be reached.
 *
 * Without this, a serverless host that cannot give us a database answers every
 * request with an opaque 500 — including the health check — and there is no way
 * to tell a misconfigured TURSO_DATABASE_URL from a missing native module from
 * a boot that never finished. The payload names the problem instead.
 *
 * The failure case needs its own process, because db.js resolves its target
 * once at import time and a booted module cannot be re-pointed afterwards.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'pf-health-'));

process.env.DB_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = 'test-secret';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { default: app } = await import('../server/app.js');

let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/** Boots the app in a child process and returns what /api/health says. */
async function healthInChild(env) {
  const script = `
    const app = (await import(${JSON.stringify(join(root, 'server/app.js'))})).default;
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const res = await fetch('http://127.0.0.1:' + srv.address().port + '/api/health');
    process.stdout.write(JSON.stringify({ status: res.status, body: await res.json() }));
    srv.close();
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DB_PATH: join(dir, 'child.db'), ...env },
  });
  return JSON.parse(stdout);
}

describe('a working database', () => {
  test('reports ok, the user count and where data lives', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.users, 'number');
    // This suite's database lives in a temp directory, which is outside both
    // the project and data/, so "ephemeral" is the correct answer here.
    assert.equal(body.storage, 'ephemeral');
    assert.equal(body.databaseError, undefined);
    assert.match(body.databasePath, /pf-health-/);
  });
});

describe('an unreachable database', () => {
  test('health explains the failure rather than 500ing silently', async () => {
    // Port 1 refuses connections, so this is an unreachable endpoint rather
    // than a slow one — the shape of a wrong TURSO_DATABASE_URL.
    const { status, body } = await healthInChild({
      TURSO_DATABASE_URL: 'libsql://127.0.0.1:1/nope',
      TURSO_AUTH_TOKEN: 'invalid',
    });

    // The point of the endpoint: it still answers, and it says what is wrong.
    assert.equal(body.ok, false);
    assert.equal(body.storage, 'turso');
    assert.equal(typeof body.databaseError, 'string');
    assert.ok(body.databaseError.length > 0);
    // Naming the URL is what makes it actionable.
    assert.match(body.databasePath, /127\.0\.0\.1:1/);
    // A 500 is fine here; an unparseable or empty reply would not be.
    assert.ok(status === 500 || status === 200);
  });

  test('the boot did not throw — the process reached the response', async () => {
    // A module-load failure would kill the process before any response, which
    // is exactly the opaque 500 this work was meant to eliminate.
    const { body } = await healthInChild({
      TURSO_DATABASE_URL: 'libsql://127.0.0.1:1/nope',
    });
    assert.ok('databaseError' in body);
  });
});

describe('the health payload shape', () => {
  test('always answers JSON with the same keys', async () => {
    // It is the one endpoint a person can open in a browser, so it has to be
    // readable in every state.
    const res = await fetch(`${base}/api/health`);
    assert.ok(res.headers.get('content-type').includes('application/json'));
    const body = await res.json();
    assert.ok('ok' in body && 'storage' in body);
  });

  test('reports the path when storage is ephemeral', async () => {
    // Without this, "ephemeral" does not say where the data went.
    const { body } = await healthInChild({ DB_PATH: '/tmp/pf-health-ephemeral.db' });
    assert.equal(body.storage, 'ephemeral');
    assert.match(body.databasePath, /pf-health-ephemeral\.db$/);
  });
});
