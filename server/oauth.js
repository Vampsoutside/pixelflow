/**
 * Google and Microsoft sign-in.
 *
 * Both providers run the same OAuth 2.0 authorization-code flow with an
 * OpenID Connect userinfo call, so they share one implementation and differ
 * only in endpoints and scopes.
 *
 * Design notes worth knowing before editing:
 *
 *  - Identity is the provider's `sub` claim, not the email. Emails change and
 *    are not unique across Microsoft tenants; `sub` is stable and unique per
 *    provider.
 *  - An account created here gets an unguessable random password rather than a
 *    NULL one. The users table declares password_hash NOT NULL, and a random
 *    hash means the account simply cannot be signed into with a password while
 *    still satisfying that constraint.
 *  - Linking is keyed on (provider, sub) with a UNIQUE constraint, so a
 *    callback replay cannot attach a provider to a second account.
 */

/** How long a sign-in attempt stays valid. */
export const STATE_TTL_MS = 10 * 60 * 1000;

const TENANT = 'common';

export const PROVIDERS = {
  google: {
    label: 'Google',
    clientId: () => process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || '',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
  },

  microsoft: {
    label: 'Microsoft',
    clientId: () => process.env.MICROSOFT_CLIENT_ID || '',
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET || '',
    authorizeUrl: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    // The OIDC userinfo endpoint works for both work and personal accounts,
    // unlike Graph, which needs a tenant-specific token.
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile User.Read',
  },
};

export const providerNames = Object.keys(PROVIDERS);

export const isProvider = (name) =>
  Object.prototype.hasOwnProperty.call(PROVIDERS, String(name || ''));

/** True when both the client id and secret are present. */
export function providerConfigured(name) {
  const p = PROVIDERS[name];
  if (!p) return false;
  return Boolean(p.clientId() && p.clientSecret());
}

/** Which providers the client should offer, for the sign-in buttons. */
export function availableProviders() {
  return Object.entries(PROVIDERS)
    .filter(([name]) => providerConfigured(name))
    .map(([name, p]) => ({ name, label: p.label }));
}

/**
 * The redirect URI Google and Microsoft will send the browser back to.
 *
 * They compare this against the console entry byte for byte, so it is derived
 * from PUBLIC_ORIGIN rather than guessed from the request — a proxy in front
 * of the app would otherwise produce a URI the provider has never seen.
 */
export function redirectUri(provider) {
  const explicit = process.env[`${provider.toUpperCase()}_REDIRECT_URI`];
  if (explicit) return explicit;
  const port = Number(process.env.PORT) || 5173;
  const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  return `${origin.replace(/\/+$/, '')}/api/auth/${provider}/callback`;
}

/** The URL to send the browser to in order to begin. */
export function authorizeUrl(provider, state) {
  const p = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: p.clientId(),
    response_type: 'code',
    redirect_uri: redirectUri(provider),
    scope: p.scope,
    state,
    // Without this Google returns only the id and would never send an email.
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${p.authorizeUrl}?${params}`;
}

/**
 * Swaps the authorization code for an access token.
 *
 * Both providers accept client credentials in the POST body, which avoids
 * having to construct a Basic header and keeps the two flows identical.
 */
export async function exchangeCode(provider, code) {
  const p = PROVIDERS[provider];
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: p.clientId(),
      client_secret: p.clientSecret(),
      code,
      redirect_uri: redirectUri(provider),
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // The body can contain a client secret in some error shapes; log the
    // status only.
    throw new Error(`${provider} token endpoint returned ${res.status}: ${detail.slice(0, 120)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error(`${provider} returned no access token`);
  return json.access_token;
}

/** Fetches the profile behind an access token. */
export async function fetchProfile(provider, accessToken) {
  const p = PROVIDERS[provider];
  const res = await fetch(p.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`${provider} userinfo returned ${res.status}`);
  const profile = await res.json();

  if (!profile.sub) throw new Error(`${provider} returned no subject`);
  return {
    subject: String(profile.sub),
    email: typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : null,
    name: typeof profile.name === 'string' ? profile.name : '',
  };
}
