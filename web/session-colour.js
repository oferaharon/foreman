/*
 * One colour per speaker in the shared room — a pure, stateless mapping from a session's
 * name to a slot in the `--peer-N` ring, no DOM, no storage, node-tested like `quota.js`,
 * `trust-gate.js`, `notify.js` and `prefs.js` before it.
 *
 * Keyed on the session **name**, never a pid or pane id — both of those die with the
 * session (the registry file is gone within seconds of exit, and a fresh tmux server can
 * reissue `%0`), while the name is what a room entry actually carries at read time. The
 * cost, said plainly: two sessions that ever share a name share a colour, and the
 * wrapper's `<repo>-<branch>` fallback name is *designed* to collide (CLAUDE.md's very
 * first trap — one folder held 96 transcripts titled `<repo>-main`). That is fine for a
 * colour and would be fatal for an identity, which is exactly why identity is resolved and
 * stored on the entry itself (§6 of the shared-room plan) and only the colour is derived
 * from the name, live, every render.
 *
 * The hash is FNV-1a over the raw string — cheap, dependency-free, and it does not need to
 * resist an adversary, only to spread ordinary session names across the ring instead of
 * piling them on one or two slots the way `charCodeAt(0)` would (most names here start
 * with a handful of letters).
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** `N`, the number of hues in the `--peer-N` ring — see `tokens.css` for why it is 7 and
 *  not the 8 this started at: an eighth hue could still clear 7:1 against `--ground` in
 *  both themes, but not without landing inside a small ΔE2000 of an existing status colour
 *  (`--working`, `--decision`, `--accent`, and — while not reserved — `--idle` and
 *  `--mode-edits` too, which a peer pill sitting near either would read as a status dot
 *  rather than a name). A ring member must be exported as its own constant, not
 *  hard-coded here and again in the CSS, or the two can drift the way two spellings of
 *  a threshold always do. */
export const PEER_COLOUR_COUNT = 7;

/** FNV-1a, 32-bit, over the UTF-8 bytes of `str`. Deterministic across processes and
 *  restarts — the same string always folds to the same unsigned 32-bit integer — which is
 *  the whole requirement here: nothing about this needs to be cryptographically sound. */
function fnv1a(str) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * A session name's slot in the `--peer-N` ring, `1..PEER_COLOUR_COUNT`. Deterministic and
 * stable across restarts (no `Date.now()`, no `Math.random()`, no process-local state) —
 * the same name always draws the same pill colour, in this session and the next.
 *
 * A non-string or empty name still answers a valid slot rather than throwing: `colourFor`
 * is called from render code, and the panel's standing rule is to show something plausible
 * over throwing away a paint.
 */
export function colourFor(name) {
  const key = typeof name === 'string' && name.length > 0 ? name : '';
  return (fnv1a(key) % PEER_COLOUR_COUNT) + 1;
}
