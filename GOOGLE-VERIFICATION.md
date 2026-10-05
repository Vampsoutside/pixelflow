# Google OAuth verification — status and remaining steps

Verified against Google's own documentation:
[Comply with OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
and [Submit for brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

## Why the first submission was rejected

Google's reviewer fetches the home page the way a browser without JavaScript
does. `index.html` is a single-page app whose entire body is two divs — an auth
overlay and the app shell — and **both ship with the `hidden` attribute**. So
the reviewer saw a blank page and reported four symptoms, all from that one
cause:

| Reviewer said | Actual cause |
|---|---|
| Home page is behind a login page | The only thing present was a sign-in form |
| Home page does not explain the app's purpose | No text existed outside JS |
| App name "stitch" does not match the app | Page title read "PixelFlow" |
| Home page URL not registered to you | `/#timer` — a hash fragment, not a page |

The hash fragment is worth explaining: `https://stitch-flax.vercel.app/#timer` is
the same page as `/`. Google read the fragment as a distinct path. Nothing was
wrong with the domain — putting a clean URL in the field is the fix.

## What changed in this repository

- **`/about`** — a static page describing what the app does, who it is for, and
  how data is handled. Crawler-visible, no JavaScript needed, no sign-in.
- **Home page meta** — a real `<meta name="description">` and a canonical URL.
- **Footer links on the signed-out screen** — About / Privacy / Terms, so a
  human without an account has a way in.
- **`/about`, `/privacy`, `/terms`** each have their own Vercel rewrite ahead of
  the SPA catch-all, without which all three silently returned the app shell.

## Do these before resubmitting

1. **Rename the Vercel project from `stitch` to `PixelFlow`**
   Dashboard → project **Settings → General → Project Name**.
   This is the name the reviewer saw. Renaming changes your deployment URLs, so
   add a custom domain if you want a stable one.
2. **Set the Home page URL to `https://stitch-flax.vercel.app`**
   No `#timer`, no trailing slash.
3. **Set App name to `PixelFlow`** on the Branding page — it must match what
   `/about` calls itself.
4. **Privacy policy and Terms URLs**:
   - `https://stitch-flax.vercel.app/privacy`
   - `https://stitch-flax.vercel.app/terms`

## Already done

- Privacy Policy and Terms of Use, public and crawler-visible.
- Account deletion (`DELETE /api/me`, exposed in Settings), required by the
  API Services User Data Policy.
- Least-privilege scope: `.../auth/calendar.events`, not `.../auth/calendar`.
  Does not request `calendar.acls`, `calendar.calendarlist` or
  `calendar.calendars`.
- HTTPS-only redirect URIs built from `PUBLIC_ORIGIN`.
- Both redirect URIs registered — sign-in and Calendar sync.

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
  business days. Google's error text says to wait up to 24 hours after changing
  ownership or branding before retrying; do that.
- **Demo video.** Verification usually asks for a screen recording of the
  feature using each scope. Record one continuous clip: sign in with Google →
  connect Google Calendar → sync an event in → create an event in PixelFlow →
  open Google Calendar and show it there. This is the most common reason a
  submission bounces, and the only step not doable from the console.
- **Production OAuth client hygiene.** Google's policy asks that production use a
  client with no developer-only origins. If
  `http://127.0.0.1:5173/api/auth/google/callback` is registered, remove it, or
  move production to its own project.

## What this app does not do

No advertising. No analytics or tracking SDKs. No third-party cookies. No sale
or sharing of data. Friends see only username, avatar, level, and study totals.
Stating this in the verification form is the strongest argument that the scopes
are proportionate.
