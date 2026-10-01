import { randomBytes } from 'node:crypto';
import { asyncRouter } from '../http.js';
import { db, tx } from '../db.js';
import {
  hashPassword, verifyPassword, setSessionCookie, clearSessionCookie,
  requireAuth, csrfToken, newState, verifyState,
} from '../auth.js';
import { getUser, consumeLoginState, DEFAULT_SETTINGS } from '../store.js';
import {
  PROVIDERS, isProvider, providerConfigured, availableProviders, redirectUri,
  authorizeUrl, exchangeCode, fetchProfile, STATE_TTL_MS,
} from '../oauth.js';

const router = asyncRouter();

const USERNAME_RE = /^[a-z0-9_]{3,20}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function validateCredentials({ username, email, password }) {
  if (!USERNAME_RE.test(String(username || ''))) {
    return 'Username must be 3–20 letters, numbers or underscores.';
  }
  if (!EMAIL_RE.test(String(email || ''))) return 'That email address does not look right.';
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

router.post('/signup', async (req, res) => {
  const { username, email, password } = req.body || {};
  const problem = validateCredentials({ username, email, password });
  if (problem) return res.status(400).json({ error: problem });

  const clash = await db.prepare('SELECT username, email FROM users WHERE username = ? OR email = ?')
    .get(username, email);
  if (clash) {
    return res.status(409).json({
      error: clash.username.toLowerCase() === String(username).toLowerCase()
        ? 'That username is taken.'
        : 'That email is already registered.',
    });
  }

  const info = await db.prepare(
    'INSERT INTO users (username, email, password_hash) VALUES (?,?,?)',
  ).run(username, email, hashPassword(password));
  const id = Number(info.lastInsertRowid);

  // A brand-new account starts with a sensible plan: Mon–Fri at the default
  // focus duration, so the tracker and its bars render something real.
  await tx(async (t) => {
    const insert = t.prepare(
      'INSERT INTO study_plans (user_id, weekday, planned_minutes, active) VALUES (?,?,?,1)',
    );
    for (const weekday of [1, 2, 3, 4, 5]) {
      await insert.run(id, weekday, DEFAULT_SETTINGS.focusMins * 60);
    }
    // Carry over the prototype's starter tags so the Tasks pane is not empty.
    const tag = t.prepare('INSERT INTO tags (user_id, name, color) VALUES (?,?,?)');
    await tag.run(id, 'Study', '#7c6fff');
    await tag.run(id, 'Work', '#6bffda');
  });

  setSessionCookie(res, id);
  return res.json({ user: await getUser(id), csrfToken: csrfToken() });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const row = await db.prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(username, username);

  // Same message either way so the endpoint cannot be used to enumerate accounts.
  if (!row || !verifyPassword(String(password || ''), row.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  setSessionCookie(res, row.id);
  return res.json({ user: await getUser(row.id), csrfToken: csrfToken() });
});

router.post('/logout', async (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/**
 * Signs you straight in, with no form and no credentials.
 *
 * The guest is a real row in `users`, not a separate anonymous path: every
 * feature already depends on a user id — friends, logs, plans — so this is
 * what makes the whole app work without a login. Its password is random and
 * discarded, so nobody can sign into it later, and `is_guest` marks the
 * account as claimable before its data is thrown away.
 */
router.post('/guest', async (_req, res) => {
  // Retry on the astronomically unlikely id collision rather than failing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const tag = randomBytes(5).toString('base64url');
    const username = `guest_${tag}`;
    const email = `${username}@guest.pixelflow.local`;

    const clash = await db.prepare('SELECT 1 AS x FROM users WHERE username = ? OR email = ?')
      .get(username, email);
    if (clash) continue;

    const info = await db.prepare(
      'INSERT INTO users (username, email, password_hash, is_guest) VALUES (?,?,?,1)',
    ).run(username, email, hashPassword(randomBytes(32).toString('hex')));
    const id = Number(info.lastInsertRowid);

    // Same starter plan and tags as a real sign-up, so the tracker is not an
    // empty screen the moment someone arrives.
    await tx(async (t) => {
      const plan = t.prepare(
        'INSERT INTO study_plans (user_id, weekday, planned_minutes, active) VALUES (?,?,?,1)',
      );
      for (const weekday of [1, 2, 3, 4, 5]) {
        await plan.run(id, weekday, DEFAULT_SETTINGS.focusMins * 60);
      }
      const tag = t.prepare('INSERT INTO tags (user_id, name, color) VALUES (?,?,?)');
      await tag.run(id, 'Study', '#7c6fff');
      await tag.run(id, 'Work', '#6bffda');
    });

    setSessionCookie(res, id);
    return res.json({ user: await getUser(id), csrfToken: csrfToken() });
  }

  return res.status(500).json({ error: 'Could not start a guest session.' });
});

/**
 * Turns the guest session into a real account, keeping every row it owns.
 * Setting a password this way is the only way a guest's data can be kept.
 */
router.post('/claim', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'No such user' });
  if (!user.isGuest) return res.status(409).json({ error: 'This account is already claimed.' });

  const { username, email, password } = req.body || {};
  const problem = validateCredentials({ username, email, password });
  if (problem) return res.status(400).json({ error: problem });

  const clash = await db.prepare(
    'SELECT username, email FROM users WHERE (username = ? OR email = ?) AND id <> ?',
  ).get(username, email, user.id);
  if (clash) {
    return res.status(409).json({
      error: clash.username.toLowerCase() === String(username).toLowerCase()
        ? 'That username is taken.'
        : 'That email is already registered.',
    });
  }

  await db.prepare(
    'UPDATE users SET username = ?, email = ?, password_hash = ?, is_guest = 0 WHERE id = ?',
  ).run(username, email, hashPassword(password), user.id);

  return res.json({ user: await getUser(user.id), csrfToken: csrfToken() });
});

router.get('/session', async (req, res) => {
  res.json({ user: req.user ? await getUser(req.user.id) : null });
});

router.get('/users/:id', requireAuth, async (req, res) => {
  const user = await getUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user' });
  res.json({ user });
});

// ── sign in with Google / Microsoft ───────────────────────────────────────

/** Which providers are wired up, so the client only shows real buttons. */
router.get('/providers', async (_req, res) => {
  res.json({ providers: availableProviders() });
});

/** Where the providers think they should send the browser back to. */
router.get('/providers/:name/redirect-uri', async (req, res) => {
  const { name } = req.params;
  if (!isProvider(name)) return res.status(404).json({ error: 'Unknown provider' });
  if (!providerConfigured(name)) {
    return res.status(503).json({ error: `${PROVIDERS[name].label} sign-in is not configured.` });
  }
  return res.json({ redirectUri: redirectUri(name) });
});

/**
 * Picks a username for a provider account.
 *
 * Tries the email local part first because that is what a person recognises as
 * theirs, then the provider display name, then a fallback — appending a number
 * until it is free. `users.username` is UNIQUE, so this has to be checked.
 *
 * `handle` is the transaction's own statement factory: reading through the
 * module-level `db` while a transaction is open would not see its writes.
 */
async function pickUsername(handle, email, providerName, profileName) {
  const basis = [
    String(email || '').split('@')[0],
    String(profileName || '').replace(/[^A-Za-z0-9_]/g, ''),
    providerName,
  ].find((s) => USERNAME_RE.test(s)) || 'player';

  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? basis.slice(0, 20) : `${basis.slice(0, 17)}_${n}`;
    const taken = await handle.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(candidate);
    if (!taken) return candidate;
  }
  // Astronomically unlikely; a random suffix is a safe last resort.
  return `user_${randomBytes(6).toString('hex')}`;
}

/**
 * Finds or creates the local account behind a verified provider identity.
 *
 * The order matters: an existing identity wins over an email match, because the
 * identity is the only link we know is genuinely this person's. Linking on
 * email alone would let anyone who controls an address on a domain claim the
 * account that already used it.
 */
async function resolveUser(provider, profile) {
  const existing = await db.prepare(
    'SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?',
  ).get(provider, profile.subject);

  if (existing) return { id: Number(existing.user_id), created: false };

  return tx(async (t) => {
    // Link on email only when the existing account has never been linked to any
    // provider. That keeps the promise honest: the only thing the provider has
    // told us is "this address", and an account that has already proven a
    // different identity with a provider must not be reachable just by
    // claiming the same email.
    if (profile.email) {
      const byEmail = await t.prepare(
        `SELECT u.id FROM users u
          WHERE u.email = ?
            AND NOT EXISTS (
              SELECT 1 FROM oauth_identities o WHERE o.user_id = u.id
            )`,
      ).get(profile.email);

      if (byEmail) {
        await t.prepare(
          'INSERT INTO oauth_identities (user_id, provider, subject, email) VALUES (?,?,?,?)',
        ).run(byEmail.id, provider, profile.subject, profile.email);
        return { id: Number(byEmail.id), created: false };
      }
    }

    const username = await pickUsername(t, profile.email, provider, profile.name);

    // users.email is UNIQUE, and we deliberately declined to merge above, so
    // this address can still be taken. Fall back to an address derived from
    // the provider's own subject, which is unique by construction.
    let email = profile.email || `${provider}-${profile.subject}@linked.local`;
    const clash = await t.prepare('SELECT 1 AS x FROM users WHERE email = ?').get(email);
    if (clash) email = `${provider}-${profile.subject}@linked.local`;

    // A random password: the column is NOT NULL, and an unguessable value means
    // the account genuinely cannot be signed into with a password form.
    const info = await t.prepare(
      'INSERT INTO users (username, email, password_hash) VALUES (?,?,?)',
    ).run(username, email, hashPassword(randomBytes(32).toString('hex')));

    const id = Number(info.lastInsertRowid);
    await t.prepare(
      'INSERT INTO oauth_identities (user_id, provider, subject, email) VALUES (?,?,?,?)',
    ).run(id, provider, profile.subject, profile.email);

    // Same starter plan and tags as a local sign-up.
    const plan = t.prepare(
      'INSERT INTO study_plans (user_id, weekday, planned_minutes, active) VALUES (?,?,?,1)',
    );
    for (const weekday of [1, 2, 3, 4, 5]) {
      await plan.run(id, weekday, DEFAULT_SETTINGS.focusMins * 60);
    }
    const tag = t.prepare('INSERT INTO tags (user_id, name, color) VALUES (?,?,?)');
    await tag.run(id, 'Study', '#7c6fff');
    await tag.run(id, 'Work', '#6bffda');

    return { id, created: true, username };
  });
}

/** Step 1 — bounce to the provider's consent screen. */
router.get('/:provider/login', async (req, res) => {
  const { provider } = req.params;
  if (!isProvider(provider)) return res.status(404).json({ error: 'Unknown provider' });
  if (!providerConfigured(provider)) {
    return res.status(503).json({
      error: `${PROVIDERS[provider].label} sign-in is not configured on this server.`,
    });
  }

  const state = newState();
  // Recording the current user makes this "add a provider to my account"
  // rather than "sign in", when someone starts it while already signed in.
  await db.prepare('INSERT INTO oauth_login_states (state, provider, link_user_id, created_at) VALUES (?,?,?,?)')
    .run(state, provider, req.user?.id ?? null, Date.now());

  return res.redirect(authorizeUrl(provider, state));
});

/** Step 2 — the provider sends the browser back with a code. */
router.get('/:provider/callback', async (req, res) => {
  const { provider } = req.params;
  if (!isProvider(provider)) return res.redirect('/?auth=unknown-provider');
  if (!providerConfigured(provider)) return res.redirect('/?auth=unconfigured');

  const { code, state, error } = req.query;
  const label = PROVIDERS[provider].label;
  if (error) return res.redirect(`/?auth=denied&provider=${provider}`);

  // Single-use state, expired after ten minutes.
  const row = await consumeLoginState(String(state || ''), provider);

  if (!row || !verifyState(state) || Date.now() - row.created_at > STATE_TTL_MS) {
    return res.redirect('/?auth=bad-state');
  }

  try {
    const profile = await fetchProfile(provider, await exchangeCode(provider, String(code || '')));

    // Adding a provider to the account you are already signed in as.
    if (row.link_user_id) {
      const owner = await db.prepare(
        'SELECT 1 AS x FROM oauth_identities WHERE user_id = ? AND provider = ? AND subject = ?',
      ).get(row.link_user_id, provider, profile.subject);

      if (owner) return res.redirect('/?auth=already-linked');

      await db.prepare(
        'INSERT INTO oauth_identities (user_id, provider, subject, email) VALUES (?,?,?,?)',
      ).run(row.link_user_id, provider, profile.subject, profile.email);
      setSessionCookie(res, Number(row.link_user_id));
      return res.redirect(`/?auth=linked&provider=${provider}`);
    }

    const { id, created } = await resolveUser(provider, profile);
    setSessionCookie(res, id);
    return res.redirect(`/?auth=${created ? 'welcome' : 'ok'}&provider=${provider}`);
  } catch (err) {
    console.error(`[auth] ${provider} sign-in failed:`, err.message);
    return res.redirect('/?auth=failed');
  }
});

/** Removes a linked provider from the signed-in account. */
router.post('/providers/:name/unlink', requireAuth, async (req, res) => {
  const { name } = req.params;
  if (!isProvider(name)) return res.status(404).json({ error: 'Unknown provider' });

  await db.prepare('DELETE FROM oauth_identities WHERE user_id = ? AND provider = ?')
    .run(req.user.id, name);
  return res.json({ ok: true, linked: await linkedProviders(req.user.id) });
});

router.get('/providers/linked', requireAuth, async (req, res) => {
  res.json({ linked: await linkedProviders(req.user.id) });
});

async function linkedProviders(userId) {
  const rows = await db.prepare(
    'SELECT provider, email FROM oauth_identities WHERE user_id = ? ORDER BY provider',
  ).all(userId);
  return rows.map((r) => ({ provider: r.provider, label: PROVIDERS[r.provider]?.label || r.provider, email: r.email }));
}

export default router;
