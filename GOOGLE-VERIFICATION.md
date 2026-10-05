# Google OAuth verification — status and remaining steps

## Why the first two submissions were rejected

Google's reviewer fetches the **Home page URL from the consent screen** without
running JavaScript. Twice, that URL resolved to the login-walled app shell, so
the reviewer saw a sign-in form and nothing else:

> Your home page is behind a login page. / Your home page does not explain the
> purpose of your app. / The app name "stitch" configured for your OAuth consent
> screen does not match the app name on your home page.

The app name mismatch was a separate thing: the Vercel project was called
`stitch` while the product is called PixelFlow.

## What changed

**The app moved from `/` to `/app`.** This is the structural fix. `/` is now a
public marketing page — hero, feature grid, data-handling summary, working links
— that explains the app to anyone who has not signed in. `/app` serves the
login-walled shell exactly as before. Every provider return (sign-in, Calendar
sync, Spotify) now redirects to `/app?...` so an OAuth callback still lands in
the app rather than on the landing page.

**A logo.** `/logo.svg` — a pixel-art timer face with a flowing trail, drawn on
an 8px grid so it stays legible as a favicon. Used in the header, hero, footer
and favicon of every public page.

**New pages**, all public, all sharing `/css/site.css`:
- `/about` — what the app does, who it is for, how data is handled
- `/products` — the full feature table, and what is deliberately absent
- `/support` — common questions, self-service delete, contact and security routes
- `/privacy`, `/terms` — rebuilt on the shared nav, header and footer

## Two things only you can do

### 1. Turn off Vercel Deployment Protection

This is very likely the remaining blocker. The project currently reports:

```
ssoProtection:      enabled, all_except_custom_domains
passwordProtection: disabled
```

So `https://pixelflow-vampsoutside.vercel.app` redirects to
`https://vercel.com/sso-api?...` — **a login page**. If Google's reviewer follows
the Home page URL to the project's own domain, they hit a Vercel sign-in wall and
report exactly the error you received, no matter what the page contains.

Dashboard → project **Settings → Deployment Protection** → turn off Vercel
Authentication.

`stitch-flax.vercel.app` is a custom domain on this project and is already
public, which is why that one works. The protection applies to the project's own
`*.vercel.app` domains.

### 2. Fix the consent screen fields

| Field | Value |
|---|---|
| App name | `PixelFlow` |
| Home page | your public URL — **no `#fragment`**, no trailing slash |
| Privacy policy | `https://<your-domain>/privacy` |
| Terms of service | `https://<your-domain>/terms` |

The home page must be reachable with no sign-in and must describe the app. `/` now
does that.

Then **wait 24 hours** before resubmitting, as Google's message asks — it is
propagating the domain-ownership check.

## Already done

- Privacy Policy and Terms of Use, public and crawler-visible.
- Account deletion (`DELETE /api/me`, in Settings), required by the
  API Services User Data Policy.
- Least-privilege scope: `.../auth/calendar.events`, not `.../auth/calendar`.
  Does not request `calendar.acls`, `calendar.calendarlist` or
  `calendar.calendars`.
- HTTPS-only redirect URIs built from `PUBLIC_ORIGIN`:
  - `https://<your-domain>/api/auth/google/callback`
  - `https://<your-domain>/api/googlecalendar/callback`
- A meta description and canonical URL on every public page.

## Scope justification

> **openid, email** — identify the signed-in user so they can use an existing
> Google account without creating another one. Authentication only; never used
> for advertising or analytics.
>
> **https://www.googleapis.com/auth/calendar.events** — the core feature of this
> app. A user connects their calendar to see the events they scheduled alongside
> the study hours they plan, and to reach their schedule on any device. The app
> reads events for the calendar the user connects and writes events the user
> creates or edits in PixelFlow. It does not access calendar sharing, the list of
> calendars, or calendar properties, and it does not access any other account.

## Still outstanding

- **Google Calendar API** must be enabled (APIs & Services → Library). Sign-in
  works without it; sync 403s without it.
- **Verify Branding** — automated where possible (minutes), otherwise 2–3
  business days.
- **Demo video.** Verification usually asks for a screen recording of the
  feature using each scope. One continuous clip: sign in with Google → connect
  Google Calendar → sync an event in → create an event in PixelFlow → open Google
  Calendar and show it there. This is the most common reason a submission bounces
  and the only step not doable from the console.
- **Production OAuth client hygiene.** If
  `http://127.0.0.1:5173/api/auth/google/callback` is registered, remove it.

## What this app does not do

No advertising. No analytics or tracking SDKs. No third-party cookies. No sale
or sharing of data. Friends see only username, avatar, level and study totals.
State this in the verification form — it is the strongest argument that the
scopes are proportionate.