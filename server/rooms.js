import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { STATE_DIR } from './config.js';
import { assertClean, assertSendableBody } from './envelope.js';

/**
 * Group rooms — a named place where a handful of sessions coordinate on one thing.
 *
 * This module is the **store and nothing else**: an index of rooms and one append-only
 * log per room. It resolves no roster row, composes no envelope, types into no pane and
 * knows nothing about HTTP. Member resolution is `rooms-line.js`'s job and the fan-out is
 * the endpoint's; the shape of a member is this file's, and that is the whole of the
 * overlap.
 *
 * Two things on disk, both under `STATE_DIR` — resolved, never `~/.foreman` as a literal,
 * so a scratch `FOREMAN_STATE_DIR` genuinely isolates a bench:
 *
 *   - `<STATE_DIR>/rooms.json`  — the index, rewritten wholesale on a 2s dirty timer.
 *   - `<STATE_DIR>/rooms/<id>.jsonl` — one append-only log per room, never rewritten.
 *
 * The split is deliberate and it is the same split `links.js` and `room.js` already make:
 * a small mutable record that a card reads, and a log that only ever grows. A rewrite can
 * erase; an append cannot.
 *
 * ## Why it is not called `RoomStore`
 *
 * `server/room.js` exports `RoomStore` — the **team** room, one file per repo, a lead
 * talking to the workers it dispatched. That is a different thing with a different
 * lifetime, and this feature deliberately does not touch it. `RoomsStore` beside
 * `RoomStore` is the `rooms_post`-beside-`room_post` mistake the plan refuses for the MCP
 * tools (§5.3), one letter apart and doing different things, so the class is
 * `GroupRoomStore` and the tools it will back are `group_*`. The files can be `rooms.js`
 * and `room.js` because an import path is read once and a symbol is read everywhere.
 *
 * ## The two halves, and which precedent each is copied from
 *
 * **The index is `LinkStore` (`server/links.js`)**: a boot read that tolerates a
 * hand-edited file, a 2-second dirty flush, `seq` taken as `max(stored, highest id)` so a
 * hand-edited counter that went backwards cannot mint an id already in use, and — the
 * load-bearing one — a `corrupt` flag that renames an unparseable file to `.bad` *before*
 * the first flush can overwrite it. A boot must finish, so an unparseable file starts the
 * store clean rather than throwing; the danger is the write that follows, which would
 * replace a file with a typo in it (recoverable in any editor) with one that has thrown
 * the rest away.
 *
 * **Each log is `SharedRoomStore` (`server/shared-room.js`)**: `parseEntries` that skips a
 * torn last line, `read({since, limit})` capped from the end, boot rotation by `rename`
 * over `MAX_BYTES` with the `seq` **carried across it**, and an `EventEmitter` so a socket
 * can subscribe. A held cursor filters on `e.seq > since`, so a counter that restarted at
 * zero after a rotation would silently show that reader nothing until it had climbed back.
 *
 * ## What must survive a rollback
 *
 * `rooms.json` is loaded and then rewritten wholesale from memory, which is the exact
 * shape of `TaskStore`'s erasure (CLAUDE.md): a record this version does not understand,
 * dropped on read, is *deleted* by the next flush — and here it would orphan a log nobody
 * can find again. So:
 *
 *   - **unknown keys are carried through** — on the file, on each room and on each
 *     member — rather than rebuilt from a known list. A field a later version adds
 *     survives a rollback past it.
 *   - **skipping is reserved for shapes that cannot function at all**: a non-object, a
 *     record with no string `id`, a duplicate `id`, and a member with none of the three
 *     ids on it (nothing to resolve by, nothing to remove by — there is no information in
 *     it to lose).
 *   - **nothing else is re-validated at load.** An over-long name is *sliced*, exactly as
 *     `LinkStore` slices a hand-typed label, and a name or a member id carrying a control
 *     character is kept as it was found. That is `LinkStore`'s call, not a new one: the
 *     door refuses those (`create`, `rename`, `addMember`) and the composer refuses them
 *     again at send time, and neither of those refusals erases anything. A load that
 *     dropped the record instead would delete a room over a character.
 *
 * The one id that cannot merely be tolerated is one that would build a file path. A room
 * whose id is not `[A-Za-z0-9._-]` never came from this store, and `logFile` throws for
 * it — so the record is **kept** (nothing is erased) and only its log is unreachable,
 * which is a strictly better trade than skipping the record and deleting it on the next
 * flush.
 *
 * ## What is in memory and never on disk
 *
 * `rosterFrame` runs every two seconds and is broadcast to every client, so **nothing it
 * reads may touch a file** (§5.9). Per room this store keeps `seq`, `unseen` and `seenAt`
 * in a Map beside the record; `list()` folds them into the copy it hands out, which is
 * what the frame calls.
 *
 * `unseen` starts at **zero** for every room at boot, seeded from what the room already
 * holds: a room is a **log, not an inbox**, and a badge that opened at "everything ever
 * said" would be asking for attention nobody owes it. It counts a *session's* posts only,
 * never the maintainer's own — `LinkStore#touch`'s rule, for its reason: server-side,
 * "is he looking at it right now" is not knowable, so a counter bumped by his own typing
 * would sit at 1 until he closed the pane and reopened it, which is exactly what would
 * hide the bug.
 *
 * The rate limiter's own windows are in memory too. A restart forgives them, which is
 * correct: they exist to damp a room full of sessions answering each other within one
 * conversation (§5.6), not to be a quota anybody accrues.
 *
 * ## No invisible characters, here or anywhere near here
 *
 * Lines are `JSON.stringify` + `\n`, which escapes every control byte inside a body, so a
 * message containing a newline cannot tear a line. Nothing here builds a composite key or
 * a signature; if something ever needs one, join it with ordinary punctuation — this repo
 * has been bitten by a character you cannot see in an editor three times over
 * (`normalize.js`'s ANSI regex, `mergeSig`'s three control bytes, `rate-limits.js`'s NUL).
 */

const FILE = path.join(STATE_DIR, 'rooms.json');

/** Members per room. Every post is typed into every *other* member's terminal, so eight
 *  members is seven typed messages per post. Raising this later is one constant; lowering
 *  it once rooms exist is not. */
export const MAX_MEMBERS = 8;

/** A room name is a header fragment — it is interpolated into the line every member's
 *  terminal receives — not prose. */
export const MAX_ROOM_NAME = 60;

/** The per-log rotation threshold, `SharedRoomStore`'s value. A room's traffic is a
 *  handful of messages a day; this is a floor under a file nobody is watching. */
export const MAX_BYTES = 4 * 1024 * 1024;

/* ------------------------------------------------------------ rate limits --- */

/**
 * The amplification guard (§5.6). A five-member room where every member answers every post
 * is twenty typed messages a round, each of which wakes a session that may answer again.
 * `MAX_PER_PANE` in the queue is a backstop that turns that into 409s; this is the design.
 *
 * Three limits, checked in this order — the floor first, because it is the one a session
 * in a conversation actually hits. Every one of them **refuses**, and a refusal says so:
 * a silently dropped post is a session believing it has told the others something it has
 * not.
 */
export const POST_FLOOR_MS = 15_000;
export const RATE_WINDOW_MS = 5 * 60_000;
export const MAX_POSTS_PER_SESSION = 10;
export const MAX_POSTS_PER_ROOM = 30;

/** How the window is said in a refusal, so the sentence and the constant cannot drift. */
const WINDOW_LABEL = `${RATE_WINDOW_MS / 60_000} minutes`;

/* ------------------------------------------------------------------ shapes --- */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An error the endpoint can map to a status without matching a sentence. */
function fault(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * A field as it is stored: refused for control characters **before** it is trimmed, then
 * trimmed.
 *
 * The order is the whole of it, and getting it wrong is silent. `String#trim` strips
 * carriage return, newline and tab along with spaces — so a `paneId` of `%12` followed by
 * a carriage return, trimmed first, arrives at `assertClean` as a perfectly ordinary
 * `%12` and is *accepted*, having quietly stripped exactly the character this repo
 * refuses rather than strips. Caught by a test asserting the refusal, which is the only
 * way it ever would be: nothing about the stored value looks wrong afterwards.
 */
function clean(v, what) {
  if (typeof v !== 'string') return '';
  assertClean(v, what, { oneLine: true });
  return v.trim();
}

/** The same read with no refusal — for a *lookup* key, which is compared and never stored
 *  or interpolated into a line anybody's terminal receives. */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Where a store's logs live, derived from its index so a scratch index brings its own
 *  directory with it: `<dir>/rooms.json` -> `<dir>/rooms/`. */
export function logDirFor(file) {
  const base = String(file);
  const stem = base.replace(/\.json$/, '');
  // A path that did not end in `.json` would otherwise name the index file itself as the
  // directory — a scratch store constructed on `rooms` would try to mkdir over its own file.
  return stem === base ? `${base}-logs` : stem;
}

/**
 * Does this stored member answer to `key`?
 *
 * `key` is any one of the three ids — a tmux session name, a pane id, or a session label.
 * The store matches on all three because it is a *lookup*, not a resolution: which of the
 * three to believe when they disagree, and in what order, is `rooms-line.js`'s question
 * and is answered against the live roster, not here.
 */
export function memberMatches(member, key) {
  const want = str(key);
  if (!want || !member) return false;
  return member.tmuxSession === want || member.paneId === want || member.name === want;
}

/** A member as the door accepts it. Every id is refused for control characters, because
 *  each of them is interpolated into a header line in the message members receive — a
 *  carriage return in a member name would forge one exactly the way a body would. */
function cleanMember(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') throw fault('A room member needs a session.', 'bad-member');
  const { tmuxSession, name, paneId, addedAt, ...rest } = raw;
  const t = clean(tmuxSession, 'A tmux session name');
  const n = clean(name, 'A session name');
  const p = clean(paneId, 'A pane id');
  if (!t && !n && !p) {
    throw fault(
      'A room member needs at least one of a tmux session name, a pane id or a session name.',
      'bad-member',
    );
  }
  return {
    ...rest,
    tmuxSession: t || null,
    name: n || null,
    paneId: p || null,
    addedAt: Number(addedAt) || now,
  };
}

/** A name as the door accepts it: refused over the cap and refused for control characters,
 *  never shortened and never stripped. */
function cleanName(raw) {
  const s = clean(raw, 'A room name');
  if (!s) throw fault('A room needs a name.', 'bad-name');
  if (s.length > MAX_ROOM_NAME) {
    throw fault(
      `A room name is ${s.length} characters and the cap is ${MAX_ROOM_NAME}. ` +
        'It is refused rather than shortened.',
      'bad-name',
    );
  }
  return s;
}

/** The highest `room-N` already on disk, so a re-load can never mint a duplicate id. */
function highestSeq(rooms) {
  let top = 0;
  for (const r of rooms) {
    const n = /^room-(\d+)$/.exec(r.id)?.[1];
    if (n) top = Math.max(top, Number(n));
  }
  return top;
}

/** Split a jsonl body into entries, skipping torn lines. A crash mid-append leaves half a
 *  line, and the half is the *last* one — the rest is perfectly good history and refusing
 *  to read it over one bad tail would be the worse failure. */
export function parseEntries(text) {
  const entries = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* torn write — skip */
    }
  }
  return entries;
}

/**
 * Does this log's last byte need a newline before the next entry is appended?
 *
 * A crash mid-append leaves half a line **with no terminator**, and the next
 * `appendFileSync` lands flush against it: the torn half and a perfectly good new entry
 * become one unparseable line, and the post a session believes it made to everyone is
 * gone. `parseEntries` skipping a torn *last* line is only half the story — this is the
 * other half, and it is the half a reader loses.
 *
 * Terminating the tear is not repairing it. The half-line stays exactly as it was found
 * and stays unparseable; nothing is rewritten, re-interpreted or thrown away. One byte is
 * read per post, and posts are rare.
 */
function needsNewline(file) {
  let fd;
  try {
    const { size } = fs.statSync(file);
    if (!size) return false;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } catch {
    return false; // no file yet, or unreadable — the append will say so
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Drop timestamps that have fallen out of a window, in place. */
function prune(times, floor) {
  while (times.length && times[0] <= floor) times.shift();
  return times;
}

const secs = (ms) => Math.max(1, Math.ceil(ms / 1000));

/* ------------------------------------------------------------------ store --- */

export class GroupRoomStore extends EventEmitter {
  /**
   * @param {string} [file] override the index location (tests)
   * @param {string} [dir]  override the log directory (defaults beside the index)
   */
  constructor(file = FILE, dir = logDirFor(file)) {
    super();
    this.file = file;
    this.dir = dir;
    /** [{ id, name, members, createdAt, archivedAt, lastAt, lastFrom, ...unknown }] */
    this.rooms = [];
    this.seq = 0;
    this.dirty = false;
    this.corrupt = false; // a file that existed and would not parse — preserve it before writing
    /** Top-level keys of `rooms.json` this version has never heard of, carried through the
     *  rewrite for the same reason a record's unknown keys are. */
    this.extra = {};
    /** id -> { seq, unseen, seenAt, rotated, posts: number[], bySession: Map<string, number[]> } */
    this.live = new Map();

    this.#load();
    for (const room of this.rooms) this.#seedLog(room);

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  /* ------------------------------------------------------------ the index --- */

  #load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      // Absent is the ordinary first run. Anything else is a file we must not clobber.
      this.corrupt = err?.code !== 'ENOENT';
      return;
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const { seq, rooms, ...rest } = raw;
      this.extra = rest;
    }
    const list = Array.isArray(raw?.rooms) ? raw.rooms : [];
    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const { id, name, members, createdAt, archivedAt, lastAt, lastFrom, ...rest } = r;
      if (typeof id !== 'string' || !id.trim()) continue;
      if (this.rooms.some((seen) => seen.id === id)) continue;
      this.rooms.push({
        // Unknown keys first, so a later version's field survives a rollback past it and
        // the known ones still win. This is the half `TaskStore` did not have.
        ...rest,
        id,
        // Sliced, never refused: this is the tolerant boot read. The door refuses an
        // over-long name; dropping the room here would delete it on the next flush.
        name: typeof name === 'string' ? name.slice(0, MAX_ROOM_NAME) : '',
        members: this.#loadMembers(members),
        createdAt: Number(createdAt) || 0,
        archivedAt: Number(archivedAt) || null,
        lastAt: Number(lastAt) || null,
        lastFrom: typeof lastFrom === 'string' ? lastFrom : null,
      });
    }

    // The higher of the two: a hand-edited `seq` that went backwards must not be able to
    // mint an id already in use, which would give one room two records.
    this.seq = Math.max(Number.isInteger(raw?.seq) ? raw.seq : 0, highestSeq(this.rooms));
  }

  /**
   * The membership as the boot read tolerates it.
   *
   * A member with none of the three ids is skipped, and it is the one skip here that
   * costs nothing: it cannot be resolved to a session, cannot be removed by key, and
   * carries no information to lose. Everything else is kept as found — including a count
   * over `MAX_MEMBERS`, which `addMember` refuses at the door but which a hand-edited
   * file is allowed to hold rather than have four members silently deleted from it.
   */
  #loadMembers(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const { tmuxSession, name, paneId, addedAt, ...rest } = m;
      const t = str(tmuxSession);
      const n = str(name);
      const p = str(paneId);
      if (!t && !n && !p) continue;
      out.push({ ...rest, tmuxSession: t || null, name: n || null, paneId: p || null, addedAt: Number(addedAt) || 0 });
    }
    return out;
  }

  #flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (this.corrupt) {
        // Same directory, so the rename is a rename and not a silent copy-then-delete.
        try {
          fs.renameSync(this.file, `${this.file}.bad`);
          console.error(`[rooms] ${this.file} could not be parsed; kept as ${this.file}.bad`);
        } catch {
          /* gone, or unwritable — the write below is still the right thing to attempt */
        }
        this.corrupt = false;
      }
      fs.writeFileSync(
        this.file,
        JSON.stringify({ ...this.extra, seq: this.seq, rooms: this.rooms }, null, 2),
      );
    } catch {
      /* best-effort */
    }
  }

  /** Write now rather than waiting for the next tick (tests, shutdown). */
  flush() {
    this.#flush();
  }

  stop() {
    clearInterval(this.timer);
    this.#flush();
  }

  #record(id) {
    return this.rooms.find((r) => r.id === id) || null;
  }

  /** The live counters for a room, created on first touch. */
  #live(id) {
    let held = this.live.get(id);
    if (!held) {
      held = { seq: 0, unseen: 0, seenAt: null, rotated: null, posts: [], bySession: new Map() };
      this.live.set(id, held);
    }
    return held;
  }

  /**
   * A room, as a copy, with the memory-held counters folded in.
   *
   * A copy on the way out for `LinkStore#get`'s reason: a caller that reached in and
   * mutated the record would be writing to the store without setting `dirty`, so the
   * change would be live in memory and absent from disk until something unrelated
   * flushed. `#record` is the live one and it is private.
   *
   * `unseen` and `seq` are memory-owned and win over anything a hand-edited file holds
   * under those names — the file's copy is still carried through to disk untouched.
   */
  #copy(room) {
    const live = this.#live(room.id);
    return {
      ...room,
      members: room.members.map((m) => ({ ...m })),
      memberCount: room.members.length,
      seq: live.seq,
      unseen: live.unseen,
      seenAt: live.seenAt,
    };
  }

  /**
   * Every room, or only the open ones. **Reads no file** — this is what `rosterFrame`
   * calls every two seconds, and a file read there is a file read forever (§5.9).
   */
  list({ open = false } = {}) {
    return this.rooms.filter((r) => !open || !r.archivedAt).map((r) => this.#copy(r));
  }

  /** One room, as a copy, or null. */
  get(id) {
    const room = this.#record(id);
    return room ? this.#copy(room) : null;
  }

  /**
   * Every room `key` is a member of. A store lookup by one of the three ids, not a
   * resolution against the live roster — see `memberMatches`.
   */
  roomsFor(key, { open = false } = {}) {
    return this.rooms
      .filter((r) => (!open || !r.archivedAt) && r.members.some((m) => memberMatches(m, key)))
      .map((r) => this.#copy(r));
  }

  /** Is `key` in this room? */
  isMember(id, key) {
    const room = this.#record(id);
    return !!room && room.members.some((m) => memberMatches(m, key));
  }

  /**
   * Create a room.
   *
   * Only the maintainer ever calls this path — no `foreman` tool reaches it, the way
   * there is deliberately no tool to open a link. The store does not know that and does
   * not enforce it: the enforcement is that no tool is registered.
   */
  create(name, members = [], { now = Date.now() } = {}) {
    const clean = cleanName(name);
    const list = Array.isArray(members) ? members : [];
    if (list.length > MAX_MEMBERS) {
      throw fault(
        `A room holds at most ${MAX_MEMBERS} sessions and that is ${list.length}. ` +
          'Every post is typed into every other member’s terminal, so the cap is about their panes, not about storage.',
        'too-many-members',
      );
    }
    const roster = [];
    for (const m of list) {
      const member = cleanMember(m, { now });
      if (roster.some((seen) => this.#sameMember(seen, member))) {
        throw fault(`${member.name || member.tmuxSession || member.paneId} is already in the room.`, 'duplicate-member');
      }
      roster.push(member);
    }

    this.seq += 1;
    const room = {
      id: `room-${this.seq}`,
      name: clean,
      members: roster,
      createdAt: now,
      archivedAt: null,
      lastAt: null,
      lastFrom: null,
    };
    this.rooms.push(room);
    this.dirty = true;
    return this.#copy(room);
  }

  /**
   * Two members are the same session when the **strongest id they both carry** agrees.
   *
   * Strongest first, and it is `rooms-line.js`'s order for `rooms-line.js`'s reason
   * (§5.2): a tmux session name survives a `/clear` and a relaunch, a pane id survives a
   * `/clear` but not a relaunch, and a session name survives neither on its own. Two
   * members that share no id at all are two members — the panel always knows a live row's
   * tmux session, so that only happens to a hand-edited file.
   */
  #sameMember(a, b) {
    if (a.tmuxSession && b.tmuxSession) return a.tmuxSession === b.tmuxSession;
    if (a.paneId && b.paneId) return a.paneId === b.paneId;
    return !!(a.name && b.name) && a.name === b.name;
  }

  rename(id, name) {
    const room = this.#record(id);
    if (!room) return null;
    room.name = cleanName(name);
    this.dirty = true;
    return this.#copy(room);
  }

  /**
   * Archive a room: it is **done**, not deleted. The record stays, the log stays readable,
   * and `archivedAt` is what takes it out of the open list — `LinkStore#close`'s call, for
   * its reason. Nothing in this feature deletes a room or a line of one.
   */
  archive(id, { now = Date.now() } = {}) {
    const room = this.#record(id);
    if (!room || room.archivedAt) return null;
    room.archivedAt = now;
    this.dirty = true;
    return this.#copy(room);
  }

  unarchive(id) {
    const room = this.#record(id);
    if (!room || !room.archivedAt) return null;
    room.archivedAt = null;
    this.dirty = true;
    return this.#copy(room);
  }

  /**
   * Add a member. Refused over the cap, and refused for a session already in the room —
   * a second copy of one member is a second typed message into one pane.
   */
  addMember(id, member, { now = Date.now() } = {}) {
    const room = this.#record(id);
    if (!room) return null;
    const clean = cleanMember(member, { now });
    if (room.members.length >= MAX_MEMBERS) {
      throw fault(
        `${room.name} already holds ${room.members.length} sessions and the cap is ${MAX_MEMBERS}. ` +
          'Remove one first.',
        'too-many-members',
      );
    }
    if (room.members.some((m) => this.#sameMember(m, clean))) {
      throw fault(
        `${clean.name || clean.tmuxSession || clean.paneId} is already in ${room.name}.`,
        'duplicate-member',
      );
    }
    room.members.push(clean);
    this.dirty = true;
    return this.#copy(room);
  }

  /**
   * Remove the first member answering to `key` — a tmux session name, a pane id or a
   * session name. Pass the strongest id you hold: a tmux session name survives a `/clear`
   * and a relaunch, a pane id survives neither reliably (§5.2).
   *
   * Answers the room when something was removed, `null` when nothing matched, so a caller
   * can tell "removed" from "was not there" without reading the membership twice.
   */
  removeMember(id, key) {
    const room = this.#record(id);
    if (!room) return null;
    const at = room.members.findIndex((m) => memberMatches(m, key));
    if (at < 0) return null;
    room.members.splice(at, 1);
    this.dirty = true;
    return this.#copy(room);
  }

  /* -------------------------------------------------------------- the log --- */

  /**
   * Where a room's log lives.
   *
   * The id builds a path, so it is the one field the tolerant boot read cannot simply
   * carry: an id outside `[A-Za-z0-9._-]` never came from this store. The record is kept
   * all the same — throwing here costs that room its log and costs nothing else, while
   * skipping it at load would delete the room on the next flush.
   */
  logFile(id) {
    if (!SAFE_ID.test(String(id ?? ''))) {
      throw fault(`${id} is not a room id this store could have written.`, 'bad-room-id');
    }
    return path.join(this.dir, `${id}.jsonl`);
  }

  /**
   * Boot: rotate an oversized log, then take `seq` off the last line it holds.
   *
   * Boot-only for `SharedRoomStore`'s reason — this process is the only writer and has
   * not written yet — and it is why `list()` can promise never to read a file: everything
   * a two-second frame wants is put in memory here.
   *
   * The log is also the authority on `lastAt`/`lastFrom`, so a record left stale by a
   * crash between the append and the 2s flush is healed from it rather than believed.
   */
  #seedLog(room) {
    const live = this.#live(room.id);
    let file;
    try {
      file = this.logFile(room.id);
    } catch {
      return; // an id that cannot name a file — the record stands, the log is unreachable
    }
    const carried = this.#rotate(room.id, file, live);
    const entries = parseEntries(readText(file));
    const last = entries[entries.length - 1];
    live.seq = last ? Number(last.seq) || carried : carried;
    if (last && Number(last.ts) > (room.lastAt || 0)) {
      room.lastAt = Number(last.ts);
      room.lastFrom = typeof last.from === 'string' ? last.from : room.lastFrom;
      this.dirty = true;
    }
  }

  /** Retire an oversized log. Answers the seq to carry into the fresh one. */
  #rotate(id, file, live) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return 0; // no log yet — the ordinary case for a room nobody has posted in
    }
    if (size <= MAX_BYTES) return 0;
    const entries = parseEntries(readText(file));
    const carried = entries.length ? Number(entries[entries.length - 1].seq) || 0 : 0;
    const to = `${file}.1`;
    // `rename` replaces an existing `.1` in one step: one generation, overwritten, and no
    // window where neither file is there. Never a rewrite — a compaction pass that reads
    // records it does not understand has `TaskStore`'s shape.
    fs.renameSync(file, to);
    live.rotated = { room: id, bytes: size, to: path.basename(to), carriedSeq: carried };
    return carried;
  }

  /** What every rotation did at construction, for the boot line to print. Never contents. */
  rotations() {
    return [...this.live.values()].map((l) => l.rotated).filter(Boolean);
  }

  /**
   * Is this poster over a limit right now? `null` when it may post.
   *
   * Exported behaviour rather than a private check so the endpoint can answer 429 before
   * it composes anything, and so a test can assert the sentence rather than the throw.
   *
   * **The maintainer is never refused.** `by === null` is the panel's own composer, and
   * this limiter exists to damp sessions answering each other (§5.6) — a person typing
   * the same thing twice is deliberate, and refusing their word is not this module's job.
   * Their posts still *count* toward the room-wide window, because a room-wide cap is
   * about how many typed copies a member's pane receives, whoever sent them.
   */
  rateFault(id, by, { now = Date.now() } = {}) {
    if (by === null || by === undefined) return null;
    const room = this.#record(id);
    if (!room) return null; // `post` answers 404 for this; no counters are minted for a room that is not there
    const live = this.#live(id);
    const name = room.name || id;

    const mine = prune(live.bySession.get(by) || [], now - RATE_WINDOW_MS);
    const last = mine[mine.length - 1];
    if (last && now - last < POST_FLOOR_MS) {
      return {
        code: 'rate-limited',
        retryAfterMs: POST_FLOOR_MS - (now - last),
        message:
          `You posted to "${name}" ${secs(now - last)}s ago — you have already said this to everyone. ` +
          `Wait ${secs(POST_FLOOR_MS - (now - last))}s.`,
      };
    }
    if (mine.length >= MAX_POSTS_PER_SESSION) {
      const wait = mine[0] + RATE_WINDOW_MS - now;
      return {
        code: 'rate-limited',
        retryAfterMs: wait,
        message:
          `You have posted ${mine.length} times to "${name}" in the last ${WINDOW_LABEL} — ` +
          `you have already said this to everyone. Try again in ${secs(wait)}s.`,
      };
    }
    const all = prune(live.posts, now - RATE_WINDOW_MS);
    if (all.length >= MAX_POSTS_PER_ROOM) {
      const wait = all[0] + RATE_WINDOW_MS - now;
      return {
        code: 'rate-limited',
        retryAfterMs: wait,
        message:
          `"${name}" has taken ${all.length} posts in the last ${WINDOW_LABEL} and is at its ` +
          `limit — every one of them is typed into every member’s terminal. Try again in ${secs(wait)}s.`,
      };
    }
    return null;
  }

  /**
   * Append one entry to a room's log.
   *
   * `from` is who is speaking, as a string the card and the envelope can print: a
   * member's session name, or `panel` for the maintainer. `by` is **who is posting**, as
   * one of the three member ids — and it is required rather than defaulted, with `null`
   * spelling the maintainer explicitly, because a `by` that quietly defaulted would let a
   * session's post skip the membership check and the limiter by omission. The same stance
   * `speaker` has in `envelope.js`: not plumbed by accident.
   *
   * The store refuses, in the order the endpoint answers them: no such room (404), an
   * archived room (409), a poster who is not a member (409), over a limit (429). A body
   * is checked first when it is present, since it is the only one the caller can fix.
   *
   * Whether every member's copy was *handed* to a pane is not this module's business and
   * is not a condition of the append: the post happened, and the entry the endpoint
   * writes says who missed it.
   */
  post(id, { from, kind = 'peer', ...rest } = {}, { by, now = Date.now() } = {}) {
    if (by === undefined) {
      throw fault('A room post must say who is posting: a member id, or null for the maintainer.', 'bad-poster');
    }
    const sender = clean(from, 'A room sender');
    if (!sender) throw fault('A room post needs a sender.', 'bad-sender');
    if (typeof rest.text === 'string') assertSendableBody(rest.text, 'A room message');

    const room = this.#record(id);
    if (!room) throw fault(`There is no room ${id}.`, 'no-room');
    if (room.archivedAt) {
      throw fault(`"${room.name}" is archived. It is still readable; nothing more can be posted to it.`, 'archived');
    }
    if (by !== null && !this.isMember(id, by)) {
      throw fault(`${by} is not in "${room.name}".`, 'not-a-member');
    }
    const over = this.rateFault(id, by, { now });
    if (over) throw fault(over.message, over.code);

    const live = this.#live(id);
    const entry = { seq: live.seq + 1, ts: now, kind, from: sender, ...rest };
    const file = this.logFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lead = needsNewline(file) ? '\n' : '';
    fs.appendFileSync(file, `${lead}${JSON.stringify(entry)}\n`);

    live.seq = entry.seq;
    live.posts.push(now);
    if (by !== null) {
      const mine = live.bySession.get(by) || [];
      mine.push(now);
      live.bySession.set(by, mine);
      // Counts a session's posts only. The maintainer's own typing must not badge the
      // room he is looking at — `LinkStore#touch`'s rule and its reason.
      live.unseen += 1;
    }
    room.lastAt = now;
    room.lastFrom = sender;
    this.dirty = true;

    this.emit('post', id, entry);
    return entry;
  }

  /** Every entry in a room. Torn lines skipped. Throws for a room that does not exist —
   *  an empty read and "there is no such room" are different answers. */
  readAll(id) {
    if (!this.#record(id)) throw fault(`There is no room ${id}.`, 'no-room');
    return parseEntries(readText(this.logFile(id)));
  }

  /** Entries after `since` (a seq), capped from the end — a pane opens on a tail. */
  read(id, { since = 0, limit = 200 } = {}) {
    const all = this.readAll(id);
    const after = since > 0 ? all.filter((e) => e.seq > since) : all;
    return {
      entries: after.slice(-limit),
      cursor: all.length ? all[all.length - 1].seq : 0,
      truncated: after.length > limit,
    };
  }

  /** The room has been opened: nothing in it is new any more. */
  seen(id, { now = Date.now() } = {}) {
    const room = this.#record(id);
    if (!room) return null;
    const live = this.#live(id);
    live.unseen = 0;
    live.seenAt = now;
    return this.#copy(room);
  }
}
