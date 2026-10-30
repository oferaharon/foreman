import { execFile } from 'node:child_process';
import { CronWitness, IdleClock, hibernateMs, idleSince, readSchedulerLock, sleepRecord, sleepVerdict } from './hibernate.js';
import { heldBy } from './snapshot.js';

/*
 * The sleep loop: the part of hibernation that acts. `hibernate.js` decides; this asks it,
 * once a minute, and puts **at most one** session to sleep per pass.
 *
 * Everything it touches is injected — the roster, the pane reads, `sendText`, the clock —
 * so the loop is tested with a fake bench and an injected clock rather than through a knob
 * that makes the real panel sleep faster. `server/index.js` wires the real ones in, and is
 * the only place that does.
 *
 * `Hibernator#hibernate` is **the only caller of `/exit` this feature adds**. Grep for it.
 * It is reached from the loop alone: no endpoint puts a named session to sleep (the
 * maintainer's ruling of 2026-10-29 — automatic only, no manual sleep button).
 */

/** One pass a minute. The registry ticks every two seconds; a sleep decision needs no more. */
export const PASS_EVERY_MS = 60_000;

/**
 * How long a sleep waits for its name to leave tmux after `/exit` — relaunch's figure
 * (`EXIT_GONE_TIMEOUT_MS` in `index.js`), for relaunch's reason: about three seconds is
 * normal, and the ceiling only costs waiting.
 */
export const SLEEP_EXIT_TIMEOUT_MS = 20_000;

const POLL_MS = 300;

/**
 * A pane's process and every process under it, off one `ps -axo pid=,ppid=` read.
 *
 * The scheduler lock names the `claude` process, which is the pane's own pid when the
 * launch shell `exec`s it and a child of it otherwise — so the lock check is asked against
 * the whole tree rather than guessing which.
 *
 * @param {string} psOut
 * @param {number} root
 * @returns {number[]|null} `null` when `root` is not a pid
 */
export function pidTree(psOut, root) {
  if (!Number.isInteger(root) || root <= 0) return null;
  const kids = new Map();
  for (const line of String(psOut || '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = [root];
  for (let i = 0; i < out.length; i += 1) for (const k of kids.get(out[i]) || []) if (!out.includes(k)) out.push(k);
  return out;
}

/** `ps -axo pid=,ppid=`, or `null` when it could not be read — which the lock check reads as unknown. */
export function readProcessTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * The pinned row a sleeper's pin sat under: the nearest *named* pin above it, or `null` when
 * it was at the top. Names, never pane ids — a wake comes back on a new pane.
 *
 * @param {Array<string|null>} pinnedNames the pinned group by session name, top first
 * @param {string} name
 */
export function pinAfterOf(pinnedNames, name) {
  const at = pinnedNames.indexOf(name);
  if (at < 0) return null;
  for (let i = at - 1; i >= 0; i -= 1) if (pinnedNames[i]) return pinnedNames[i];
  return null;
}

/**
 * Where a woken sleeper's pin goes back: the current pinned group by name, with its own name
 * spliced in just under `pinAfter` — at the top when it had nothing above it, and at the
 * bottom when the row it sat under is no longer pinned. This is `wanted` for
 * `carryPinOrder`, which moves only the pin the wake made.
 *
 * @param {Array<string|null>} current
 * @param {{name: string, pinAfter: string|null}} record
 */
export function wakePinOrder(current, { name, pinAfter }) {
  const out = current.filter((n) => n !== name);
  if (!pinAfter) return [name, ...out];
  const at = out.indexOf(pinAfter);
  if (at < 0) return [...out, name];
  out.splice(at + 1, 0, name);
  return out;
}

/**
 * @typedef {object} HibernatorDeps
 * @property {() => object[]} sessions               the roster as the registry holds it
 * @property {() => Promise<void>} refresh            re-poll the roster now
 * @property {() => Promise<object[]>} listPanes      `{paneId, tmuxSession, pid, createdMs}` per pane
 * @property {(paneId: string) => Promise<object>} readPaneState
 * @property {(paneId: string) => Promise<boolean|null>} composerEmpty  `readComposerEmpty` (`tmux.js`, through `ghost.js`)
 * @property {() => Promise<string|null>} [processTable]
 * @property {(folder: string) => object|null} [readLock]
 * @property {(paneId: string, text: string) => Promise<void>} sendText  the guarded path
 * @property {(paneId: string, ...keys: string[]) => Promise<void>} sendKeys
 * @property {() => Promise<string[]>} liveSessionNames
 * @property {() => string} setting                    `hibernateAfter`, read at every pass
 * @property {() => boolean} busy                      a relaunch or restore is running
 * @property {() => Set<string>} watched               session ids open in a connected browser
 * @property {() => Promise<Array<string|null>>} pinnedNames
 * @property {(record: object) => void} [onSlept]
 * @property {(line: string) => void} [log]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

export class Hibernator {
  /**
   * @param {object} opts
   * @param {import('./hibernate.js').HibernateStore} opts.store
   * @param {HibernatorDeps} opts.deps
   * @param {() => number} [opts.now]
   * @param {IdleClock} [opts.clock]
   * @param {CronWitness} [opts.cron]
   */
  constructor({ store, deps, now = () => Date.now(), clock = null, cron = null }) {
    this.store = store;
    this.deps = { readLock: readSchedulerLock, processTable: readProcessTable, log: () => {}, onSlept: () => {}, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...deps };
    this.now = now;
    this.clock = clock || new IdleClock(now());
    this.cron = cron || new CronWitness();
    this.lastPass = -Infinity;
    this.running = false;
    this.started = false;
    /** True from the re-read to the name freeing — relaunch, restore, wake and forget refuse meanwhile. */
    this.sleeping = false;
  }

  /** From here on, ticks may run passes. Called after the single-instance probe. */
  start() {
    this.started = true;
  }

  /**
   * Every roster tick: the idle clock learns who was busy (every tick, or a turn shorter
   * than a pass would be missed), and once a minute a pass runs. Never two at once.
   */
  tick(sessions = this.deps.sessions()) {
    const now = this.now();
    this.clock.note(sessions, now);
    if (!this.started || this.running || now - this.lastPass < PASS_EVERY_MS) return null;
    this.lastPass = now;
    this.running = true;
    return this.pass(sessions).finally(() => {
      this.running = false;
    });
  }

  /** The setting as a number, or `null` for off. */
  afterMs() {
    return hibernateMs(this.deps.setting());
  }

  /**
   * Everything `sleepVerdict` asks, for one row. `pane` is its `listPanes` entry, `ps` one
   * process-table read shared by the pass. `composer` is read only when asked — it is a
   * tmux capture, and the pass asks it only of a row everything else already allowed.
   */
  async context(row, { sessions, pane, ps, live = null, composer = false, watched }) {
    const now = this.now();
    const name = row.tmuxSession;
    const createdMs = pane?.createdMs ?? null;
    let composerOk = null;
    if (composer && row.paneId) {
      const read = await this.deps.composerEmpty(row.paneId).catch(() => null);
      composerOk = typeof read === 'boolean' ? read : null;
    }
    return {
      now,
      afterMs: this.afterMs(),
      sessions,
      live,
      held: name ? this.store.heldCount(name) : null,
      idleSince: idleSince(row, { lastBusy: name ? this.clock.lastBusy(name) : null, createdMs, wokeAt: name ? this.clock.wokeAt(name) : null }),
      cron: row.paneId ? this.cron.check({ key: row.paneId, path: row.transcriptPath || null, since: createdMs, now }) : null,
      lock: this.deps.readLock(row.paneCwd),
      pids: pane && ps != null ? pidTree(ps, pane.pid) : null,
      composerEmpty: composerOk,
      keepAwake: name ? this.store.isKeepAwake(name) : null,
      watched: watched.has(row.id),
    };
  }

  /**
   * Whether this row would be put to sleep now, and why not — read fresh off the pane, for
   * the pane header's tooltip. Everything a pass would ask, including the composer.
   *
   * `besideWatched` answers as though no browser had it open. The tooltip is asked from the
   * session's own header, so "it is open in a browser" would be the answer every time and
   * would hide the reason that matters once the pane is closed; the route says the watched
   * half separately.
   */
  async verdict(row, { besideWatched = false } = {}) {
    // Off answers before anything is read — the cron scan's first read of a transcript is
    // the whole file, and nobody needs it to be told hibernation is off.
    if (!row || this.afterMs() == null) return sleepVerdict(row, { afterMs: this.afterMs() });
    const sessions = this.deps.sessions();
    const [panes, ps] = await Promise.all([this.deps.listPanes().catch(() => []), this.deps.processTable()]);
    const pane = panes.find((p) => p.paneId === row.paneId) || null;
    const live = row.paneId ? await this.deps.readPaneState(row.paneId).catch(() => null) : null;
    const ctx = await this.context(row, { sessions, pane, ps, live, composer: true, watched: besideWatched ? new Set() : this.deps.watched() });
    return sleepVerdict(row, ctx);
  }

  /**
   * One pass: find the session that has been idle longest among those the rules allow, and
   * put it — and only it — to sleep. Skipped whole while a relaunch or restore runs: both
   * end and start sessions by name, and a sleep landing between an exit and its restart
   * would record a session the restart then brings back.
   *
   * @returns {Promise<{slept: object|null, why?: string}>}
   */
  async pass(sessions = this.deps.sessions()) {
    this.#prune(sessions);
    if (this.afterMs() == null) return { slept: null, why: 'off' };
    if (this.deps.busy()) return { slept: null, why: 'busy' };

    const [panes, ps] = await Promise.all([this.deps.listPanes().catch(() => []), this.deps.processTable()]);
    const paneOf = new Map(panes.map((p) => [p.paneId, p]));
    const watched = this.deps.watched();

    // Cheap first: every rule but the composer, which costs a capture. A row that passes
    // the rest is then asked that too.
    const candidates = [];
    for (const row of sessions) {
      if (!row?.tmuxSession || this.store.has(row.tmuxSession)) continue;
      const pane = paneOf.get(row.paneId) || null;
      const ctx = await this.context(row, { sessions, pane, ps, watched });
      const v = sleepVerdict(row, { ...ctx, composerEmpty: true });
      if (v.ok) candidates.push({ row, since: ctx.idleSince });
    }
    candidates.sort((a, b) => a.since - b.since);

    for (const { row } of candidates) {
      if (this.deps.busy()) return { slept: null, why: 'busy' };
      const out = await this.hibernate(row);
      if (out.slept || out.tried) return out;
    }
    return { slept: null, why: 'none eligible' };
  }

  /**
   * Put one session to sleep — **the only `/exit` this feature sends.**
   *
   * The relaunch loop's order, and its rules: the roster is refreshed and the pane re-read
   * before anything is decided, because the roster is a poll behind; the verdict is asked
   * again against that read, composer included; the record is written (and flushed to disk)
   * **before** the `/exit`, so a crash between the two leaves a greyed row rather than a
   * session that vanished; and `/exit` goes through `sendText`, which re-reads the pane a
   * third time and refuses a box.
   *
   * Then it waits for the *name* to leave tmux. Two ways that does not happen, and both end
   * the same way — the record deleted, the session left awake, a line in the log:
   *
   *   • **A box comes up instead.** `/exit` with a cron live raises "The following will stop
   *     when you exit" (measured on v2.1.296; `docs/traps/launch.md`). The verdict refuses a
   *     session with a cron, so this should never be seen — but if it is, the answer is
   *     **Escape**, which cancels, and never `1` or `2`: both end or orphan somebody's loop.
   *     It does not wait the name out either; nothing is going to close.
   *   • **The name never frees** within `SLEEP_EXIT_TIMEOUT_MS`.
   *
   * `tried` on the result means a sleep was attempted on this pass, so the pass stops there:
   * at most one `/exit` per pass, whether it worked or not.
   *
   * @returns {Promise<{slept: object|null, tried?: boolean, why?: string}>}
   */
  async hibernate(candidate) {
    if (this.sleeping) return { slept: null, why: 'a sleep is already running' };
    this.sleeping = true;
    try {
      return await this.#hibernate(candidate);
    } finally {
      this.sleeping = false;
    }
  }

  async #hibernate(candidate) {
    const name = candidate?.tmuxSession;
    if (!name) return { slept: null, why: 'no name' };

    await this.deps.refresh().catch(() => {});
    const sessions = this.deps.sessions();
    const row = sessions.find((s) => s.tmuxSession === name);
    if (!row?.paneId) return { slept: null, why: 'gone' };
    const [panes, ps] = await Promise.all([this.deps.listPanes().catch(() => []), this.deps.processTable()]);
    const pane = panes.find((p) => p.paneId === row.paneId) || null;
    const live = await this.deps.readPaneState(row.paneId).catch(() => null);
    const ctx = await this.context(row, { sessions, pane, ps, live, composer: true, watched: this.deps.watched() });
    const v = sleepVerdict(row, ctx);
    if (!v.ok) return { slept: null, why: v.why };
    // A relaunch, restore or wake that began while this was re-reading has the bench now.
    if (this.deps.busy()) return { slept: null, why: 'busy' };

    const pinnedNames = await this.deps.pinnedNames().catch(() => []);
    const record = sleepRecord(row, {
      now: this.now(),
      idleSince: ctx.idleSince,
      pinned: Boolean(row.pinned),
      pinAfter: row.pinned ? pinAfterOf(pinnedNames, name) : null,
    });
    this.store.put(record);
    this.store.flush();

    const giveUp = (why) => {
      this.store.remove(name);
      this.store.flush();
      this.deps.log(`hibernate: ${name} left awake — ${why}`);
      return { slept: null, tried: true, why };
    };

    try {
      await this.deps.sendText(row.paneId, '/exit');
    } catch (err) {
      return giveUp(`/exit was refused: ${err.message}`);
    }

    const deadline = this.now() + SLEEP_EXIT_TIMEOUT_MS;
    for (;;) {
      await this.deps.sleep(POLL_MS);
      const names = await this.deps.liveSessionNames().catch(() => null);
      if (names && !names.includes(name)) break;
      const after = await this.deps.readPaneState(row.paneId).catch(() => null);
      const held = heldBy(after);
      if (held) {
        await this.deps.sendKeys(row.paneId, 'Escape').catch(() => {});
        return giveUp(`/exit raised a box (${held}); pressed Escape`);
      }
      if (this.now() > deadline) return giveUp(`it had not closed ${SLEEP_EXIT_TIMEOUT_MS / 1000} s after /exit`);
    }

    this.deps.log(`hibernate: ${name} is asleep (idle since ${new Date(record.idleSince).toISOString()})`);
    this.deps.onSlept(record);
    return { slept: record, tried: true };
  }

  /** A wake succeeded: start this name's idle clock now (measurement 5 — `lastActivity` does not move on a resume). */
  woke(name) {
    this.clock.woke(name, this.now());
  }

  #prune(sessions) {
    const names = sessions.map((s) => s?.tmuxSession).filter(Boolean);
    this.clock.prune([...names, ...this.store.names()]);
    this.cron.prune(sessions.map((s) => s?.paneId).filter(Boolean));
  }
}
