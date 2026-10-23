import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';
import { parseTags } from '../web/task-tags.js';

const FILE = path.join(STATE_DIR, 'tasks.json');

/** The states a task can be *stored* in, in lifecycle order. `blocked` is deliberately
 *  absent — it is derived from the roster (a worker on a permission box is blocked exactly
 *  as long as the pane says so), and storing it would mean a second source of truth going
 *  stale.
 *
 * `pending` is the rung below `queued`: a brief, a label, a kind and maybe a model, with no
 * session, no branch and no worktree — an idea recorded with its context while changing it
 * is still free, promoted into a real worker later on the maintainer's second yes. It is a
 * *new* state rather than a reuse of `queued` because `queued` genuinely is active (the
 * seconds between `createWorktree` and the session coming up, when a checkout
 *  already exists on disk), so it belongs in `ACTIVE` and `pending` must never join it. */
export const TASK_STATES = ['pending', 'queued', 'dispatched', 'working', 'review', 'done', 'failed', 'abandoned'];

/**
 * What a worker was dispatched to *do*. `build` is every task that ever existed before
 * planners, so a record written without one reads as `build` — the field is additive and
 * nothing migrates. A `plan` task is an ordinary worker in every mechanical respect
 * (worktree, branch, room, cap) and differs in exactly two: the brief it launches with
 * and the permission stance that stops it writing code.
 */
export const TASK_KINDS = ['build', 'plan'];
export const DEFAULT_TASK_KIND = 'build';
/**
 * What the cap counts. `pending` is not here and must not be: `active()` is what
 * `server/index.js` checks against `maxWorkers`, so three recorded ideas would fill a
 * default team's cap and refuse every dispatch with no worker running at all.
 */
const ACTIVE = new Set(['queued', 'dispatched', 'working']);

/**
 * A task still on the board — dispatched, being worked, or waiting on the lead's review.
 *
 * Wider than `ACTIVE`, which counts live workers against the cap: a task in `review` has
 * finished its work and still owns its worker, its branch and its worktree, so anything
 * asking "is this session on a ticket?" has to say yes. Everything outside this set is
 * closed — `done`, `failed` and `abandoned` are all things nobody is waiting on, and a
 * row that went on advertising one would be pointing at a dead task.
 *
 * `pending` is out for a different reason than the closed states: it is not open *yet*.
 * Both consumers are in `server/sessions.js` and both are about a live session — a
 * pending task has none, so `openTaskFor` would never match it anyway, and `#team`'s
 * `lead · N tasks` would turn a number about how busy the team is into a number about how
 * long the wish list is.
 */
export const OPEN_STATES = new Set(['queued', 'dispatched', 'working', 'review']);

/** `parseTags`, as a store wants it: the clean list, or a throw carrying its sentence. */
function checkedTags(input) {
  const parsed = parseTags(input);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.tags;
}

/**
 * The team's tickets — one record per task, one task per worker.
 *
 * Same pattern as pins/groups/queue: a Map, a debounced flush, a file under STATE_DIR.
 * Keyed by id = the worker's label, which names the branch (`agent/<id>`), the worktree
 * and the tmux session, so one string ties a row in this store to everything on disk.
 *
 * Unlike pins, tasks are *not* pruned when their pane dies — a vanished session is a
 * `failed` task, not a forgotten one, and its worktree stays behind as evidence. That is
 * the spec's failure table, and it's why `prune` here marks instead of deleting.
 */
export class TaskStore {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    this.file = file;
    this.tasks = new Map(); // id -> record
    this.dirty = false;
    this.#load();

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, t] of Object.entries(raw)) {
        if (!t || !TASK_STATES.includes(t.state)) continue;
        // Additive fields: every task on disk before planners existed is a build task,
        // and reads as one rather than as `undefined` deciding something later. Same for
        // the two the pending state added — a record written before them answers `null` —
        // and for tags, where a record from before them is untagged.
        //
        // The spread is also why this store keeps a field it has never heard of: a stored
        // key this build does not know rides `...t` into the Map and `#flush` writes it
        // back, so a rollback past a field loses nothing. The price is that an invalid
        // value is kept just as faithfully, which is why every reader of `tags` goes
        // through `readTags`/`whatTag` (`web/task-tags.js`) and never reads it raw.
        this.tasks.set(id, { kind: DEFAULT_TASK_KIND, modelReason: null, startedBy: null, tags: [], ...t });
      }
    } catch {
      /* first run, or hand-edited into nonsense — start clean */
    }
  }

  #flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.tasks), null, 2));
    } catch {
      /* best-effort */
    }
  }

  flush() {
    this.#flush();
  }

  /**
   * @param {{id: string, repo: string, body: string, kind?: 'build'|'plan', source?: string,
   *          state?: string, branch?: string, worktree?: string, base?: string,
   *          staleBase?: boolean, model?: string, modelReason?: string,
   *          startedBy?: string, planFile?: string, tags?: string[]}} t
   */
  create(t, { now = Date.now() } = {}) {
    if (!t?.id) throw new Error('A task needs an id.');
    if (this.tasks.has(t.id)) throw new Error(`Task already exists: ${t.id}`);
    const kind = t.kind ?? DEFAULT_TASK_KIND;
    if (!TASK_KINDS.includes(kind)) throw new Error(`No such task kind: ${kind}`);
    // A task is born `queued` unless it says otherwise — `pending` is the one caller that
    // does. Validated here for the same reason the kind is: a bad state has to fail at the
    // store, while somebody is still holding the request, rather than eight hours later
    // when a dispatch tries to promote a record nothing can read back.
    const state = t.state ?? 'queued';
    if (!TASK_STATES.includes(state)) throw new Error(`No such state: ${state}`);
    // Omitted means untagged; given means validated, and a bad set fails here for the same
    // reason a bad state does. The record below is built field by field, so a `tags` this
    // block did not carry onto it would be dropped without a word.
    const tags = t.tags === undefined ? [] : checkedTags(t.tags);
    const rec = {
      id: t.id,
      repo: t.repo,
      kind,
      body: t.body ?? '',
      source: t.source ?? 'chat',
      state,
      branch: t.branch ?? null,
      worktree: t.worktree ?? null,
      base: t.base ?? null,
      staleBase: Boolean(t.staleBase),
      // What the worker was *launched* with — the rail's model chip is the live truth
      // (safeguards can switch a session mid-flight); this is the dispatch record.
      model: t.model ?? null,
      // Why that model, in the lead's own words — required at dispatch whenever the model
      // departs from the team default, and kept because a pending task needs it *again*
      // at promotion, long after the sentence that justified it has left the room.
      modelReason: t.modelReason ?? null,
      // Who said "start it" — stamped at promotion, null for anything dispatched
      // directly. Nothing writes it yet; it is here so the field exists on every record
      // rather than appearing halfway through the store's history.
      startedBy: t.startedBy ?? null,
      // Where a planner's output will land. Recorded at dispatch, before the file
      // exists, so `plan_read` can tell "not written yet" from "wrong task".
      planFile: t.planFile ?? null,
      // What the task *is* — one word from `WHAT_TAGS`, for the task's whole life.
      tags,
      tmuxSession: null,
      pane: null,
      pr: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
    };
    this.tasks.set(rec.id, rec);
    this.dirty = true;
    return rec;
  }

  get(id) {
    return this.tasks.get(id) ?? null;
  }

  list(repo = null) {
    const all = [...this.tasks.values()];
    return repo ? all.filter((t) => t.repo === repo) : all;
  }

  /** Tasks that hold (or are about to hold) a live worker — what the cap counts. */
  active(repo) {
    return this.list(repo).filter((t) => ACTIVE.has(t.state));
  }

  /** @param {string} id @param {object} patch fields to merge; `state` and `tags` validated */
  update(id, patch, { now = Date.now() } = {}) {
    const rec = this.tasks.get(id);
    if (!rec) return null;
    if (patch.state && !TASK_STATES.includes(patch.state)) {
      throw new Error(`No such state: ${patch.state}`);
    }
    // So the general path cannot write what `setTags` would refuse.
    if (Object.hasOwn(patch, 'tags')) patch = { ...patch, tags: checkedTags(patch.tags) };
    Object.assign(rec, patch, { updatedAt: now });
    if (patch.state === 'dispatched' && !rec.dispatchedAt) rec.dispatchedAt = now;
    this.dirty = true;
    return rec;
  }

  /**
   * Replace a task's tags, in any state — the tag describes the record for its whole life,
   * so a `done` task can be retagged as freely as a pending one.
   *
   * Deliberately leaves `updatedAt` alone, unlike `update`. Both task lists sort
   * newest-first on it within each tier, so a retag that stamped it would jump the row the
   * maintainer just clicked to the top of its tier, under the cursor — and the lead's
   * closed `recent` list is ordered by it too, so retagging a month-old task would put it
   * back in front of the lead as though something had happened to it.
   *
   * @param {string} id @param {string[]} tags validated by `parseTags`, which throws here
   * @returns {object|null} the record, or `null` for an unknown id
   */
  setTags(id, tags) {
    const rec = this.tasks.get(id);
    if (!rec) return null;
    rec.tags = checkedTags(tags);
    this.dirty = true;
    return rec;
  }

  /**
   * A dispatched/working task whose tmux session no longer exists has crashed —
   * mark it, don't drop it. Worktree stays; the lead (or the maintainer) decides what next.
   *
   * @param {Set<string>} liveSessions tmux session names currently alive
   * @returns {string[]} ids newly marked failed
   */
  prune(liveSessions, { now = Date.now() } = {}) {
    const failed = [];
    for (const rec of this.tasks.values()) {
      const gone =
        (rec.state === 'dispatched' || rec.state === 'working') &&
        rec.tmuxSession &&
        !liveSessions.has(rec.tmuxSession);
      if (gone) {
        rec.state = 'failed';
        rec.updatedAt = now;
        failed.push(rec.id);
        this.dirty = true;
      }
    }
    return failed;
  }

  stop() {
    clearInterval(this.timer);
    this.#flush();
  }
}
