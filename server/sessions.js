import path from 'node:path';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PROJECTS_DIR, RECENT_WINDOW_MS, ROSTER_POLL_MS, SESSION_PREFIX } from './config.js';
import { listClaudePanes, readPaneState } from './tmux.js';
import { bindPanes, unboundReason } from './binding.js';
import { defaultSessionTitle } from './git.js';
import { shellConfigMtime } from './wrapper.js';
import { probe } from './transcript.js';
import { slugFor, isLeadName } from './launch.js';
import { OPEN_STATES } from './tasks.js';

/*
 * A lead is recognised by the naming contract, not by a stored flag — `isLeadName` in
 * `launch.js`, which is where the contract itself lives. It is the same function the
 * snapshot restores through, on purpose: two spellings of "is this a lead" could disagree,
 * and a row badged `lead` here but started as an ordinary session there is exactly the
 * shape of lie this panel exists to not tell.
 */

/**
 * The open task a tmux session is working, or `null`.
 *
 * The join is the task record's `tmuxSession`, which dispatch stamps on it — there is no
 * flag on the session itself, and there must not be one: a worker is a worker because a
 * ticket says so, and the ticket is the thing that closes.
 *
 * `OPEN_STATES` is the whole point. A session whose task is `done`, `failed` or
 * `abandoned` is an ordinary session again — it may still be sitting there with a
 * transcript worth reading, but the branch it once had is merged or swept and a row that
 * kept naming it would be pointing at nothing. In practice a closed task's session is
 * usually gone too; this is what makes the one that isn't behave.
 *
 * @param {Array<{tmuxSession?: string|null, state: string}>} tasks every task record
 * @param {string|null|undefined} tmuxSession the row's tmux session name
 */
export function openTaskFor(tasks, tmuxSession) {
  if (!tmuxSession) return null;
  for (const t of tasks || []) {
    if (t?.tmuxSession === tmuxSession && OPEN_STATES.has(t.state)) return t;
  }
  return null;
}

/** Queue identity for change detection — which items, and whether any failed. */
const queueSig = (items = []) => items.map((i) => `${i.id}:${i.error ? 1 : 0}`).join(',');

/**
 * The model and context percentage this pane last showed, remembered across the polls where
 * it shows neither.
 *
 * Both are scraped off the composer footer, and a session holding a question box, a
 * permission prompt or a picker has no composer footer to scrape — the same shape as
 * `bypass`, and the same rule: nothing on screen is not the same as nothing. Effort escapes
 * this by living on every assistant record in the transcript; these two have nowhere else
 * to come from.
 *
 * They move together because they share one line, so a footer drawn *without* a `ctx:` —
 * a session that has spent no context yet — clears the remembered percentage rather than
 * leaving a stale number beside a live model.
 *
 * Found the hard way: a session sat on an `AskUserQuestion` box for three hours and
 * reported no model for three hours, and the client's `shortModel` threw on it, unwinding
 * the composer build and taking the question card with it. The one session you could not
 * answer was the one asking you something. The guard there is the fix for the crash; this
 * is the fix for the emptiness.
 *
 * @param {Map<string, {model: string|null, contextPct: number|null}>} store per-pane memory
 */
export function rememberFooter(store, paneId, scrape) {
  if (scrape?.model) {
    store.set(paneId, { model: scrape.model, contextPct: scrape.contextPct ?? null });
  }
  return store.get(paneId) ?? { model: null, contextPct: null };
}

/**
 * The roster: every Claude Code session currently running in a tmux pane.
 *
 * Only running ones. A transcript whose terminal has closed is history, and the panel
 * is not a history browser — it showed those for a while behind a "show finished"
 * toggle, and all that produced was an inbox full of unread badges for conversations
 * nobody could reply to.
 */
export class SessionRegistry extends EventEmitter {
  constructor(statusEngine, readState, queue, pins, tasks = null) {
    super();
    this.status = statusEngine;
    this.read = readState;
    this.queue = queue;
    this.pins = pins;
    // The task store, for one decoration: a row whose tmux session belongs to a task is
    // a *worker*, and `workerOf` carries its repo so the rail can nest it under the
    // lead. The mapping comes from the store, never from paths — a worktree's cwd tells
    // you nothing reliable about who dispatched it.
    this.tasks = tasks;
    this.probeCache = new Map(); // path -> { mtime, meta }
    this.replyLog = new Map(); // sessionId -> sorted reply timestamps
    this.sessions = new Map(); // sessionId -> session
    this.lastBinding = new Map(); // paneId -> {sessionId, confidence}, so a binding survives a sibling
    // paneId -> whether permission prompts are off. Remembered rather than recomputed
    // because the mode line it is read from is not on screen while a permission box or a
    // dialog owns the footer, and a session must not stop looking dangerous for the
    // handful of polls it spends asking you something.
    this.bypassing = new Map();
    // paneId -> the last footer this pane actually drew, for the same reason and with the
    // same rule: model and `ctx:` are scraped off the composer footer, and a session
    // holding a question box has no footer to scrape. Effort escapes this by living in
    // the transcript; these two have nowhere else to come from.
    this.footers = new Map();
    // Set by index.js once the team watcher exists — the watcher takes the registry, so
    // it cannot be handed over at construction. Null until then, and a null reads as
    // "not stuck", which is the safe direction: a row nobody has judged yet is quiet.
    this.stuckFor = null;
    this.timer = null;
  }

  start() {
    const tick = async () => {
      try {
        await this.refresh();
      } catch (err) {
        this.emit('error', err);
      }
    };
    tick();
    this.timer = setInterval(tick, ROSTER_POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => {
      // Pinned rows come first and stay in the order they were pinned, because a pin is
      // a request for a fixed place to look — one that re-sorted itself every time the
      // session went quiet would be no better than the rail underneath it.
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return (a.pinnedAt || 0) - (b.pinnedAt || 0);

      // Blocked first, then replied-and-unread, then everything else by recency.
      const rank = (s) => {
        // An open question is as blocking as a permission box — Claude has stopped and
        // is waiting on you. It only reads as `dialog` because that's about whether the
        // pane can be *typed into*, which is a different question from whether it wants
        // something from you.
        if (s.status === 'needs-decision' || s.question) return 0;
        if (s.needsYou) return 1;
        return 2;
      };
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /** Find the session currently occupying a pane. */
  byPane(paneId) {
    for (const s of this.sessions.values()) if (s.paneId === paneId) return s;
    return null;
  }

  /**
   * What part this row plays on a team, or `null` for the ordinary sessions that are most
   * of the rail.
   *
   * Lead first, deliberately: the naming contract is the lead's identity and no task
   * record should ever be able to argue with it. `isLead` and `workerOf` are both read
   * back off this one answer, so the rail cannot be told a row is a worker in one field
   * and something else in another.
   */
  #team(tmuxSession, cwd) {
    const all = this.tasks ? this.tasks.list() : [];
    if (isLeadName(tmuxSession, cwd)) {
      const teamTasks = all.filter((t) => t.repo === cwd);
      return {
        role: 'lead',
        tasks: teamTasks.filter((t) => OPEN_STATES.has(t.state)).length,
        // A task in `review` is business for the maintainer — the lead still has to open
        // the PR, or it has and the PR is waiting on their merge word — and nothing in the
        // rail said so before this: `needsYou` measures the panel viewer's own read state,
        // not whether the team has anything for them. This is the fact that does.
        review: teamTasks.filter((t) => t.state === 'review').length,
      };
    }
    const task = openTaskFor(all, tmuxSession);
    if (!task) return null;
    // `stuck` is the watcher's, not the store's — it is elapsed time since the task last
    // changed state, and it rides here rather than in a field of its own for the reason
    // the two above do: the rail must not be able to be told a row is a worker in one
    // place and something else in another. `team` is already in `#diff`, so a worker
    // going stuck repaints its row and its lead's on the next poll and nothing else.
    return {
      role: 'worker',
      repo: task.repo,
      task: task.id,
      branch: task.branch || null,
      state: task.state,
      stuck: this.stuckFor ? Boolean(this.stuckFor(task.id)) : false,
    };
  }

  async #scanTranscripts() {
    let projectDirs;
    try {
      projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return [];
    }

    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const candidates = [];

    await Promise.all(
      projectDirs
        .filter((d) => d.isDirectory())
        .map(async (d) => {
          const dir = path.join(PROJECTS_DIR, d.name);
          let entries;
          try {
            entries = await fsp.readdir(dir);
          } catch {
            return;
          }
          for (const name of entries) {
            if (!name.endsWith('.jsonl')) continue;
            const file = path.join(dir, name);
            let stat;
            try {
              stat = await fsp.stat(file);
            } catch {
              continue;
            }
            if (stat.mtimeMs < cutoff) continue;
            if (stat.size === 0) continue;
            candidates.push({ file, mtime: stat.mtimeMs });
          }
        }),
    );

    const metas = await Promise.all(
      candidates.map(async ({ file, mtime }) => {
        const cached = this.probeCache.get(file);
        if (cached && cached.mtime === mtime) return cached.meta;
        const meta = await probe(file);
        if (meta) this.probeCache.set(file, { mtime, meta });
        return meta;
      }),
    );

    // Drop cache entries for files that aged out of the window.
    const live = new Set(candidates.map((c) => c.file));
    for (const key of this.probeCache.keys()) if (!live.has(key)) this.probeCache.delete(key);

    return metas.filter((m) => m && m.sessionId);
  }

  /**
   * Remember every reply we've seen, rather than trusting one probe.
   *
   * `probe` only samples the file's head and tail. A session that runs a long burst of
   * tool calls pushes its earlier text replies out of that window, and recomputing from
   * the window alone would silently drop unread back to zero. Polling is frequent enough
   * to catch each reply as it lands, so accumulating is both cheap and accurate.
   */
  #mergeReplies(sessionId, times) {
    const prev = this.replyLog.get(sessionId) || [];
    if (!times.length) return prev;

    const merged = prev.length ? [...new Set([...prev, ...times])].sort() : times.slice();
    // Bounded: nobody needs a count past a few hundred unread.
    const capped = merged.length > 300 ? merged.slice(-300) : merged;
    this.replyLog.set(sessionId, capped);
    return capped;
  }

  /** What's waiting to be typed into a pane. Rides along on the session so the panel
   *  learns about it from the same broadcast that carries status. */
  #queued(paneId) {
    if (!paneId || !this.queue) return [];
    return this.queue.list(paneId);
  }

  /**
   * Whether this pane is running with permission prompts off.
   *
   * `seen` is `null` on the polls where the mode line isn't drawn — a permission box or a
   * dialog has the footer — so the last real answer stands. Unknown reads as `false`:
   * a session is not called dangerous until the pane has said so.
   */
  #bypass(paneId, seen) {
    if (seen != null) this.bypassing.set(paneId, seen);
    return this.bypassing.get(paneId) ?? false;
  }


  async refresh() {
    const [metas, panes] = await Promise.all([this.#scanTranscripts(), listClaudePanes()]);

    // Drop queues for panes that are gone, before anything reads one — but never on an
    // empty roster. `tmux` returns nothing at all when its server is down or hiccups, and
    // reading that as "every pane closed" would throw away everything typed ahead.
    if (panes.length) {
      const live = new Map(panes.map((p) => [p.paneId, p.createdMs || null]));
      this.queue?.prune(live);
      this.pins?.prune(live);
      for (const paneId of this.bypassing.keys()) {
        if (!live.has(paneId)) this.bypassing.delete(paneId);
      }
      for (const paneId of this.footers.keys()) {
        if (!live.has(paneId)) this.footers.delete(paneId);
      }
    }

    // Latest file wins if a session id somehow appears twice.
    const bySession = new Map();
    for (const m of metas) {
      const prev = bySession.get(m.sessionId);
      if (!prev || m.mtime > prev.mtime) bySession.set(m.sessionId, m);
    }

    // What the shell wrapper would have named each of these by default. A title equal
    // to it carries no ownership information — see binding.js.
    const wrapperAt = await shellConfigMtime();
    await Promise.all(
      panes.map(async (p) => {
        p.defaultTitle = await defaultSessionTitle(p.cwd);
        // Launched after the shell last changed, so it stamps its own label.
        p.modernNamer = Boolean(p.createdMs && wrapperAt && p.createdMs > wrapperAt);
      }),
    );

    const { bound: paneOf, unbound: unboundPanes } = bindPanes({
      panes,
      metas: [...bySession.values()],
      hookBindingFor: (paneId) => this.status.paneBinding(paneId),
      rememberedFor: (paneId) => this.lastBinding.get(paneId) || null,
    });

    this.lastBinding = new Map(
      [...paneOf].map(([sid, b]) => [b.pane.paneId, { sessionId: sid, confidence: b.confidence }]),
    );

    // Every pane gets read, not just the hook-less ones. Hooks can report a session
    // as "working" while a permission box is actually up — PreToolUse fires, then the
    // tool blocks — and only the pane carries the box and its options.
    const scraped = new Map();
    await Promise.all(
      [...paneOf.entries()].map(async ([sid, bind]) => {
        scraped.set(sid, await readPaneState(bind.pane.paneId));
      }),
    );

    const next = new Map();
    for (const meta of bySession.values()) {
      const bind = paneOf.get(meta.sessionId);

      // No pane, no session. A transcript whose terminal is gone is a file, not something
      // you can read status from or reply to — and it used to arrive in the inbox with an
      // unread badge you could do nothing about. The panel is for sessions that are still
      // running; finished ones are `claude --resume`'s business.
      if (!bind) continue;

      // Grouped by where the session was *launched*, not where it has wandered to. A
      // session that changes directory mid-conversation would otherwise hop out of the
      // rail heading — and out of whatever group you filed that heading under — while you
      // were reading it. `cwd` below still reports where it actually is, which is what
      // `@` completion and the command list need.
      const project = path.basename(bind.pane.cwd || meta.cwd || '') || 'unknown';

      // Sessions minted here are named `<prefix><folder>-<label>`, and that label is the
      // name you actually gave the session. It beats the transcript's own title, which is
      // `<repo>-<branch>` and so reads identically for two sessions working the same
      // branch. The prefix is `SESSION_PREFIX` — the configured one, and the only one:
      // a session named under any other prefix has no label here and falls back to the
      // title, which is the honest answer for a session this panel did not name.
      const tmuxName = bind.pane.tmuxSession || '';
      const label = tmuxName.startsWith(SESSION_PREFIX) ? tmuxName.slice(SESSION_PREFIX.length) : null;
      const hooked = this.status.stateOf(meta.sessionId);
      const scrape = scraped.get(meta.sessionId);

      // Precedence: what is on screen right now is ground truth, then the hook, then
      // whatever else the pane looked like.
      //
      // A permission box and a `/model`-style dialog both outrank the hook, and for the
      // same reason: the hook happily says `idle` while one is open — nothing is running,
      // after all — and a message sent on that word lands in the box.
      // A plan approval is the same case again, and the sharpest of the three: the run has
      // genuinely stopped, so `Stop` has fired and the hook is honestly reporting `idle`
      // while the terminal holds a box whose first option can turn permission prompts off.
      let status;
      if (scrape?.prompt || scrape?.plan) status = 'needs-decision';
      else if (scrape?.state === 'dialog') status = 'dialog';
      else status = hooked === 'unknown' ? (scrape?.state ?? 'unknown') : hooked;

      const footer = rememberFooter(this.footers, bind.pane.paneId, scrape);

      // Anything already on disk the first time we meet a session counts as read.
      this.read.ensureBaseline(meta.sessionId, meta.lastTs || new Date().toISOString());
      const watermark = this.read.get(meta.sessionId);
      const replies = this.#mergeReplies(meta.sessionId, meta.replyTimes);
      const unread = replies.filter((t) => t > watermark).length;
      const lastReply = replies.at(-1) || null;
      const team = this.#team(bind.pane.tmuxSession, bind.pane.cwd);

      next.set(meta.sessionId, {
        id: meta.sessionId,
        title: label || meta.title || project,
        label,
        project,
        cwd: meta.cwd,
        // Where the *pane* is, which is where the session was launched. `cwd` above is the
        // transcript's, and Claude Code rewrites that when a session changes directory
        // mid-conversation — so it is the wrong thing to relaunch into. `project` is this
        // one's basename, and the snapshot wants the whole path.
        paneCwd: bind.pane.cwd || null,
        gitBranch: meta.gitBranch,
        transcriptPath: meta.path,
        size: meta.size,
        paneId: bind.pane.paneId,
        tmuxSession: bind.pane.tmuxSession,
        // Whether a Terminal window is attached *now*. A session started without one — or
        // one whose window you have since closed — is invisible on the desktop, so the
        // header offers to open one. Read live off tmux, never inferred from the launch.
        attached: Boolean(bind.pane.attached),
        binding: bind.confidence,
        interactive: true,
        status,
        statusSource: scrape?.prompt
          ? 'prompt'
          : scrape?.plan
            ? 'plan'
            : scrape?.state === 'dialog'
            ? 'dialog'
            : hooked === 'unknown' && scrape
              ? 'pane'
              : 'hook',
        prompt: scrape?.prompt || null,
        dialog: scrape?.dialog || null,
        plan: scrape?.plan || null,
        question: scrape?.question || null,
        model: footer.model,
        contextPct: footer.contextPct,
        effort: meta.effort || scrape?.effort || null,
        activity: scrape?.state === 'working' ? scrape.activity : null,
        activitySeconds: scrape?.state === 'working' ? scrape.activitySeconds ?? null : null,
        mode: scrape?.mode || null,
        bypass: this.#bypass(bind.pane.paneId, scrape?.bypass ?? null),
        unread,
        lastReply,
        queued: this.#queued(bind.pane.paneId),
        pinned: Boolean(this.pins?.has(bind.pane.paneId)),
        pinnedAt: this.pins?.at(bind.pane.paneId) ?? null,
        // One answer, three fields: `isLead` and `workerOf` are what the rail already
        // nests and badges by, `team` is what the row's third line reads.
        isLead: team?.role === 'lead',
        workerOf: team?.role === 'worker' ? team.repo : null,
        team,
        // The inbox: blocked on you, or it replied and you haven't looked. A question
        // Claude is asking counts as blocked — it cannot go on without an answer.
        needsYou:
          status === 'needs-decision' ||
          Boolean(scrape?.plan) ||
          Boolean(scrape?.question) ||
          (unread > 0 && status !== 'working'),
        lastActivity: meta.lastTs ? Date.parse(meta.lastTs) : meta.mtime,
      });
    }

    // A pane with no transcript is a session you just opened and haven't spoken to.
    // It belongs in the rail — it's the one you're about to type into — but it must
    // not borrow someone else's history to get there.
    for (const pane of unboundPanes) {
      // tmux pane ids look like `%19`, and a `%` in a URL path is read as a
      // percent-escape, so the id has to survive routing without it.
      const id = `pane-${pane.paneId.replace('%', '')}`;
      const project = pane.cwd ? path.basename(pane.cwd) : 'unknown';
      const scrape = await readPaneState(pane.paneId);
      const reason = unboundReason(pane, [...bySession.values()]);
      const footer = rememberFooter(this.footers, pane.paneId, scrape);
      const team = this.#team(pane.tmuxSession, pane.cwd);

      next.set(id, {
        id,
        title: pane.label || project,
        label: pane.label,
        project,
        cwd: pane.cwd,
        paneCwd: pane.cwd || null,
        gitBranch: null,
        transcriptPath: null,
        size: 0,
        paneId: pane.paneId,
        tmuxSession: pane.tmuxSession,
        attached: Boolean(pane.attached),
        binding: 'pane-only',
        paneOnlyReason: reason,
        interactive: true,
        status: scrape.prompt || scrape.plan ? 'needs-decision' : scrape.state,
        statusSource: 'pane',
        prompt: scrape.prompt || null,
        dialog: scrape.dialog || null,
        plan: scrape.plan || null,
        question: scrape.question || null,
        model: footer.model,
        contextPct: footer.contextPct,
        effort: scrape.effort || null,
        activity: scrape.state === 'working' ? scrape.activity : null,
        activitySeconds: scrape.state === 'working' ? scrape.activitySeconds ?? null : null,
        mode: scrape.mode || null,
        bypass: this.#bypass(pane.paneId, scrape.bypass ?? null),
        unread: 0,
        lastReply: null,
        queued: this.#queued(pane.paneId),
        pinned: Boolean(this.pins?.has(pane.paneId)),
        pinnedAt: this.pins?.at(pane.paneId) ?? null,
        isLead: team?.role === 'lead',
        workerOf: team?.role === 'worker' ? team.repo : null,
        team,
        needsYou: Boolean(scrape.prompt) || Boolean(scrape.plan) || Boolean(scrape.question),
        lastActivity: pane.createdMs || Date.now(),
      });
    }

    const liveIds = new Set(next.keys());
    this.read.prune(liveIds);
    for (const id of this.replyLog.keys()) if (!liveIds.has(id)) this.replyLog.delete(id);

    const changed = this.#diff(next);
    this.sessions = next;
    if (changed) this.emit('update', this.list());
    // Every poll, changed or not: the queue flusher needs a heartbeat, not an edge —
    // a message in backoff has to be retried while nothing else about the roster moves.
    this.emit('tick', this.list());
  }

  #diff(next) {
    if (next.size !== this.sessions.size) return true;
    for (const [id, s] of next) {
      const prev = this.sessions.get(id);
      if (!prev) return true;
      if (
        prev.status !== s.status ||
        prev.paneId !== s.paneId ||
        prev.title !== s.title ||
        prev.binding !== s.binding ||
        prev.activity !== s.activity ||
        prev.activitySeconds !== s.activitySeconds ||
        prev.mode !== s.mode ||
        prev.unread !== s.unread ||
        prev.needsYou !== s.needsYou ||
        prev.pinned !== s.pinned ||
        prev.dialog !== s.dialog ||
        JSON.stringify(prev.question) !== JSON.stringify(s.question) ||
        queueSig(prev.queued) !== queueSig(s.queued) ||
        JSON.stringify(prev.prompt) !== JSON.stringify(s.prompt) ||
        prev.contextPct !== s.contextPct ||
        prev.effort !== s.effort ||
        prev.lastActivity !== s.lastActivity ||
        // A task closing, or a lead's count moving, changes the row's third line and
        // nothing else on it — without this the rail would go on naming a dead ticket
        // until some unrelated field happened to move.
        JSON.stringify(prev.team) !== JSON.stringify(s.team) ||
        prev.transcriptPath !== s.transcriptPath
      ) {
        return true;
      }
    }
    return false;
  }
}
