import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { STATE_DIR } from './config.js';
import { isLeadName, slugFor } from './launch.js';
import { MAX_PER_PANE } from './queue.js';
import { SESSION_ID_RE, heldBy, isBenchRow, relaunchOne } from './snapshot.js';

export { HIBERNATE_CHOICES, DEFAULT_HIBERNATE, hibernateMs, isHibernateChoice } from '../web/hibernate-choices.js';

/*
 * Hibernation's rules and its memory: whether a session may be put to sleep, how long it
 * has been idle, whether something is scheduled inside it, and who is asleep.
 *
 * Pure apart from the files it is pointed at — no tmux, no roster, no timers but the
 * store's flush. The loop that acts on these answers lives in `index.js`; everything that
 * decides lives here, so it can be tested without a pane.
 *
 * Sleeping a session is `/exit`ing it and keeping its row, so every rule below leans the
 * same way, by the maintainer's ruling of 2026-10-29: **when in doubt the verdict is no.** A
 * wrong "asleep" silently kills somebody's work — a loop, a half-typed message, a worker's
 * lead — while a wrong "awake" costs a few hundred MB. An input the caller did not supply is
 * a doubt, and refuses.
 */

const DAY = 24 * 60 * 60_000;

/**
 * Whether this roster row may be put to sleep now, and if not, why — in words, the way
 * `heldBy` answers, because the words are what the pane header's tooltip shows.
 *
 * Every ruling of 2026-10-29 is one refusal here, plus three that follow from them: the
 * name can be given back (ruling 5's "same session name"), nothing is typed in its terminal
 * (the `/exit` would wipe it), and it is not open in a browser (the plan's Q2). `rule` is a
 * stable code for tests and logs; `why` is for people.
 *
 * @param {object} row the live roster row
 * @param {object} ctx
 * @param {number} ctx.now
 * @param {number|null} ctx.afterMs the setting, through `hibernateMs` — `null` is off
 * @param {Array<object>} ctx.sessions the whole roster, for a lead's workers
 * @param {object|null} [ctx.live] the pane as just re-read; asked as well as the row
 * @param {number} ctx.held messages held for this name
 * @param {number|null} ctx.idleSince from `idleSince`
 * @param {{blocked: boolean, why: string|null}} ctx.cron from `CronWitness#check`
 * @param {object|null} ctx.lock from `readSchedulerLock` — `null` when there is none
 * @param {number[]|null} ctx.pids this pane's process and its children
 * @param {boolean|null} ctx.composerEmpty from `ghost.js`'s `composerEmpty`
 * @param {boolean} ctx.keepAwake
 * @param {boolean} ctx.watched open in a connected browser
 * @returns {{ok: true} | {ok: false, rule: string, why: string}}
 */
export function sleepVerdict(row, ctx = {}) {
  const no = (rule, why) => ({ ok: false, rule, why });
  const now = ctx.now ?? Date.now();

  if (!Number.isFinite(ctx.afterMs) || ctx.afterMs <= 0) return no('off', 'hibernation is off');
  if (!row) return no('unknown', 'it is not in the roster');

  // (a) Never a worker — `isBenchRow`, the allow-list, and nothing written beside it.
  if (!isBenchRow(row)) return no('worker', 'it is a worker');

  // (b) A lead with a live worker. Rows, not task records: a pending task has no session,
  // and a worker whose task closed under it is still a worker in this lead's repo.
  if (row.team?.role === 'lead') {
    if (!Array.isArray(ctx.sessions)) return no('unknown', 'its team’s workers cannot be counted');
    const workers = ctx.sessions.filter(
      (s) => s && s !== row && s.team?.role === 'worker' && s.team.repo === row.paneCwd,
    ).length;
    if (workers) return no('workers', `its team has ${workers} worker${workers === 1 ? '' : 's'} running`);
  }

  // (d) Something to resume: a bound transcript, under an id `--resume` accepts.
  if (!row.transcriptPath || !SESSION_ID_RE.test(String(row.id || ''))) {
    return no('history', 'it has no conversation to resume');
  }

  // † The name can be given back — the exact test restart-one makes, not a second one.
  const back = relaunchOne(row, { mode: 'resume' });
  if (!back.entry) {
    const why =
      back.why === 'name'
        ? 'it wasn’t started under a name the panel can give back'
        : back.why === 'folder'
          ? 'there is no folder to start it again in'
          : 'it has no pane the panel can restart';
    return no('name', why);
  }

  // † Ruling 3, and Q2: somebody asked for it to stay, or somebody is looking at it.
  if (ctx.keepAwake !== false) return no('keep-awake', ctx.keepAwake ? 'it is set to keep awake' : 'its keep-awake setting is unknown');
  if (ctx.watched !== false) return no('watched', ctx.watched ? 'it is open in a browser' : 'whether a browser has it open is unknown');

  // (c) Idle, holding nothing, nothing waiting to be typed.
  if (row.status !== 'idle') {
    const words = { working: 'it is working', 'needs-decision': 'it is waiting on you', dialog: 'a box is open in its terminal' };
    return no('busy', words[row.status] || `it is ${row.status || 'in an unknown state'}`);
  }
  const holding = heldBy(ctx.live) || heldBy({ ...row, state: row.status });
  if (holding) return no('holding', holding);
  const queued = Array.isArray(row.queued) ? row.queued.length : null;
  if (queued !== 0) return no('queued', queued == null ? 'its queue cannot be read' : plural(queued, 'message is', 'messages are') + ' queued for it');
  if (ctx.held !== 0) return no('held', Number.isInteger(ctx.held) ? plural(ctx.held, 'message is', 'messages are') + ' waiting for it' : 'its held messages cannot be counted');

  // (e) Nothing in the background. `null` is a box over the line it is read from — unknown,
  // never zero.
  const bg = row.background;
  if (!bg) return no('background', 'its background work cannot be read');
  if (bg.shells > 0) return no('background', bg.shells === 1 ? 'a background shell is running' : `${bg.shells} background shells are running`);
  if (bg.monitors > 0) return no('background', bg.monitors === 1 ? 'a monitor is running' : `${bg.monitors} monitors are running`);
  if (bg.agents > 0) return no('background', bg.agents === 1 ? 'a background agent is running' : `${bg.agents} background agents are running`);
  if (!ctx.cron || typeof ctx.cron.blocked !== 'boolean') return no('cron', 'whether anything is scheduled in it is unknown');
  if (ctx.cron.blocked) return no('cron', ctx.cron.why || 'something is scheduled in it');
  const locked = lockBlocks(ctx.lock, ctx.pids);
  if (locked) return no('lock', locked);

  // (f) Nothing for you to read.
  if (row.unread !== 0) return no('unread', 'it has a reply you haven’t read');
  if (row.needsYou) return no('unread', 'it is waiting on you');

  // † The terminal's own input line is empty. `/exit` goes through `sendText`, which presses
  // `C-u` first, and would wipe whatever is half-typed in a Terminal window.
  if (ctx.composerEmpty !== true) {
    return no('composer', ctx.composerEmpty === false ? 'something is typed in its terminal' : 'its terminal’s input line cannot be read');
  }

  // And idle for long enough.
  if (!Number.isFinite(ctx.idleSince)) return no('idle', 'how long it has been idle is unknown');
  const idle = now - ctx.idleSince;
  if (idle < ctx.afterMs) return no('idle', `it has been idle ${minutes(idle)} of ${minutes(ctx.afterMs)}`);

  return { ok: true };
}

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

const minutes = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m >= 120 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;
};

/**
 * When this row's idle clock started: the **latest** of four times, never the transcript's
 * alone.
 *
 * Measured on v2.1.296: `--resume` writes one `bridge-session` record with no `timestamp`,
 * so a freshly woken session's `lastActivity` still says the moment it went to sleep — and a
 * clock built on that alone puts it straight back to sleep on the next pass. The pane's own
 * creation time and the wake time are what stop that; `lastBusy` (the last poll it was seen
 * doing anything, from `IdleClock`) is what catches a session that worked without writing.
 *
 * @param {{lastActivity?: number|null}} row
 * @param {{lastBusy?: number|null, createdMs?: number|null, wokeAt?: number|null}} [ctx]
 * @returns {number|null} `null` when none of the four is known
 */
export function idleSince(row, { lastBusy = null, createdMs = null, wokeAt = null } = {}) {
  const times = [row?.lastActivity, lastBusy, createdMs, wokeAt].filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/**
 * The in-memory half of the idle clock, keyed by tmux session name because pane ids reset.
 *
 * Every name starts at the panel's boot time, so a panel restart restarts every clock — the
 * plan's Q9, accepted: the cost is one more idle period, the alternative is trusting a
 * transcript timestamp that does not move on a resume. `wokeAt` is kept here rather than on
 * the sleep record, because the record is deleted the moment the wake succeeds.
 */
export class IdleClock {
  constructor(bootAt = Date.now()) {
    this.bootAt = bootAt;
    this.busy = new Map();
    this.woken = new Map();
  }

  /** One poll's roster: anything not plainly `idle` was busy at `now`. */
  note(sessions, now = Date.now()) {
    for (const s of sessions || []) {
      if (s?.tmuxSession && s.status !== 'idle') this.busy.set(s.tmuxSession, now);
    }
  }

  woke(name, at = Date.now()) {
    if (name) this.woken.set(name, at);
  }

  lastBusy(name) {
    return Math.max(this.bootAt, this.busy.get(name) ?? -Infinity);
  }

  wokeAt(name) {
    return this.woken.get(name) ?? null;
  }

  /** Forget names that are neither live nor asleep. */
  prune(keep) {
    const names = new Set(keep);
    for (const map of [this.busy, this.woken]) for (const name of map.keys()) if (!names.has(name)) map.delete(name);
  }
}

/* ------------------------------------------------------------------ the cron witness --- */

/**
 * The tools whose calls the witness follows. A result record never names its tool — a
 * `CronDelete` result's `toolUseResult` is `{id}` and nothing else — so the name is learned
 * from the assistant's `tool_use` and the result is read only through that.
 */
const SCHEDULER_TOOLS = new Set(['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']);

/** Recurring crons expire on their own after seven days (the `CronCreate` result says so). */
export const RECURRING_EXPIRY_MS = 7 * DAY;

/**
 * How long past its `scheduledFor` an armed wake-up is still believed. A fire is written to
 * the transcript, and was measured landing *early* (49 s before), so this only matters for a
 * fire the witness never saw; the tool clamps a delay at one hour.
 */
export const WAKEUP_GRACE_MS = 10 * 60_000;

const CHUNK = 1 << 20;

/**
 * Whether anything is scheduled inside a session — a cron, a `/loop`, a `ScheduleWakeup` —
 * read out of its transcripts, since nothing on screen shows one.
 *
 * Every rule here is a measurement, written up in `docs/traps/launch.md` ("A `/loop`
 * outlives `/clear`"):
 *
 *   • **Incremental, and its own reader.** Each path is read from the byte offset the last
 *     check stopped at, the whole file once at first. `probe` samples head and tail, and a
 *     `CronCreate` in the middle of a long conversation is exactly what it would miss.
 *
 *   • **Keyed by pane process, not by path.** A cron survives `/clear` into a transcript
 *     that never mentions it, so the paths a pane has shown are remembered under its key and
 *     read together. The key carries the pane's creation time, which is also the cut-off:
 *     a scheduled task is session-only and died with the process that made it, so a woken
 *     session reading its old transcript does not count the loops its last life ran.
 *
 *   • **A one-shot retires on its own fire** (`scheduled_task_fire` with its `taskId`), a
 *     recurring one on `CronDelete` or after seven days, a wake-up on a `stop` or a loop
 *     fire. A `CronList` result is the exact list at that moment and replaces what was
 *     known. A fire of an id never seen being created is counted as a live recurring cron —
 *     it is the one trace a cron made before a `/clear` the witness never saw leaves behind.
 *
 * The lock file is the other witness, and the verdict asks both (`lockBlocks`).
 */
export class CronWitness {
  #paths = new Map(); // path -> {offset, partial, names, events, lastAt}
  #panes = new Map(); // key -> {since, paths: Set}

  /**
   * @param {{key: string, path: string|null, since: number|null, now?: number}} at
   *   `key` is the pane id, `since` its creation time
   * @returns {{blocked: boolean, why: string|null}}
   */
  check({ key, path: file, since = null, now = Date.now() }) {
    if (!key) return { blocked: true, why: 'it has no pane to follow' };
    let pane = this.#panes.get(key);
    if (!pane || pane.since !== since) {
      pane = { since, paths: new Set() };
      this.#panes.set(key, pane);
    }
    if (file) pane.paths.add(file);

    const events = [];
    for (const p of pane.paths) {
      const st = this.#scan(p);
      if (!st) return { blocked: true, why: 'its transcript cannot be read' };
      events.push(...st.events);
    }
    return judge(events, { since, now });
  }

  /** Drop panes that are gone, and every path no remaining pane has shown. */
  prune(liveKeys) {
    const keep = new Set(liveKeys);
    for (const key of this.#panes.keys()) if (!keep.has(key)) this.#panes.delete(key);
    const shown = new Set();
    for (const pane of this.#panes.values()) for (const p of pane.paths) shown.add(p);
    for (const p of this.#paths.keys()) if (!shown.has(p)) this.#paths.delete(p);
  }

  #scan(file) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return null;
    }
    let st = this.#paths.get(file);
    // Shorter than where we stopped: a different file under the same path. Start again.
    if (!st || size < st.offset) {
      st = { offset: 0, partial: Buffer.alloc(0), names: new Map(), events: [], lastAt: null };
      this.#paths.set(file, st);
    }
    if (size === st.offset) return st;

    let fd;
    try {
      fd = fs.openSync(file, 'r');
      while (st.offset < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - st.offset));
        const got = fs.readSync(fd, buf, 0, buf.length, st.offset);
        if (got <= 0) break;
        st.offset += got;
        // Split on the newline byte, never on a decoded string — a chunk boundary can fall
        // inside a multi-byte character, and the partial line is carried as bytes.
        const data = Buffer.concat([st.partial, buf.subarray(0, got)]);
        const end = data.lastIndexOf(0x0a);
        if (end < 0) {
          st.partial = data;
          continue;
        }
        st.partial = data.subarray(end + 1);
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) readLine(line, st);
      }
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return st;
  }
}

/** One transcript line, into the path's events — or nothing, which is most lines. */
function readLine(line, st) {
  if (!line) return;
  // A cheap filter before the parse: a scheduler call names its tool, a fire names its
  // subtype, and a result names the `tool_use_id` it answers.
  const result = st.names.size > 0 && line.includes('"tool_use_id"');
  if (!result && !line.includes('Cron') && !line.includes('ScheduleWakeup') && !line.includes('scheduled_task_fire')) return;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  const t = Date.parse(r?.timestamp);
  if (Number.isFinite(t)) st.lastAt = t;
  const at = Number.isFinite(t) ? t : st.lastAt;
  const push = (e) => st.events.push({ ...e, at });

  if (r?.type === 'system' && r.subtype === 'scheduled_task_fire') {
    push({ type: 'fire', id: r.taskId ?? null, loop: r.taskKind === 'loop' || r.cronKind === 'loop' });
    return;
  }
  const content = r?.message?.content;
  if (!Array.isArray(content)) return;

  if (r.type === 'assistant') {
    for (const b of content) {
      if (b?.type === 'tool_use' && SCHEDULER_TOOLS.has(b.name)) st.names.set(b.id, { name: b.name, input: b.input || {} });
    }
    return;
  }
  if (r.type !== 'user') return;

  const answers = content.filter((b) => b?.type === 'tool_result' && st.names.has(b.tool_use_id));
  for (const b of answers) {
    const { name, input } = st.names.get(b.tool_use_id);
    st.names.delete(b.tool_use_id);
    // Measured: a refused call (`noop` missing) is `is_error: true` with a string
    // `toolUseResult`, and scheduled nothing.
    if (b.is_error) continue;
    // `toolUseResult` is one per record. Two scheduler answers in one record would leave
    // the witness guessing which it belongs to — so it says it cannot tell.
    const tur = answers.length === 1 && r.toolUseResult && typeof r.toolUseResult === 'object' ? r.toolUseResult : null;
    if (!tur) {
      push({ type: 'unreadable' });
      continue;
    }
    if (name === 'CronCreate' && typeof tur.id === 'string') {
      push({ type: 'create', id: tur.id, recurring: tur.recurring !== false, durable: tur.durable === true });
    } else if (name === 'CronDelete') {
      push({ type: 'delete', id: tur.id ?? input.id ?? null });
    } else if (name === 'CronList' && Array.isArray(tur.jobs)) {
      push({
        type: 'list',
        jobs: tur.jobs.filter((j) => j && typeof j.id === 'string').map((j) => ({ id: j.id, recurring: j.recurring !== false, durable: j.durable === true })),
      });
    } else if (name === 'ScheduleWakeup') {
      if (tur.stopped === true || input.stop === true) push({ type: 'stop' });
      else push({ type: 'arm', until: Number.isFinite(tur.scheduledFor) && tur.scheduledFor > 0 ? tur.scheduledFor : null });
    } else {
      push({ type: 'unreadable' });
    }
  }
}

/** Replay one pane process's events in time order, and say whether anything is still live. */
function judge(events, { since, now }) {
  const mine = events
    .filter((e) => e.at == null || since == null || e.at >= since || (e.type === 'create' && e.durable))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));

  let live = new Map();
  let wake = null;
  let unreadable = false;
  for (const e of mine) {
    if (e.type === 'create') live.set(e.id, { recurring: e.recurring, at: e.at });
    else if (e.type === 'delete') live.delete(e.id);
    else if (e.type === 'list') live = new Map(e.jobs.map((j) => [j.id, { recurring: j.recurring, at: e.at }]));
    else if (e.type === 'arm') wake = { until: e.until ?? (e.at ?? now) + 60 * 60_000 };
    else if (e.type === 'stop') wake = null;
    else if (e.type === 'unreadable') unreadable = true;
    else if (e.type === 'fire') {
      if (e.loop) wake = null;
      else if (!live.has(e.id)) live.set(e.id, { recurring: true, at: e.at });
      else if (!live.get(e.id).recurring) live.delete(e.id);
    }
  }

  for (const job of live.values()) {
    if (job.recurring && job.at != null && now - job.at >= RECURRING_EXPIRY_MS) continue;
    return {
      blocked: true,
      why: job.recurring ? 'a /loop or recurring cron is scheduled in it' : 'a one-off scheduled task is waiting to fire in it',
    };
  }
  if (wake && now <= wake.until + WAKEUP_GRACE_MS) return { blocked: true, why: 'a /loop wake-up is pending in it' };
  if (unreadable) return { blocked: true, why: 'a scheduler call in its transcript cannot be read' };
  return { blocked: false, why: null };
}

/**
 * `<folder>/.claude/scheduled_tasks.lock`, as read: `null` when there is none, the parsed
 * `{sessionId, pid, procStart, acquiredAt}`, or `{unreadable: true}`.
 *
 * Measured: it appears with a folder's first cron, stays after `CronDelete`, goes when its
 * holder exits, and then passes to another session in that folder that still holds one.
 */
export function readSchedulerLock(folder) {
  if (!folder) return { unreadable: true };
  let raw;
  try {
    raw = fs.readFileSync(path.join(folder, '.claude', 'scheduled_tasks.lock'), 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? null : { unreadable: true };
  }
  try {
    const lock = JSON.parse(raw);
    return Number.isInteger(lock?.pid) ? lock : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

/**
 * Why the folder's scheduler lock keeps this session awake, or `null`.
 *
 * Matched on **pid, never on `sessionId`**: after a `/clear` the lock still names the old
 * session id under the same process. It is conservative — it outlives `CronDelete`, so a
 * session that has ever run `/loop` stays awake until it is restarted (the plan's Q8,
 * accepted) — and it is partial, because it names one holder per folder.
 *
 * @param {object|null|undefined} lock from `readSchedulerLock`
 * @param {number[]|null|undefined} pids this pane's process and its children
 */
export function lockBlocks(lock, pids) {
  if (lock === null) return null;
  if (!lock || lock.unreadable) return 'its folder’s scheduler lock cannot be read';
  if (!Array.isArray(pids)) return 'which process holds its folder’s scheduler lock cannot be told';
  return pids.includes(lock.pid) ? 'it has used the scheduler (a /loop or a cron) since it started' : null;
}

/* ------------------------------------------------------------------------- the store --- */

const FILE = path.join(STATE_DIR, 'hibernate.json');

let tmpCounter = 0;

/**
 * What a sleeper's row needs to be drawn, and what its wake needs to launch it again.
 *
 * `folder` is `paneCwd`, never `cwd` — the transcript's `cwd` moves when a session changes
 * directory, and a wake into it would put the row under another heading. `model` is for
 * display only: a wake launches on the panel's `launchModel`, by ruling.
 */
export function sleepRecord(row, { now = Date.now(), idleSince: since = null, pinned = false, pinAfter = null } = {}) {
  const folder = row.paneCwd || null;
  return {
    name: row.tmuxSession,
    folder,
    slug: slugFor(row.tmuxSession, folder),
    lead: Boolean(isLeadName(row.tmuxSession, folder)),
    sessionId: row.id,
    transcriptPath: row.transcriptPath,
    title: row.title ?? null,
    label: row.label ?? null,
    project: row.project ?? null,
    bypass: Boolean(row.bypass),
    attached: Boolean(row.attached),
    pinned: Boolean(pinned),
    pinAfter: pinAfter ?? null,
    sleptAt: now,
    idleSince: since,
    lastActivity: row.lastActivity ?? null,
    model: row.model ?? null,
  };
}

/**
 * Who is asleep, who must stay awake, and what is waiting for a sleeper — at
 * `STATE_DIR/hibernate.json`.
 *
 * Everything is keyed by **tmux session name**, because pane ids reset and names are the
 * contract a wake comes back under.
 *
 * **Unknown keys are carried through** — top-level and inside each record — because the file
 * is rewritten whole from memory, and a store that kept only the fields it knew would
 * delete a later build's data on a rollback (`GroupStore` and `TaskStore` both learned this).
 * An unparseable file is **never written over**: the store runs empty and says so through
 * `unreadable`, since replacing it would forget every sleeper in it.
 *
 * Writes go through a temp file in the same directory and a `rename`, which is atomic only
 * within one filesystem (`writeConfigFile`'s rule), on the same two-second timer as its
 * siblings.
 */
export class HibernateStore extends EventEmitter {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE, { flushMs = 2000 } = {}) {
    super();
    this.file = file;
    this.extra = {};
    this.asleepBy = new Map();
    this.keepAwakeSet = new Set();
    this.heldFor = new Map();
    this.seq = 0;
    this.dirty = false;
    this.unreadable = false;
    this.#load();
    this.timer = setInterval(() => this.#flush(), flushMs);
    this.timer.unref?.();
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // first run
    }
    let doc;
    try {
      doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    } catch {
      this.unreadable = true;
      return;
    }
    const { asleep, keepAwake, held, ...extra } = doc;
    this.extra = extra;
    if (asleep && typeof asleep === 'object') {
      for (const [name, rec] of Object.entries(asleep)) {
        if (name && rec && typeof rec === 'object' && !Array.isArray(rec)) this.asleepBy.set(name, { ...rec, name });
      }
    }
    if (Array.isArray(keepAwake)) for (const name of keepAwake) if (typeof name === 'string' && name) this.keepAwakeSet.add(name);
    if (held && typeof held === 'object') {
      for (const [name, items] of Object.entries(held)) {
        if (!Array.isArray(items)) continue;
        const clean = items.filter((i) => i && typeof i.id === 'string' && typeof i.text === 'string');
        if (clean.length) this.heldFor.set(name, clean.slice(0, MAX_PER_PANE));
      }
    }
  }

  #flush() {
    if (!this.dirty || this.unreadable) return;
    this.dirty = false;
    const doc = {
      ...this.extra,
      asleep: Object.fromEntries(this.asleepBy),
      keepAwake: [...this.keepAwakeSet],
      held: Object.fromEntries(this.heldFor),
    };
    const tmp = `${this.file}.tmp-${process.pid}-${(tmpCounter += 1)}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      this.dirty = true; // try again next tick
    }
  }

  /** Write now rather than waiting for the next tick (tests, shutdown). */
  flush() {
    this.#flush();
  }

  #touch() {
    this.dirty = true;
    this.emit('changed');
  }

  /** Every sleeper's record. Copies, so callers can't reach in. */
  asleep() {
    return [...this.asleepBy.values()].map((r) => ({ ...r }));
  }

  get(name) {
    const rec = this.asleepBy.get(name);
    return rec ? { ...rec } : null;
  }

  has(name) {
    return this.asleepBy.has(name);
  }

  /** The names a launch must not mint while their owners sleep. */
  names() {
    return new Set(this.asleepBy.keys());
  }

  bySessionId(id) {
    for (const rec of this.asleepBy.values()) if (id && rec.sessionId === id) return { ...rec };
    return null;
  }

  /**
   * The sleeping lead for a folder, or nothing — what a nudge, a trigger or a merge press
   * finds when `findLead` finds no live one. Exactly one or none, `findLead`'s own rule: two
   * sleeping leads in one folder would be a choice, and a message is never sent on a guess.
   * `lead` is the record's `isLeadName` at sleep, and `folder` its `paneCwd`.
   */
  leadFor(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
    const want = path.resolve(folder);
    const leads = [...this.asleepBy.values()].filter(
      (r) => r.lead === true && typeof r.folder === 'string' && path.isAbsolute(r.folder) && path.resolve(r.folder) === want,
    );
    return leads.length === 1 ? { ...leads[0] } : null;
  }

  /** Record a sleeper — written *before* its `/exit`, so a crash mid-sleep leaves the row. */
  put(record) {
    if (!record?.name) throw new Error('A sleep record needs the session’s name.');
    this.asleepBy.set(record.name, { ...record });
    this.#touch();
    return { ...record };
  }

  /** Merge fields into a sleeper's record, keeping every key it already had. */
  update(name, patch) {
    const rec = this.asleepBy.get(name);
    if (!rec) return null;
    const next = { ...rec, ...patch, name };
    this.asleepBy.set(name, next);
    this.#touch();
    return { ...next };
  }

  /** The record goes; held messages are the caller's to take first (`takeHeld`). */
  remove(name) {
    if (!this.asleepBy.delete(name)) return false;
    this.#touch();
    return true;
  }

  /** The bin on a sleeping row: the record and anything held for it. The transcript stays. */
  forget(name) {
    const record = this.get(name);
    const dropped = this.heldFor.get(name)?.length || 0;
    if (!record && !dropped) return null;
    this.asleepBy.delete(name);
    this.heldFor.delete(name);
    this.#touch();
    return { record, dropped };
  }

  isKeepAwake(name) {
    return this.keepAwakeSet.has(name);
  }

  keepAwake() {
    return [...this.keepAwakeSet];
  }

  setKeepAwake(name, on) {
    if (!name) throw new Error('Which session?');
    const had = this.keepAwakeSet.has(name);
    if (on) this.keepAwakeSet.add(name);
    else this.keepAwakeSet.delete(name);
    if (had !== Boolean(on)) this.#touch();
    return Boolean(on);
  }

  /** What is waiting for a sleeper, oldest first. */
  held(name) {
    return (this.heldFor.get(name) || []).map((i) => ({ ...i }));
  }

  heldCount(name) {
    return this.heldFor.get(name)?.length || 0;
  }

  /**
   * Keep a message for a sleeper until it wakes. Same item shape and the same cap as the
   * pane queue it moves into on wake, and refused for a name that is not asleep — a message
   * held for nobody would wait forever.
   */
  hold(name, text, { now = Date.now() } = {}) {
    if (!this.asleepBy.has(name)) throw new Error('That session is not asleep.');
    const items = this.heldFor.get(name) || [];
    if (items.length >= MAX_PER_PANE) throw new Error(`This session already has ${MAX_PER_PANE} messages waiting.`);
    this.seq += 1;
    const item = {
      id: `${now.toString(36)}-${this.seq.toString(36)}`,
      text: String(text),
      at: now,
      paneCreatedMs: null,
      attempts: 0,
      nextTryAt: 0,
      error: null,
    };
    items.push(item);
    this.heldFor.set(name, items);
    this.#touch();
    return { ...item };
  }

  /** Everything held for a name, removed from the store, in order — the wake's drain. */
  takeHeld(name) {
    const items = this.heldFor.get(name) || [];
    if (!items.length) return [];
    this.heldFor.delete(name);
    this.#touch();
    return items.map((i) => ({ ...i }));
  }

  stop() {
    clearInterval(this.timer);
    this.#flush();
  }
}
