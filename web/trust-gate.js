/*
 * trust-gate.js — the one screen Claude Code draws that nothing else in this panel reads,
 * and, since 2026-09-19, one the panel may answer.
 *
 * Claude Code's folder-trust gate is the screen a session lands on the first time it is
 * opened in a directory Claude Code has not seen before. Answering it grants read, edit
 * and execute on that folder. This file is everything the panel knows about that screen:
 * how to read it off the pane, how to recognise it once read, how to reassemble the two
 * pieces of copy that wrap, and the card the desktop draws for it.
 *
 * ── The ruling, and the stance it replaced ────────────────────────────────────────────
 *
 * Until 2026-09-19 the panel refused this box outright. The card had no button, the phone
 * had no button, and `POST /api/sessions/:id/answer` returned 409 for it, so the refusal
 * was a property of the panel rather than a habit of its front end. The reasoning is worth
 * keeping because it is all still true: the panel has no authentication by the 2026-08-27
 * ruling, it binds wider than loopback, and a button here is a one-click grant of read,
 * edit and execute in a folder nobody vetted, reachable from anything on the LAN.
 *
 * The maintainer reversed it on 2026-09-19, with that exposure put to him in those words.
 * His ruling: Foreman must not force a user to open a terminal — *one panel to use instead
 * of terminals* is the whole narrative, and a screen the panel can read perfectly and will
 * not answer sends him to the Mac for the one keystroke the tool exists to save. So the
 * gate is offered like any other multiple-choice box, on the desktop, on the phone and at
 * the endpoint, and the exposure is accepted as it stands.
 *
 * What did **not** change with it: the card still transcribes the screen — the folder, in
 * full, and the sentence that says what is being granted — because that is what lets
 * somebody decide, and the Yes still asks twice. Do not quietly re-derive the refusal, and
 * do not add authentication here; both are decided, and both were decided with the cost
 * spelled out.
 *
 * ── Why this is a file and not four lines in `buildDecisionBar` ───────────────────────
 *
 * Five parties need the same answer to "is this screen the trust gate, and what is on it?",
 * and before this file existed they had grown two spellings of it:
 *
 *   server/tmux.js  `parsePane`, which has to read the unnumbered layout at all
 *   web/app.js      the desktop composer and its decision bar
 *   web/m/cards.js  the phone
 *   server/index.js the `/answer` endpoint
 *   server/dispatch.js the one gate the panel answers unattended, for a fresh worktree
 *
 * The server imports this file directly (`../web/trust-gate.js`) rather than keeping a
 * second copy, which is the one thing in the layout worth a raised eyebrow: everything else
 * under `server/` imports only from `server/`. It is deliberate. The browser needs this
 * module at a path that resolves as a static file *and* in node — so it has to live under
 * `web/` — and one measured fact with five readers must not become five facts. Nothing
 * here touches the DOM at module scope, so importing it server-side costs nothing.
 *
 * ── What was measured ─────────────────────────────────────────────────────────────────
 *
 * **Claude Code v2.1.257**, captured at the launcher's 220 columns and again at 70, pinned
 * as `test/fixtures/pane-trust-gate.txt` and `pane-trust-gate-narrow.txt`. The options are
 * **unnumbered** and the cursor starts on **No**:
 *
 *     ❯ No, exit
 *       Yes, I trust this folder
 *
 *     Enter to confirm · Esc to cancel
 *
 * **Claude Code v2.1.247**, the same two widths, kept as `pane-trust-gate-2.1.247.txt` and
 * `-2.1.247-narrow.txt`. There the options were numbered and the cursor started on Yes:
 *
 *     ❯ 1. Yes, I trust this folder
 *       2. No, exit
 *
 * Both are still live shapes — nothing in this repo pins which Claude Code is installed —
 * so both are read. The numbered one parses as an ordinary permission box through
 * `parsePrompt`; the unnumbered one is what `parseTrustGate` below exists for, because
 * `OPTION_RE` in `server/permission.js` requires an `N.` and must keep requiring it. The
 * five screen parsers refuse each other's boxes by exactly that kind of strictness, and
 * loosening the shared regex to admit a bare label would teach every screen in the panel to
 * read a sentence as an option. Same lesson, same shape of fix, as the scrolling-window
 * flattening in `server/model.js`.
 *
 * **And what the answer is.** There is no digit to press on the unnumbered layout, so the
 * answer is the cursor: press `Down`, re-read, repeat until `❯` sits on the row you want,
 * then `Enter`. Measured on v2.1.257 in a throwaway folder — and the reason it is written
 * as press-and-re-read rather than a counted number of presses is measured too: **the list
 * wraps**, `Down` from the last row lands on the first, so a miscount does not stall, it
 * silently selects the other answer. `confirmGateOption` in `server/tmux.js` is the walk;
 * it never sends `Enter` unless the row under the cursor is the row it was asked for.
 */

/** The gate's own footer. The only "this box is open right now" marker it has. */
const GATE_FOOTER_RE = /Enter to confirm/i;

/** The trust row, by its own label. Same spelling as `TRUST_RE` in `server/permission.js`. */
const TRUST_LABEL_RE = /^yes,?\s+i trust\b/i;

/** The box's top edge. */
const GATE_EDGE_RE = /^\s*[─━╭╰│╮╯]{3,}/;

/**
 * Read the unnumbered folder-trust gate straight off the pane.
 *
 * Returns a prompt in exactly the shape `parsePrompt` returns for the numbered layout, so
 * every reader downstream — `isTrustGate`, `trustPath`, `gateSentences`, the two cards,
 * `needsKind`, the answer endpoint — is unchanged by which Claude Code drew the screen.
 * `parsePane` tries `parsePrompt` first and falls back to this; the numbered gate therefore
 * never reaches here.
 *
 * **What it is anchored on, and why each anchor is there.** The footer, so a gate scrolled
 * into the backlog is not read as a live one. The `❯`, because the option block is the only
 * run of lines on this screen that contains one and there is nothing else to tell an option
 * row from a sentence — this screen has no numbers, no bullets and no indent that a wrapped
 * paragraph does not also have. Exactly two rows in that block, because that is what the
 * screen has and a third means it is not this screen. And a row matching
 * `Yes, I trust this folder`, which is what makes the box *answerable*: without it we cannot
 * say which row grants, and a gate we cannot answer correctly is one we decline to answer at
 * all — it falls through to `dialog` and the old cannot-read card, which is the safe
 * direction. `isTrustGate` deliberately stays looser than this (see its own note): that one
 * decides whether a box is the gate, this one decides whether we know how to press it.
 *
 * The two `kind`s are assigned here rather than through `classify` in `server/permission.js`
 * — which this file cannot import, being a browser module — and that is not a second
 * spelling of the classifier. This screen has exactly two rows: the one that says it trusts
 * the folder, and the one that does not. `classify` carves the trust label out as a plain
 * `approve` anyway, so the two layouts produce identical option objects; `test/pane.test.js`
 * pins that they do.
 *
 * @param {string} text raw `capture-pane` output
 * @returns {null | {title, subject, detail, question, options, cursor, raw}}
 */
export function parseTrustGate(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));

  const nonEmpty = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  const footerIdx = nonEmpty.slice(-3).find((i) => GATE_FOOTER_RE.test(lines[i]));
  if (footerIdx === undefined) return null;

  // The cursor row, in the block directly above the footer. Nothing else on this screen
  // carries a `❯`.
  let cursorIdx = -1;
  for (let i = footerIdx - 1; i >= 0 && footerIdx - i < 8; i -= 1) {
    if (lines[i].includes('❯')) {
      cursorIdx = i;
      break;
    }
    if (lines[i].trim() && GATE_EDGE_RE.test(lines[i])) break;
  }
  if (cursorIdx < 0) return null;

  // The contiguous non-blank run that row sits in — bounded by the blank lines the screen
  // puts above and below it at both measured widths.
  let start = cursorIdx;
  while (start > 0 && lines[start - 1].trim()) start -= 1;
  let end = cursorIdx;
  while (end + 1 < footerIdx && lines[end + 1].trim()) end += 1;

  const rows = lines.slice(start, end + 1);
  if (rows.length !== 2) return null;

  const options = rows.map((line, n) => {
    const selected = line.includes('❯');
    const label = line.replace('❯', '').trim();
    return {
      index: n + 1,
      label,
      kind: TRUST_LABEL_RE.test(label) ? 'approve' : 'deny',
      selected,
    };
  });

  if (!options.some((o) => TRUST_LABEL_RE.test(o.label))) return null;
  if (options.filter((o) => o.selected).length !== 1) return null;

  // Everything from the box's top edge down to the option block is the body, in the same
  // shape `parsePrompt` produces it: the title, then the first line under it as `subject`,
  // then the rest as `detail`. `trustPath` and `gateSentences` are written against that.
  const body = [];
  for (let j = start - 1; j >= 0 && start - j < 24; j -= 1) {
    const line = lines[j];
    if (GATE_EDGE_RE.test(line)) break;
    if (line.trim()) body.unshift(line.trim());
  }
  if (!body.length) return null;

  return {
    title: body[0] || null,
    subject: body[1] || null,
    detail: body.slice(2),
    // Nothing on this screen reads as a question: the nearest line above the options is
    // `Security guide`. The numbered layout's parse returns null here too, pinned in
    // `test/pane.test.js`, and the two must agree — a question plucked out of the body on
    // one layout and not the other would move a sentence out of `detail` and out of the card.
    question: null,
    options,
    cursor: options.find((o) => o.selected)?.index ?? null,
    raw: lines.slice(Math.max(0, start - 20), footerIdx + 1).filter((l) => l.trim()),
  };
}

/**
 * Is this prompt Claude Code's folder-trust gate?
 *
 * Looser than `parseTrustGate` on purpose, and the asymmetry is the same one it has always
 * had, pointed the other way round now that the panel answers. This decides whether a box
 * gets the **gate's** treatment — the transcript, the folder path, the armed Yes, and the
 * cursor-walk answer instead of a digit. A box wrongly called the gate is a box the panel
 * tries to answer by cursor and refuses to Enter on, which is loud and harmless; a gate
 * wrongly called an ordinary permission box gets a digit sent into it, which on this screen
 * is not an answer at all, and loses the copy that says what is being granted. So the test
 * that *claims* the screen stays the loose one.
 *
 * `answerTrustGate` (`server/dispatch.js`) is stricter again, and deliberately: it decides
 * whether to answer a gate **unattended**, for a worktree the dispatch itself just created,
 * and it also checks the folder's own name is on screen.
 *
 * @param {{title?: string, subject?: string, question?: string, detail?: string[],
 *          options?: {label?: string}[]} | null | undefined} prompt
 * @returns {boolean}
 */
export function isTrustGate(prompt) {
  if (!prompt) return false;

  const labels = (prompt.options || []).map((o) => String(o.label || '')).join(' | ');
  if (/I trust this folder/i.test(labels)) return true;

  // A wording change that keeps the screen but loses that label still has to be recognised.
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
 * The option on this gate that grants trust, or null when no row says it does.
 *
 * One spelling of "which row is the Yes", shared by the card, the endpoint and the
 * dispatch's unattended answer. There is no digit to fall back on here, so a gate whose
 * trust row cannot be named is one nothing may press `Enter` on.
 *
 * @param {{options?: {label?: string}[]}|null|undefined} prompt
 * @returns {object|null}
 */
export function trustOption(prompt) {
  return (prompt?.options || []).find((o) => TRUST_LABEL_RE.test(String(o.label || ''))) || null;
}

/**
 * The workspace path, reassembled.
 *
 * The body walk takes the first line under the title as `subject`, and at 70 columns the
 * path is three lines — so the subject is a *truncated* path and its remaining thirds are
 * the first entries of `detail`. Pinned in `test/pane.test.js`. Nothing that *answers* the
 * box cares; anything that displays the folder does, because a path cut mid-word is worse
 * than no path when the whole question is which folder this is — and under the 2026-09-19
 * ruling it is now also the thing somebody is deciding on before they press Yes.
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
 * The desktop's trust-gate card: the gate named, transcribed, and answerable.
 *
 * Built as a `.perm` card so it lands where the permission bar would have, and carries
 * `.perm-trust` for the amber edge — not because it is refused any more, but because it is
 * still the most consequential box the panel draws, and the reader should be able to tell
 * it from an ordinary prompt at a glance.
 *
 * Three things about it are deliberate.
 *
 * **The transcript stays.** The folder, whole, and both of the gate's own sentences. Under
 * the old stance that block was the entire value of the card — it told you whether the walk
 * to the Mac was worth making. Under the new one it is what a person decides *on*, which is
 * a stronger reason to keep it, not a weaker one. A card that offered two buttons and no
 * folder path would be asking for a signature on an unread page.
 *
 * **The rows are drawn in the screen's own order, without numbers.** v2.1.257 draws them
 * unnumbered with `No` first; printing `1.` / `2.` beside them would be inventing a handle
 * the terminal does not show and cannot be cross-checked against. The `index` still travels
 * to the endpoint, because something has to name the row — it is just not a keystroke any
 * more, and on this screen it never was.
 *
 * **The Yes asks twice**, the same idiom `buildPermOption` uses for a broad approval and for
 * the same reason: what it buys outlives the call in front of you. `No, exit` goes on one
 * click — refusing is the cheap direction.
 *
 * @param {object} prompt a `parsePane` prompt already established to be the gate
 * @param {(option: object) => void} [onAnswer] called with the option the reader chose;
 *   omitted for a read-only render, which then draws the rows as flat text
 * @returns {HTMLElement}
 */
export function buildTrustCard(prompt, onAnswer) {
  const card = document.createElement('div');
  card.className = 'perm perm-trust';

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
  card.append(box);

  const opts = document.createElement('div');
  opts.className = 'perm-opts';
  for (const o of prompt.options || []) {
    opts.append(onAnswer ? gateButton(o, onAnswer) : gateRow(o));
  }
  card.append(opts);

  const err = document.createElement('div');
  err.className = 'perm-err';
  err.hidden = true;
  card.append(err);
  card._err = err;

  return card;
}

/** A row nobody can press — the read-only render, and what a card with no handler gets. */
function gateRow(o) {
  const row = document.createElement('div');
  row.className = 'perm-gate-opt';
  row.textContent = o.label;
  return row;
}

/**
 * One answering row. The trust row arms; the refusal does not.
 *
 * The arming is spelled out here rather than reused from `buildPermOption` because that
 * function lives inside `createPane`'s closure in `web/app.js` and this file must stay
 * importable in node — `test/trust-gate.test.js` builds this card against a stub DOM. The
 * behaviour is the same four seconds and the same "label never moves" rule, and the reason
 * for that rule is the same: the sentence you are re-reading while you decide must not be
 * taken off screen by the press that asks you to think about it.
 */
function gateButton(o, onAnswer) {
  const arm = TRUST_LABEL_RE.test(String(o.label || ''));

  const b = document.createElement('button');
  b.className = `perm-opt ${o.kind}${arm ? ' needs-arming' : ''}`;
  b.dataset.index = String(o.index);

  const body = document.createElement('span');
  body.className = 'perm-body';

  const label = document.createElement('span');
  label.className = 'perm-label';
  label.textContent = o.label;
  body.append(label);
  b.append(body);

  if (!arm) {
    b.onclick = () => onAnswer(o);
    return b;
  }

  const confirm = document.createElement('span');
  confirm.className = 'perm-confirm';
  confirm.hidden = true;
  confirm.textContent =
    'sure? click again — this grants read, edit and execute in that folder, for good';
  body.append(confirm);

  let armed = false;
  let timer = 0;
  const disarm = () => {
    armed = false;
    b.classList.remove('is-armed');
    confirm.hidden = true;
  };
  b.onclick = () => {
    if (!armed) {
      armed = true;
      b.classList.add('is-armed');
      confirm.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(timer);
    disarm();
    onAnswer(o);
  };
  return b;
}
