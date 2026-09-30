# Deploying PixelFlow

Two things to do: push to GitHub, then import the repo into Vercel. Everything
is already in this folder — there is nothing to configure in the dashboard
beyond picking the repo.

---

## Read this first: where the data lives

PixelFlow stores everything in a single SQLite file. Vercel runs your code as
**serverless functions**, and those have **no disk that outlives a single
invocation** — the filesystem is a read-only bundle plus a scratch `/tmp` that
is thrown away when the instance recycles.

`server/db.js` handles this by trying the local `data/` directory first, then
`/tmp`, then in-memory. On Vercel it will land on one of the last two, so:

- The app **boots and works** — the first visitor makes their own account.
- Your data **does not persist**, and concurrent instances do not share it.

`GET /api/health` tells you which mode you are in:

```json
{ "ok": true, "users": 3, "storage": "ephemeral" }
```

`"turso"` means a hosted database is wired up, `"persistent"` means you have a
real disk, `"ephemeral"` means you are on a serverless host with per-instance
storage.

### If you need real data to stick

Pick one:

**A. A host with a real disk — zero code changes.** Render, Railway, Fly.io or
any VPS run `npm start` as-is and the SQLite file persists. Use Vercel only for
the front end if you want a CDN in front, or skip Vercel entirely.

**B. A hosted SQLite (Turso / libSQL) on Vercel — the recommended path.**
`server/db.js` speaks libSQL already, so this is a config change: set the two
`TURSO_*` variables and the same code talks to a hosted database instead of a
local file. See [Using Turso](#using-turso) below.

Do not try to work around this by pointing `DB_PATH` at a file in the repo —
the bundle is read-only and discarded on every deploy regardless.

### Using Turso

```bash
npm install -g @libsql/cli
turso login
turso db create pixelflow            # note the URL it prints
turso db tokens create pixelflow --json   # note the JWT
```

Then set both variables — in `.env` locally, or in Vercel under
**Settings → Environment Variables**:

```
TURSO_DATABASE_URL=libsql://your-db-xyz.turso.io
TURSO_AUTH_TOKEN=eyJhbGciOi...
```

`TURSO_DATABASE_URL` is all that is required; the token is only needed if the
database is not fully public. When both are set, `GET /api/health` reports
`"storage": "turso"`.

The schema is applied automatically on every boot, so there is no separate
migration step to run.

---

## 1. Push to GitHub

```bash
cd github-pomodoro
git init
git add -A
git commit -m "PixelFlow — pixel pomodoro and study tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/github-pomodoro.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `.env` and `data/*.db`, so the
database and your Spotify secrets stay out of the repo.

## 2. Import into Vercel

**Via the dashboard (no CLI needed):**

1. Go to [vercel.com/new](https://vercel.com/new).
2. Sign in with GitHub and install the Vercel GitHub app on the repo.
3. Import `github-pomodoro`.
4. Leave **Framework Preset** as *Other* and **Build Command** empty —
   `vercel.json` already sets these.
5. Deploy.

**Via the CLI:**

```bash
npx vercel            # first time: log in, link the project
npx vercel --prod     # ship it
npx vercel dev        # run the whole thing locally first
```

Vercel picks Node **24** from `engines.node` in `package.json`, which is the
line where `node:sqlite` is available without a command-line flag.

### How the routing works

`vercel.json` sets `public/` as the output directory, so Vercel's CDN serves the
front end directly. Anything under `/api/` invokes `api/index.js`, which
re-exports the same Express app `npm start` uses. Vercel checks the filesystem
and functions before applying rewrites, so the SPA fallback
(`/whatever/path` → `/index.html`) never swallows an API call.

## 3. Environment variables

Only needed if you want the Spotify player. Add them under
**Project → Settings → Environment Variables**:

| Variable | Purpose |
|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify app client id |
| `SPOTIFY_CLIENT_SECRET` | Spotify app client secret |
| `TURSO_DATABASE_URL` | hosted database URL — set this on Vercel so data persists |
| `TURSO_AUTH_TOKEN` | token for that database |

The Spotify **redirect URI** in your Spotify developer dashboard must match your
Vercel domain exactly, e.g. `https://your-app.vercel.app/api/spotify/callback`.
Until that matches, the Media section falls back to the embedded player and a
SoundCloud box — which is the intended behaviour, not a break.

## 4. After deploying

Open the site and click **Create an account** to register the first user. No
demo accounts are created, and there are no preset credentials shipped with the
app.

Note that sign-up is open to anyone with the URL. If you would rather it not
be, delete the deploy or put the project behind Vercel Authentication under
**Settings → Security**.

Check `/api/health` first if anything looks wrong:

```bash
curl https://your-app.vercel.app/api/health
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `storage: "ephemeral"` | Expected on Vercel. See the database note above. |
| Blank page, console 404 on a JS file | `outputDirectory` is not `public`. Check `vercel.json`. |
| `No such endpoint` on every API call | The function is not matching. Confirm `api/index.js` exists and the repo root is the project root. |
| `node:sqlite` not found | Runtime is below Node 24. Check the Node version Vercel reports. |
| Login works, then everything 500s | The instance recycled and lost the in-memory database. Expected without a hosted DB. |
