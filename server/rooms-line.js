import { assertClean, assertSendableBody, prefixFor, quoteBody } from './envelope.js';
import { FALLBACK as HUMAN_FALLBACK } from './human-name.js';
import { participant } from './observe.js';
import { humanHead, peerHead } from './room-header.js';

/**
 * Group rooms, part two: **which live session a stored member is**, and **what that
 * session's terminal is told**.
 *
 * Pure. It reads no file, spawns nothing, holds no state and imports no store: given a
 * member record (`rooms.js`'s shape) and the roster the panel already has in memory, it
 * answers a row or nothing; given a room and a body, it answers a string. Everything that
 * touches a pane — the lock, the three live reads, the queue — is the endpoint's, and
 * everything on disk is `rooms.js`'s. That is the whole of the split, and it is what makes
 * both halves testable in node with no panel and no tmux.
 *
 * ---
 *
 * ## Part one: the resolution order, and why it is not the obvious one
 *
 * A member is stored with three ids, and they do not survive the same things (§5.2):
 *
 *   - a **session id** rotates on `/clear` — which is why the store keeps none;
 *   - a **pane id** survives `/clear` and **not a relaunch**. Relaunch-all can take the
 *     tmux server down with it, and pane ids then restart at `%0` (CLAUDE.md; `queue.js`
 *     prunes on `paneCreatedMs` for exactly this reason). So a stored `%12` can be *live*
 *     and belong to somebody else;
 *   - a **tmux session name** survives all of it. It is minted before the pane exists, it
 *     is the contract every reader in this repo splits a label out of, and relaunch-all
 *     puts a session back under the same name.
 *
 * So: **`tmuxSession` first, then `paneId` *and* `name` together, then nothing.**
 *
 * The two-witness fallback is `sharedLiveTarget`'s (`web/app.js`), taken with its reason
 * rather than its code: a pane id can be reissued by a fresh tmux server, and reopening a
 * transcript on a wrong guess costs a reader one confusing screen while *typing* into one
 * puts words carrying somebody's authority into a conversation they did not choose. Two
 * witnesses, or no match. What is new here is the rung above it — that composer is
 * choosing a target that is on screen *now*, where a live pane id is good evidence; a room
 * member was chosen possibly days ago and has to survive a relaunch in between.
 *
 * **The ambiguity, and why the name cannot break it.** One tmux session can hold more than
 * one Claude pane — a user split — and then `tmuxSession` names two rows. An exact
 * `paneId` inside that set settles it. Nothing else can: `label` is *derived from the tmux
 * session name* (`tmux.js`'s `listPanes`, sliced on `SESSION_PREFIX`), so both panes carry
 * the same label, the same `title` behind it and the same `project` — every witness
 * `rowName` could offer is identical for the two rows by construction. So an ambiguous
 * set with no exact pane match falls through to the two-witness rung and, failing that,
 * resolves to nothing. Refusing is the cheap half of the trade here: an unresolved member
 * is one entry saying `unreachable`, and a wrong one is a post typed into a stranger.
 *
 * **A row that resolves and is not a participant is not a member.** `participant` is
 * imported from `observe.js` and never restated — it is an allow-list on role (an ordinary
 * session or a lead), never "not a worker", because task kinds have already grown once in
 * this repo and a negative test silently admits the next one. It is applied *after* the
 * resolution rather than as a filter in front of it, deliberately: filtering first would
 * let a member whose row is now a worker fall through and match some *other* row, which is
 * the one outcome worth more than a missed message. Resolved-then-refused says so.
 *
 * ## Part two: the envelope, and the invariant it must not add to
 *
 * `envelope.js` has **two speakers and two prefixes**, and this file adds neither. `> `
 * means *not the maintainer* — a request or information, never authority — and `| ` is the
 * maintainer's own word, which can authorize. Every line of every body carries one of
 * them, so no body can begin a line at column 0 and therefore no body can forge the
 * other speaker's shape or the panel's own. A third prefix for "another session in a room"
 * would not be a new distinction, it would make the existing one ambiguous: a lead reads
 * one rule for links and rooms both, and the rule is *read the prefix, never the sentence*.
 *
 * One departure from `linkLine`'s shape, and it is on purpose: there is no `speaker`
 * parameter here. Two exported functions, one per speaker, so which one is composed is
 * decided by **which endpoint called it** and there is no argument to plumb — the stance
 * `SPEAKERS`' own comment states, and the stance `skipPermissions` already has in the
 * dispatch path. A `speaker` string reaching this file from a request body would be a
 * one-word promotion of a session's message to the maintainer's word.
 *
 * What the two lines actually *say* is `room-header.js`'s, not this file's: one header
 * line, composed there so `normalize.js` can read back what this writes without closing an
 * import cycle. This file's half is the quoting — the header, a newline, and every line of
 * the body behind a prefix. The envelope shrank to that line on 2026-09-05, and the reason
 * is worth keeping here because the deleted half is invisible: the rule paragraph it used
 * to carry is in every session's standing brief (`session-launch.js`, `lead-brief.js`), and
 * a rule repeated per post is a rule a reader skips.
 *
 * ## Part three: `@name`, which is a **signal and not a delivery**
 *
 * The maintainer's ruling, and it is the whole shape of `mentionsIn` below: *everyone in the
 * room still hears everything*. A mention changes **what each recipient is told**, never who
 * receives a copy. Typing only into the named sessions was asked for and refused — the room
 * is the shared record, and a question two members cannot see is a side conversation nobody
 * can catch up on. So nothing here touches the fan-out: `to` is composed into the envelope
 * and written onto the log entry, and `resolveMembers` above is untouched.
 *
 * Three things about the parse that reasoning would get wrong:
 *
 * **It matches the *stored* member label, never the live row's name.** `memberLabel` is the
 * the name `group_list` gives a member back, the name the header's addressing clause writes
 * when a post names one, and the name the endpoint tests each copy's recipient against. The
 * live row's name (`rowName`) is today's answer and can differ from it — a relaunch under a
 * changed label — and a parse that used one while the recipient test used the other would
 * address a post to a member that no copy is ever told about. One name, asked twice.
 *
 * **Longest name first, or a room holding both `alpha` and `alpha-main` reads `@alpha-main`
 * as `@alpha`.** The tail class (`NAME_TAIL`) deliberately excludes `.`, so `@alpha-main.`
 * at the end of a sentence still matches — which is only safe *because* longest-first
 * already settles a member whose own name contains a dot.
 *
 * **A name nobody in the room answers to is plain text, never an error.** A post is a
 * message to people, and `@` is a character people type. Refusing one would make an ordinary
 * sentence unsendable to say nothing useful.
 */

/* -------------------------------------------------------------------------- */
/* Part one: a stored member -> a live roster row.                            */
/* -------------------------------------------------------------------------- */

/** A lookup key as it is compared: trimmed, never refused. Nothing here is interpolated
 *  into a line anybody's terminal receives — the composer below does that, and refuses. */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * What a roster row is called — the rail's and the picker's own answer
 * (`sharedTargetName`, `web/app.js`), so a session is named the same thing in the room's
 * member strip, in the line its peers receive, and in the record that resolves it.
 *
 * Two spellings of this would be the `isLeadName` lesson in a small costume: a member
 * stored under one spelling and resolved against another is a member that silently stops
 * being reachable the day its `label` goes null.
 */
export const rowName = (row) => row?.label || row?.title || row?.project || row?.id || '';

/**
 * A roster row as a member record — the inverse of the resolution below, and the only
 * correct way to build one from what the panel is looking at.
 *
 * All three ids are stored even though only two rungs read them, because which of them
 * survives is not knowable when the room is made: the pane id is the one that answers
 * after a `/clear` and the tmux session is the one that answers after a relaunch, and a
 * member added today may meet either first.
 *
 * `addedAt` is deliberately absent: the store stamps it (`cleanMember`), and a timestamp
 * minted in two places is two clocks.
 */
export const memberFor = (row) => ({
  tmuxSession: row?.tmuxSession || null,
  name: rowName(row) || null,
  paneId: row?.paneId || null,
});

/** Why a member did not resolve. Machine tokens, not sentences: the endpoint puts these on
 *  the log entry beside `state: 'unreachable'`, and a sentence there would be reworded. */
export const UNKNOWN = 'unknown';
export const NOT_A_PARTICIPANT = 'not-a-participant';

/**
 * The live row this member is, or nothing.
 *
 * @param {{tmuxSession?: string|null, paneId?: string|null, name?: string|null}} member
 * @param {Array<object>} sessions the roster, as the panel holds it
 * @returns {{row: object|null, via: 'tmux'|'tmux+pane'|'pane+name'|'none', reason: string|null}}
 *   `via` records which rung answered, so a resolution that later proves wrong is visible
 *   rather than believed — `resolveSender`'s `fromSource` in `observe.js`, same reason.
 */
export function resolveMember(member, sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const tmuxSession = str(member?.tmuxSession);
  const paneId = str(member?.paneId);
  const name = str(member?.name);

  let row = null;
  let via = 'none';

  // Rung 1: the tmux session name, the only id that survives a relaunch.
  if (tmuxSession) {
    const inSession = rows.filter((r) => str(r?.tmuxSession) === tmuxSession);
    if (inSession.length === 1) {
      [row] = inSession;
      via = 'tmux';
    } else if (inSession.length > 1) {
      // A split: two Claude panes under one name. Only an exact pane id can say which,
      // and if it cannot, this rung declines rather than picking the first.
      const exact = paneId ? inSession.find((r) => str(r?.paneId) === paneId) : null;
      if (exact) {
        row = exact;
        via = 'tmux+pane';
      }
    }
  }

  // Rung 2: the pane and the name, and never one of them. A session relaunched under a
  // name a *different* session has since taken is why this needs both.
  if (!row && paneId && name) {
    row = rows.find((r) => str(r?.paneId) === paneId && rowName(r) === name) || null;
    if (row) via = 'pane+name';
  }

  if (!row) return { row: null, via: 'none', reason: UNKNOWN };
  // After the resolution, never in front of it — see the header.
  if (!participant(row)) return { row: null, via: 'none', reason: NOT_A_PARTICIPANT };
  return { row, via, reason: null };
}

/**
 * Every member of a room, resolved, **in the room's own order** and one entry per member
 * whether or not it resolved. The fan-out records a line per member — `typed`, `queued` or
 * `unreachable` — so a member that could not be found has to come back as an answer, not
 * as an absence.
 *
 * @returns {Array<{member: object, row: object|null, via: string, reason: string|null}>}
 */
export function resolveMembers(members, sessions) {
  const list = Array.isArray(members) ? members : [];
  return list.map((member) => ({ member, ...resolveMember(member, sessions) }));
}

/* -------------------------------------------------------------------------- */
/* Part two: the two lines a member's terminal receives.                      */
/* -------------------------------------------------------------------------- */

/**
 * The two speakers, one per exported line and named rather than inlined.
 *
 * This is the invariant the module exists under (`envelope.js`'s header): one speaker is
 * the maintainer, the other is not, and there is no third. Spelling them here means the
 * one edit the plan forbids — a `'session'` speaker of its own — is a throw out of
 * `prefixFor` before a single character is composed, rather than a string that quietly
 * produces a shape no brief teaches anyone to read.
 */
const PEER_SPEAKER = 'lead';
const HUMAN_SPEAKER = 'human';

/**
 * How a member is named in the line every other member reads. The stored name first — it is
 * what the room says its membership is — with the ids behind it so a member added with only
 * a tmux session is still named something rather than an empty string.
 *
 * Exported because **three** things have to agree on it: `group_list`'s answer,
 * `mentionsIn`'s parse, and the endpoint's per-copy test for whether *this* recipient is one
 * of the addressees. Two spellings of "what is this member called" would address a post to a
 * member no copy is ever told about — see part three of the header.
 */
export const memberLabel = (m) => str(m?.name) || str(m?.tmuxSession) || str(m?.paneId) || '';

/**
 * What continues a name once one has started.
 *
 * `.` is deliberately **out**: a mention at the end of a sentence (`@alpha-main.`) has to
 * match, and a member whose own name carries a dot is already settled one rung up by
 * longest-first. `@` is out too, so `x@alpha-main` — an address, not a mention — is not one.
 */
const NAME_TAIL = /[A-Za-z0-9_-]/;

/**
 * The members this post addresses, in the room's own order.
 *
 * A **signal**, never a delivery: see part three of the header, and note that nothing in
 * this function is reachable from the fan-out. It answers `[]` for a body naming nobody,
 * which is the ordinary case.
 *
 * The match is exact, including case. One rule with no second spelling beats a forgiving
 * one that the browser's own highlight would then have to mirror — and the composer's
 * autocomplete is the affordance that gets the spelling right.
 *
 * @param {string} text the post, as it was written
 * @param {Array<object>} members the room's membership, as `rooms.js` stores it
 * @returns {string[]} member labels, deduplicated, in the room's order
 */
export function mentionsIn(text, members = []) {
  const body = typeof text === 'string' ? text : '';
  const labels = (Array.isArray(members) ? members : []).map(memberLabel).filter(Boolean);
  if (!body.includes('@') || !labels.length) return [];

  // Longest first, so a room holding both `alpha` and `alpha-main` never reads the longer
  // mention as the shorter one.
  const byLength = [...new Set(labels)].sort((a, b) => b.length - a.length);

  const found = new Set();
  for (let at = body.indexOf('@'); at !== -1; at = body.indexOf('@', at + 1)) {
    const before = at > 0 ? body[at - 1] : '';
    // A name character or another `@` in front means this is part of a word, not a mention.
    if (before && (NAME_TAIL.test(before) || before === '@')) continue;
    const name = byLength.find((n) => {
      if (!body.startsWith(n, at + 1)) return false;
      const after = body[at + 1 + n.length];
      return after === undefined || !NAME_TAIL.test(after);
    });
    if (name) found.add(name);
  }
  // Room order rather than the order they were typed: `group_list` answers the membership
  // in that order, and one order for both is one thing for a reader to hold.
  return labels.filter((n, i) => labels.indexOf(n) === i && found.has(n));
}


/* -------------------------------------------------------------------------- */
/* Part two: the two lines a member's terminal receives.                      */
/* -------------------------------------------------------------------------- */

/**
 * What a member is told when **another session** posted.
 *
 * One header line and the quoted body, and nothing else — the maintainer's ruling of
 * 2026-09-05. What used to sit between them (the room's whole membership, and a paragraph
 * restating what a `> ` line means and how to call `group_read` and `group_post`) is in
 * every session's standing brief already, so per post it bought nothing and cost a reader
 * a paragraph a turn. `group_list` answers the membership on demand. `room-header.js`
 * composes the line and says what each part of it is for.
 *
 * `peerHead` is the `> ` speaker's header and `prefixFor(PEER_SPEAKER)` is checked before
 * anything is composed, exactly as before: the word "lead" in that key is about the
 * *class*, not the role — one speaker is the maintainer and the other is not, and a room
 * post is the other.
 *
 * @param {object} opts
 * @param {{id: string, name: string}} opts.room
 * @param {string} opts.from   who posted, as the room names them
 * @param {string} opts.body   the post, verbatim — refused, never trimmed or shortened
 * @param {string} [opts.human] the maintainer's name, resolved by the caller. Unused by
 *   the line now that the rule paragraph has gone, and still accepted and refused: the
 *   endpoint passes a per-folder name to both variants off one call site, and a parameter
 *   that silently stopped being checked is a parameter that comes back uncheckable.
 * @param {string[]} [opts.to]  who the post named with `@`, from `mentionsIn`
 * @param {string} [opts.you]   the member this copy is for, as `memberLabel` names them —
 *   the whole of what makes an addressee's copy differ from everybody else's
 */
export function roomPeerLine({ room, from, body, human = HUMAN_FALLBACK, to = [], you = '' } = {}) {
  prefixFor(PEER_SPEAKER); // refuse before anything is composed
  assertClean(str(human) || HUMAN_FALLBACK, "The maintainer's name", { oneLine: true });
  const head = peerHead({ room, from, to, you });
  return `${head}\n${quoteBody(assertSendableBody(body, 'A room message'), PEER_SPEAKER)}`;
}

/**
 * What a member is told when **the maintainer** posted, from the panel's own composer.
 *
 * `prefixFor('human')` — `| ` — and the header's note clause is the one sentence in this
 * feature that can *authorize* something. It is a frozen string in `room-header.js` rather
 * than prose composed here, so a session that could not tell it from a peer's request
 * would have to be misreading a constant rather than a rewording.
 */
export function roomHumanLine({ room, body, human = HUMAN_FALLBACK, to = [], you = '' } = {}) {
  prefixFor(HUMAN_SPEAKER); // refuse before anything is composed
  const who = str(human) || HUMAN_FALLBACK;
  assertClean(who, "The maintainer's name", { oneLine: true });
  const head = humanHead({ room, who, to, you });
  return `${head}\n${quoteBody(assertSendableBody(body, 'A room message'), HUMAN_SPEAKER)}`;
}
