import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';
import { WORKTREES_DIR } from './worktree.js';
import { isLeadName, slugFor } from './launch.js';

const FILE = path.join(STATE_DIR, 'snapshot.json');

/**
 * The bench you set up, saved so a reboot can't take it.
 *
 * A dozen sessions across nine folders is twenty minutes of `+ new` to rebuild from
 * memory, and the panel already knows every ingredient: `launch.js` mints names
 * deterministically, and each roster row carries the folder its pane was launched in. So
 * a snapshot is nothing more than a saved list of `{folder, slug}` to replay.
 *
 * One slot, written when you press the button. This is deliberately not crash recovery —
 * a rolling auto-snapshot would have to guess whether an empty roster means "everything
 * closed" or "the panel restarted first", and guessing wrong overwrites the thing you
 * were counting on. You say when the bench is right.
 *
 * Restored sessions are **fresh**. No `--resume`, no history: reading a conversation back
 * is `claude --resume`'s job, the same as it has been since sessions without a live pane
 * stopped appearing in the roster at all. That is a statement about the *file* and still
 * holds — `restoreSessions` grew a resume path for **relaunch all**, which builds its
 * entries from the live roster (`relaunchEntries`) and never from this slot, precisely
 * because a session id saved days ago points at a conversation whose pane is long gone.
 *
 * Two things are pointedly absent from the file.
 *
 *   Groups, because `groups.js` keys on the folder and never prunes against the roster —
 *   the shelves are still sitting there after a reboot, waiting for sessions to reappear
 *   in those folders. Copying the assignments in here would be a second source of truth
 *   for the one part of this that already survives on its own.
 *
 *   The queue, because its entries are messages written for a conversation that no longer
 *   exists. Replaying one into a fresh, contextless session is exactly the keystroke in
 *   the wrong place that the rest of this panel is built to prevent.
 *
 *   Workers, for the same reason one level up — see `isBenchRow`. A **lead** does ride
 *   along, and comes back through `launchLead` rather than through `createSession`, or it
 *   would return as an ordinary session wearing the lead chip.
 *
 * Pins do ride along: `PinStore` is pane-keyed with a birthday guard, so every pin dies at
 * reboot by design, and re-pinning is what makes the restored rail look like the one you
 * saved.
 *
 * **What a saved bench does when the session prefix changes under it**, since the prefix
 * is configuration now (`sessionPrefix` in `config.json`) and a saved entry carries the
 * *name* it was minted with. Traced rather than assumed:
 *
 *   `save` stores `{folder, slug, tmuxSession, …}`, and the **slug is what the restore
 *   actually launches with** — computed at save time by `slugFor` against the prefix in
 *   force then, so it is the bare label either way and carries no prefix at all. The
 *   restore mints a fresh name from `{folder, slug}` through `uniqueSessionName`, which
 *   takes today's prefix. So an entry saved as `<old>alpha-main` comes back as
 *   `<new>alpha-main`: the right folder, the right label, a different name.
 *
 *   The skip-what-is-already-live guard compares the **saved** `tmuxSession` against the
 *   live list, so under a changed prefix it matches nothing and every entry relaunches.
 *   That is correct when the old sessions are gone (a reboot, which is what a snapshot is
 *   for) and is the one thing to know when they are not: an old `<old>alpha-main` still
 *   running is not recognised, and the restore starts `<new>alpha-main` beside it. No
 *   name collision and no `-2`, but two live sessions in one folder — which is also two
 *   panes in one folder, and `binding.js` needs an exact label match to tell them apart.
 *   `/exit` the strays or don't restore into them.
 *
 *   `drift` compares saved names against live names, so immediately after a prefix change
 *   every saved entry reads `missing` and every live one reads `extra`, and the rail's
 *   stale-snapshot dot lights. That is honest rather than a bug: the saved bench genuinely
 *   no longer describes what is running, and re-saving it is one press.
 *
 *   `isLeadEntry` is unaffected: it reads `slug === 'lead'` first, which is prefix-free.
 *   Its `isLeadName` fallback does use today's prefix, and only fires for a file
 *   hand-edited to carry a name without a slug — `save` has always computed one.
 */
/**
 * Is this folder one of the panel's own worker worktrees?
 *
 * `path.relative` rather than `startsWith`, which would call `<state>/worktrees-old` a
 * worktree because the string matches.
 */
const underWorktrees = (folder) => {
  if (!folder) return false;
  const rel = path.relative(WORKTREES_DIR, folder);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Is this roster row part of "the bench" — the thing a snapshot is *of*?
 *
 * Your own sessions are, and so is a team lead: you opened them, and after a reboot you
 * want them back where they were. A **worker** is not. A worker exists because a lead
 * dispatched it against a task, in a worktree the panel created and will delete at close;
 * putting one back is the queue argument again, one level up. A relaunched worker gets no
 * worker brief, no `foreman` tools and no worker settings, and it comes up joined to a task
 * record that still says `working` — so the rail draws `worker · agent/<id>` under it and
 * the lead's `worker_read` reads a session that has never heard of the task. Half the time
 * its worktree has been swept and the launch just fails.
 *
 * Both halves are needed. `team.role` is the live join on an *open* task, which is the
 * honest answer while a task is running; the folder test catches the row whose task closed
 * under it, still sitting in a checkout that is on its way to being deleted.
 *
 * The role test is an **allow-list** — no team, or `lead` — rather than "not a worker", and
 * that is the whole point of writing it this way round. Task kinds already grew once (a
 * planner is a `kind: 'plan'` task, and `sessions.js` calls it a `worker` like any other);
 * the day one of them gets a role of its own, a "not a worker" test would start quietly
 * saving it, and the failure looks like a working snapshot until you restore.
 */
const isBenchRow = (s) => {
  if (!s) return false;
  const role = s.team?.role ?? null;
  return (role === null || role === 'lead') && !underWorktrees(s.paneCwd);
};

/**
 * The rows that make a relaunch refuse — every live worker, by both of the tests above.
 *
 * "Relaunch all" is the one control here that ends sessions it did not start, so it takes
 * the strictest reading of who is on the bench: not "leave the workers alone", but "not
 * while there are any". A worker cannot be put back — `restoreSessions` has no path to a
 * worker brief, the `foreman` tools or the worker settings, and by design never will — so a
 * relaunch that ran anyway would have to either kill one and leave it dead, or step around
 * it and leave a worker on the old Claude Code build, which is the one thing the button
 * exists to prevent. The maintainer's own answer was that they would only press this when
 * the machine is quiet; the refusal is here because every other destructive path in this
 * panel refuses rather than trusting, and because "quiet" is a thing they would have to
 * remember.
 *
 * Returns the rows rather than a boolean so the refusal can name them. A message that says
 * *which* worker is still running is one you can act on; "there are workers" is one you
 * have to go and look up.
 */
export const liveWorkers = (sessions = []) => (sessions || []).filter((s) => s && !isBenchRow(s));

/**
 * A Claude Code session id, as `--resume` will accept one.
 *
 * Anchored and shape-checked rather than passed straight through, because the roster's
 * `id` is two different things: the transcript's own `sessionId` for a bound row, and the
 * synthetic `pane-19` spelling for a pane the panel could not bind to a history. Handing
 * the second to `--resume` would start a session that fails at launch — and worse, fails
 * *after* the old one has already been exited.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a relaunch is about to end and start again.
 *
 * The same rows a snapshot would save — this calls `benchEntries` rather than filtering
 * again, because the property that matters is that the two agree about workers, and two
 * filters written to the same rule are two filters that can drift apart. What it adds is
 * the two things the *live* operation needs and a saved one never could: the pane, which
 * is what `/exit` is typed into and what has to be re-read for a box first, and the session
 * id to resume.
 *
 * Nothing here is written to `snapshot.json`, and that is deliberate rather than an
 * oversight. A relaunch is about the sessions running right now; a session id saved on
 * Tuesday and restored after Friday's reboot would resume a conversation whose pane has
 * been gone for days, which is the argument the snapshot already makes about the queue one
 * level up. `SnapshotStore` is untouched by any of this, including the slot the
 * maintainer's own saved bench lives in — a relaunch must not spend it.
 *
 * `resume` is per-entry, not a mode the loop carries, because it is genuinely per-entry:
 * an unbound pane has no history to come back with, and the honest answer for that row is
 * a fresh session rather than a failed launch.
 *
 * @param {Array<object>} sessions the live roster
 * @param {{resume?: boolean}} [opts] whether to bring histories back
 */
export function relaunchEntries(sessions = [], { resume = false } = {}) {
  const live = new Map();
  for (const s of sessions || []) if (s?.tmuxSession) live.set(s.tmuxSession, s);

  return benchEntries(sessions).map((entry) => {
    const s = entry.tmuxSession ? live.get(entry.tmuxSession) : null;
    // `transcriptPath` is the witness that this row has a history at all; the id shape is
    // the witness that what we hold is a session id rather than a `pane-19`. Both, because
    // either alone has been wrong in this file's history.
    const id = s?.transcriptPath && SESSION_ID_RE.test(String(s.id || '')) ? s.id : null;
    return { ...entry, paneId: s?.paneId ?? null, resume: resume ? id : null };
  });
}

/**
 * The live roster, as the list of things worth putting back.
 *
 * `paneCwd`, never `cwd`: the transcript's `cwd` is rewritten when a session changes
 * directory mid-conversation, and relaunching into where a session wandered to would put
 * it under a different rail heading — and so out of the group you filed it under.
 */
export function benchEntries(sessions = []) {
  const out = [];
  for (const s of sessions) {
    const folder = s?.paneCwd;
    if (!folder) continue; // nothing to relaunch into
    if (!isBenchRow(s)) continue;
    out.push({
      folder,
      slug: slugFor(s.tmuxSession, folder),
      tmuxSession: s.tmuxSession || null,
      // What the pane says now, not what the process was launched with — the mode line is
      // the live answer, and the two only ever differ if you cycled out of it.
      skipPermissions: Boolean(s.bypass),
      pinned: Boolean(s.pinned),
    });
  }
  return out;
}

/**
 * Was this saved entry a team lead?
 *
 * Read off the **slug**, not off a flag added to the file, and that is the deliberate
 * choice rather than the lazy one. `isLeadName` is already the whole panel's answer to
 * "is this a lead" — it is what puts the chip and the task count on the rail row — so
 * asking it here means the restore cannot disagree with the screen. A second field could,
 * and the failure it would cause is the one this exists to fix: an entry marked
 * `lead: false` whose slug is `lead` comes back as an ordinary session still wearing the
 * badge, with no brief, no `foreman` tools and no permission stance.
 *
 * It also means there is nothing to migrate. A `snapshot.json` written before any of this
 * already carries `slug: "lead"`, because `save` has always computed the slug, so an old
 * file restores its lead correctly on the first press.
 *
 * The stored slug is what `save` computed at the time; the session name is the fallback,
 * for a file hand-edited to carry one without the other.
 */
export const isLeadEntry = (entry) =>
  entry?.slug === 'lead' || (!entry?.slug && isLeadName(entry?.tmuxSession, entry?.folder));

/**
 * Put the bench back, one session at a time.
 *
 * Serially, because each launch blocks for up to six seconds waiting for claude to come up
 * and then opens a Terminal window — a dozen at once is a thundering herd against one tmux
 * server. That makes the request a minute long, so each entry reports itself through
 * `onStep` as it resolves rather than leaving a spinner to look hung. One entry failing
 * takes only itself down: a folder renamed since the save shouldn't cost you the other
 * eleven.
 *
 * The two launchers are injected, and their *shapes* are the point, not the testability.
 * `startLead` takes positional arguments and no options object, so a saved
 * `skipPermissions` has no argument to ride in on — a bypass lead is not a thing, and the
 * way to keep it not a thing is to leave the restore path no door for it. `resume` is the
 * second positional for exactly that reason: an options bag would be a general channel
 * from a stored entry to the lead's launch flags, and this is not one.
 *
 * `entry.resume` is only ever set by `relaunchEntries` — a snapshot read off disk carries
 * no such field, so restoring the saved bench stays what it has always been: fresh
 * sessions, no history, as `SnapshotStore` documents at the top of this file.
 *
 * @param {Array<object>} entries        what was saved
 * @param {object}  deps
 * @param {string[]} deps.liveNames      tmux sessions already up; those entries are skipped
 * @param {(o: object) => Promise<object>} deps.startSession  ordinary launch
 * @param {(folder: string, resume: string|null) => Promise<object>} deps.startLead  the lead launch
 * @param {(step: object, entry: object) => void} [deps.onStep] per-entry progress
 */
export async function restoreSessions(
  entries = [],
  { liveNames = [], startSession, startLead, onStep = () => {} } = {},
) {
  // Names already up are skipped rather than started. Without this a second press would
  // find every name taken and `uniqueSessionName` would obligingly mint `-2`s; for a lead
  // it would instead hit the one-lead-per-project refusal, which reports as a failure when
  // the truth is "it is already there".
  const live = new Set(liveNames);
  const results = [];

  for (const entry of entries) {
    const lead = isLeadEntry(entry);
    const resume = typeof entry.resume === 'string' && entry.resume ? entry.resume : null;
    const step = {
      folder: entry.folder,
      slug: entry.slug,
      name: entry.tmuxSession,
      lead,
      resumed: Boolean(resume),
    };
    let done;

    if (entry.tmuxSession && live.has(entry.tmuxSession)) {
      done = { ...step, state: 'skipped' };
    } else {
      try {
        const made = lead
          ? await startLead(entry.folder, resume)
          : await startSession({
              folder: entry.folder,
              label: entry.slug,
              skipPermissions: Boolean(entry.skipPermissions),
              resume,
            });
        if (made?.name) live.add(made.name);
        done = {
          ...step,
          name: made?.name ?? step.name,
          state: 'started',
          paneId: made?.paneId ?? null,
        };
      } catch (err) {
        done = { ...step, state: 'failed', error: err.message };
      }
    }

    results.push(done);
    onStep(done, entry);
  }

  return results;
}

export class SnapshotStore {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    this.file = file;
    this.snap = null; // { savedAt, sessions: [{ folder, slug, tmuxSession, skipPermissions, pinned }] }
    this.dirty = false;
    this.#load();

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw.savedAt !== 'number' || !Array.isArray(raw.sessions)) return;
      const sessions = raw.sessions
        .filter((e) => e && typeof e.folder === 'string' && e.folder)
        .map((e) => ({
          folder: e.folder,
          slug: typeof e.slug === 'string' && e.slug ? e.slug : null,
          tmuxSession: typeof e.tmuxSession === 'string' ? e.tmuxSession : null,
          skipPermissions: Boolean(e.skipPermissions),
          pinned: Boolean(e.pinned),
        }));
      this.snap = { savedAt: raw.savedAt, sessions };
    } catch {
      /* first run, or hand-edited into nonsense — start clean */
    }
  }

  #flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (this.snap) fs.writeFileSync(this.file, JSON.stringify(this.snap, null, 2));
      else fs.rmSync(this.file, { force: true });
    } catch {
      /* best-effort */
    }
  }

  /** Write now rather than waiting for the next tick (tests, shutdown). */
  flush() {
    this.#flush();
  }

  /** A copy, so callers can't reach in and edit what's saved. */
  get() {
    if (!this.snap) return null;
    return { savedAt: this.snap.savedAt, sessions: this.snap.sessions.map((e) => ({ ...e })) };
  }

  /** Replaces the slot wholesale — there is only one, and saving again means "like this". */
  save(entries, now = Date.now()) {
    this.snap = {
      savedAt: now,
      sessions: entries
        .filter((e) => e && e.folder)
        .map((e) => ({
          folder: e.folder,
          slug: e.slug || null,
          tmuxSession: e.tmuxSession || null,
          skipPermissions: Boolean(e.skipPermissions),
          pinned: Boolean(e.pinned),
        })),
    };
    this.dirty = true;
    return this.get();
  }

  clear() {
    if (!this.snap) return false;
    this.snap = null;
    this.dirty = true;
    return true;
  }

  /**
   * How far the bench has wandered from what's saved, by tmux session name.
   *
   * `missing` is saved-but-not-running, `extra` is running-but-not-saved. Both are what a
   * save-once snapshot goes quietly stale *as*, which is why the rail wears a dot for it:
   * a snapshot you last touched before adding two projects is worth knowing about the day
   * before the reboot, not the morning after.
   *
   * Nothing saved is not drift. There is no promise yet to have broken.
   *
   * @param {Array<{tmuxSession?: string|null}>} sessions the live roster
   */
  drift(sessions = []) {
    if (!this.snap) return { missing: [], extra: [] };
    // Filtered the same way `benchEntries` filters, or every dispatched worker reads as
    // `extra` and the rail's drift dot stays lit for as long as a team is working — which
    // would turn "your snapshot has gone stale" into background noise exactly when the
    // panel is busiest.
    const live = new Set(sessions.filter(isBenchRow).map((s) => s.tmuxSession).filter(Boolean));
    const saved = new Set(this.snap.sessions.map((e) => e.tmuxSession).filter(Boolean));
    return {
      missing: [...saved].filter((name) => !live.has(name)),
      extra: [...live].filter((name) => !saved.has(name)),
    };
  }

  stop() {
    clearInterval(this.timer);
    this.#flush();
  }
}
