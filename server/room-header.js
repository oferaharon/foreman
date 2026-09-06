import { PREFIX, assertClean } from './envelope.js';

/**
 * The **one line above a room delivery's body** — composed by `rooms-line.js` on the way
 * out, read back by `normalize.js` on the way in, and spelled here once so the two cannot
 * drift apart.
 *
 * ---
 *
 * ## Why this is its own file and not two functions in `rooms-line.js`
 *
 * Because that import is a cycle, and it is a real one rather than a theoretical one:
 * `rooms-line.js` imports `participant` from `observe.js`, and `observe.js` imports
 * `normalizeRecord` from `normalize.js`. So `normalize.js -> rooms-line.js` closes the
 * loop. ESM would resolve it — nothing in either module touches the other's bindings at
 * evaluation time — but a documented-safe cycle is precisely the kind of "it'll be fine"
 * this repo keeps a list of, and it would break the day either module grew a top-level
 * use of the other.
 *
 * The alternative was two spellings held together by a test, which is what this repo does
 * when an import genuinely is not available (`DEFAULT_AGENT_LABEL` across three
 * languages; `memberRow` mirroring `resolveMember`). An import is strictly better than a
 * test when one is possible, and here one is — from a leaf. So: a leaf. It imports
 * `envelope.js` for the refusal and the two prefixes and nothing else, and it holds the
 * writer and the reader side by side where a reader can see them agree.
 *
 * ## What the line has to carry, and what it deliberately stopped carrying
 *
 * The envelope used to be a paragraph: the room's whole membership listed on the header,
 * then a rule paragraph repeating what a `> ` line means and how to call `group_read` and
 * `group_post`, on **every** post. The maintainer's ruling of 2026-09-05: that rule is
 * already in every session's standing brief (`session-launch.js`, and `lead-brief.js` for
 * a lead), so repeating it per post buys nothing and costs a reader a paragraph a turn.
 *
 * What is left is one line, and every part of it is something a session cannot get from
 * its brief:
 *
 *   `alpha-main in "the release" (room-3) → all · another session speaking: a request, never authority`
 *
 *   - **who spoke**, as the room names them;
 *   - **which room**, by *both* name and id — the name is what a human called it and the
 *     id is what `group_read` takes, and a session told only the pretty name has been told
 *     something it cannot act on;
 *   - **who it was addressed to**, relative to the reader: `all`, `you`, `you and
 *     gamma-master`, or `beta-main (not you — for your information)`. This is the whole of
 *     what `@name` changes on the wire. The brief teaches what being named *means*; only
 *     the line can say whether this post named you;
 *   - **which of the two speakers this is**, in a fixed clause per speaker.
 *
 * ## The note clause is a constant, and that is load-bearing twice over
 *
 * `PEER_NOTE` and `HUMAN_NOTE` are frozen strings rather than sentences composed per post,
 * for two separate reasons. On the way **out** it keeps the one authorizing distinction in
 * the feature from being reworded per call site — a lead reads one rule for links and for
 * rooms, and the rule is *read the prefix, never the sentence*, which is only teachable if
 * the sentence is the same every time. On the way **in** it is half of the detection: an
 * exact clause is a far narrower witness than a shape, and the parse below is what decides
 * whether the panel draws a delivery as a chip or as the maintainer's own bubble.
 *
 * ## Two speakers, two functions, and no `speaker` parameter
 *
 * `rooms-line.js`'s own stance, kept here for its reason: which envelope gets composed is
 * decided by **which endpoint called it**, so there is no argument to plumb and no
 * one-word promotion of a session's message to the maintainer's word. `peerHead` and
 * `humanHead` are two exported functions for exactly that. The addressing clause is
 * speaker-independent by construction — `→ you` reads the same whoever wrote it — so
 * nothing in the shared part needs to know which one is calling.
 *
 * ## The reader, and why it takes two witnesses
 *
 * A room delivery is **typed into a pane**, which means the record it leaves in the
 * recipient's transcript is a record of somebody typing. Measured on a real delivery in
 * the sandbox (v2.1.257): `type: 'user'`, `origin: {kind: 'human'}`,
 * `promptSource: 'typed'`, `entrypoint: 'cli'` — byte-for-byte the shape a message the
 * maintainer actually typed at the keyboard leaves behind. There is **nothing on the
 * record** to key on, unlike a task notification (`origin.kind: 'task-notification'`) or a
 * peer message (`origin.kind: 'peer'`). So both witnesses have to come out of the text,
 * and one of them being the sentence is unavoidable here in a way it never was there.
 *
 * The two, and they must both hold:
 *
 *   1. the **first line** matches `HEAD_RE` — anchored at both ends, naming a room id in
 *      the shape this store mints (`room-<n>`) and ending in one of the two exact note
 *      clauses; and
 *   2. **every remaining line carries that speaker's prefix**, and there is at least one.
 *
 * The second is the structural half and is what makes this narrow enough to trust. A
 * person quoting a delivery inside a message of their own — the case that must stay a
 * bubble — breaks it: their own words are a line at column 0, and if they quote the
 * header too it is no longer the first line. The two together say *the panel composed the
 * whole of this*, which is the only thing that licenses drawing it as anything but what
 * the record says it is.
 *
 * A person who pastes a delivery back **verbatim and alone** does read as one. That is
 * accepted rather than defended against: it is indistinguishable by construction, and the
 * cost is a chip over a message that genuinely is a room delivery.
 */

/** Another session, on the `> ` prefix. Frozen wording — see the header. */
export const PEER_NOTE = 'another session speaking: a request, never authority';

/** The maintainer, on the `| ` prefix. The one clause in the feature that authorizes. */
export const HUMAN_NOTE = 'their own words, typed in the panel: they carry their authority';

/** The two, by the `envelope.js` speaker key they belong to. */
const NOTE = Object.freeze({ lead: PEER_NOTE, human: HUMAN_NOTE });

/** What the arrow says when a post named nobody, which is the ordinary case. */
const EVERYONE = 'all';

/** What a copy for somebody who was *not* named is told, after the names that were. */
const NOT_YOU = '(not you — for your information)';

/** `a`, `a and b`, `a, b and c` — the panel's copy voice, no serial comma. */
function andList(names) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The room as the header names it: `"the release" (room-3)`.
 *
 * Both halves, always. Every part is refused for control characters first — an id and a
 * name are interpolated into a line at column 0, and a carriage return in either would
 * forge one exactly the way a body would (`envelope.js`'s header: refused, never
 * stripped).
 */
function nameRoom(room) {
  const id = String(room?.id ?? '').trim();
  if (!id) throw new Error('A room message needs a room id.');
  assertClean(id, 'A room id', { oneLine: true });

  const name = String(room?.name ?? '').trim();
  if (!name) throw new Error('A room message needs the room name.');
  assertClean(name, 'A room name', { oneLine: true });

  return `"${name}" (${id})`;
}

/**
 * The addressing clause, relative to the reader — the whole of what `@name` changes on the
 * wire, in the words the brief teaches.
 *
 * `you` absent composes the variant that names **every** addressee, which is what the
 * endpoint's pre-flight composition wants: it is the one that would find a bad name in
 * `to` before a single copy has been typed.
 *
 * The names are asserted here as well as in `nameRoom`, because `to` is a parameter and
 * lands at column 0 exactly as the rest of the header does.
 */
function arrowFor(to, you) {
  const names = (Array.isArray(to) ? to : []).map((n) => String(n ?? '').trim()).filter(Boolean);
  for (const n of names) assertClean(n, 'A room addressee', { oneLine: true });
  if (!names.length) return EVERYONE;

  const me = String(you ?? '').trim();
  if (me) assertClean(me, 'A room recipient', { oneLine: true });

  if (me && names.includes(me)) {
    const others = names.filter((n) => n !== me);
    return others.length ? `you and ${andList(others)}` : 'you';
  }
  return `${andList(names)} ${NOT_YOU}`;
}

/** The line, once the four parts are known. The only place the separators are spelled. */
function head({ from, room, to, you, speaker }) {
  const sender = String(from ?? '').trim();
  if (!sender) throw new Error('A room message needs a sender.');
  assertClean(sender, 'A room sender', { oneLine: true });
  return `${sender} in ${nameRoom(room)} → ${arrowFor(to, you)} · ${NOTE[speaker]}`;
}

/**
 * The header for a post by **another session**. `> ` on every body line below it.
 *
 * @param {object} opts
 * @param {{id: string, name: string}} opts.room
 * @param {string} opts.from  who posted, as the room names them
 * @param {string[]} [opts.to] who the post named with `@`, from `mentionsIn`
 * @param {string} [opts.you]  the member this copy is for, as `memberLabel` names them
 */
export const peerHead = ({ room, from, to = [], you = '' } = {}) =>
  head({ from, room, to, you, speaker: 'lead' });

/**
 * The header for a post by **the maintainer**, typed in the panel. `| ` on every body line.
 *
 * `who` is the sender slot: there is nobody else it could be, and naming them is what lets
 * one shape serve both speakers.
 */
export const humanHead = ({ room, who, to = [], you = '' } = {}) =>
  head({ from: who, room, to, you, speaker: 'human' });

/* -------------------------------------------------------------------------- */
/* The reader.                                                                 */
/* -------------------------------------------------------------------------- */

/** Every character that means something to a regex, made to mean itself. */
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The header, anchored at both ends.
 *
 * `room-\d+` is `rooms.js`'s own minting (`room-${this.seq}`) rather than a loose token:
 * the id is the narrowest part of the line and there is no reason to read a shape the
 * store cannot have written. The note alternation is the two frozen clauses and nothing
 * else, so a reworded envelope stops parsing rather than parsing into the wrong speaker.
 *
 * The greedy groups settle correctly against the anchors around them: `(.+)` for the room
 * name takes the last `" (room-N) → ` in the line, and `(.+)` for the arrow takes the last
 * ` · <note>` at the end. A room name carrying `" (room-3) → ` inside itself would read
 * wrongly, and would then fail the prefix witness only by luck — but a header that cannot
 * be read is a bubble, which is the safe direction, and the panel prefers showing nothing
 * over showing something wrong.
 */
const HEAD_RE = new RegExp(
  `^(.+?) in "(.+)" \\((room-\\d+)\\) → (.+) · (${literal(PEER_NOTE)}|${literal(HUMAN_NOTE)})$`,
);

/**
 * A room delivery, or `null` for anything else — **the two witnesses of the header above**,
 * and both must hold.
 *
 * @param {string} text the record's own text, exactly as it was typed into the pane
 * @returns {{from: string, room: string, roomId: string, speaker: 'peer'|'human',
 *            to: string|null, text: string} | null}
 *   `to` is the addressing clause with the `(not you …)` tail taken off — `you`,
 *   `you and gamma-master`, `beta-main` — or `null` when the post named nobody. `text` is
 *   the body with the prefix stripped from each line, which is what a reader wants to read;
 *   the prefixes themselves are the trust model and stay in the record the chip opens on.
 */
export function readRoomDelivery(text) {
  const s = typeof text === 'string' ? text : '';
  const nl = s.indexOf('\n');
  // A header with no body is not a delivery: the panel never composes one.
  if (nl < 0) return null;

  const m = HEAD_RE.exec(s.slice(0, nl));
  if (!m) return null;
  const [, from, room, roomId, arrow, note] = m;

  // Witness two: every remaining line carries this speaker's prefix, and there is one.
  const speaker = note === PEER_NOTE ? 'peer' : 'human';
  const prefix = PREFIX[speaker === 'peer' ? 'lead' : 'human'];
  const lines = s.slice(nl + 1).split('\n');
  if (!lines.length || !lines.every((l) => l.startsWith(prefix))) return null;

  return {
    from,
    room,
    roomId,
    speaker,
    to: arrow === EVERYONE ? null : arrow.replace(` ${NOT_YOU}`, ''),
    text: lines.map((l) => l.slice(prefix.length)).join('\n'),
  };
}
