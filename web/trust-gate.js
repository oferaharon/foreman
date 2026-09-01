/*
 * trust-gate.js — the one box the panel can read perfectly and will never answer.
 *
 * Claude Code's folder-trust gate is the screen a session lands on the first time it is
 * opened in a directory Claude Code has not seen before. Answering it grants read, edit
 * and execute on that folder. The panel does not answer security gates, and this file is
 * the whole of how that stance is enforced in the browser: one witness, the copy the gate
 * actually shows, and a card with nothing to press.
 *
 * ── Why this is a file and not four lines in `buildDecisionBar` ───────────────────────
 *
 * Three parties need the same answer to "is this screen the trust gate?", and they had
 * grown two spellings of it before this file existed:
 *
 *   web/app.js      the desktop composer, which drew a one-tap "Yes, I trust this folder"
 *   web/m/cards.js  the phone, which refused it correctly and owned the only copy
 *   server/index.js the `/answer` endpoint, which would have sent the digit either way
 *
 * The server imports this file directly (`../web/trust-gate.js`) rather than keeping a
 * third copy, which is the one thing in the layout worth a raised eyebrow: everything else
 * under `server/` imports only from `server/`. It is deliberate. The browser needs this
 * module at a path that resolves as a static file *and* in node — so it has to live under
 * `web/` — and one measured fact with three readers must not become three facts. Nothing
 * here touches the DOM at module scope, so importing it server-side costs nothing.
 *
 * ── What was measured ─────────────────────────────────────────────────────────────────
 *
 * Claude Code **v2.1.247**, captured at the launcher's 220 columns and again at 70, pinned
 * as `test/fixtures/pane-trust-gate.txt` and `pane-trust-gate-narrow.txt`. At both widths
 * `parsePane` returns an ordinary, fully-populated permission box:
 *
 *   state:   'needs-decision'
 *   dialog:  null
 *   prompt:  { title: 'Accessing workspace:', cursor: 1, options: [
 *              {index: 1, label: 'Yes, I trust this folder', kind: 'approve', selected: true},
 *              {index: 2, label: 'No, exit',                 kind: 'deny'} ] }
 *
 * That is why the gate needs a witness of its own. The two guards that would obviously
 * catch an unanswerable box both walk straight past it: it has no `dialog`, and it has a
 * prompt. It is not "the box we could not read" — it is a box we read perfectly and refuse.
 */

/**
 * Is this prompt Claude Code's folder-trust gate?
 *
 * The witness is the one `answerTrustGate` (`server/dispatch.js`) already uses, with one
 * deliberate difference: that function requires the label **and** the safety-check phrase,
 * and this requires **either**. The asymmetry is not sloppiness. `answerTrustGate` decides
 * whether to *answer* a gate — for a worktree the dispatch itself just created, and for
 * nothing else — where a miss costs a dispatch that sits and waits. This decides whether to
 * *refuse*, where a miss ships a one-tap grant of read, edit and execute to anything that
 * can reach the panel. The two errors are not the same size, so the test that refuses is
 * the looser one.
 *
 * @param {{title?: string, subject?: string, question?: string, detail?: string[],
 *          options?: {label?: string}[]} | null | undefined} prompt
 * @returns {boolean}
 */
export function isTrustGate(prompt) {
  if (!prompt) return false;

  const labels = (prompt.options || []).map((o) => String(o.label || '')).join(' | ');
  if (/I trust this folder/i.test(labels)) return true;

  // A wording change that keeps the screen but loses that label still has to be refused.
  // Both halves are quoted from the fixtures; the phrase lands in `detail` at 220 columns
  // and in a *wrapped* `detail` line at 70, so the whole box is flattened before testing.
  // `Do you trust` is the pre-v2.1.247 spelling and is kept for older Claude Code builds.
  const flat = [prompt.title, prompt.subject, prompt.question, ...(prompt.detail || [])]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  return /Accessing workspace/i.test(flat) && /safety check|Do you trust/i.test(flat);
}

/**
 * The workspace path, reassembled.
 *
 * `readOptionBlock` takes the first line under the title as `subject`, and at 70 columns
 * the path is three lines — so the subject is a *truncated* path and its remaining thirds
 * are the first entries of `detail`. Pinned in `test/pane.test.js`. Nothing that *answers*
 * the box cares; anything that displays the folder does, because a path cut mid-word is
 * worse than no path when the whole question is which folder this is.
 *
 * @param {{subject?: string, detail?: string[]}} prompt
 * @returns {string|null}
 */
export function trustPath(prompt) {
  if (!prompt?.subject) return null;
  let out = prompt.subject;
  for (const line of prompt.detail || []) {
    if (/^(Quick safety check|Claude Code|Security guide|Do you trust)/i.test(line)) break;
    out += line;
  }
  return out;
}

/**
 * What the gate actually says, reassembled into the two sentences it means.
 *
 * Caught on the bench at 70 columns and worth the paragraph: a first draft picked the
 * `detail` lines that *matched* the phrases, which at 220 columns is the whole screen and
 * at 70 columns is the first line of a four-line wrap — so the card showed "Quick safety
 * check: Is this a project you created or one you trust?" and silently dropped "(Like your
 * own code, a well-known open source project, or work from your team). If not, take a
 * moment to review what's in this folder first." The half it threw away is the half that
 * tells you how to decide.
 *
 * So the tail is joined rather than filtered. `Security guide` is a link label with nothing
 * behind it in a capture and goes; the two real sentences are split back apart on the
 * second one's own opening, which is a fixed string on this screen and reads as two facts —
 * what to check, and what is being granted.
 *
 * @param {{detail?: string[]}} prompt
 * @returns {string[]}
 */
export function gateSentences(prompt) {
  const detail = prompt?.detail || [];
  const from = detail.findIndex((l) => /safety check|Do you trust/i.test(l));
  if (from < 0) return [];

  const text = detail
    .slice(from)
    .filter((l) => !/^\s*Security guide\s*$/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const at = text.search(/Claude Code['’]ll be able to/i);
  return at > 0 ? [text.slice(0, at).trim(), text.slice(at).trim()] : [text];
}

/**
 * The desktop's refusal card: the gate named, transcribed, and given nothing to press.
 *
 * It is built as a `.perm` card so it lands where the permission bar would have, and
 * carries `.perm-refusal` so it cannot be mistaken for one — same treatment the "could not
 * read the prompt" card already uses, because they are the same kind of answer: *this
 * session is waiting on something, and it is not waiting on you here.*
 *
 * **Nothing in here may become a control.** No `<button>`, no `<a>`, no handler, not even a
 * disabled one — a disabled button is a button somebody will enable. The options are shown
 * as flat text for one reason: knowing the Mac is showing `1. Yes, I trust this folder /
 * 2. No, exit` is exactly what makes the walk to the terminal worth making.
 * `test/trust-gate.test.js` walks the returned tree and fails on any of it.
 *
 * @param {object} prompt a `parsePane` prompt already established to be the gate
 * @returns {HTMLElement}
 */
export function buildTrustNotice(prompt) {
  const card = document.createElement('div');
  card.className = 'perm perm-refusal';

  const head = document.createElement('div');
  head.className = 'perm-head';
  const kind = document.createElement('span');
  kind.className = 'perm-kind';
  kind.textContent = 'folder-trust gate';
  head.append(kind);
  card.append(head);

  const box = document.createElement('div');
  box.className = 'perm-gate';

  const title = document.createElement('div');
  title.className = 'perm-gate-title';
  title.textContent = prompt.title || 'Accessing workspace:';
  box.append(title);

  const dir = trustPath(prompt);
  if (dir) {
    const el = document.createElement('div');
    el.className = 'perm-gate-path';
    el.textContent = dir;
    box.append(el);
  }

  for (const line of gateSentences(prompt)) {
    const el = document.createElement('div');
    el.className = 'perm-gate-line';
    el.textContent = line;
    box.append(el);
  }

  const opts = document.createElement('div');
  opts.className = 'perm-gate-opts';
  for (const o of prompt.options || []) {
    const row = document.createElement('div');
    row.className = 'perm-gate-opt';
    row.textContent = `${o.index}. ${o.label}`;
    opts.append(row);
  }
  box.append(opts);
  card.append(box);

  const note = document.createElement('p');
  note.className = 'perm-note';
  note.textContent =
    "This is Claude Code's folder-trust gate, and answering it grants read, edit and " +
    'execute on that folder. The panel never answers a security gate — it has to be ' +
    'answered at the Mac, in the terminal.';
  card.append(note);

  return card;
}
