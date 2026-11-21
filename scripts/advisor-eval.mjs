#!/usr/bin/env node
/*
 * advisor-eval.mjs — score the model advisor (`server/advisor.js`) against what actually
 * happened. Code in the repo, data never: everything it reads and writes lives under the
 * state dir, and the one page it writes for a human names no project, no task and no brief.
 *
 *   node scripts/advisor-eval.mjs replay [options]   run the advisor over every past brief
 *   node scripts/advisor-eval.mjs report [options]   re-render summary.md from rows.jsonl
 *   node scripts/advisor-eval.mjs live   [options]   score live advice (stage 2) per team
 *
 * Options:
 *   --state-dir DIR    the panel's state dir (default $FOREMAN_STATE_DIR, else ~/.foreman).
 *                      Read only, except STATE_DIR/advisor/ (the calls' empty cwd) and
 *                      STATE_DIR/advisor-eval/ (the results).
 *   --out DIR          results folder (default STATE_DIR/advisor-eval/<today>)
 *   --claude BIN       the claude binary (default `claude` on PATH)
 *   --projects DIR     transcripts root for the rail check (default ~/.claude/projects)
 *   --concurrency N    calls at a time (default 3)
 *   --limit N          only the newest N tasks (a smoke run)
 *   --no-second-model  skip the Haiku comparison on the held-out set
 *   --budget N         stop when projected total input tokens pass N (default 20000000)
 *   --timeout MS       per call (default 120000)
 *
 * **Resumable**: every finished call is appended to rows.jsonl at once, and a rerun with the
 * same --out skips what is already there. **What reaches a human** — stdout and summary.md —
 * is counts only, repos as six-hex hashes; repo-key.json beside them maps each hash back to
 * its path, for the maintainer's own reading, and must never be pasted anywhere.
 *
 * Every call goes through server/advisor.js's measured flag set with the env scrubbed of
 * TMUX/TMUX_PANE and the parent session's linkage, from a cwd no session uses — the two
 * ways an advisor call could steal a rail row (plan Traps; docs/traps/bots.md,
 * docs/traps/binding.md). After a replay the script checks no transcript appeared for it.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ADVISOR_MODEL,
  ADVISOR_EFFORT,
  ADVISOR_VERSION,
  adviceArgv,
  adviceEnv,
  adviceInput,
  adviceUsage,
  briefSha,
  readAdvice,
} from '../server/advisor.js';
import { WORKER_EFFORTS, modelLabel } from '../server/worker-models.js';
import { teamKey } from '../server/team.js';

/** The second advisor model tried on the held-out set (plan Q2, the maintainer's ruling). */
export const SECOND_MODEL = 'claude-haiku-4-5-20251001';
export const HELD_OUT_SHARE = 0.3;
export const RUNS = 2;

// ---------------------------------------------------------------- reading the history

/** Model id → family, retired ids included (`claude-opus-5` is an Opus). */
export function family(id) {
  const m = /(haiku|sonnet|opus|fable)/i.exec(String(id ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/** Cost order. Fable is treated as the heaviest, as the advisor's own prompt describes it. */
export const FAMILY_RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

/** `cheaper` / `same` / `heavier` — the advisor's pick against what ran. */
export function direction(advised, ran) {
  const a = FAMILY_RANK[family(advised)];
  const r = FAMILY_RANK[family(ran)];
  if (a === undefined || r === undefined) return null;
  return a < r ? 'cheaper' : a > r ? 'heavier' : 'same';
}

/** A short, stable stand-in for a repo path. Never reversible from the page alone. */
export const repoHash = (repo) => crypto.createHash('sha256').update(String(repo)).digest('hex').slice(0, 6);

/** tasks.json is an object keyed by id (TaskStore#flush); an array is accepted too. */
export function taskList(json) {
  const raw = Array.isArray(json) ? json : Object.values(json ?? {});
  return raw.filter((t) => t && typeof t === 'object' && typeof t.id === 'string');
}

/** Every room line, from every team, indexed by the task ids it is about. */
export function indexRoom(entries) {
  const by = new Map();
  const add = (id, e) => {
    if (typeof id !== 'string' || !id) return;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(e);
  };
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const ids = new Set([e.about, e.from, e.to].filter((v) => typeof v === 'string' && v !== 'lead' && v !== 'panel'));
    for (const id of ids) add(id, e);
  }
  return by;
}

/**
 * How a task went, from the room alone — the plan's "Scoring" table, with its weaknesses:
 *
 * - `struggled`: a stuck or loop alert, an interrupt, or an escalation by the worker.
 * - `reworked`: more than one done report, or the lead writing to it after its first one.
 * - `clean`: done, exactly one done report, a PR (a planner has none), none of the above.
 * - `unclear`: done but none of the above can be read (no done report on record).
 * - `abandoned` / `open`: not scored — closed without finishing, or still running.
 */
export function labelOutcome(task, entries = []) {
  const id = task.id;
  if (task.state === 'abandoned' || task.state === 'failed') return { outcome: 'abandoned' };
  if (task.state !== 'done') return { outcome: 'open' };
  const seqOf = (e) => (Number.isFinite(e.seq) ? e.seq : Number.isFinite(e.ts) ? e.ts : 0);
  const reports = entries.filter(
    (e) => (e.report === 'review' && e.from === id) || (e.kind === 'system' && e.about === id && /reports DONE/.test(String(e.text ?? ''))),
  );
  const firstReport = reports.length ? Math.min(...reports.map(seqOf)) : Infinity;
  const followups = entries.filter((e) => e.from === 'lead' && e.to === id && e.kind === 'chat' && seqOf(e) > firstReport).length;
  const alerts = entries.filter((e) => e.alert && e.about === id).length;
  const interrupts = entries.filter((e) => e.event === 'interrupt' && e.about === id).length;
  const escalations = entries.filter((e) => e.kind === 'escalation' && e.from === id).length;
  const signals = { reports: reports.length, followups, alerts, interrupts, escalations };
  if (alerts || interrupts || escalations) return { outcome: 'struggled', escalationOnly: !alerts && !interrupts, signals };
  if (reports.length > 1 || followups > 0) return { outcome: 'reworked', signals };
  if (reports.length === 1 && (task.kind === 'plan' || task.pr)) return { outcome: 'clean', signals };
  return { outcome: 'unclear', signals };
}

/**
 * The tasks a replay advises: every one that was dispatched, with a body, oldest first,
 * the oldest 70% `train` and the newest 30% `held-out`.
 */
export function replayItems(tasks, roomIndex) {
  const items = tasks
    .filter((t) => t.dispatchedAt && typeof t.body === 'string' && t.body.trim())
    .map((t) => ({
      task: t.id,
      repo: t.repo ?? '',
      repoHash: repoHash(t.repo ?? ''),
      kind: t.kind === 'plan' ? 'plan' : 'build',
      tag: Array.isArray(t.tags) && t.tags.length ? t.tags[0] : null,
      at: t.createdAt ?? t.dispatchedAt,
      ran: t.model ?? null,
      ranEffort: t.effort ?? null,
      body: t.body,
      ...labelOutcome(t, roomIndex.get(t.id) ?? []),
    }))
    .sort((a, b) => a.at - b.at || (a.task < b.task ? -1 : 1));
  const cut = Math.round(items.length * (1 - HELD_OUT_SHARE));
  items.forEach((it, i) => (it.split = i < cut ? 'train' : 'held-out'));
  return items;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line is not fatal */
    }
  }
  return out;
}

function teamDirs(stateDir) {
  const root = path.join(stateDir, 'teams');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.statSync(d).isDirectory());
}

export function loadState(stateDir) {
  const tasks = taskList(JSON.parse(fs.readFileSync(path.join(stateDir, 'tasks.json'), 'utf8')));
  const room = teamDirs(stateDir).flatMap((d) => readJsonl(path.join(d, 'room.jsonl')));
  return { tasks, roomIndex: indexRoom(room) };
}

// ---------------------------------------------------------------- calling the advisor

/**
 * One advisor call: the measured argv, the input on stdin, pipes on every stream (a child
 * on `inherit` would write into a parent's own stdout — in stage 2, the MCP channel).
 */
export function callAdvisor({ claude = 'claude', input, model, effort = ADVISOR_EFFORT, cwd, env = process.env, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ms: Date.now() - started, ...r });
    };
    let child;
    try {
      child = spawn(claude, adviceArgv({ model, effort }), { cwd, env: adviceEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ ok: false, error: `spawn failed: ${e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'timed out' });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish({ ok: false, error: `spawn failed: ${e.message}` }));
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      const advice = readAdvice(out);
      const tokens = adviceUsage(out);
      if (advice.ok) finish({ ...advice, tokens });
      else finish({ ok: false, error: code ? `exit ${code}: ${advice.error}` : advice.error, tokens, stderr: err.slice(0, 300) });
    });
    child.stdin.end(input);
  });
}

/** Run `fn` over `items`, `n` at a time, in order; `shouldStop()` halts new starts. */
export async function pool(items, n, fn, shouldStop = () => false) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
}

const rowKey = (r) => `${r.task}\u0000${r.advisorModel}\u0000${r.run}`;
const totalIn = (t) => (t ? t.input + t.cacheRead + t.cacheWrite : 0);

/**
 * The call list, in the order a stopped run is still most useful: the advisor on the
 * held-out set, then on the rest, then the second model on the held-out set one run at a
 * time. The second model goes last because it is the slow half — Haiku 4.5 takes no effort
 * level and thinks at length, ~20-35 s a call against Sonnet's ~3 s (measured on the first
 * smoke run).
 */
export function plannedCalls(items, { secondModel = SECOND_MODEL } = {}) {
  const calls = [];
  const held = items.filter((i) => i.split === 'held-out');
  const train = items.filter((i) => i.split === 'train');
  for (const it of held) for (let run = 1; run <= RUNS; run++) calls.push({ it, model: ADVISOR_MODEL, run });
  for (const it of train) for (let run = 1; run <= RUNS; run++) calls.push({ it, model: ADVISOR_MODEL, run });
  if (secondModel) for (let run = 1; run <= RUNS; run++) for (const it of held) calls.push({ it, model: secondModel, run });
  return calls;
}

/** Transcripts written since `sinceMs` that carry the advisor's input marker, plus the
 *  projects folder a transcript of the advisor's own cwd would land in. */
export function railCheck({ projectsDir, advisorCwd, sinceMs }) {
  const cwdFolder = path.join(projectsDir, advisorCwd.replace(/[^A-Za-z0-9]/g, '-'));
  const found = [];
  const walk = (dir, depth) => {
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const st = fs.statSync(p);
        if (st.birthtimeMs >= sinceMs) {
          try {
            if (fs.readFileSync(p, 'utf8').includes('--- brief ---\n')) found.push(p);
          } catch {
            /* unreadable is not ours */
          }
        }
      }
    }
  };
  walk(projectsDir, 0);
  return { advisorFolder: fs.existsSync(cwdFolder), newWithInput: found.length };
}

export async function replay(opts) {
  const { stateDir, out, claude, concurrency, limit, secondModel, budget, timeoutMs, projectsDir, log = console.log } = opts;
  const advisorCwd = path.join(stateDir, 'advisor');
  fs.mkdirSync(advisorCwd, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const rowsFile = path.join(out, 'rows.jsonl');
  const { tasks, roomIndex } = loadState(stateDir);
  let items = replayItems(tasks, roomIndex);
  if (limit) {
    items = items.slice(-limit);
    const cut = Math.round(items.length * (1 - HELD_OUT_SHARE));
    items.forEach((it, i) => (it.split = i < cut ? 'train' : 'held-out'));
  }
  const have = new Set(readJsonl(rowsFile).map(rowKey));
  const calls = plannedCalls(items, { secondModel }).filter((c) => !have.has(rowKey({ task: c.it.task, advisorModel: c.model, run: c.run })));
  const started = Date.now();
  const meta = readMeta(out);
  meta.startedAt ??= started;
  meta.version = ADVISOR_VERSION;
  meta.items = items.length;
  writeMeta(out, meta);
  log(`advisor-eval: ${items.length} briefs, ${calls.length} calls to make (${have.size} already done), ${concurrency} at a time`);

  let made = 0;
  let inTokens = 0;
  let stopped = false;
  const stop = () => stopped;
  await pool(calls, concurrency, async ({ it, model, run }) => {
    let r = await callAdvisor({ claude, input: adviceInput(it), model, cwd: advisorCwd, timeoutMs });
    if (!r.ok && !/^not an advisable|^not an effort|^no reason/.test(r.error)) {
      await new Promise((res) => setTimeout(res, 5000));
      r = { ...(await callAdvisor({ claude, input: adviceInput(it), model, cwd: advisorCwd, timeoutMs })), retried: true };
    }
    const { body, ...rest } = it;
    const row = {
      ...rest,
      briefSha: briefSha(body),
      briefChars: body.length,
      advisorModel: model,
      advisorVersion: ADVISOR_VERSION,
      run,
      ok: r.ok,
      model: r.model ?? null,
      effort: r.effort ?? null,
      reason: r.reason ?? null,
      error: r.ok ? null : r.error,
      tokens: r.tokens ?? null,
      ms: r.ms,
      retried: Boolean(r.retried),
    };
    fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
    made++;
    inTokens += totalIn(r.tokens);
    const projected = (inTokens / made) * calls.length;
    if (made >= 30 && projected > budget && !stopped) {
      stopped = true;
      log(`advisor-eval: STOPPING — projected ${Math.round(projected / 1e6)}M input tokens is over the ${Math.round(budget / 1e6)}M budget`);
    }
    if (made % 100 === 0) log(`advisor-eval: ${made}/${calls.length} calls, ${Math.round(inTokens / 1e3)}k input tokens so far`);
  }, stop);

  meta.finishedAt = Date.now();
  meta.stopped = stopped;
  meta.wallMs = (meta.wallMs ?? 0) + (meta.finishedAt - started);
  meta.rail = railCheck({ projectsDir, advisorCwd, sinceMs: meta.startedAt });
  meta.advisorCwdEmpty = fs.readdirSync(advisorCwd).length === 0;
  writeMeta(out, meta);
  return report({ out, log });
}

const metaFile = (out) => path.join(out, 'run.json');
function readMeta(out) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(out), 'utf8'));
  } catch {
    return {};
  }
}
function writeMeta(out, meta) {
  fs.writeFileSync(metaFile(out), `${JSON.stringify(meta, null, 2)}\n`);
}

// ---------------------------------------------------------------- scoring

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const SCORED = new Set(['clean', 'reworked', 'struggled']);

/** The core tables for one advisor model's first-run calls. */
export function score(rows) {
  const s = { calls: rows.length, ok: 0, scored: 0, cheaper: 0, heavier: 0, same: 0, save: 0, catch: 0, risk: 0, riskEscalationOnly: 0, cheaperReworked: 0, heavierClean: 0, noHistoryModel: 0 };
  for (const r of rows) {
    if (!r.ok) continue;
    s.ok++;
    const dir = direction(r.model, r.ran);
    if (!dir) {
      s.noHistoryModel++;
      continue;
    }
    if (!SCORED.has(r.outcome)) continue;
    s.scored++;
    s[dir]++;
    if (dir === 'cheaper' && r.outcome === 'clean') s.save++;
    if (dir === 'cheaper' && r.outcome === 'reworked') s.cheaperReworked++;
    if (dir === 'cheaper' && r.outcome === 'struggled') {
      s.risk++;
      if (r.escalationOnly) s.riskEscalationOnly++;
    }
    if (dir === 'heavier' && (r.outcome === 'reworked' || r.outcome === 'struggled')) s.catch++;
    if (dir === 'heavier' && r.outcome === 'clean') s.heavierClean++;
  }
  return s;
}

/** Both runs of one brief, per advisor model: how often the advisor agreed with itself. */
export function selfAgreement(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.ok) continue;
    const k = r.task;
    if (!by.has(k)) by.set(k, {});
    by.get(k)[r.run] = r;
  }
  let pairs = 0, model = 0, effort = 0, both = 0;
  for (const p of by.values()) {
    if (!p[1] || !p[2]) continue;
    pairs++;
    const m = p[1].model === p[2].model;
    const e = p[1].effort === p[2].effort;
    model += m;
    effort += e;
    both += m && e;
  }
  return { pairs, model, effort, both };
}

function countBy(rows, f) {
  const m = {};
  for (const r of rows) {
    const k = f(r);
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
}

function cost(rows) {
  const c = { calls: rows.length, failed: 0, input: 0, cacheRead: 0, output: 0, ms: [] };
  for (const r of rows) {
    if (!r.ok) c.failed++;
    if (r.tokens) {
      c.input += totalIn(r.tokens);
      c.cacheRead += r.tokens.cacheRead;
      c.output += r.tokens.output;
    }
    if (Number.isFinite(r.ms)) c.ms.push(r.ms);
  }
  c.ms.sort((a, b) => a - b);
  c.medianMs = c.ms.length ? c.ms[Math.floor(c.ms.length / 2)] : 0;
  delete c.ms;
  return c;
}

const m1 = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const name = (id) => modelLabel(id);

function scoreTable(cols) {
  const lines = [
    `| | ${cols.map((c) => c.label).join(' | ')} |`,
    `| --- | ${cols.map(() => '---:').join(' | ')} |`,
  ];
  const row = (label, f) => lines.push(`| ${label} | ${cols.map((c) => f(c.s)).join(' | ')} |`);
  row('Tasks with a known outcome and model', (s) => s.scored);
  row('Advisor picked the **same** model as ran', (s) => `${s.same} (${pct(s.same, s.scored)})`);
  row('Advisor picked a **cheaper** model', (s) => `${s.cheaper} (${pct(s.cheaper, s.scored)})`);
  row('Advisor picked a **heavier** model', (s) => `${s.heavier} (${pct(s.heavier, s.scored)})`);
  row('**Would save** — cheaper, and the task went clean', (s) => s.save);
  row('**Would catch** — heavier, and the task needed rework or struggled', (s) => s.catch);
  row('**Would risk** — cheaper, and the task struggled', (s) => `**${s.risk}** (${pct(s.risk, s.cheaper)} of cheaper calls)`);
  row('…of which the only sign was the worker asking a question', (s) => s.riskEscalationOnly);
  row('Cheaper, and the task needed rework (softer risk)', (s) => s.cheaperReworked);
  row('Heavier on a task that went clean (would spend more)', (s) => s.heavierClean);
  return lines.join('\n');
}

function spreadTable(rows, keyLabel, keyOf) {
  const keys = [...new Set(rows.map(keyOf))].sort();
  const lines = [`| ${keyLabel} | ${WORKER_EFFORTS.join(' | ')} | total |`, `| --- | ${WORKER_EFFORTS.map(() => '---:').join(' | ')} | ---: |`];
  for (const k of keys) {
    const sub = rows.filter((r) => keyOf(r) === k);
    const c = countBy(sub, (r) => r.effort);
    lines.push(`| ${k} | ${WORKER_EFFORTS.map((e) => c[e] ?? 0).join(' | ')} | ${sub.length} |`);
  }
  return lines.join('\n');
}

/** The one page. Takes rows and run metadata; names nothing but hashes and model names. */
export function renderSummary(rows, meta = {}) {
  const first = (model, split) => rows.filter((r) => r.advisorModel === model && r.run === 1 && (!split || r.split === split));
  const main = first(ADVISOR_MODEL);
  const tasks = new Set(rows.map((r) => r.task));
  const held = new Set(rows.filter((r) => r.split === 'held-out').map((r) => r.task));
  const outcomes = countBy([...new Map(main.map((r) => [r.task, r])).values()], (r) => r.outcome);
  const date = meta.startedAt ? new Date(meta.startedAt).toISOString().slice(0, 10) : '';
  const sec = [];

  sec.push(`# Model advisor — replay over past briefs${date ? ` (${date})` : ''}`);
  sec.push(
    `The advisor read **${tasks.size}** past worker briefs — the brief only, plus whether it was a build or a plan and its tag — and said which model it would have run each on. Its answers are compared with what each task actually ran on and how it went. Advisor version ${ADVISOR_VERSION}, running on ${name(ADVISOR_MODEL)} at \`${ADVISOR_EFFORT}\`. Every brief was asked twice.`,
  );
  sec.push(
    `Fable 5.2 is counted as heavier than Opus 5.5, as the advisor's own instructions describe it. How a task "went" is read from the team room: **clean** (done, one done report, nothing after), **reworked** (sent back or reported twice), **struggled** (a stuck or loop alert, an interrupt, or the worker escalating a question). Tasks closed unfinished (${outcomes.abandoned ?? 0}), still open (${outcomes.open ?? 0}) or with no done report on record (${outcomes.unclear ?? 0}) are not scored. Of the rest: ${outcomes.clean ?? 0} clean, ${outcomes.reworked ?? 0} reworked, ${outcomes.struggled ?? 0} struggled.`,
  );

  sec.push('## The headline');
  sec.push(
    scoreTable([
      { label: 'All', s: score(main) },
      { label: 'Oldest 70%', s: score(first(ADVISOR_MODEL, 'train')) },
      { label: `Newest 30% (held out, ${held.size})`, s: score(first(ADVISOR_MODEL, 'held-out')) },
    ]),
  );
  sec.push(
    '**Would risk** is the number that matters most: a task the advisor would have put on a smaller model, which then struggled even on the larger one. **Read "would save" with care**: past Sonnet tasks were picked by a lead *because* they looked small, so "the advisor says Sonnet and the task went clean on Opus" does not prove Sonnet would have managed — only a real re-run, or the live trial, can show that. Tasks with no recorded model (the earliest, which ran on whatever the machine default was) are left out of every comparison.',
  );

  const sa = selfAgreement(rows.filter((r) => r.advisorModel === ADVISOR_MODEL));
  sec.push('## Does it agree with itself?');
  sec.push(
    `Asked the same brief twice, ${name(ADVISOR_MODEL)} picked the same model **${pct(sa.model, sa.pairs)}** of the time and the same effort ${pct(sa.effort, sa.pairs)} (both: ${pct(sa.both, sa.pairs)}; ${sa.pairs} briefs).`,
  );

  sec.push('## Effort — what it would pick (unscored)');
  sec.push(
    `Every past task with an effort on record ran at \`high\`, so there is nothing to score the advisor's effort against; this is only how its picks spread (${name(ADVISOR_MODEL)}, first run of each brief). In the live trial effort will be used, and the same script will be able to score it then.`,
  );
  const okMain = main.filter((r) => r.ok);
  sec.push(spreadTable(okMain, 'kind', (r) => r.kind));
  sec.push(spreadTable(okMain, 'tag', (r) => r.tag ?? 'none'));
  sec.push(spreadTable(okMain, 'advised model', (r) => name(r.model)));

  const second = [...new Set(rows.map((r) => r.advisorModel))].filter((m) => m !== ADVISOR_MODEL);
  for (const m of second) {
    const a = score(first(ADVISOR_MODEL, 'held-out'));
    const b = score(first(m, 'held-out'));
    const saA = selfAgreement(rows.filter((r) => r.advisorModel === ADVISOR_MODEL && r.split === 'held-out'));
    const saB = selfAgreement(rows.filter((r) => r.advisorModel === m));
    const both = new Map();
    for (const r of rows.filter((x) => x.split === 'held-out' && x.run === 1 && x.ok)) {
      if (!both.has(r.task)) both.set(r.task, {});
      both.get(r.task)[r.advisorModel] = r.model;
    }
    const pairs = [...both.values()].filter((p) => p[ADVISOR_MODEL] && p[m]);
    const agree = pairs.filter((p) => p[ADVISOR_MODEL] === p[m]).length;
    const cA = cost(rows.filter((r) => r.advisorModel === ADVISOR_MODEL && r.split === 'held-out'));
    const cB = cost(rows.filter((r) => r.advisorModel === m));
    sec.push(`## ${name(ADVISOR_MODEL)} or ${name(m)} as the advisor? (held-out set only)`);
    sec.push(
      scoreTable([
        { label: name(ADVISOR_MODEL), s: a },
        { label: name(m), s: b },
      ]),
    );
    sec.push(
      `Agrees with itself on the model: ${name(ADVISOR_MODEL)} ${pct(saA.model, saA.pairs)}, ${name(m)} ${pct(saB.model, saB.pairs)}. The two advisors picked the same model on ${pct(agree, pairs.length)} of ${pairs.length} briefs. Median time per call: ${(cA.medianMs / 1000).toFixed(1)} s against ${(cB.medianMs / 1000).toFixed(1)} s; failed calls: ${cA.failed} against ${cB.failed}. ${name(m)} takes no effort level, so its effort picks are the model's own and are not compared.`,
    );
  }

  sec.push('## By repo (hashes; the key is in `repo-key.json` beside this file)');
  const hashes = [...new Set(main.map((r) => r.repoHash))];
  const perRepo = hashes
    .map((h) => ({ h, s: score(main.filter((r) => r.repoHash === h)), n: main.filter((r) => r.repoHash === h).length }))
    .sort((a, b) => b.n - a.n);
  const rl = ['| repo | briefs | scored | same | cheaper | heavier | would save | would catch | would risk |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const { h, s, n } of perRepo) rl.push(`| \`${h}\` | ${n} | ${s.scored} | ${s.same} | ${s.cheaper} | ${s.heavier} | ${s.save} | ${s.catch} | ${s.risk} |`);
  sec.push(rl.join('\n'));

  sec.push('## What the run cost');
  const cl = ['| advisor | calls | failed | input tokens | of which cached | output tokens | median per call |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const m of [ADVISOR_MODEL, ...second]) {
    const c = cost(rows.filter((r) => r.advisorModel === m));
    cl.push(`| ${name(m)} | ${c.calls} | ${c.failed} | ${m1(c.input)} | ${m1(c.cacheRead)} | ${m1(c.output)} | ${(c.medianMs / 1000).toFixed(1)} s |`);
  }
  sec.push(cl.join('\n'));
  const extras = [];
  if (meta.wallMs) extras.push(`Wall time ${Math.round(meta.wallMs / 60000)} min.`);
  if (meta.stopped) extras.push('**The run was stopped early by its token budget; the numbers above cover only the calls made.**');
  if (meta.rail) {
    extras.push(
      meta.rail.newWithInput === 0 && !meta.rail.advisorFolder
        ? 'Rail check: no transcript was written for any advisor call (none carries the advisor input, and the advisor folder has no projects entry), so no session row could have been rebound.'
        : `Rail check FAILED: ${meta.rail.newWithInput} new transcript(s) carry advisor input; advisor projects folder present: ${meta.rail.advisorFolder}.`,
    );
  }
  if (extras.length) sec.push(extras.join(' '));

  return `${sec.join('\n\n')}\n`;
}

/** Counts only — what stdout may carry. */
export function headline(rows) {
  const s = score(rows.filter((r) => r.advisorModel === ADVISOR_MODEL && r.run === 1));
  const h = score(rows.filter((r) => r.advisorModel === ADVISOR_MODEL && r.run === 1 && r.split === 'held-out'));
  return `scored ${s.scored}: same ${s.same}, cheaper ${s.cheaper}, heavier ${s.heavier}; would save ${s.save}, would catch ${s.catch}, would risk ${s.risk} (held-out: risk ${h.risk} of ${h.cheaper} cheaper)`;
}

export function report({ out, log = console.log }) {
  const rows = readJsonl(path.join(out, 'rows.jsonl'));
  const meta = readMeta(out);
  fs.writeFileSync(path.join(out, 'summary.md'), renderSummary(rows, meta));
  const key = {};
  for (const r of rows) key[r.repoHash] = r.repo;
  fs.writeFileSync(path.join(out, 'repo-key.json'), `${JSON.stringify(key, null, 2)}\n`);
  log(`advisor-eval: ${rows.length} rows; ${headline(rows)}`);
  log(`advisor-eval: wrote summary.md and repo-key.json`);
  return { rows, meta };
}

// ---------------------------------------------------------------- live (stage 2)

/*
 * Live mode scores the trial once stage 2 writes advice: `<teamDir>/advice.jsonl` (one line
 * per call: id, at, briefSha, kind, tag, advisorVersion, advisorModel, model, effort,
 * reason, tokens {in, out}, ms, ok, error) and `advice: {id, model, effort, reason,
 * version}` on each task record (plan, "What gets recorded"). It joins the two on the
 * advice id, takes what the lead launched from the task's own `model`/`effort`, labels the
 * outcome exactly as the replay does, and writes one section per team. Written against the
 * plan's record format and tested on made-up data; if stage 2 changes the format, this is
 * the function to change with it.
 */

/** One row per advised (or unadvised) dispatched task in one team. */
export function liveRows(tasks, adviceLines, roomIndex) {
  const byId = new Map(adviceLines.filter((a) => a && a.id).map((a) => [a.id, a]));
  return tasks
    .filter((t) => t.dispatchedAt)
    .map((t) => {
      const adv = t.advice?.id ? byId.get(t.advice.id) ?? t.advice : null;
      const advisedModel = adv?.model ?? null;
      const advisedEffort = adv?.effort ?? null;
      return {
        task: t.id,
        repoHash: repoHash(t.repo ?? ''),
        advised: Boolean(adv),
        version: adv?.advisorVersion ?? adv?.version ?? null,
        advisedModel,
        advisedEffort,
        ran: t.model ?? null,
        ranEffort: t.effort ?? null,
        followedModel: adv ? advisedModel === t.model : null,
        followedEffort: adv && advisedEffort ? advisedEffort === t.effort : null,
        dir: adv ? direction(advisedModel, t.model) : null,
        ...labelOutcome(t, roomIndex.get(t.id) ?? []),
      };
    });
}

export function renderLive(teams) {
  const sec = ['# Model advisor — live trial, per team'];
  sec.push(
    'Each section is one team with the advisor switched on. "Followed" means the lead launched the model the advisor proposed; "overruled" means it launched something else and had to say why. Outcomes are read from the room exactly as in the replay: clean, reworked, struggled; unfinished and open tasks are not scored.',
  );
  for (const { hash, rows, advice } of teams) {
    const adv = rows.filter((r) => r.advised);
    const scored = adv.filter((r) => SCORED.has(r.outcome));
    const followed = scored.filter((r) => r.followedModel);
    const over = scored.filter((r) => r.followedModel === false);
    const o = (list) => {
      const c = countBy(list, (r) => r.outcome);
      return `${list.length} (clean ${c.clean ?? 0}, reworked ${c.reworked ?? 0}, struggled ${c.struggled ?? 0})`;
    };
    const cheaperFollowed = followed.filter((r) => FAMILY_RANK[family(r.ran)] < FAMILY_RANK.opus);
    const calls = advice.length;
    const failed = advice.filter((a) => a.ok === false).length;
    const tok = advice.reduce((n, a) => n + (Number(a.tokens?.in) || 0), 0);
    sec.push(`## Team \`${hash}\``);
    sec.push(
      [
        `- Dispatched tasks: ${rows.length}; advised: ${adv.length}; went out without advice: ${rows.length - adv.length}.`,
        `- Lead followed the model: ${adv.filter((r) => r.followedModel).length}; overruled: ${adv.filter((r) => r.followedModel === false).length}. Followed the effort: ${adv.filter((r) => r.followedEffort).length}; overruled the effort: ${adv.filter((r) => r.followedEffort === false).length}.`,
        `- Outcomes when followed: ${o(followed)}. When overruled: ${o(over)}.`,
        `- **Struggled on a below-Opus model the advisor proposed and the lead followed**: ${cheaperFollowed.filter((r) => r.outcome === 'struggled').length} of ${cheaperFollowed.length}.`,
        `- Advisor calls: ${calls} (${failed} failed), ${m1(tok)} input tokens.`,
      ].join('\n'),
    );
    const eff = scored.filter((r) => r.ranEffort);
    if (eff.length) {
      const l = ['| launched effort | tasks | clean | reworked | struggled |', '| --- | ---: | ---: | ---: | ---: |'];
      for (const e of WORKER_EFFORTS) {
        const sub = eff.filter((r) => r.ranEffort === e);
        if (!sub.length) continue;
        const c = countBy(sub, (r) => r.outcome);
        l.push(`| ${e} | ${sub.length} | ${c.clean ?? 0} | ${c.reworked ?? 0} | ${c.struggled ?? 0} |`);
      }
      sec.push(l.join('\n'));
    }
  }
  if (!teams.length) sec.push('No team has written any advice yet.');
  return `${sec.join('\n\n')}\n`;
}

export function live({ stateDir, out, log = console.log }) {
  const { tasks, roomIndex } = loadState(stateDir);
  const teams = [];
  const key = {};
  const byRepo = new Map();
  for (const t of tasks) {
    if (!byRepo.has(t.repo)) byRepo.set(t.repo, []);
    byRepo.get(t.repo).push(t);
  }
  const dirs = new Map(teamDirs(stateDir).map((d) => [path.basename(d), d]));
  for (const [repo, list] of byRepo) {
    const d = dirs.get(teamKey(repo));
    const advice = d ? readJsonl(path.join(d, 'advice.jsonl')) : [];
    if (!advice.length && !list.some((t) => t.advice)) continue;
    const hash = repoHash(repo);
    key[hash] = repo;
    teams.push({ hash, rows: liveRows(list, advice, roomIndex), advice });
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'live-summary.md'), renderLive(teams));
  fs.writeFileSync(path.join(out, 'repo-key.json'), `${JSON.stringify(key, null, 2)}\n`);
  log(`advisor-eval live: ${teams.length} team(s) with advice; wrote live-summary.md`);
  return teams;
}

// ---------------------------------------------------------------- command line

export function parseArgs(argv, env = process.env) {
  const [mode = 'replay', ...rest] = argv;
  const o = {
    mode,
    stateDir: env.FOREMAN_STATE_DIR || path.join(os.homedir(), '.foreman'),
    out: null,
    claude: 'claude',
    projectsDir: path.join(os.homedir(), '.claude', 'projects'),
    concurrency: 3,
    limit: 0,
    secondModel: SECOND_MODEL,
    budget: 20_000_000,
    timeoutMs: 120_000,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = () => rest[++i];
    if (a === '--state-dir') o.stateDir = v();
    else if (a === '--out') o.out = v();
    else if (a === '--claude') o.claude = v();
    else if (a === '--projects') o.projectsDir = v();
    else if (a === '--concurrency') o.concurrency = Math.min(3, Math.max(1, Number(v()) || 3));
    else if (a === '--limit') o.limit = Number(v()) || 0;
    else if (a === '--no-second-model') o.secondModel = null;
    else if (a === '--budget') o.budget = Number(v()) || o.budget;
    else if (a === '--timeout') o.timeoutMs = Number(v()) || o.timeoutMs;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!['replay', 'report', 'live'].includes(o.mode)) throw new Error(`Unknown mode: ${o.mode}`);
  o.out ??= path.join(o.stateDir, 'advisor-eval', o.mode === 'live' ? `live-${today()}` : today());
  return o;
}

const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.mode === 'replay') await replay(o);
  else if (o.mode === 'report') report(o);
  else live(o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`advisor-eval: ${e.message}`);
    process.exit(1);
  });
}
