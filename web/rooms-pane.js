/*
 * The room pane's arithmetic: the order its entries are drawn in, who a stored member is
 * on the roster *right now*, what became of one post, and who is left to add.
 *
 * The eighth shared pure module in `web/`, and here for the reason each of the seven
 * before it gives: a sort, a resolution order and the sentence a delivery mark is spelled
 * with are all things a node test can hold, and the same three inlined into `web/app.js`
 * are none of them. `trust-gate.js` set the precedent, `rooms-band.js` and
 * `rooms-create.js` followed it one band up, and this is their sibling one pane over.
 *
 * Four rules are carried in here rather than left to the caller, each already paid for
 * somewhere in this repo:
 *
 * **`ts` first, `seq` only as the tie-break.** `seq` is the order the log was *written*
 * and `ts` is the order things happened. They come apart here for a reason the shared room
 * already records: a fan-out is serialised per room (`roomTurn` in `server/index.js`) but
 * the *append* happens after the typing, so a post that had four panes to reach is written
 * after one that had none — and a view that trusted `seq` would put an answer above its
 * question, occasionally, with nothing on screen to say why. `seq` is still the tie-break,
 * because two entries inside one millisecond have to land in a stable order or they swap
 * places between paints.
 *
 * **The word is `handed`, never *delivered*.** `sendOrQueue` types or queues; a queued copy
 * waits for a pane to go idle, which may be hours and may be never — `queue.prune` drops
 * everything for a pane that has gone away, and nothing writes back to an append-only log.
 * So the entry records a *handoff* and the line under a bubble says so. The shared room's
 * own delivery line made this call first and its comment is the precedent; this is the
 * plan's §5.4 in one function.
 *
 * **A member is resolved for a dot, and the dot decides nothing.** `memberRow` below
 * mirrors `resolveMember` in `server/rooms-line.js` — `tmuxSession` first, then `paneId`
 * **and** `name` together as two witnesses, then nothing — because two spellings of "which
 * row is this member" that disagree would show a live dot beside a member the fan-out will
 * record as unreachable. It cannot literally *be* that function: that one imports
 * `server/observe.js` and runs in node. What keeps the disagreement cheap is that this side
 * answers only a **status dot**, never a delivery: the endpoint re-resolves against a fresh
 * roster read at post time, and its answer is the one that decides who a copy goes to.
 * `test/rooms-pane.test.js` pins the two orders against each other.
 *
 * **The strongest id is the one that travels.** `PATCH /api/rooms/:id` takes any of the
 * three ids as `remove`, and the store matches on all three — so which one is *sent* is
 * this side's decision and it is `tmuxSession` first: a tmux session name survives a
 * `/clear` and a relaunch, a pane id survives neither (tmux reissues `%0` with every fresh
 * server), and a label collides by design (`<repo>-<branch>`).
 *
 * **`@name` is typed here and parsed nowhere here.** The four mention helpers below are the
 * composer's affordance and the bubble's quiet label, and not one of them decides anything:
 * `mentionsIn` in `server/rooms-line.js` is the single parse, the endpoint runs it on every
 * post whoever wrote it, and what a bubble shows comes off the entry's own `to` rather than
 * from re-reading the text. So the one thing that could drift — *which member did this post
 * name* — has exactly one implementation, and the browser never asks the question.
 *
 * `mentionQuery` does share one small rule with the server, the character class that
 * continues a name, and that is on purpose rather than an oversight: it decides when a
 * **popup opens**, so a disagreement costs a suggestion that does not appear, never a
 * mention that is read differently at the two ends. `test/rooms-pane.test.js` drives both
 * against one set of names anyway.
 */

import { orderForHere, roomParticipants, rowName } from './rooms-create.js';

/** A trimmed string, or `''` — the shape every id comparison below wants. `server/rooms.js`
 *  and `server/rooms-line.js` both normalise the same way at their own doors. */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The entries, in the order the messages actually happened.
 *
 * A copy, never a sort in place: `view.groupEntries` is appended to by the socket and
 * sorting the live array would reorder history under an append that is already in flight.
 */
export function roomOrdered(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  return [...list].sort((a, b) => (a?.ts || 0) - (b?.ts || 0) || (a?.seq || 0) - (b?.seq || 0));
}

/** One entry's identity across paints. `seq` alone is enough — one room, one file, one
 *  counter, monotonic across a boot rotation — and it is keyed on the *record* rather than
 *  the node, because every child of the list is replaced on every paint. */
export const entryKey = (e) => String(e?.seq ?? '');

/** How a member is named on its chip and in a confirmation. The stored name first, because
 *  that is the name the room was built with and the name every other member's terminal
 *  reads; the ids behind it so a member that never had one is still called something. */
export const memberName = (m) => str(m?.name) || str(m?.tmuxSession) || str(m?.paneId) || 'a session';

/**
 * The id to send as `remove` — the strongest one this member holds.
 *
 * Never the label first: two sessions can share one (`<repo>-<branch>` collides by design,
 * CLAUDE.md's first trap), and the store's `removeMember` takes the *first* member that
 * answers to the key. A tmux session name is the one id that survives a relaunch.
 */
export const memberKey = (m) => str(m?.tmuxSession) || str(m?.paneId) || str(m?.name) || '';

/**
 * The live roster row this member is, or `null`.
 *
 * `resolveMember`'s rung order, and see the header for why it is mirrored rather than
 * imported and what stops the two drifting into a disagreement that matters. The
 * participant check is **not** repeated here: that one is about whether a session may be
 * *addressed*, the endpoint enforces it, and a member that somehow became a worker should
 * still draw its real status rather than vanish off the strip with nothing saying why.
 */
export function memberRow(member, sessions = []) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const tmuxSession = str(member?.tmuxSession);
  const paneId = str(member?.paneId);
  const name = str(member?.name);

  // Rung 1: the tmux session name, the only id that survives a relaunch.
  if (tmuxSession) {
    const inSession = rows.filter((r) => str(r?.tmuxSession) === tmuxSession);
    if (inSession.length === 1) return inSession[0];
    // A split: two Claude panes under one name. Only an exact pane id can say which, and
    // if it cannot, this rung declines rather than picking the first.
    if (inSession.length > 1) {
      const exact = paneId ? inSession.find((r) => str(r?.paneId) === paneId) : null;
      if (exact) return exact;
    }
  }

  // Rung 2: the pane and the name, and never one of them. A session relaunched under a name
  // a *different* session has since taken is why this needs both.
  if (paneId && name) {
    return rows.find((r) => str(r?.paneId) === paneId && rowName(r) === name) || null;
  }
  return null;
}

/**
 * What became of one post, as one quiet line.
 *
 * Three groups because the entry records three states, and each is said in its own words
 * rather than as a tally: `typed` is a copy that reached a terminal, `queued` is one
 * waiting for a pane to be free, and `unreachable` is one that found no pane at all. The
 * verb for the first is **handed** and never *delivered* — see the header — and the other
 * two are not dressed as successes.
 *
 * An empty `handed` is not a failure and does not read as one: a room whose only other
 * members have all exited, or a room of one, hands a post to nobody and the log is still
 * the record that it was said.
 */
export function handedText(entry) {
  const marks = Array.isArray(entry?.handed) ? entry.handed : [];
  if (!marks.length) return 'nobody else to hand it to';

  const named = (state) =>
    marks.filter((m) => m?.state === state).map((m) => memberName(m)).filter(Boolean);
  const typed = named('typed');
  const queued = named('queued');
  // Anything that is not one of the two known states is a miss, including a mark this
  // version has never heard of: an unknown word must not read as a success.
  const missed = marks
    .filter((m) => m?.state !== 'typed' && m?.state !== 'queued')
    .map((m) => memberName(m))
    .filter(Boolean);

  const parts = [];
  if (typed.length) parts.push(`handed to ${typed.join(', ')}`);
  if (queued.length) parts.push(`${queued.join(', ')} queued`);
  if (missed.length) parts.push(`${missed.join(', ')} not reached`);
  return parts.join(' · ');
}

/** Is anything on this entry still waiting, or missed? The line takes the panel's waiting
 *  colour when it is — one amber line to read, never a per-name colour. */
export const handedWaiting = (entry) =>
  (Array.isArray(entry?.handed) ? entry.handed : []).some((m) => m?.state !== 'typed');

/**
 * Who is left to add: every session that may be in a room, minus the ones already in it,
 * in the create modal's own order.
 *
 * `roomParticipants` is asked rather than re-spelled — one allow-list on this side of the
 * wire, exactly as `sharedParticipants` asks it — and `orderForHere` puts the folder you
 * are looking at first for the create modal's reason: a room is usually the sessions in
 * front of you, and filtering by folder would make a cross-project room unbuildable, which
 * is half of what rooms are for.
 *
 * Already-a-member is decided by `memberRow` rather than by comparing names: a member whose
 * label has since been taken by a different session must not hide that session from the
 * list, and the same resolution that draws its dot is the one that says it is already here.
 */
export function addableSessions(sessions = [], room = null, here = null) {
  const rows = roomParticipants(sessions);
  const members = Array.isArray(room?.members) ? room.members : [];
  const taken = new Set();
  for (const m of members) {
    const row = memberRow(m, sessions);
    if (row?.id) taken.add(row.id);
  }
  return orderForHere(
    rows.filter((s) => !taken.has(s?.id)),
    here,
  );
}

/**
 * Why the `+` cannot add anybody, or `null` when it can.
 *
 * A sentence rather than a boolean, for `createReason`'s reason one file over: a disabled
 * control with nothing saying why is the thing this repo keeps deciding not to ship. The
 * cap is checked first because it is the one a person is about to hit, and the count it
 * names is the room's own.
 */
export function addReason(room, sessions = [], max = 8) {
  const members = Array.isArray(room?.members) ? room.members : [];
  if (members.length >= max) {
    return (
      `${room?.name || 'This room'} already holds ${members.length} sessions and the cap is ${max}. ` +
      'Every post is typed into every other member’s terminal, so the cap is about their panes, ' +
      'not about storage.'
    );
  }
  if (!addableSessions(sessions, room).length) {
    return 'Every session that can be in a room is already in this one.';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* `@name`: the composer's affordance, and the bubble's quiet label.           */
/* -------------------------------------------------------------------------- */

/** What continues a name once one has started — `NAME_TAIL` in `server/rooms-line.js`,
 *  mirrored for the reason the header gives and for nothing more than opening a popup. */
const NAME_TAIL = /[A-Za-z0-9_-]/;

/**
 * The name a mention would have to spell — `memberLabel` in `server/rooms-line.js`, `''`
 * exactly where that one answers `''`.
 *
 * Deliberately **not** `memberName` above, which falls back to the words `a session` for a
 * member holding no id at all. That is a label for a chip; it can never be a member label on
 * the server, so a menu offering it would insert a token the parse cannot match.
 */
const mentionable = (m) => str(m?.name) || str(m?.tmuxSession) || str(m?.paneId) || '';

/**
 * Who a post named, off the entry itself — **never** by re-reading the text.
 *
 * An entry written before mentions existed carries no `to` at all, which is why this reads
 * as "nobody" rather than as anything to repair: `rooms/<id>.jsonl` is append-only and old
 * lines are never rewritten.
 */
export function addressedNames(entry) {
  const list = Array.isArray(entry?.to) ? entry.to : [];
  return list.map(str).filter(Boolean);
}

/**
 * The quiet line a bubble carries when its post named somebody, or `null`.
 *
 * Deliberately not an inline highlight of the `@` tokens in the body: that would need the
 * server's match rule spelled a second time in the browser, on the one question this file's
 * header says the browser must never ask. A muted label beside the timestamp says the same
 * fact off the field the server already wrote down.
 */
export function addressedText(entry) {
  const names = addressedNames(entry);
  if (!names.length) return null;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `to ${list}`;
}

/**
 * The `@…` token the caret is sitting in, or `null`.
 *
 * Scans back from the caret over name characters to an `@`, and stops at anything else — so
 * a space, a newline or punctuation between the caret and the nearest `@` means there is no
 * token here. `sharedAtToken`'s job one file over, written as a scan rather than a
 * `lastIndexOf` because a room's names carry `-` and a scan is what makes the boundary rule
 * the same one the server uses.
 *
 * @returns {{start: number, query: string} | null} `start` is the index of the `@` itself
 */
export function mentionQuery(value = '', caret = 0) {
  const s = typeof value === 'string' ? value : '';
  const at = Math.max(0, Math.min(Number(caret) || 0, s.length));
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = s[i];
    if (ch === '@') {
      const before = i > 0 ? s[i - 1] : '';
      // A name character or another `@` in front: part of a word, not the start of a mention.
      if (before && (NAME_TAIL.test(before) || before === '@')) return null;
      return { start: i, query: s.slice(i + 1, at) };
    }
    if (!NAME_TAIL.test(ch)) return null;
  }
  return null;
}

/**
 * The member names an open menu offers, in the room's own order.
 *
 * Matched case-insensitively on a **prefix**, which is the one place this side is more
 * forgiving than the server's exact match — and it is the right way round: the menu is what
 * puts the exact spelling into the box, so being generous about what opens it costs
 * nothing, while being generous about what *counts* as a mention would be a second rule.
 */
export function mentionMatches(query = '', room = null, limit = 8) {
  const q = String(query ?? '').trim().toLowerCase();
  const names = (Array.isArray(room?.members) ? room.members : []).map(mentionable).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (q && !n.toLowerCase().startsWith(q)) continue;
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Put one name in, replacing the half-typed token under the caret.
 *
 * The trailing space is part of the insertion — a mention is followed by a sentence — and a
 * space already sitting after the caret is swallowed rather than doubled, which is what a
 * reader gets for choosing from the menu in the middle of a line they already wrote.
 *
 * @returns {{value: string, caret: number}}
 */
export function insertMention(value = '', start = 0, caret = 0, name = '') {
  const s = typeof value === 'string' ? value : '';
  const from = Math.max(0, Math.min(Number(start) || 0, s.length));
  const to = Math.max(from, Math.min(Number(caret) || 0, s.length));
  const token = `@${String(name ?? '')} `;
  const tail = s.slice(to);
  const rest = tail.startsWith(' ') ? tail.slice(1) : tail;
  return { value: `${s.slice(0, from)}${token}${rest}`, caret: from + token.length };
}
