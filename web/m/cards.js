/*
 * cards.js — item 7. The answer cards: the part of the phone that presses buttons.
 *
 * `buildCard(session)` returns a node to mount above the composer, or **null when nothing
 * is blocking**. Item 6's lead screen mounts whatever comes back.
 *
 * ── The governing rule ────────────────────────────────────────────────────────────────
 *
 * **Nothing here answers anything.** Every card posts to an endpoint that already exists,
 * with the body it already takes, and the server re-reads the pane, re-checks every label
 * the card displayed, computes a multi-select's toggle *diff* and re-reads the review
 * screen before a submit digit is ever sent. This file draws buttons big enough for a
 * thumb and gets out of the way. Re-implementing any of that reading here would give the
 * panel two opinions about one screen, which is the failure the endpoints were written to
 * make impossible.
 *
 *   permission → POST /api/sessions/:id/answer    {option, expectLabel}
 *   question   → POST /api/sessions/:id/question  {options[], expect[]}
 *                                                 {action:'submit'|'cancel'|'chat'|'text', text}
 *   plan       → POST /api/sessions/:id/plan      {index, expectLabel} | {feedback}
 *
 * ── The five screens, and which of them may have controls ─────────────────────────────
 *
 * A lead can raise three of Claude Code's five numbered boxes. It gets a card for each.
 *
 *   permission  routinely — the lead shells `git pull`, `npm run restart-panel`, `lsof`,
 *               and calls Gitea. Options in the box's **own numeric order**, each showing
 *               its own digit, and every yes broader than "this once" armed. Which is not
 *               the same as "option 2" — see `broaderYeses` for the four-option box that
 *               proved it during this item's bench.
 *   question    always available. Single-select sends on one tap; a multi-select ticks and
 *               submits through the server's diff-and-review path.
 *   plan        rarely, and it is the dangerous one. Its option 1 is the **broad** yes —
 *               exactly backwards from a permission box — and can be "clear context and
 *               bypass permissions". Sorted safest-first, danger armed.
 *
 * The other two get **no controls, ever**:
 *
 *   /model      a digit there does not move a cursor, it *commits* — and commits as the
 *               **global default for every future session**. Measured the expensive way;
 *               `~/.claude/settings.json` was restored from a backup.
 *   /effort     has no session-only path at all. Its Enter writes `effortLevel` globally,
 *               and the `s` ("this session only") key inside /model still wrote it
 *               globally. Also measured, also restored from a backup.
 *
 * And neither does the **startup trust gate**, which is not a permission prompt however
 * much it parses like one. See `web/trust-gate.js` — it is the sharpest thing either this
 * file or the desktop's composer leans on, and it is now shared with both.
 *
 * ── What is rebuilt, and what must not be ─────────────────────────────────────────────
 *
 * This is called on every roster frame, roughly every two seconds. A card that was rebuilt
 * each time would drop a multi-select's ticks, empty a half-typed field and disarm a
 * button between the two taps that were meant to arm and fire it — and the box that most
 * invites a slow, careful answer is the box that most deserves not to be yanked. So the
 * node is memoised against a **signature** of what the card actually draws and sends. Two
 * things are deliberately left out of that signature: a question option's `checked` flag,
 * which is the terminal's tick and not the reader's, and the free-text row's *label*,
 * because the moment anyone types into it that label stops being "Type something." and
 * becomes the text (`test/fixtures/dialog-choice-typed.txt` is that state).
 */

import { isTrustGate, trustPath, gateSentences } from '../trust-gate.js';

/**
 * One live node per session, keyed by id.
 *
 * Bounded by the number of teams — this is a phone, and there is one lead screen. An entry
 * is dropped the moment its session stops blocking, which is also what stops a stale
 * disabled card coming back if the same box reopens.
 *
 * @type {Map<string, {sig: string, node: HTMLElement}>}
 */
const live = new Map();

/**
 * @param {any} session a roster row
 * @returns {HTMLElement|null} the card, or null when nothing is blocking
 */
export function buildCard(session) {
  if (!session?.id) return null;

  const kind = classify(session);
  if (!kind) {
    live.delete(session.id);
    return null;
  }

  const sig = signature(session, kind);
  const held = live.get(session.id);
  if (held && held.sig === sig) return held.node;

  const node = build(session, kind);
  live.set(session.id, { sig, node });
  return node;
}

/**
 * Which card this session gets, most specific first.
 *
 * The order after `trust` is the desktop's, and each step of it was learned the same way:
 * all three of plan, question and permission report `needs-decision`, so with the
 * permission branch in front a question box fell through to "the prompt could not be read"
 * while a perfectly parsed question sat unused, and the plan approval did it again one
 * step later.
 *
 * `trust` goes first because it is the branch that *refuses*, and a refusal that can be
 * reached only after two other tests have declined is a refusal waiting to be bypassed.
 */
function classify(s) {
  if (isTrustGate(s.prompt)) return 'trust';
  if (s.plan && s.interactive) return 'plan';
  if (s.question && s.interactive) return 'question';
  if (s.prompt && s.interactive) return 'permission';
  // A box we could not read, or one we can read and will not touch. `dialog` covers the
  // pickers: /model, /effort, /config, /resume. `needs-decision` with nothing behind it is
  // the `Switch model?` confirm's shape.
  if (s.status === 'needs-decision' || s.status === 'dialog') return 'opaque';
  return null;
}

function build(s, kind) {
  switch (kind) {
    case 'trust':
      return trustCard(s);
    case 'plan':
      return planCard(s);
    case 'question':
      return questionCard(s);
    case 'permission':
      return permissionCard(s);
    default:
      return opaqueCard(s);
  }
}

/**
 * What the card draws and what it would send, as one string.
 *
 * Anything in here rebuilds the card when it changes; anything left out does not. Getting
 * that boundary wrong is felt in opposite directions — too tight and the phone shows a box
 * that has moved on, too loose and the card vanishes from under a thumb mid-answer.
 */
function signature(s, kind) {
  const opt = (o) => `${o.index}:${o.kind || o.tone || ''}:${o.label}`;
  switch (kind) {
    case 'trust': {
      const p = s.prompt;
      return ['trust', p.title, p.subject, (p.detail || []).join('¶'), p.options.map(opt).join(',')].join('|');
    }
    case 'plan': {
      const p = s.plan;
      return [
        'plan',
        p.header,
        p.planPath || '',
        p.options.map(opt).join(','),
        p.feedback ? `${p.feedback.index}:${p.feedback.label}` : '',
      ].join('|');
    }
    case 'question': {
      const q = s.question;
      // The free-text row's label is excluded: it is *replaced* by whatever gets typed
      // into it, so keying on it would rebuild the card in the middle of using it.
      const opts = (q.options || [])
        .map((o) => (o.index === q.freeTextIndex ? `${o.index}:*` : `${o.index}:${o.label}:${o.description || ''}`))
        .join(',');
      return [
        'question',
        q.kind,
        q.question,
        String(q.multiSelect),
        opts,
        String(q.chatIndex),
        String(q.freeTextIndex),
        (q.answers || []).map((a) => `${a.question}→${a.answer || ''}`).join(','),
        (q.questions || []).map((step) => `${step.label}${step.answered ? '✓' : ''}`).join(','),
      ].join('|');
    }
    case 'permission': {
      const p = s.prompt;
      return [
        'permission',
        p.title,
        p.subject,
        (p.detail || []).join('¶'),
        p.question,
        p.options.map(opt).join(','),
      ].join('|');
    }
    default:
      return ['opaque', s.status, s.dialog || ''].join('|');
  }
}

/* ════════════════════════════════════════════════════ the trust gate ═══ */

/*
 * The witness and the two copy-reassemblers moved to `web/trust-gate.js`. The desktop
 * composer needed exactly the same three answers this file needed, and the phone was the
 * only place in the panel that had them — which is how the desktop went on drawing a
 * one-tap `Yes, I trust this folder` long after the phone stopped. One measured fact,
 * three readers, one copy. The card below is still the phone’s own; only the witness is
 * shared. Read that file for what v2.1.247 actually puts on screen and why neither
 * obvious test for an unanswerable box catches it.
 */

/**
 * The gate, said plainly and with nothing to press.
 *
 * The copy is written off the real screen rather than off §2.6 of the plan, which quotes
 * "Do you trust the files in this folder?" — a sentence Claude Code no longer says. The
 * options are shown as inert text, not buttons: knowing that the Mac is showing
 * `1. Yes, I trust this folder / 2. No, exit` is exactly what makes the trip worth making.
 */
function trustCard(s) {
  const p = s.prompt;
  const card = shell('m-card is-refusal');

  card.append(head('waiting on something the panel will not answer'));

  const box = document.createElement('div');
  box.className = 'm-gate-screen';

  const title = document.createElement('div');
  title.className = 'm-gate-title';
  title.textContent = p.title || 'Accessing workspace:';
  box.append(title);

  const path = trustPath(p);
  if (path) {
    const el = document.createElement('div');
    el.className = 'm-gate-path';
    el.textContent = path;
    box.append(el);
  }

  for (const line of gateSentences(p)) {
    const el = document.createElement('div');
    el.className = 'm-gate-line';
    el.textContent = line;
    box.append(el);
  }

  const opts = document.createElement('div');
  opts.className = 'm-gate-opts';
  for (const o of p.options || []) {
    const row = document.createElement('div');
    row.className = 'm-gate-opt';
    row.textContent = `${o.index}. ${o.label}`;
    opts.append(row);
  }
  box.append(opts);
  card.append(box);

  card.append(
    note(
      "This is Claude Code's folder-trust gate. The panel never answers a security gate — " +
        'it has to be answered at the Mac, in the terminal.',
    ),
  );
  return card;
}

/* ══════════════════════════════════════════════════════ the permission ═══ */

/**
 * The permission card.
 *
 * Two rules, both of which this panel has already broken once:
 *
 * **The options keep the box's own numeric order and carry their own digits.** They are
 * not sorted, not reordered, not filtered. The digit and the position agree with what the
 * terminal shows, which is the one thing a human can cross-check from across the room —
 * and answering by position is what v1 did when it sent `Down, Enter` for "deny", landed
 * on option 2, and granted a standing rule instead.
 *
 * **Every yes after the plain one is a broader yes** — "Yes, and don't ask again", "Yes,
 * allow all edits this session", "Yes, allow reading from /private/tmp from this project",
 * "Yes, and switch to auto mode" — so each is styled as a warning and armed; `broaderYeses`
 * below decides which, and on what two pieces of evidence. `No` is a plain single tap,
 * because refusing is the cheap direction and so is agreeing once.
 */
function permissionCard(s) {
  const p = s.prompt;
  const card = shell('m-card');
  const err = errorLine();

  const h = head(p.title || 'permission');
  if (p.subject) {
    const subj = document.createElement('span');
    subj.className = 'm-card-subject';
    subj.textContent = p.subject;
    h.append(subj);
  }
  card.append(h);

  if (p.detail?.length) {
    const detail = document.createElement('div');
    detail.className = 'm-card-detail';
    for (const line of p.detail) {
      const row = document.createElement('div');
      row.textContent = line;
      // Diff lines arrive as `1 -hello` / `1 +goodbye`.
      if (/^\d+\s*-/.test(line)) row.className = 'del';
      else if (/^\d+\s*\+/.test(line)) row.className = 'add';
      detail.append(row);
    }
    card.append(detail);
  }

  if (p.question) {
    const q = document.createElement('div');
    q.className = 'm-card-q';
    q.textContent = p.question;
    card.append(q);
  }

  const broad = broaderYeses(p.options);

  const opts = document.createElement('div');
  opts.className = 'm-opts';
  for (const o of p.options) {
    opts.append(
      optionButton({
        digit: o.index,
        label: o.label,
        tone: o.kind,
        // Every yes that grants more than this one call asks twice. The plain yes and
        // `No` go on one tap — refusing is the cheap direction and so is agreeing once.
        arm: broad.has(o.index),
        armNote: 'tap again — this grants more than this one call',
        card,
        err,
        send: () => post(`/api/sessions/${encodeURIComponent(s.id)}/answer`, {
          option: o.index,
          // The label travels so the server can refuse if the box moved under us.
          expectLabel: o.label,
        }),
      }),
    );
  }
  card.append(opts, err);
  return card;
}

/**
 * Which yeses on this box are broader than "yes, this once".
 *
 * Two independent witnesses, unioned, and both are kept on purpose.
 *
 * **The kind**, from `classify` in `server/permission.js`. When this card was built that
 * was the half that could not be trusted: it tested five phrases and a real four-option
 * Bash prompt walked past all of them, so `Yes, allow reading from /private/tmp from this
 * project` and `Yes, and switch to auto mode` both arrived as a plain `approve` and this
 * function's positional rule was the only thing standing between a phone and a one-tap
 * standing grant. That gap is fixed — the classifier's rule is now structural (the bare
 * `Yes` is the only narrow approval) and it reports three kinds, `approve`,
 * `approve-always` and `approve-mode`.
 *
 * **The position**, within the approvals only: Claude Code's cursor starts on the narrow
 * yes and it is always the first approval in the run, so every approval after it grants
 * more. Kept even though the classifier is fixed, because the two rest on entirely
 * different premises — what the label says, and where the terminal puts its cursor — and
 * a union of them is safer than either alone in both directions. A box whose *first*
 * approval is qualified is caught by the kind; a box that somehow offers two plain yeses
 * is caught by the position. Arming a row that did not need it costs one extra tap.
 *
 * The one box where those two witnesses genuinely disagree never gets here: the folder-trust
 * gate's `Yes, I trust this folder` is a qualified first approval, so the kind would want it
 * armed and the position would not — and `kindOf` routes that screen to `trustCard` before
 * this function is reached, on `isTrustGate` from `web/trust-gate.js`. The gate is refused,
 * not armed; arming is for boxes the panel will answer.
 *
 * Note how the kind test is written: **anything that is not the narrow `approve` and not a
 * refusal arms.** Spelling out the broad kinds by name is what nearly shipped
 * `approve-mode` as an unarmed one-tap row the day it was added — the row that switches a
 * session to auto mode, of all of them. A fourth kind must arm by default and be quieted
 * deliberately, never the other way round.
 */
function broaderYeses(options) {
  const out = new Set();
  let seenNarrowYes = false;
  for (const o of options || []) {
    if (o.kind === 'deny' || o.kind === 'other') continue;
    if (o.kind !== 'approve') {
      out.add(o.index); // every broad kind, named or not
      continue;
    }
    if (!seenNarrowYes) {
      seenNarrowYes = true; // the plain "Yes" — one tap
      continue;
    }
    out.add(o.index);
  }
  return out;
}

/* ════════════════════════════════════════════════════════════ the plan ═══ */

/**
 * The plan-approval card, which inverts the rule the permission card is built on.
 *
 * Here **option 1 is the broad yes** — the cursor starts on it, so Claude Code puts it at
 * the top — and its first row can read `Yes, clear context (34% used) and bypass
 * permissions`: one press that throws away the conversation the maintainer is having *and*
 * stops the session ever asking them anything again. The list is rebuilt at every render, so
 * the safe answer sits at no fixed number.
 *
 * So the card sorts **narrow → broad → refine → danger** and marks the first row primary.
 * The top button in a card is the one that gets pressed unread, and this is the screen
 * where that costs the most. The digit still travels with each row and is still what gets
 * sent — the sort changes where a row is drawn, never what it means.
 */
function planCard(s) {
  const p = s.plan;
  const card = shell('m-card is-plan');
  const err = errorLine();

  card.append(head('plan ready'));

  const header = document.createElement('div');
  header.className = 'm-card-q';
  header.textContent = p.header;
  card.append(header);

  if (p.planPath) card.append(planReader(s, p.planPath));

  const rank = { narrow: 0, broad: 1, refine: 2, danger: 3 };
  const sorted = [...p.options].sort((a, b) => (rank[a.tone] ?? 1) - (rank[b.tone] ?? 1));

  const opts = document.createElement('div');
  opts.className = 'm-opts';
  sorted.forEach((o, i) => {
    opts.append(
      optionButton({
        digit: o.index,
        label: o.label,
        description: o.description,
        tone: o.tone,
        primary: i === 0,
        arm: o.tone === 'danger',
        armNote: 'tap again — this changes the session itself, not just this plan',
        card,
        err,
        send: () => post(`/api/sessions/${encodeURIComponent(s.id)}/plan`, {
          index: o.index,
          expectLabel: o.label,
        }),
      }),
    );
  });
  card.append(opts);

  if (p.feedback) {
    const ta = document.createElement('textarea');
    ta.className = 'm-card-text';
    ta.rows = 3;
    ta.placeholder = p.feedback.label || 'Tell Claude what to change…';

    const bar = document.createElement('div');
    bar.className = 'm-card-bar';
    const send = document.createElement('button');
    send.className = 'm-card-submit';
    send.textContent = 'keep planning';
    send.onclick = () => {
      const feedback = ta.value.trim();
      if (!feedback) {
        ta.focus();
        return;
      }
      fire(card, err, () => post(`/api/sessions/${encodeURIComponent(s.id)}/plan`, { feedback }));
    };
    bar.append(send);
    card.append(ta, bar);
  }

  card.append(err);
  return card;
}

/** The plan file itself, fetched only if you open it. */
function planReader(s, planPath) {
  const box = document.createElement('details');
  box.className = 'm-plan-file';

  const summary = document.createElement('summary');
  summary.textContent = planPath.split('/').filter(Boolean).at(-1) || planPath;
  box.append(summary);

  const body = document.createElement('div');
  body.className = 'm-plan-md';
  body.textContent = 'reading…';
  box.append(body);

  let loaded = false;
  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true;
    try {
      // Imported here rather than at the top of the file, deliberately. A static import
      // makes the whole module fail to load if `/vendor/marked.js` ever does — and this
      // module is also what draws the permission card, which needs no markdown at all.
      // A broken vendor file should cost the plan *reader*, not every answer button on the
      // phone. The module cache means the fetch happens once.
      const { marked } = await import('/vendor/marked.js');
      const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/plan-file`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not read it.');
      // Options per call rather than `marked.setOptions`: this module shares one marked
      // instance with whatever else the page imports, and `breaks: true` would turn a plan
      // wrapped at 90 columns into a wall of forced line breaks on a 390px screen.
      body.innerHTML = marked.parse(data.markdown, { gfm: true, breaks: false });
    } catch (e) {
      loaded = false; // let a retry happen on the next open
      body.textContent = e.message;
    }
  });
  return box;
}

/* ════════════════════════════════════════════════════════ the question ═══ */

/**
 * `AskUserQuestion`, in four layouts that look alike and answer nothing alike.
 *
 * What a digit means changes per screen and nothing on screen says when you got it wrong,
 * so the client sends *what was chosen* and lets the server decide the keys:
 *
 *   single-select   one tap sends. No confirm step — the terminal has none either.
 *   multi-select    ticks are local; one `submit` sends the chosen set. The server diffs
 *                   it against what the box already has (a multi-select's keys are a diff,
 *                   not a selection — sending the digits you want turns *off* whatever is
 *                   already on), presses Tab, **re-reads the review screen** and refuses
 *                   the submit digit unless every chosen label is listed there.
 *   review          two rows that mean submit and cancel, by their own digits.
 *   preview panel   arrives already stripped (`stripPreviewPanel`), so it has options and
 *                   no preview — and `chatIndex === null`, `freeTextIndex === null`,
 *                   `needsConfirm === true`. Which is why the hatches below are drawn from
 *                   the parse and never assumed.
 */
function questionCard(s) {
  const q = s.question;
  const card = shell('m-card');
  const err = errorLine();

  card.append(head(q.kind === 'review' ? 'ready to submit?' : 'Claude is asking'));

  // A set of questions shows where you are in it — otherwise answering one and seeing
  // another appear reads like the phone did something wrong.
  if (q.questions?.length > 1) {
    const strip = document.createElement('div');
    strip.className = 'm-steps';
    for (const step of q.questions) {
      const chip = document.createElement('span');
      chip.className = `m-step${step.answered ? ' is-done' : ''}`;
      chip.textContent = step.label;
      strip.append(chip);
    }
    card.append(strip);
  }

  const question = document.createElement('div');
  question.className = 'm-card-q';
  question.textContent = q.question;
  card.append(question);

  if (q.kind === 'review') {
    const list = document.createElement('div');
    list.className = 'm-review';
    for (const a of q.answers || []) {
      const row = document.createElement('div');
      row.className = 'm-review-row';
      const qq = document.createElement('span');
      qq.className = 'm-review-q';
      qq.textContent = a.question;
      const aa = document.createElement('span');
      aa.className = 'm-review-a';
      aa.textContent = a.answer || '—';
      row.append(qq, aa);
      list.append(row);
    }
    card.append(list);

    const bar = document.createElement('div');
    bar.className = 'm-card-bar';
    const submit = document.createElement('button');
    submit.className = 'm-card-submit';
    submit.textContent = 'submit answers';
    submit.onclick = () =>
      fire(card, err, () => post(`/api/sessions/${encodeURIComponent(s.id)}/question`, { action: 'submit' }));
    const cancel = document.createElement('button');
    cancel.className = 'm-card-ghost';
    cancel.textContent = 'cancel';
    cancel.onclick = () =>
      fire(card, err, () => post(`/api/sessions/${encodeURIComponent(s.id)}/question`, { action: 'cancel' }));
    bar.append(submit, cancel);
    card.append(bar, err);
    return card;
  }

  // Seeded from the box once, and only once: the memo hands the same node back on later
  // roster frames, so a tick made here is never overwritten by the terminal's own.
  const picked = new Set((q.options || []).filter((o) => o.checked).map((o) => o.index));
  const expect = (q.options || []).map((o) => ({ index: o.index, label: o.label }));

  const opts = document.createElement('div');
  opts.className = 'm-opts';

  let submit;
  for (const o of q.options || []) {
    const row = document.createElement('button');
    row.className = `m-opt${picked.has(o.index) ? ' is-on' : ''}`;
    row.setAttribute('aria-pressed', String(picked.has(o.index)));

    const mark = document.createElement('span');
    mark.className = 'm-opt-num';
    mark.textContent = q.multiSelect ? (picked.has(o.index) ? '☑' : '☐') : String(o.index);
    row.append(mark);

    const body = document.createElement('span');
    body.className = 'm-opt-body';
    const label = document.createElement('span');
    label.className = 'm-opt-label';
    label.textContent = o.label;
    body.append(label);
    if (o.description) {
      const desc = document.createElement('span');
      desc.className = 'm-opt-desc';
      desc.textContent = o.description;
      body.append(desc);
    }
    row.append(body);

    row.onclick = () => {
      if (!q.multiSelect) {
        fire(card, err, () =>
          post(`/api/sessions/${encodeURIComponent(s.id)}/question`, { options: [o.index], expect }),
        );
        return;
      }
      if (picked.has(o.index)) picked.delete(o.index);
      else picked.add(o.index);
      row.classList.toggle('is-on', picked.has(o.index));
      row.setAttribute('aria-pressed', String(picked.has(o.index)));
      mark.textContent = picked.has(o.index) ? '☑' : '☐';
      if (submit) submit.disabled = !picked.size;
    };
    opts.append(row);
  }
  card.append(opts);

  const bar = document.createElement('div');
  bar.className = 'm-card-bar';

  submit = document.createElement('button');
  submit.className = 'm-card-submit';
  submit.textContent = 'submit';
  submit.disabled = !picked.size;
  submit.hidden = !q.multiSelect;
  submit.onclick = () =>
    fire(card, err, () =>
      post(`/api/sessions/${encodeURIComponent(s.id)}/question`, { options: [...picked], expect }),
    );
  bar.append(submit);

  const hint = document.createElement('span');
  hint.className = 'm-card-note';
  hint.textContent = q.multiSelect ? 'tick any number, then submit' : 'tap one — it sends straight away';
  bar.append(hint);
  card.append(bar);

  card.append(hatches(s, q, card, err), err);
  return card;
}

/**
 * The two ways out of a question, for when the answer is not on the list.
 *
 * They matter more on a phone than anywhere: while the box is up the composer *queues*
 * instead of sending, so "just say what you mean" is the one thing that otherwise cannot
 * be done — and the rows that offer it sit below the box's rule, outside the numbered run,
 * which is exactly why they were missing from the desktop card for so long.
 *
 * They have almost nothing in common. **Chat** is one press on every layout and always the
 * same: the tool call is declined and the composer comes back. **Type something** is three
 * steps the server performs — the digit opens an editor on the row, the typed text
 * *replaces* the row's label, Enter sends — and it is **single-select only**, because on a
 * multi-select that digit merely ticks the row and anything typed after it lands nowhere.
 * Hence the gate below, copied from `buildHatches`; without it the phone offers a text box
 * that silently does nothing.
 *
 * Both are drawn only when the parse says the row is there. The preview-panel layout has
 * neither (T8).
 */
function hatches(s, q, card, err) {
  const wrap = document.createElement('div');
  wrap.className = 'm-hatch';

  if (q.freeTextIndex && !q.multiSelect) {
    const form = document.createElement('form');
    form.className = 'm-hatch-text';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'or answer in your own words';
    input.enterKeyHint = 'send';
    const go = document.createElement('button');
    go.type = 'submit';
    go.className = 'm-card-ghost';
    go.textContent = 'send';
    form.append(input, go);
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      fire(card, err, () =>
        post(`/api/sessions/${encodeURIComponent(s.id)}/question`, { action: 'text', text }),
      );
    };
    wrap.append(form);
  }

  if (q.chatIndex) {
    const chat = document.createElement('button');
    chat.className = 'm-card-ghost';
    chat.textContent = 'chat about this';
    chat.title = 'Declines the questions and frees the composer — nothing gets answered';
    chat.onclick = () =>
      fire(card, err, () => post(`/api/sessions/${encodeURIComponent(s.id)}/question`, { action: 'chat' }));
    wrap.append(chat);
  }

  return wrap;
}

/* ════════════════════════════════════ the boxes that get no controls ═══ */

/**
 * Something is blocking that the phone will not touch. Name it; offer nothing.
 *
 * Two families land here and they deserve different sentences.
 *
 * **`/model` and `/effort`**, which only appear because the maintainer opened them at the
 * Mac. These are readable — the panel has a parser for each — and they still get no
 * buttons, because a digit in `/model` does not move a cursor, it commits, and it commits
 * as the **global default for every future session**; and `/effort` has no session-only
 * setting at all, so its Enter writes `effortLevel` globally. The desktop steps the cursor
 * and commits with `s`; a phone has no business doing either, and the dialog is already
 * open in front of whoever opened it.
 *
 * **Anything else** — most likely `Switch model?`, which is `needs-decision` with no
 * prompt behind it, the same shape the trust gate was documented as having and does not.
 */
function opaqueCard(s) {
  const card = shell('m-card is-refusal');
  const name = s.dialog || null;

  card.append(head('waiting on something the panel will not answer'));

  if (name) {
    const box = document.createElement('div');
    box.className = 'm-gate-screen';
    const title = document.createElement('div');
    title.className = 'm-gate-title';
    title.textContent = name;
    box.append(title);
    card.append(box);
  }

  const picker = name && /model|effort/i.test(name);
  card.append(
    note(
      picker
        ? `${name} is open in this session's terminal. The phone offers no controls here: a ` +
            'digit in /model commits the choice as the global default for every future session, ' +
            'and /effort has no session-only setting at all. Finish it at the Mac.'
        : 'This session is holding a box the panel could not read. Answer it at the Mac; the ' +
            'panel will not guess.',
    ),
  );
  return card;
}

/* ══════════════════════════════════════════════════════════════ pieces ═══ */

function shell(className) {
  const card = document.createElement('div');
  card.className = className;
  return card;
}

function head(text) {
  const el = document.createElement('div');
  el.className = 'm-card-head';
  const kind = document.createElement('span');
  kind.className = 'm-card-kind';
  kind.textContent = text;
  el.append(kind);
  return el;
}

function note(text) {
  const el = document.createElement('p');
  el.className = 'm-card-said';
  el.textContent = text;
  return el;
}

function errorLine() {
  const el = document.createElement('div');
  el.className = 'm-card-err';
  el.hidden = true;
  return el;
}

/**
 * One full-width answer row: its digit, its label, and — for the ones that cost something —
 * a second tap.
 *
 * The digit is drawn as well as sent. On a plan box the rows are re-sorted, on a permission
 * box they are not, and in both cases the number is the only stable handle on a row: the
 * option list is rebuilt at every render, so position means nothing and the digit is what
 * the terminal will still agree with.
 *
 * **The label is never replaced by the armed state.** The desktop's bin swaps its glyph for
 * `sure?`, which is fine for a glyph; here the label is the whole point of reading the row —
 * `Yes, clear context (34% used) and bypass permissions` is a sentence you must be able to
 * re-read *while* deciding whether to tap it again. So `sure?` arrives as a line underneath
 * and the label stays put. Four seconds, then it disarms itself.
 */
function optionButton({ digit, label, description, tone, primary, arm, armNote, card, err, send }) {
  const btn = document.createElement('button');
  btn.className = `m-opt tone-${tone || 'other'}${primary ? ' is-primary' : ''}${arm ? ' needs-arming' : ''}`;

  const num = document.createElement('span');
  num.className = 'm-opt-num';
  num.textContent = String(digit);
  btn.append(num);

  const body = document.createElement('span');
  body.className = 'm-opt-body';
  const text = document.createElement('span');
  text.className = 'm-opt-label';
  text.textContent = label;
  body.append(text);
  if (description) {
    const desc = document.createElement('span');
    desc.className = 'm-opt-desc';
    desc.textContent = description;
    body.append(desc);
  }
  const confirm = document.createElement('span');
  confirm.className = 'm-opt-confirm';
  confirm.hidden = true;
  confirm.textContent = `sure? ${armNote || 'tap again to send'}`;
  body.append(confirm);
  btn.append(body);

  if (!arm) {
    btn.onclick = () => fire(card, err, send);
    return btn;
  }

  let armed = false;
  let timer = 0;
  const disarm = () => {
    armed = false;
    btn.classList.remove('is-armed');
    confirm.hidden = true;
  };
  btn.onclick = () => {
    if (!armed) {
      armed = true;
      btn.classList.add('is-armed');
      confirm.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(timer);
    disarm();
    fire(card, err, send);
  };
  return btn;
}

/**
 * Post, and say so when it does not take.
 *
 * Every button in the card is disabled for the length of the request and stays disabled on
 * success — the card goes when the next roster frame says the box has gone, and leaving it
 * inert until then is honest about what is in flight. A failure re-enables everything and
 * surfaces the server's own sentence, which is the part that must not be smoothed over:
 * "The review screen doesn't list Tea — nothing was submitted. Finish it in the terminal."
 * is a different fact from "that didn't work", and it is the one that says the pane was
 * left half-answered.
 */
async function fire(card, err, send) {
  const buttons = [...card.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  err.hidden = true;
  try {
    await send();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `That didn't take (${res.status}).`);
  return data;
}
