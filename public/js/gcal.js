/**
 * Google Calendar connection, from the browser's side.
 *
 * Two things live here that do not belong in the calendar view itself:
 *
 *  - The connection state. The calendar reads `isConnected()` to decide whether
 *    to offer sync controls at all, and `push()` is called after an edit so the
 *    change reaches Google without the user doing anything extra.
 *
 *  - The OAuth return. Google sends the user back to the app root with a ?gcal=
 *    marker, which is turned into a single message here and then stripped from
 *    the URL, so a refresh does not replay the same "connected!" toast forever.
 */

import { api } from './api.js';
import { el, toast } from './ui.js';

/** null until asked, so the first render does not assume either way. */
let connected = null;
/** Guards against two syncs racing when a user double-clicks. */
let syncing = false;

export const isConnected = () => connected === true;

/**
 * Asks the server whether Google is linked.
 *
 * A signed-out visitor is not an error — the app is usable without a Google
 * connection at all — so a failure leaves the state unknown and the UI simply
 * offers the connect button.
 */
export async function refreshStatus() {
  try {
    const data = await api.get('/api/googlecalendar/status');
    connected = Boolean(data?.connected);
  } catch {
    connected = false;
  }
  return connected === true;
}

/**
 * Sends an event to Google after it was saved here.
 *
 * Fire-and-forget on purpose: the local save has already succeeded and the user
 * is looking at the updated calendar, so blocking their click on a network call
 * to a third party would be a worse trade than a quiet retry. A failure is
 * reported once, because silently losing a Google write is how people end up
 * with calendars that quietly disagree.
 */
export async function push(id) {
  if (connected !== true || !id) return false;
  try {
    await api.post('/api/googlecalendar/push', { id });
    return true;
  } catch {
    toast('Saved here, but not sent to Google', 3200);
    return false;
  }
}

/**
 * Pulls a month in from Google.
 *
 * Returns the counts so the caller can say something more useful than "done" —
 * in particular, that a pull found nothing to change, which reads as a broken
 * button to anyone who is waiting for an event to appear.
 */
export async function syncMonth(month) {
  if (syncing) return null;
  syncing = true;
  try {
    const result = await api.post('/api/googlecalendar/sync', { month });
    const parts = [];
    if (result.created) parts.push(`${result.created} added`);
    if (result.updated) parts.push(`${result.updated} updated`);
    toast(parts.length ? `Synced — ${parts.join(', ')}` : 'Already up to date', 2600);
    return result;
  } catch (err) {
    toast(err.message || 'Could not reach Google Calendar', 3400);
    return null;
  } finally {
    syncing = false;
  }
}

export async function disconnect() {
  try {
    await api.post('/api/googlecalendar/disconnect');
    connected = false;
    toast('Google Calendar disconnected. Your events are still here.', 3400);
    return true;
  } catch (err) {
    toast(err.message || 'Could not disconnect', 3200);
    return false;
  }
}

/**
 * The connect / sync / disconnect control strip for the calendar view.
 *
 * Rendered before the connection is known rather than hidden behind it, so the
 * strip does not pop into place and shove the calendar down a line once the
 * status request comes back.
 */
export function gcalBar(month, onSynced) {
  const row = el('div', { class: 'gcal-bar' });
  const status = el('div', { class: 'gcal-status' });

  const draw = () => {
    row.innerHTML = '';
    if (connected === true) {
      status.textContent = 'GOOGLE CALENDAR CONNECTED';
      row.append(
        status,
        el('button', {
          class: 'btn gcal-sync',
          text: 'Sync',
          title: 'Pull this month in from Google',
          onclick: async () => {
            const result = await syncMonth(month);
            if (result && onSynced) await onSynced();
          },
        }),
        el('button', {
          class: 'btn',
          text: 'Disconnect',
          onclick: async () => {
            await disconnect();
            draw();
            if (onSynced) await onSynced();
          },
        }),
      );
      return;
    }

    status.textContent = connected === false ? 'NOT CONNECTED' : 'CHECKING…';
    row.append(
      status,
      el('button', {
        class: 'btn gcal-connect',
        text: 'Connect Google Calendar',
        // A full navigation, not fetch: the response is a 302 to Google's
        // consent screen and the session cookie has to travel with it.
        onclick: () => { window.location.href = '/api/googlecalendar/login'; },
      }),
    );
  };

  draw();
  return { node: row, refresh: draw };
}

/**
 * Reports the outcome of an OAuth return, once.
 *
 * Called on app start. The parameter is cleared with replaceState so a reload
 * does not show the message again — and, more importantly, does not leave a
 * stale ?gcal= in the URL that a later navigation could carry somewhere odd.
 */
export function reportOAuthReturn() {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get('gcal');
  if (!outcome) return;

  url.searchParams.delete('gcal');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);

  const messages = {
    connected: 'Google Calendar connected',
    denied: 'Google Calendar was not connected — you can do it any time',
    failed: 'Could not finish connecting Google Calendar',
    unconfigured: 'This build has no Google Calendar credentials set up',
  };
  const text = messages[outcome];
  if (text) toast(text, outcome === 'connected' ? 2600 : 4200);
}