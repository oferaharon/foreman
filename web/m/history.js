/*
 * The phone's history rules, pure, so they can be driven from `node --test` — `app.js`
 * reaches for `document` at module scope and cannot be imported there.
 *
 * Measured in the iOS Simulator's installed Home Screen app (iOS 27), an injected beacon
 * logging every load, `popstate`, `hashchange` and `replaceState`:
 *
 *  - **The back control used to push.** `‹` assigned `location.hash = homeHash()`, which is a
 *    new entry, so the stack after one round trip was `[list, session, list]` — and the back
 *    gesture, which is `history.back()`, then landed on the session again. From there the
 *    only way out was `‹`, which pushed again. So `‹` now *steps back* when the entry it is
 *    on was pushed from inside the app, and *replaces* when it was not (a cold open straight
 *    onto a conversation), so the gesture and the control can never disagree.
 *  - **A document load on a conversation route forgot the tab.** `route.tab` started as
 *    `leads` and a conversation hash said nothing about it, so a reload — or iOS restoring a
 *    Home Screen app whose web process it reclaimed in the background, which is a reload the
 *    reader never asked for — sent a standalone session's `‹` to Leads, with `standalones`
 *    sitting in storage. The kinds that are only ever drawn on one list now name it, and the
 *    entry's own state says where it was opened from, which survives a reload.
 *
 * The state is stamped on each entry rather than kept in a module variable because it is
 * the one record that survives a document load: `history.state` is serialised with the
 * entry, a variable is not.
 *
 * **And the phone never assigns `location.hash`, because on a real iPhone that reloads the
 * page — MEASURED on iOS 27, on a cabled phone, through the Web Inspector and the device's
 * own WebKit log; the Simulator does not do it.** The phone reaches the panel over plain
 * http, which Safari and the installed app both run in a `WebContent.EnhancedSecurity`
 * process. An assigned hash is a *navigation*: WebCore performs it in the document
 * (`loadInSameDocument`, `hashchange`, the screen mounts), and meanwhile the UI process's
 * own policy check on that same navigation answers `swapping process … reason=Process swap
 * due to EnhancedSecurity change` and loads the whole document again in a new process,
 * about 30 ms later. That is the refresh on every tap, and it adds a history entry with no
 * state on it. A back step onto an entry left behind by an earlier document is a navigation
 * too, and swaps the same way — loading the *previous* navigation's URL, which is the
 * session the reader was leaving: the swipe back that shows the same session again.
 *
 * `pushState` is not a navigation, so the policy check never sees it, and a step back
 * between two entries of one document is a same-document traversal that never asks it.
 * So every route change on the phone is `pushRoute` below; a page that is never reloaded
 * underneath itself never has an entry from another document to step back onto.
 */

/**
 * Move to `hash` as a new history entry **without a navigation** — see the note above.
 *
 * The entry is stamped with where it was pushed from, exactly what `stampFor` would have
 * written on landing. `pushState` fires no `hashchange`, and the shell routes on one (so
 * does a room sheet, which closes on it), so one is dispatched — as a task, the way an
 * assigned hash delivers it, because the callers that close a sheet before a launch's
 * `finally` repaints rely on that order. `win` is `window` in the page and a stub under
 * `node --test`. Answers whether it moved.
 */
export function pushRoute(hash, win = globalThis) {
  const from = win.location.hash;
  if (!hash || hash === from) return false;
  const oldURL = win.location.href;
  win.history.pushState({ from }, '', hash);
  const newURL = win.location.href;
  win.setTimeout(() => win.dispatchEvent(new win.HashChangeEvent('hashchange', { oldURL, newURL })), 0);
  return true;
}

/** The marker on the first entry the app writes, so it is never mistaken for a fresh push. */
export const ROOT_STATE = Object.freeze({ root: true });

/**
 * The tab a route kind is drawn on, or `null` for a kind that is drawn on more than one.
 *
 * An ordinary session is only ever listed under Standalones, a lead and a worker only under
 * Leads (a worker under its lead's card), a room only under Rooms. A sleeper is drawn
 * greyed in whichever list it slept in — Leads or Standalones — so it is the one kind whose
 * hash cannot say.
 */
export function tabForKind(kind) {
  if (kind === 'session') return 'standalones';
  if (kind === 'lead' || kind === 'worker') return 'leads';
  if (kind === 'room') return 'rooms';
  return null;
}

/** The tab a home hash names (`#/standalones`), or `null` for any other hash. */
export function homeTabOf(hash, tabs) {
  const m = /^#\/([a-z]+)\/?$/.exec(hash || '');
  return m && tabs.includes(m[1]) ? m[1] : null;
}

/**
 * The state to write on the entry `navigate` has just landed on, or `null` to leave it.
 *
 * Only an entry with **no** state is stamped, because that is exactly a hash nobody in the
 * app wrote — one edited in the address bar, or an old link: every entry the app writes
 * carries state (the root, every `pushRoute`, every replace), and an entry reached by the
 * back or forward gesture keeps what it was stamped with when it was new.
 */
export function stampFor(state, prevHash, hash) {
  if (state != null) return null;
  if (!prevHash || prevHash === hash) return null;
  return { from: prevHash };
}

/**
 * What `‹` does: `back` when this entry was pushed from inside the app, so the control and
 * the back gesture land on the same entry; otherwise `replace` with the list to go to, so
 * leaving a conversation opened cold does not leave it behind in the history either.
 */
export function backAction(state, home) {
  if (state && typeof state.from === 'string') return { op: 'back' };
  return { op: 'replace', hash: home };
}

/**
 * The tab to start on when the page loads on a route that does not name one.
 *
 * The entry's own `from`, when it was opened from a list, is where the reader came from; a
 * kind drawn on one list is that list; otherwise the remembered tab, which is the last list
 * the reader was on.
 */
export function bootTab(kind, state, remembered, tabs) {
  const from = state && typeof state.from === 'string' ? homeTabOf(state.from, tabs) : null;
  return from || tabForKind(kind) || (tabs.includes(remembered) ? remembered : tabs[0]);
}
