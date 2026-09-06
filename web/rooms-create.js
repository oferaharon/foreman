/*
 * The create-room modal's arithmetic: who may be in a room, in what order they are offered,
 * and what stops the button being pressable.
 *
 * The seventh shared pure module in `web/`, and here for the reason `rooms-band.js` gives
 * one file over: a filter, a sort and the sentence a refusal is spelled with are all things
 * a node test can hold, and the same three inlined into `web/app.js` are none of them.
 * `trust-gate.js` set the precedent and the band followed it.
 *
 * Four rules are carried in here rather than left to the caller, each already paid for
 * somewhere in this repo:
 *
 * **The participant filter is an allow-list on role, never "not a worker".** An ordinary
 * session or a lead, and nothing else. `server/observe.js`'s `participant` is the same
 * words on the other side of the wire, `sharedParticipants` in `web/app.js` delegates here
 * rather than spelling it a second time, and `benchEntries`' recorded reasoning is why it
 * is written positively: task kinds have already grown once in this repo, and a negative
 * test silently admits the next one. A worker's channel is its lead — the maintainer's own
 * ruling — and `POST /api/rooms` refuses one with a 409 as the second lock.
 *
 * **`interactive` is the other half and is not decoration.** A row with no live pane has
 * nothing to type into, and every post in a room is typed into every other member's
 * terminal. A picker that offered one would be making a 404 reachable.
 *
 * **Here first, everywhere else after — a sort, never a filter.** A room is usually the
 * sessions in front of you, so those are offered first; a session in another project is one
 * scroll away rather than unavailable. Filtering would make a cross-project room impossible
 * to build from the panel at all, which is half of what rooms are for.
 *
 * **The cap is the server's, and this file only ever holds the fallback.** `GET /api/rooms`
 * answers `maxMembers`, and that answer wins the moment it lands. `MAX_MEMBERS` here is
 * what the first frame draws with and what a failed call falls back to — never a second
 * authority. Same for `MAX_ROOM_NAME`: the field's `maxLength` stops the typing as a
 * courtesy, and `server/rooms.js`'s own refusal is what a person actually reads if one gets
 * past it. `test/rooms-create.test.js` reads both constants out of `server/rooms.js` and
 * asserts they still agree, which is the `logs.js` idiom — two spellings held together by
 * the only mechanism there is.
 */

/** The member cap, as a fallback only. `GET /api/rooms` is the authority and answers it. */
export const MAX_MEMBERS = 8;

/** The name cap, mirrored from `server/rooms.js` for the field's own `maxLength`. The
 *  server refuses over it rather than shortening, and that sentence is what is shown. */
export const MAX_ROOM_NAME = 60;

/**
 * Who can be put in a room, off the roster.
 *
 * **The only spelling of the allow-list on this side of the wire.** Peer messages' `@` picker
 * was the second caller and delegated here rather than repeating the filter, because two
 * spellings of "who is addressable" is the `isLeadName` lesson and a copy would disagree in
 * the direction of showing a worker. That picker was retired on 2026-09-05; the rule now has
 * one caller and `test/rooms-create.test.js` pins that `web/app.js` grows no second copy.
 */
export function roomParticipants(sessions = []) {
  const rows = Array.isArray(sessions) ? sessions : [];
  return rows.filter(
    (s) => s && s.interactive && (s.team?.role == null || s.team.role === 'lead'),
  );
}

/**
 * What a row is called — `label`, then `title`, then `project`, then the id.
 *
 * The rail's own spelling, and deliberately the same one `rowName` in `server/rooms-line.js`
 * uses to write the member record: the name the picker shows is the name that ends up in
 * `members[].name`, in the header line every other member's terminal receives, and on the
 * room's chips. One session, one name, in all four places.
 */
export const rowName = (s) => s?.label || s?.title || s?.project || s?.id || '';

/** The folder a row was launched in — the stable one, never the transcript's `cwd`, which
 *  is rewritten when a session changes directory mid-conversation (`CLAUDE.md`). */
export const rowFolder = (s) => s?.paneCwd || null;

/**
 * The rows in the order they are offered: this folder first, then everything else.
 *
 * A **stable partition**, not a sort — within each half the roster's own order is kept, so
 * the list does not reshuffle itself when a session's status changes. `here` is a folder
 * path; `null` (nothing open, or an open pane whose session has no launch folder) means
 * there is no "here" and the roster order stands.
 */
export function orderForHere(rows = [], here = null) {
  const list = Array.isArray(rows) ? rows : [];
  if (!here) return [...list];
  const near = [];
  const far = [];
  for (const s of list) (rowFolder(s) === here ? near : far).push(s);
  return [...near, ...far];
}

/** The count line under the list. Says the cap as well as the tally, because the cap is
 *  the thing a reader is about to hit and nothing else on the card mentions it. */
export const countLine = (picked, max = MAX_MEMBERS) => `${picked} of ${max}`;

/**
 * Why the ninth tick is refused, said before the server would have to say it.
 *
 * The reason is on the *panes*, not on storage — every post is typed into every other
 * member's terminal — which is `server/rooms.js`'s own sentence, kept close to it here so
 * the client's refusal and the 400's read as one voice rather than two.
 */
export const capRefusal = (max = MAX_MEMBERS) =>
  `A room holds at most ${max} sessions. Every post is typed into every other member’s ` +
  'terminal, so the cap is about their panes, not about storage.';

/**
 * Why the create button is off, or `null` when it is on.
 *
 * A sentence rather than a boolean, because a disabled button with nothing saying why is
 * the control this repo keeps deciding not to ship. Both halves are checked in the order a
 * person fills the card in — the name is the first field and the list is under it — so the
 * line never asks for the thing already done.
 */
export function createReason(name, picked) {
  if (!String(name ?? '').trim()) return 'A room needs a name.';
  if (!picked) return 'Tick at least one session — a room with nobody in it is a name and nothing else.';
  return null;
}

/** Whether the press may go through at all. The button's `disabled` and the Enter key's
 *  guard read the same function, so a keypress can never do what the button refuses. */
export const canCreate = (name, picked) => createReason(name, picked) === null;
