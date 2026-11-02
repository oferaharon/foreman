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
 */

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
 * Only an entry with **no** state is stamped, because that is exactly a fresh push from
 * `location.hash = …`: every entry the app writes any other way carries state (the root,
 * every replace), and an entry reached by the back or forward gesture keeps what it was
 * stamped with when it was new.
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
