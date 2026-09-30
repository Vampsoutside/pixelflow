# PixelFlow

A pixel-art pomodoro timer, study tracker and focus companion. Self-hosted, no
build step, no framework — an Express API over SQLite with a vanilla-JS front
end that draws everything, including the avatars and pets, on `<canvas>`.

Nine sections: **Timer, Tracker, Tasks, Friends, Media, Companion, Calendar,
Logs, Settings.**

## Stack

| | |
|---|---|
| Runtime | Node 24 (needs `node:sqlite`, built in — no native build step) |
| Server | Express 4, the only runtime dependency |
| Database | SQLite via `node:sqlite` |
| Front end | Vanilla ES modules, no bundler |
| Tests | `node:test` (18 unit tests) + a Playwright browser suite (84 checks) |

## Run it locally

```bash
npm install
npm start          # http://127.0.0.1:5173
```

The database is created and seeded automatically on first boot. Sign in as
**kira** or **milo** with the password **pixelflow**.

```bash
npm run dev        # same, with --watch
npm test           # unit tests
npm run seed       # add demo data again
npm run seed -- --reset   # wipe and re-seed
```

Copy `.env.example` to `.env` to enable the Spotify player.

## Project layout

```
api/index.js        Vercel serverless entry (re-exports the Express app)
server/
  app.js            builds the Express app — no listen(), so it can be hosted
  index.js          local entry: imports app.js and listens
  db.js             opens SQLite, falls back when the disk is read-only
  auth.js           sessions, password hashing, CSRF
  store.js          user/plan/task queries
  metrics.js        pure date + aggregation maths (unit tested)
  seed.js           demo data
  routes/           auth, study, friends, tasks, tags, logs, spotify
public/             the whole front end, served as-is
  js/pixel.js       shared grid + colour helpers
  js/avatar.js      pixel avatar renderer (dispatches to pets)
  js/pets.js        pixel cat/dog renderer
  js/wheels.js      the scrolling hour/minute wheels
tests/              node:test unit tests
vercel.json         Vercel routing config
```

## Deploying

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full walkthrough — GitHub
setup, Vercel setup, and the one database caveat you need to read before you
expect your data to stick around.

Short version:

```bash
git init && git add -A && git commit -m "PixelFlow"
git branch -M main
git remote add origin https://github.com/<you>/github-pomodoro.git
git push -u origin main
```

Then in Vercel: **Add New → Project → import the repo**. No build command, no
framework preset. `vercel.json` handles the routing.
