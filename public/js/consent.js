/**
 * Cookie consent.
 *
 * The session cookie is not optional — it is how the app knows who you are — so
 * this is not a "block everything" gate. The essential cookies are always set
 * by the server the moment you load the page, and the banner's job is to tell
 * the truth about that rather than pretend declining leaves nothing behind.
 *
 * What a choice actually changes is everything *outside* that set: the
 * preferences this module records, and any optional storage added later. The
 * categories are therefore honest about their real contents:
 *
 *   essential — pf_session (httpOnly) and pf_session_csrf. Always on. Needed
 *               to stay signed in; without them every request is anonymous.
 *   personalisation — your interface choices that are not part of your account:
 *               the selected month, chart mode, sound intensity, master volume
 *               and which right-hand panel was collapsed. Stored locally, and
 *               mirrored into your account settings where one exists.
 *   analytics — nothing today. Listed so the choice is a real one if it is
 *               ever added, rather than a category invented to be ticked.
 *
 * The decision is kept in localStorage rather than a cookie, for two reasons:
 * the banner must still be able to read it while consent is "essential only",
 * and a record of consent stored in the very mechanism it governs is circular.
 */

const KEY = 'pixelflow:consent';
const LEGACY_KEY = 'pixelflow:cookie-consent';

/** Bump the version to re-ask everyone once a category's contents change. */
const VERSION = 1;

export const CATEGORIES = [
  {
    id: 'essential',
    label: 'Strictly necessary',
    locked: true,
    detail: 'Keeps you signed in and stops cross-site requests forging your writes. '
      + 'These are set by the server on every visit and cannot be switched off.',
  },
  {
    id: 'personalisation',
    label: 'Personalisation',
    locked: false,
    detail: 'Remembers your interface choices between visits — selected month, chart mode, '
      + 'sound levels, and whether you collapsed the side panel.',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    locked: false,
    detail: 'Nothing is collected today. Kept as a real choice so this stays accurate '
      + 'if anonymous usage counts are ever added.',
  },
];

const ALL = CATEGORIES.map((c) => c.id);

function read() {
  for (const key of [KEY, LEGACY_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      // A stored decision from an older version is re-asked rather than honoured.
      if (parsed && parsed.version === VERSION && Array.isArray(parsed.granted)) {
        return parsed.granted;
      }
    } catch { /* private mode, or corrupt value: fall through and re-ask */ }
  }
  return null;
}

/** Everything needed to render the app: prefs are honoured only if allowed. */
export function preferencesAllowed() {
  const granted = read();
  // No answer yet means nothing optional is read or written.
  if (!granted) return false;
  return granted.includes('personalisation');
}

export function consentDecided() {
  return read() !== null;
}

/** The categories currently granted, for rendering an existing choice. */
export function consentGranted() {
  return read() || ALL.filter((id) => id === 'essential');
}

export function save(granted) {
  const cleaned = ALL.filter((id) => granted.includes(id));
  if (!cleaned.includes('essential')) cleaned.push('essential');
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, granted: cleaned, at: new Date().toISOString() }));
  } catch { /* private mode: the choice lasts for this page view only */ }
  return cleaned;
}

/**
 * Applies a saved decision to this page.
 *
 * Called once when the banner is answered. Declining means the interface
 * preferences recorded before the choice are dropped, so the next visit starts
 * from the defaults rather than from a state the visitor no longer consents to.
 */
export function applyConsent(granted) {
  if (granted.includes('personalisation')) return;
  // Only touch keys this module knows about — the session lives in a cookie and
  // the consent record itself must survive the change it just caused.
  for (const key of PREFERENCE_KEYS) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }
}

/** Every localStorage key that holds a cross-visit interface preference. */
const PREFERENCE_KEYS = [
  'pixelflow:rp-collapsed',
  'pixelflow:view',
  'pixelflow:sounds',
];

export function clear() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* nothing to do */ }
}

/**
 * Builds the banner and puts it on the page.
 *
 * Called on a first visit with no argument, and again from Settings with the
 * current grant list so reopening shows the state already in force instead of
 * resetting every box.
 *
 * The DOM is built by hand rather than through ui.js's `el`: this module is
 * imported by app.js before anything else, and a circular import through the
 * shared helpers was the one way this could break the boot path.
 */
export function openConsentBanner(current) {
  const existing = document.querySelector('.cookie-banner');
  if (existing) existing.remove();

  const granted = Array.isArray(current) ? current : consentGranted();
  const banner = document.createElement('div');
  banner.className = 'cookie-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Cookie preferences');

  const body = document.createElement('div');
  body.className = 'cookie-body';
  const title = document.createElement('div');
  title.className = 'pane-title';
  title.textContent = 'COOKIES';
  const intro = document.createElement('div');
  intro.className = 'pane-sub';
  intro.style.cssText = 'margin-top:6px;line-height:1.6';
  intro.textContent = 'Your session cookie is set by the server on every visit — that is what keeps you signed in, and it cannot be switched off. Choose what else this site may remember.';
  body.append(title, intro);

  const list = document.createElement('div');
  list.className = 'cookie-cats';
  const checks = new Map();
  for (const cat of CATEGORIES) {
    const label = document.createElement('label');
    label.className = `cookie-cat${cat.locked ? ' locked' : ''}`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    // Only the essential box starts ticked. Anything else pre-ticked would be
    // consent the visitor did not give.
    box.checked = cat.locked || granted.includes(cat.id);
    box.disabled = Boolean(cat.locked);
    box.setAttribute('aria-label', cat.label);
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = cat.label;
    span.append(b, document.createTextNode(` — ${cat.detail}`));
    label.append(box, span);
    list.append(label);
    checks.set(cat.id, box);
  }
  body.append(list);
  banner.append(body);

  const actions = document.createElement('div');
  actions.className = 'cookie-actions';
  const button = (text, className, onClick) => {
    const b = document.createElement('button');
    b.className = `btn small ${className}`;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };
  const chosen = () => [...checks.entries()].filter(([, box]) => box.checked).map(([id]) => id);
  const decide = (ids) => {
    // save() is what normalises the list (essential always present), so
    // applyConsent must be handed its return value rather than the raw ids.
    applyConsent(save(ids));
    banner.remove();
  };

  actions.append(
    button('Customise', '', () => banner.classList.toggle('custom')),
    button('Decline', '', () => decide(CATEGORIES.filter((c) => c.locked).map((c) => c.id))),
    button('Accept all', 'primary', () => decide(CATEGORIES.map((c) => c.id))),
    button('Save choices', 'primary save-consent', () => decide(chosen())),
  );
  banner.append(actions);

  document.body.append(banner);
  return banner;
}