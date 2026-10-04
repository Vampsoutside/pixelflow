# Google OAuth verification — what to do before this app serves the public

Verified against Google's own documentation:
[Comply with OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
and [Submit for brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

## Done in this repository

- **Privacy Policy** at `/privacy` and **Terms of Use** at `/terms`. Both public,
  no sign-in required, which is what the consent screen links to.
- **A way to delete the account and all its data** — Settings → Delete account.
  Required by the API Services User Data Policy; the app had no such route.
- **Least-privilege scopes.** The Calendar flow requests
  `.../auth/calendar.events` — view and edit events — instead of `.../auth/calendar`,
  which grants "see, edit, share, and permanently delete all the calendars you can
  access". The app only ever touches events on the primary calendar. It does not
  request `calendar.acls`, `calendar.calendarlist` or `calendar.calendars`.
- **HTTPS-only callbacks**, built from `PUBLIC_ORIGIN`. Google rejects plain HTTP
  redirect URIs outright.
- **Privacy notices that match reality.** The Settings copy previously claimed
  data never left the machine; it does now say what is stored and who processes it.

## Still yours to do — none of this can be done from code

### 1. Enable the API

OAuth consent screen → **APIs & Services → Library** → enable **Google Calendar API**.
Sign-in works without it; Calendar sync returns 403 without it.

### 2. Branding page

OAuth consent screen → **Branding**:

| Field | Value |
|---|---|
| App name | `PixelFlow` |
| Homepage | `https://stitch-flax.vercel.app` |
| Privacy policy | `https://stitch-flax.vercel.app/privacy` |
| Terms of service | `https://stitch-flax.vercel.app/terms` |
| Application logo | 128x128 PNG, on the domain you own |
| App domain | `stitch-flax.vercel.app` |

Logo and app name are checked against what the app actually shows. Use the real
name and mark you already use in the app.

### 3. Authorized redirect URIs

OAuth consent screen → **Clients → your Web client**:

```
https://stitch-flax.vercel.app/api/auth/google/callback
https://stitch-flax.vercel.app/api/googlecalendar/callback
```

Both. The first is sign-in, the second is Calendar sync. Exact match, no
trailing slash, no wildcards.

### 4. Scope justification

Verification asks you to justify every sensitive scope. Copy this:

> `openid`, `email` — identify the signed-in user so they can use their existing
> Google account without creating another one. Used only for authentication; not
> used for advertising or analytics.
>
> `https://www.googleapis.com/auth/calendar.events` — the core feature of this
> app. A user connects their calendar to see the events they scheduled alongside
> the study hours they plan, and to reach their schedule on any device. The app
> reads events for the calendar the user connects and writes events the user
> creates or edits in PixelFlow. It does not access calendar sharing, the list of
> calendars, or calendar properties, and it does not access any other account.

### 5. Publish

Set the audience to **Production** to publish. Until you do, the app stays in
**Testing**: only accounts you list as *test users* can sign in, and Google shows
an "unverified app" warning. That is fine for personal use and is not fine for
anyone else.

### 6. Verification

Branding page → **Verify Branding**. Automated where possible (minutes);
otherwise a manual review, typically 2-3 business days.

Note the separate-project requirement: Google's policy asks that production use
an OAuth client with no developer-only redirect URIs or pre-release origins. If
your project still has `http://127.0.0.1:5173/...` registered, remove it, or move
production to its own project.

## What this app does not do

No advertising, no analytics or tracking SDKs, no third-party cookies, no sale or
sharing of data. Friends see only username, avatar, level, and study totals — see
the Friends section of `/privacy`. Those facts are worth stating in your
verification submission: they are the strongest argument that the scopes are
proportionate.

## If verification is refused

The usual causes are a scope without a specific justification, a privacy policy
that does not name the data collected, or a demo video that does not show the
feature using the scope. Only the video is missing here — record the sign-in, the
Calendar connect, a sync pulling an event in, and an edit made in PixelFlow
appearing in Google Calendar.
