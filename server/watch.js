import { humanName } from './human-name.js';

/**
 * The team watcher: worker status transitions worth a room line, and the nudge that
 * follows them. Nothing else wakes the lead, which is why this exists at all — the lead is
 * a Claude Code session, and a Claude Code session acts only when something gives it
 * input, so a worker finishing, blocking or posting to the room reaches it only because
 * the panel taps it on the shoulder through the queue, which already delivers one message
 * per idle window behind `claim()`. Without that a team goes quiet the moment the lead
 * ends its turn, browser open or not.
 *
 * Everything is injected and nothing happens on import, so tests can drive `tick`
 * directly with a stub registry and an injected clock. index.js owns the timers.
 */

export const NUDGE_MARK = '[room]';

/**
 * `human` is injected rather than imported for the same reason everything else here is:
 * nothing in this module may reach for the world on its own. It takes a repo, because the
 * name is per repo (`human-name.js`, off `git config user.name`), and its answer is
 * cached there — a room line composed on every tick must not shell out on every tick.
 */
export function createTeamWatch({ registry, tasks, room, queue, readTeam, human = humanName }) {
  const lastNudge = new Map(); // repo -> ts
  const seen = new Map(); // task id -> { status, since, notified }
  const streaks = new Map(); // task id -> { text, count, flagged }

  /**
   * Coalescing is the feature, not an optimisation: a burst of worker events while a
   * `[room]` nudge is already waiting must not become three nudges, or a busy team
   * spends its day telling the lead it is busy. One queued marker at a time, floor 60s
   * per team.
   */
  function nudgeLead(repo, { now = Date.now() } = {}) {
    const lead = registry.list().find((s) => s.isLead && s.paneCwd === repo);
    if (!lead?.paneId) return; // no lead running — the room still has the line for later
    if ((now - (lastNudge.get(repo) || 0)) < 60_000) return;
    if (queue.list(lead.paneId).some((item) => item.text.startsWith(NUDGE_MARK))) return;
    const { cursor } = room.read(repo, { since: 0, limit: 1 });
    try {
      queue.add(
        lead.paneId,
        `${NUDGE_MARK} New team events (cursor ${cursor}). Use room_read and team_status, act on what you can, and surface to ${human(repo)} only what needs them.`,
        { now },
      );
      lastNudge.set(repo, now);
    } catch {
      /* queue full — the lead already has plenty to read */
    }
  }

  function postSystem(repo, about, text, { now = Date.now(), alert = false } = {}) {
    try {
      const entry = { from: 'panel', to: 'lead', kind: 'system', about, text };
      if (alert) entry.alert = true; // stuck/loop lines — the room renders these loud
      room.post(repo, entry, { now });
    } catch {
      /* a room post must never take the poller down */
    }
    nudgeLead(repo, { now });
  }

  /**
   * Status transitions worth a system line, watched off the same roster the rail draws
   * from. Deliberately coarse: dispatched→working (it started), →blocked (the big one),
   * working→idle (probably finished), and nothing else.
   */
  function tick({ now = Date.now() } = {}) {
    const byTmux = new Map(registry.list().map((s) => [s.tmuxSession, s]));
    const stuckMsFor = new Map(); // repo -> threshold, read once per repo per tick
    const watched = new Set();
    for (const t of tasks.list()) {
      if (t.state !== 'dispatched' && t.state !== 'working' && t.state !== 'review') continue;
      watched.add(t.id);
      const live = t.tmuxSession ? byTmux.get(t.tmuxSession) : null;
      if (!live) continue;
      // "Blocked" is wider than one status — the CLAUDE.md rule about `/exit`'s guard,
      // and it bit here first: a question box reads as `dialog` with `question` set, a
      // trust-gate shape reads as `needs-decision` with nothing behind it. Collapse the
      // whole family into one word before comparing, or a worker on a question box never
      // produces a "blocked" line at all (measured — it didn't).
      const status =
        live.status === 'needs-decision' || live.question || live.plan || live.prompt
          ? 'blocked'
          : live.status;
      const rec = seen.get(t.id);
      if (rec && rec.status === status) {
        // Same status as last tick — the transition machinery has nothing to say, but
        // this is exactly where "stuck" lives: a worker that never changes state again
        // would otherwise never produce another line. Once per episode; a status change
        // replaces the record and re-arms.
        if (!stuckMsFor.has(t.repo)) {
          stuckMsFor.set(t.repo, (readTeam(t.repo)?.toggles?.stuckAfterMinutes ?? 20) * 60_000);
        }
        const stuckMs = stuckMsFor.get(t.repo);
        if (!rec.notified && now - rec.since > stuckMs) {
          if (status === 'blocked') {
            const what = live.question ? 'a question' : live.plan ? 'plan approval' : 'a permission prompt';
            rec.notified = true;
            postSystem(
              t.repo, t.id,
              `${who(t)} ${t.id} has been blocked on ${what} for ${Math.round((now - rec.since) / 60_000)} minutes. Surface this to ${human(t.repo)} even if you could answer it.`,
              { now, alert: true },
            );
          } else if (status === 'idle' && t.state !== 'review') {
            // Silent means silent: a room post since it went idle restarts the clock
            // instead of firing. Only read the room at a threshold crossing — rare.
            const last = room.readAll(t.repo).findLast((e) => e.from === t.id);
            if (last && last.ts > rec.since) {
              rec.since = last.ts;
            } else {
              rec.notified = true;
              postSystem(
                t.repo, t.id,
                `${who(t)} ${t.id} has been idle and silent for ${Math.round((now - rec.since) / 60_000)} minutes and its task is not in review. Poke it once with worker_send; if it stays silent, surface to ${human(t.repo)}.`,
                { now, alert: true },
              );
            }
          }
        }
        continue;
      }
      const prev = rec?.status;
      seen.set(t.id, { status, since: now, notified: false });
      // First sighting after a boot announces nothing — except a blocked worker, which is
      // never stale news: a server restart must not eat the one line the lead most needs.
      if (prev === undefined && status !== 'blocked') continue;

      if (status === 'blocked') {
        const what = live.question ? 'a question' : live.plan ? 'plan approval' : 'a permission prompt';
        postSystem(t.repo, t.id, `${who(t)} ${t.id} is blocked on ${what}.`, { now });
      } else if (prev === 'blocked') {
        postSystem(t.repo, t.id, `${who(t)} ${t.id} is unblocked and running again.`, { now });
      } else if (prev === 'working' && status === 'idle' && t.state !== 'review') {
        postSystem(t.repo, t.id, `${who(t)} ${t.id} went idle — possibly finished, and it has not reported. Check its tail.`, { now });
      } else if (t.state === 'dispatched' && status === 'working') {
        tasks.update(t.id, { state: 'working' }, { now });
        postSystem(t.repo, t.id, `${who(t)} ${t.id} started working.`, { now });
      }
    }
    // A task that left the watched states takes its records with it — the old string
    // map leaked task ids forever, harmlessly, but these records are bigger.
    for (const id of seen.keys()) if (!watched.has(id)) seen.delete(id);
    for (const id of streaks.keys()) if (!watched.has(id)) streaks.delete(id);
  }

  /**
   * A worker posting the same message over and over is the loop signature the spec
   * names — event-driven off the room itself, not the tick. The panel's own lines
   * never count: `from: 'panel'` fails the task lookup, which is also the recursion
   * guard for the flag line this posts.
   */
  /**
   * What to call the thing in a room line. A planner's rows read as a worker's
   * otherwise, and the two want different reactions from the lead — "went idle without
   * reporting" means a lost branch for one and a lost document for the other. Falls back
   * to Worker, which is what every task written before kinds existed is.
   */
  const who = (t) => (t?.kind === 'plan' ? 'Planner' : 'Worker');

  function onPost(repo, entry) {
    const from = entry?.from;
    if (!from || !entry.text || !tasks.get(from)) return;
    const text = String(entry.text).trim();
    const s = streaks.get(from);
    if (!s || s.text !== text) {
      streaks.set(from, { text, count: 1, flagged: false });
      return;
    }
    s.count += 1;
    if (s.count >= 3 && !s.flagged) {
      s.flagged = true;
      postSystem(
        repo, from,
        `${who(tasks.get(from))} ${from} has posted the same message ${s.count} times — it may be looping. Read its tail and decide; never /exit it without ${human(repo)}.`,
        { now: entry.ts || Date.now(), alert: true },
      );
    }
  }
  room.on('post', onPost);

  /** What the task list shows beside the roster join — `stuck` is watcher state. */
  function flags(taskId) {
    return { stuck: seen.get(taskId)?.notified === true };
  }

  function stop() {
    room.off('post', onPost);
  }

  return { tick, nudgeLead, postSystem, flags, stop };
}
