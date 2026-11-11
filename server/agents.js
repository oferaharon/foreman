import fs from 'node:fs';
import readline from 'node:readline';
import { normalizeRecord } from './normalize.js';

/**
 * A session's subagents — the ones running now and the ones that ran earlier — for the
 * background line above the composer, which unfolds into a list of them.
 *
 * Two sources, and neither is enough alone:
 *
 * - **Running** is what Claude Code draws *below* its composer while subagents run: one
 *   `◯ <type>  <title>  12s · ↓ 37.3k tokens` row each, at most five, then `↓ N more`
 *   (`stripAgentPanel` in `tmux.js`). It is the only place the elapsed time and the token
 *   count exist, and the only honest answer to "is it still running" — the mode line's
 *   `← N agents` is not one (it counts every agent the session has had, finished ones
 *   included; seen reading `← 2 agents` on a fresh session, and with nothing running).
 * - **Earlier** is the session's own transcript. Every Agent call is a `tool_use` carrying
 *   the `description` and `subagent_type` it was given, and its record's timestamp is when
 *   it started. MEASURED on v2.1.322 in the sandbox: every call now comes back at once as
 *   `status: 'async_launched'` with an `agentId`, **including one asked to run in the
 *   foreground**, and finishing arrives later as a task notification whose `<task-id>` is
 *   that `agentId` and whose `<tool-use-id>` is the call's own id — usually. One notice in
 *   the measurement carried no `<tool-use-id>`, so a notice is matched on either. Older
 *   transcripts answer a call synchronously with a result that is itself the end of the run,
 *   and that shape is read too.
 *
 * The join between them is the title first and the numbers second.
 *
 * **The title is not always the description — MEASURED on v2.1.322.** A row's title is the
 * call's `description` (cut with `…` when the pane is narrow) until the subagent has been at
 * work a while, and then it can become a progress summary — `Waiting out 100-second sleep`
 * for a call described as `Count test files`. That summary is written **nowhere on disk**:
 * not in the session's transcript, not in the subagent's own (`subagents/agent-<id>.jsonl`,
 * whose tool calls were described `Wait 100 seconds`), not in its output file. So a title is
 * matched — whole, or as a prefix when it ends in `…` — and when it matches nothing, the
 * numbers are asked instead. Every notice carries `<usage>`: `<subagent_tokens>` and
 * `<duration_ms>`, the run's totals when it stopped, and those are exactly the two numbers
 * the row draws (34614 → `34.6k tokens`, 143365 ms → `2m 23s`, measured on the same run).
 * They only ever grow, so a run whose last notice already has *more* tokens or time than a
 * row shows cannot be that row; one whose numbers equal the row's is a run waiting on its
 * own background work, which is the state the summary titles appear in. A row is joined on
 * the numbers only when exactly one run fits; otherwise it is listed with nothing to jump
 * to, and every run that *might* be it is kept out of "earlier" — a running agent filed as
 * finished is the misfile this list must never make, and was the first thing the bench
 * caught. The summary's own wording (`is waiting on its own background work` against
 * `finished`) would settle it and is deliberately not read: it is Claude Code's prose, and
 * `parseTaskNotice` reads tags.
 *
 * "Last active" is the latest record about the run in this transcript: its launch result,
 * and every notice since (a run that stopped with background work of its own still going
 * notifies again when that work ends). Nothing here reads the subagent's own transcript —
 * a stat would make the pure part impure for one timestamp, and the notice lands when the
 * run stops, which is the moment this field is about.
 *
 * Pure apart from `scanAgents`, which is the streaming read. The panel never loads a
 * transcript whole — the tailer reads a window, `probe` samples head and tail — so a list
 * built from what a browser has on screen would be a subset that looks complete; this is
 * `scanImages`'s whole-file pass for the same reason (`images.js`).
 */

const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * Fold normalized messages, oldest first, into one entry per Agent call.
 *
 * Sidechain messages are skipped: an agent a subagent starts is that subagent's business,
 * and the terminal's own panel lists only the session's own.
 *
 * @param {Iterable<object>} messages  output of `normalizeRecord`, in file order
 * @returns {AgentRun[]} in the order they were started
 *
 * @typedef {{
 *   toolUseId: string, agentId: string|null, name: string|null, type: string|null,
 *   startedAt: string|null, lastActiveAt: string|null, done: boolean, status: string|null,
 *   tokens: number|null, durationMs: number|null,
 * }} AgentRun
 */
export function collectAgents(messages) {
  const byTool = new Map();
  const byAgent = new Map();
  const touch = (run, ts) => {
    if (ts && (!run.lastActiveAt || ts > run.lastActiveAt)) run.lastActiveAt = ts;
  };

  for (const m of messages) {
    if (!m || m.sidechain) continue;
    if (m.kind === 'tool_use' && AGENT_TOOLS.has(m.name) && m.toolUseId) {
      const input = m.input && typeof m.input === 'object' ? m.input : {};
      byTool.set(m.toolUseId, {
        toolUseId: m.toolUseId,
        agentId: null,
        name: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null,
        type: typeof input.subagent_type === 'string' && input.subagent_type.trim() ? input.subagent_type.trim() : null,
        startedAt: m.ts || null,
        lastActiveAt: m.ts || null,
        done: false,
        status: null,
        // The totals from the latest notice's `<usage>`, for the numbers join in `agentList`.
        tokens: null,
        durationMs: null,
      });
    } else if (m.kind === 'tool_result' && byTool.has(m.toolUseId)) {
      const run = byTool.get(m.toolUseId);
      touch(run, m.ts);
      if (m.agent?.id) {
        run.agentId = m.agent.id;
        byAgent.set(m.agent.id, run);
      }
      const status = m.agent?.status || null;
      if (status === 'async_launched') continue;
      // A synchronous answer is the end of the run, and so is a refusal or an error.
      run.done = true;
      run.status = m.isError ? 'failed' : status || 'completed';
    } else if (m.kind === 'task_notification') {
      const run = (m.toolUseId && byTool.get(m.toolUseId)) || (m.taskId && byAgent.get(m.taskId)) || null;
      if (!run) continue;
      touch(run, m.ts);
      run.done = true;
      run.status = m.status || run.status || 'completed';
      if (Number.isFinite(m.tokens)) run.tokens = m.tokens;
      if (Number.isFinite(m.durationMs)) run.durationMs = m.durationMs;
    }
  }
  return [...byTool.values()];
}

/** Lines that cannot be about an Agent call never contain one of these. */
const HINTS = ['"Agent"', '"Task"', 'task-notification', 'agentId'];

/**
 * Every Agent call in the file, oldest first — the whole transcript, one streaming pass, and
 * only the lines that could matter are parsed.
 */
export async function scanAgents(file) {
  const started = process.hrtime.bigint();
  let read = 0;
  let parsed = 0;
  const messages = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    read += 1;
    if (!line || !HINTS.some((h) => line.includes(h))) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn write, or the last line of a file being appended to
    }
    parsed += 1;
    for (const m of normalizeRecord(rec)) {
      if (m.kind === 'tool_use' || m.kind === 'tool_result' || m.kind === 'task_notification') messages.push(m);
    }
  }
  return {
    runs: collectAgents(messages),
    scan: { lines: read, parsed, ms: Number(process.hrtime.bigint() - started) / 1e6 },
  };
}

/** A row's title against a call's description: whole, or a prefix the terminal cut with `…`. */
function titleMatches(title, name) {
  if (!title || !name) return false;
  if (title === name) return true;
  if (title.endsWith('…')) {
    const prefix = title.slice(0, -1).trimEnd();
    return prefix.length > 0 && name.startsWith(prefix);
  }
  return false;
}

/** `9s`, `4m 5s`, `1h 2m` → seconds; `null` for anything else. */
export function elapsedSeconds(text) {
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(String(text || '').trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/** `37.3k` → `[37250, 37350)`-ish as `{value, slack}`: the terminal rounds to one decimal. */
function tokenCount(text) {
  const m = /^([\d.]+)([kKmM]?)$/.exec(String(text || '').trim());
  if (!m) return null;
  const unit = /k/i.test(m[2]) ? 1e3 : /m/i.test(m[2]) ? 1e6 : 1;
  const decimals = (m[1].split('.')[1] || '').length;
  return { value: Number(m[1]) * unit, slack: (unit / 10 ** decimals) / 2 + 1 };
}

/**
 * Whether a run's last-notice totals could be this row's numbers: `'exact'` when both equal
 * the row (within the terminal's rounding), `'fits'` when neither exceeds it or either is
 * unknown, `null` when the run already had more than the row shows.
 */
function numbersFit(row, run) {
  const tok = tokenCount(row.tokens);
  const sec = elapsedSeconds(row.elapsed);
  const known = [];
  if (tok && run.tokens != null) {
    if (run.tokens > tok.value + tok.slack) return null;
    known.push(Math.abs(run.tokens - tok.value) <= tok.slack);
  }
  if (sec != null && run.durationMs != null) {
    const runSec = run.durationMs / 1000;
    if (runSec > sec + 1) return null;
    known.push(Math.abs(runSec - sec) <= 1);
  }
  return known.length === 2 && known.every(Boolean) ? 'exact' : 'fits';
}

/**
 * The list the line unfolds into: running rows joined to the calls they came from, and the
 * finished calls nothing on screen is running.
 *
 * `panel` is the scrape's `{rows, more}`, or `null` — no panel on screen (nothing running),
 * or a box hiding it. Either way nothing is called running, and only a call the transcript
 * says is finished is called earlier: one still in flight behind a box is neither, rather
 * than misfiled.
 *
 * A row claims at most one call and a call at most one row. Among several calls with the
 * same title, an unfinished one wins, then the most recently started — two runs of
 * "Sleep agent one" in one session are the case, and the live one is the newer.
 *
 * @returns {{
 *   running: Array<{ type: string, name: string|null, elapsed: string|null, tokens: string|null,
 *                    toolUseId: string|null, startedAt: string|null }>,
 *   more: number,
 *   earlier: AgentRun[],
 * }}
 */
export function agentList(runs, panel) {
  const claimed = new Set();
  const sameType = (row, r) => !row.type || !r.type || r.type === row.type;
  const rows = panel?.rows || [];

  // Pass 1, by title — every row before any row is tried on numbers, so a row whose title
  // does match is never beaten to its run by one that only fits.
  const hits = rows.map((row) => {
    const candidates = runs
      .filter((r) => !claimed.has(r) && sameType(row, r) && titleMatches(row.name, r.name))
      .sort((a, b) => Number(a.done) - Number(b.done) || String(b.startedAt).localeCompare(String(a.startedAt)));
    const hit = candidates[0] || null;
    if (hit) claimed.add(hit);
    return hit;
  });

  // Pass 2, by the numbers, for the rows whose title is a progress summary. One run that
  // fits is a join; several are a doubt, and a doubt keeps each of them out of "earlier".
  const maybe = new Set();
  rows.forEach((row, i) => {
    if (hits[i]) return;
    const fits = runs
      .filter((r) => !claimed.has(r) && sameType(row, r))
      .map((r) => ({ r, how: numbersFit(row, r) }))
      .filter((f) => f.how);
    const exact = fits.filter((f) => f.how === 'exact');
    const pick = exact.length === 1 ? exact[0].r : fits.length === 1 ? fits[0].r : null;
    if (pick) {
      claimed.add(pick);
      hits[i] = pick;
    } else for (const f of fits) maybe.add(f.r);
  });

  const running = rows.map((row, i) => {
    const hit = hits[i];
    return {
      type: row.type,
      name: hit?.name || row.name,
      // What the terminal is saying the agent is doing, when that is not its description.
      activity: hit && row.name && !titleMatches(row.name, hit.name) ? row.name : null,
      elapsed: row.elapsed,
      tokens: row.tokens,
      toolUseId: hit?.toolUseId || null,
      startedAt: hit?.startedAt || null,
    };
  });
  const earlier = runs
    .filter((r) => !claimed.has(r) && !maybe.has(r) && r.done)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return { running, more: panel?.more || 0, earlier };
}
