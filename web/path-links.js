/*
 * Which runs of text in a conversation are *shaped* like a filesystem path — and, given
 * one session's own output set, which of those the panel is allowed to draw a link on.
 *
 * Two functions and a hard line between them, because they answer to different authorities:
 *
 *   `findPaths` decides **shape**. It is a text scanner with no idea what is on disk or
 *   what this session made, and it is deliberately generous at the edges — a candidate it
 *   returns is a question, never an answer.
 *
 *   `linkablePaths` decides **scope**, against the list `GET /api/sessions/:id/outputs`
 *   answered with. A candidate survives only if it resolves to a file that session
 *   produced, or to the parent directory of one. That is the 2026-09-11 ruling verbatim
 *   and §7 rule 8 of the plan: *the detector decides shape, the server decides scope*. A
 *   path to a source file the session edited, a repo's own `docs/` it merely read, a route
 *   fragment that happens to look like a directory — all stay plain text, and the browser
 *   never links a path on the strength of the shape alone.
 *
 * DOM-free and fetch-free on purpose, the way `web/trust-gate.js`, `web/files-preview.js`
 * and `web/files-new.js` are, so `test/path-links.test.js` can hold every refusal class in
 * plain Node. The DOM walk that *uses* this lives in `web/app.js`, where the two prose
 * registers it runs over are.
 *
 * --- Why the refusals are the interesting half ---
 *
 * The planner ran a greedy path-shaped matcher over 14,929 assistant text blocks and got
 * **2,729 tokens outside code**, of which the top 70 held exactly **two** real filesystem
 * paths. Everything else was one of six measured classes: dates (`31/08`), ratios and
 * tallies (`7/7`, `189/31/220`), either-or prose (`before/after`, `yes/no`, `light/dark`),
 * URL fragments, IANA timezones (`America/Los_Angeles`) and git refs (`origin/main`, 98
 * hits on that one alone). A seventh lives inside backticks: HTTP route paths
 * (`/api/version`).
 *
 * So the rule below is **a relative path must carry an extension, a leading marker
 * (`/`, `./`, `../`, `~/`) or a trailing slash**, plus named refusals for the classes that
 * clear that bar anyway. Each one is a test case with the class in its name; the whole
 * point of naming them is that the next person to widen this can see which measurement
 * they are arguing with.
 *
 * --- What is deliberately not linked, and should be said out loud ---
 *
 * **A path with a space in it.** There is no way to know where it ends in running prose,
 * and guessing wrong means a link whose target is half a sentence. `docs/my notes.md` is
 * plain text here and `docs/panel.md` says so.
 *
 * **A bare filename.** `package.json`, `notes.md` — no `/`, so nothing distinguishes it
 * from a word, and this repo's own prose is full of both.
 *
 * **Anything inside a URL**, including after a bare `www.`, which `marked` autolinks. The
 * URL spans are blanked before the scan rather than filtered after it, so a path-shaped
 * tail cannot be lifted out of an address.
 *
 * **A Windows-style `C:\…` string.** None has ever been seen in this data; it is refused
 * by name so the shape never quietly becomes a path parameter.
 */

/**
 * A URL, or a bare `www.` host — whatever `marked` would have autolinked, and everything
 * after it up to whitespace.
 *
 * The scheme half is written `[a-z][a-z0-9+.-]*:\/\/` rather than `https?` on purpose:
 * this is a *mask*, and masking one scheme too many costs a link nobody could have wanted,
 * while masking one too few hands a path scanner the tail of an address.
 */
const URL_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/gi;

/**
 * A run of characters a path could be made of.
 *
 * `:` and `\` are **in** the class rather than out of it, which looks backwards until you
 * see what it buys: a `C:\Users\me` and a `server/index.js:412` arrive as one token each
 * and are refused whole, by name, instead of being silently chopped into a plausible
 * fragment. Neither ever leaves this module as a candidate.
 */
const RUN_RE = /[A-Za-z0-9_.~@+:\\/-]+/g;

/** Sentence furniture a path can pick up on its way out of a clause. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '"', "'", '…']);

/** A git ref, not a directory. `origin/main` alone was 98 hits inside code. */
const GIT_REF_RE = /^(?:origin|upstream|refs|HEAD|FETCH_HEAD|ORIG_HEAD)\//;

/** `America/Los_Angeles` — an IANA zone, which is two capitalised words over a slash. */
const TZ_RE =
  /^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Brazil|Canada|Chile|Etc|Europe|Indian|Mexico|Pacific|US)\/[A-Z][A-Za-z_+-]*$/;

/** An extension: a dot inside the last segment, then one to eight alphanumerics. */
const EXT_RE = /\.[A-Za-z0-9][A-Za-z0-9]{0,7}$/;

/** Every segment is digits — a date, a ratio or a tally, never a path. */
function allDigits(parts) {
  return parts.every((s) => /^\d+$/.test(s));
}

/**
 * Why this token is not a path candidate, or `null` if it is one.
 *
 * Exported so the tests can assert the *reason* rather than only the refusal: a token that
 * stops being linked for a new reason is a different fact from one that was always
 * refused, and a bare boolean hides the difference.
 */
export function refuseReason(token) {
  const t = String(token || '');
  if (t.length < 2) return 'too-short';
  // Before the colon test, so the Windows shape is named by what it is.
  if (t.includes('\\')) return 'windows';
  // `file:line`, `C:/…`, a stray label — a colon is not in any path this panel serves.
  if (t.includes(':')) return 'colon';
  if (!t.includes('/')) return 'bare-name';

  const parts = t.split('/').filter(Boolean);
  if (!parts.length) return 'no-segments';
  if (allDigits(parts)) return 'digits';
  if (GIT_REF_RE.test(t)) return 'git-ref';
  if (TZ_RE.test(t)) return 'timezone';

  const rooted = t.startsWith('/') || t.startsWith('~/') || t.startsWith('./') || t.startsWith('../');
  const folderish = t.endsWith('/');
  if (!rooted && !folderish && !EXT_RE.test(parts[parts.length - 1])) return 'bare-relative';
  return null;
}

/**
 * Every path-shaped span in a string, left to right and non-overlapping.
 *
 * `{start, end, text}` against the string handed in — offsets, so the caller can splice a
 * text node without re-finding anything. What it does **not** carry is a kind: whether a
 * candidate is a file or a folder is not a fact about its spelling (a trailing slash is
 * not a folder — 263 folder-shaped tokens in the data, 70 of them a real directory), it is
 * a fact about the output set, and `linkablePaths` is where that is asked.
 */
export function findPaths(text) {
  const s = String(text || '');
  if (!s || !s.includes('/')) return [];

  // Blank the URLs first, keeping every offset: a mask, not a filter, so a path-shaped
  // tail can never be lifted back out of an address.
  const masked = s.replace(URL_RE, (m) => ' '.repeat(m.length));

  const out = [];
  RUN_RE.lastIndex = 0;
  for (const m of masked.matchAll(RUN_RE)) {
    let start = m.index;
    let end = start + m[0].length;
    while (end > start && TRAILING.has(s[end - 1])) end -= 1;
    if (end - start < 2) continue;
    const token = s.slice(start, end);
    if (refuseReason(token)) continue;
    out.push({ start, end, text: token });
  }
  return out;
}

/* ------------------------------------------------------------ resolution --- */

/** `/Users/<someone>` out of an absolute cwd, which is the only `~` this Mac has. */
function homeOf(cwd) {
  const m = /^(\/Users\/[^/]+)(?:\/|$)/.exec(String(cwd || ''));
  return m ? m[1] : null;
}

/** Collapse `.`, `..` and repeated slashes; no trailing slash except at the root. */
function normalise(abs) {
  const parts = [];
  for (const seg of String(abs).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/** The directory one absolute path sits in, or `null` at the root. */
export function parentOf(abs) {
  const at = String(abs || '').lastIndexOf('/');
  if (at < 0) return null;
  const dir = at === 0 ? '/' : String(abs).slice(0, at);
  return dir === abs ? null : dir;
}

/**
 * One candidate as an absolute path, resolved the way the session would have meant it.
 *
 * Relative against `cwd` — which the caller takes from the session's `cwd`, falling back
 * to `paneCwd`; a transcript's `cwd` is what the record was written under and is the
 * honest base for something the session said. `~/` needs a home directory, and the only
 * one derivable here is the `/Users/<someone>` prefix of the cwd itself: a browser knows
 * no `$HOME`, so a `~` path in a session whose cwd is somewhere else entirely resolves to
 * nothing and is left as plain text. `~other/…` is never resolved at all.
 *
 * Returns `null` for anything it cannot place, which is the same answer as "not in the
 * output set" one step later — and the two are the same to a reader either way.
 */
export function resolvePath(text, cwd) {
  let t = String(text || '').trim();
  if (!t || t.includes('\\') || t.includes(':')) return null;

  if (t.startsWith('~')) {
    if (!t.startsWith('~/')) return null;
    const home = homeOf(cwd);
    if (!home) return null;
    t = `${home}/${t.slice(2)}`;
  } else if (!t.startsWith('/')) {
    const base = String(cwd || '').trim();
    if (!base.startsWith('/')) return null;
    t = `${base}/${t}`;
  }

  const abs = normalise(t);
  return abs === '/' ? null : abs;
}

/* ---------------------------------------------------------------- scope --- */

/**
 * The candidates this session is allowed to draw a link on, each with what to do about it.
 *
 * `{...span, kind: 'file' | 'folder', entry}` — and `entry` is always an **output record**,
 * never a path, because that is what the two click handlers send back: a file opens the
 * preview overlay on `{uuid, index}` and a folder posts the same pair to
 * `POST …/output/reveal-folder`, which re-derives the directory server-side. Nothing that
 * leaves the browser is ever spelled as a path (§7 rule 1), so a folder's `entry` is *an
 * output that lives in it* rather than the folder itself.
 *
 * Two details that are not arbitrary:
 *
 *   **A file match wins over a folder match**, asked in that order, so a path that is
 *   somehow both opens rather than reveals. The overlay is the cheaper mistake.
 *
 *   **A folder prefers an output still on disk.** Any output in a directory answers "which
 *   record names this folder" equally well, but the reveal is refused for a gone file — so
 *   picking a `gone` one when a live sibling exists would draw a link that 404s. `onDisk`
 *   is compared to `true` and not truth-tested: it is `null` for a pathless entry and
 *   `false` for a deleted one, which are different answers.
 */
export function linkablePaths(found, outputs, cwd) {
  const spans = Array.isArray(found) ? found : [];
  if (!spans.length) return [];

  const byFile = new Map();
  const byFolder = new Map();
  for (const o of Array.isArray(outputs) ? outputs : []) {
    const raw = typeof o?.path === 'string' ? o.path.trim() : '';
    if (!raw || !raw.startsWith('/')) continue;
    const abs = normalise(raw);
    if (abs === '/') continue;
    if (!byFile.has(abs)) byFile.set(abs, o);
    const dir = parentOf(abs);
    if (!dir || dir === '/') continue;
    const prev = byFolder.get(dir);
    if (!prev || (prev.onDisk !== true && o.onDisk === true)) byFolder.set(dir, o);
  }
  if (!byFile.size && !byFolder.size) return [];

  const out = [];
  for (const span of spans) {
    const abs = resolvePath(span.text, cwd);
    if (!abs) continue;
    const file = byFile.get(abs);
    if (file) {
      out.push({ ...span, kind: 'file', entry: file });
      continue;
    }
    const folder = byFolder.get(abs);
    if (folder) out.push({ ...span, kind: 'folder', entry: folder });
  }
  return out;
}

/** Shape and scope in one call — what both DOM call sites actually want. */
export function pathLinksIn(text, outputs, cwd) {
  return linkablePaths(findPaths(text), outputs, cwd);
}
