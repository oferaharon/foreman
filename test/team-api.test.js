import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The team endpoints, against the real server.
 *
 * `POST /api/team/tasks` lives inline in `server/index.js`, so there is nothing to import
 * — which is fine, because the thing worth testing is the whole request/response, express
 * body parsing and status codes included. So this boots the actual panel on a scratch
 * port and a scratch state dir and talks HTTP to it, the same way `test/worktree.test.js`
 * runs against real throwaway repos rather than a stubbed git.
 *
 * The scratch state dir is not tidiness. `CLAUDE.md`: a second server pointed at the real
 * one boots its own worktree GC, and will sweep real worktrees belonging to real failed
 * tasks and post the receipt into a real team's room, entirely within its rights.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let child;
let port;
let stateDir;
let repo;

/** The scratch panel's trigger secret. Long enough that the equal-length check in
 *  `triggerAuthorized` is not the thing doing the work. */
const TOKEN = 'scratch-trigger-token-0123456789';

/**
 * Stop a scratch panel and **wait for it to be gone** before touching its state dir.
 *
 * `kill()` sends SIGTERM, and since the SIGTERM handler landed the panel answers that by
 * flushing every store — so the process writes into the state dir on its way out, and an
 * `rm` fired in the same tick races those writes and fails `ENOTEMPTY`. Deterministically:
 * it failed on three runs out of three. Waiting is the fix, and the race is the flush
 * working.
 */
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

/** A port nobody is on — asked of the OS rather than guessed, so a busy Mac is fine. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port: p } = probe.address();
  await new Promise((r) => probe.close(r));
  return p;
}

/** `teamKey` in server/team.js: the repo path with each slash as a dash. Spelled out here
 *  rather than imported, so this file only ever talks to the server over HTTP. */
const teamKeyFor = (dir) => String(dir).replace(/\/+$/, '').replace(/\//g, '-').replace(/^-/, '');

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-api-'));
  // Never a real checkout: nothing here cuts a worktree, and the one test that *tries* to
  // dispatch relies on this not being a git repo to fail at `createWorktree`.
  repo = path.join(stateDir, 'FakeRepo');
  await fsp.mkdir(repo, { recursive: true });
  // The other fixture — a real git checkout, for the promotions that need a worktree.
  // Here rather than in a second `before` so the order is the file's, not the runner's.
  prepareGitRepo();
  port = await freePort();

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOREMAN_PORT: String(port),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: stateDir,
      // The trigger endpoint's switch. Read once at boot, so it has to be here rather
      // than set per-test; the `unset` case gets a server of its own further down.
      FOREMAN_TRIGGER_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  // Insurance against an interrupted run: a spawned panel that outlives `npm test` would
  // sit on a scratch port forever, and the `after` hook below never fires on a Ctrl-C.
  process.on('exit', () => child?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/team/tasks`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('the scratch panel never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

test.after(async () => {
  await stop(child);
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
});

test('a pending task is a brief and a name — no branch, no worktree, no session', async () => {
  const res = await api('POST', '/api/team/tasks', {
    folder: repo,
    label: 'search-index',
    body: 'index the transcripts so the panel can search them',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.state, 'pending');
  assert.equal(res.body.task.body, 'index the transcripts so the panel can search them');
  assert.equal(res.body.task.kind, 'build');
  assert.equal(res.body.task.source, 'chat');
  // The four facts about a checkout, on a task that has no checkout. `planFile` too —
  // it is derived at promotion, and `GET /api/team/plans/:id` falls back to the same
  // call, so a pending planner reads back as "not written yet" rather than as a lie.
  assert.equal(res.body.task.branch, null);
  assert.equal(res.body.task.worktree, null);
  assert.equal(res.body.task.base, null);
  assert.equal(res.body.task.planFile, null);
  assert.equal(res.body.task.tmuxSession, null);
});

test('the response carries the tidied id, because that is the name it will be started by', async () => {
  const res = await api('POST', '/api/team/tasks', {
    folder: repo,
    label: 'Brief  Modal!!',
    body: 'click a row, read the brief',
  });
  assert.equal(res.status, 200);
  // `tidyLabel` lowercases, collapses non-alphanumerics and trims. A lead holding the
  // string it typed would later ask to promote a record that is not in the store.
  assert.equal(res.body.id, 'brief-modal');
  assert.equal(res.body.task.id, 'brief-modal');
});

test('an omitted model stays omitted — the default is resolved when it starts, not now', async () => {
  const res = await api('POST', '/api/team/tasks', {
    folder: repo,
    label: 'later-thought',
    body: 'something for next month',
  });
  // Not `claude-opus-5`. `null` means "whatever the team default is on the day this
  // starts"; freezing today's resolved default would pin an old default silently, and
  // the room's "departure from the default" line would never fire because the record
  // would look like an explicit choice.
  assert.equal(res.body.task.model, null);
  assert.equal(res.body.task.modelReason, null);
});

test('a named model is validated now and stored as it was asked for', async () => {
  const res = await api('POST', '/api/team/tasks', {
    folder: repo,
    label: 'mechanical-sweep',
    body: 'rename a symbol everywhere',
    model: 'claude-sonnet-5',
    modelReason: 'wide and mechanical, nothing to judge',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.model, 'claude-sonnet-5');
  assert.equal(res.body.task.modelReason, 'wide and mechanical, nothing to judge');
});

test('the same refusals as a dispatch, at the moment the idea is recorded', async () => {
  const missing = await Promise.all([
    api('POST', '/api/team/tasks', { label: 'x', body: 'y' }),
    api('POST', '/api/team/tasks', { folder: repo, body: 'y' }),
    api('POST', '/api/team/tasks', { folder: repo, label: 'x' }),
  ]);
  assert.deepEqual(missing.map((r) => r.status), [400, 400, 400]);
  assert.match(missing[0].body.error, /Which folder\?/);
  assert.match(missing[1].body.error, /needs a label/);
  assert.match(missing[2].body.error, /needs a task/);

  const dup = await api('POST', '/api/team/tasks', { folder: repo, label: 'search-index', body: 'again' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already called/);

  // Tidying happens before the duplicate check, so two labels that tidy to one name
  // collide — which is the whole point of the id being the tidied string.
  const dupTidied = await api('POST', '/api/team/tasks', { folder: repo, label: 'Search Index', body: 'again' });
  assert.equal(dupTidied.status, 409);

  const kind = await api('POST', '/api/team/tasks', { folder: repo, label: 'k', body: 'b', kind: 'ponder' });
  assert.equal(kind.status, 400);
  assert.match(kind.body.error, /No such task kind: ponder/);

  // An unknown model must fail here, while the maintainer is still in the conversation — not eight
  // hours from now against a record that cannot be started.
  const model = await api('POST', '/api/team/tasks', { folder: repo, label: 'm', body: 'b', model: 'gpt-9' });
  assert.equal(model.status, 400);
  assert.match(model.body.error, /Unknown model "gpt-9"/);

  const noReason = await api('POST', '/api/team/tasks', {
    folder: repo, label: 'r', body: 'b', model: 'claude-fable-5',
  });
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.error, /needs a one-line modelReason/);

  // Every refusal above wrote nothing: the store still holds only what succeeded.
  const { body } = await api('GET', '/api/team/tasks');
  const ids = body.tasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['brief-modal', 'later-thought', 'mechanical-sweep', 'search-index']);
});

test('the room line is keyed on `event`, so a reword can never turn its colour off', async () => {
  const file = path.join(stateDir, 'teams', teamKeyFor(repo), 'room.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const entry = lines.find((e) => e.about === 'search-index');
  assert.equal(entry.kind, 'system');
  assert.equal(entry.event, 'pending');
  assert.equal(entry.from, 'panel');
  assert.equal(entry.to, 'lead');
  assert.match(entry.text, /recorded as pending — nothing is running/);

  // A planner says so in the sentence and is still the same event — the word in the text
  // is for the reader, the `event` is for the stylesheet.
  await api('POST', '/api/team/tasks', { folder: repo, label: 'shape-it', body: 'plan it', kind: 'plan' });
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const planner = after.find((e) => e.about === 'shape-it');
  assert.equal(planner.event, 'pending');
  assert.match(planner.text, /^Planner shape-it recorded as pending/);
});

test('a backlog does not fill the cap — the regression guard for the whole feature', async () => {
  // Five recorded ideas against a default cap of three. If `pending` ever reaches
  // `ACTIVE`, every dispatch on this repo is refused with no worker running at all.
  for (const n of [1, 2, 3, 4, 5]) {
    const res = await api('POST', '/api/team/tasks', { folder: repo, label: `idea-${n}`, body: 'later' });
    assert.equal(res.status, 200, `idea-${n} recorded`);
  }

  // A real dispatch, with the backlog sitting there. It fails — `repo` is not a git
  // checkout, so `createWorktree` throws — and *how* it fails is the assertion: a 400
  // from git, not a 409 from the cap. Deliberately not a real repo: a dispatch that got
  // past this line would launch a Claude session from the test suite.
  const dispatch = await api('POST', '/api/team/dispatch', {
    folder: repo, label: 'the-real-thing', body: 'do it',
  });
  assert.equal(dispatch.status, 400, dispatch.body.error);
  assert.doesNotMatch(dispatch.body.error, /active workers/, 'the cap never saw the backlog');
  assert.equal((await api('GET', '/api/team/tasks')).body.tasks.some((t) => t.id === 'the-real-thing'), false);
});

/*
 * Promotion — starting a pending task, which is this same dispatch endpoint against an
 * existing record. What is worth testing over HTTP is exactly the part that branches:
 * the refusals, and what survives onto the record. Everything from `createWorktree` down
 * is the ordinary dispatch path and is deliberately not a second thing to test.
 */

test('promoting a task nobody recorded is a 404 — not a new task by that name', async () => {
  const res = await api('POST', '/api/team/dispatch', { folder: repo, id: 'never-recorded' });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /No such task: never-recorded/);
  assert.equal((await api('GET', '/api/team/tasks')).body.tasks.some((t) => t.id === 'never-recorded'), false);
});

test('a task that is already running refuses by naming the state it is in', async () => {
  await api('POST', '/api/team/tasks', { folder: repo, label: 'busy-already', body: 'in flight' });
  await api('PATCH', '/api/team/tasks/busy-already', { state: 'working', summary: 'on it' });

  const res = await api('POST', '/api/team/dispatch', { folder: repo, id: 'busy-already' });
  assert.equal(res.status, 409);
  // Naming the state is the point. A worker already running under this label is the case
  // that matters, and "it is working" is a very different problem from "no such task" —
  // a lead told only "no" would retry.
  assert.match(res.body.error, /busy-already is working, not pending/);
  assert.equal((await api('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'busy-already').state, 'working');
});

test('a promotion that cannot cut a worktree leaves the task pending, with its brief', async () => {
  // `repo` is not a git checkout, so `createWorktree` throws — and the handler returns
  // before anything touches the record. That is the whole failure split: no worktree
  // means the idea is not lost. (Once a worktree *does* exist, a setup or launch failure
  // is `failed` and keeps the checkout as evidence — never a fall back to pending.)
  const before = (await api('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'later-thought');
  assert.equal(before.state, 'pending');

  const res = await api('POST', '/api/team/dispatch', { folder: repo, id: 'later-thought' });
  assert.equal(res.status, 400, res.body.error);
  assert.doesNotMatch(res.body.error, /No such task/);

  const after = (await api('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'later-thought');
  assert.equal(after.state, 'pending', 'still on the backlog');
  assert.equal(after.body, 'something for next month', 'and the brief is intact');
  assert.equal(after.branch, null);
  assert.equal(after.worktree, null);
  assert.equal(after.startedBy, null, 'nothing said "start it", because nothing started');
});

test('a folder that disagrees with the record is refused rather than silently overruled', async () => {
  const res = await api('POST', '/api/team/dispatch', { folder: '/somewhere/Else', id: 'later-thought' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /belongs to/);
});

/*
 * The rest of promotion needs a worktree to actually exist, which needs a real git repo —
 * the same reasoning `test/worktree.test.js` runs on: stubbing git to test a git wrapper
 * proves nothing. What it must NOT do is launch a Claude session from the test suite, so
 * the team's `setup` command is `exit 7`: the dispatch gets its worktree, writes the
 * record, and then fails at setup — one step before `createSession`. Everything this item
 * changed has already happened by then.
 */

let gitRepo;

/** Called from the one `before` above — hoisted, so it can be read down here with the
 *  tests that use it. */
function prepareGitRepo() {
  gitRepo = path.join(stateDir, 'RealRepo');
  fs.mkdirSync(gitRepo, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: gitRepo, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(gitRepo, 'README.md'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-m', 'first']);

  const dir = path.join(stateDir, 'teams', teamKeyFor(gitRepo));
  fs.mkdirSync(dir, { recursive: true });
  // A legacy stored `setup` still wins over detection (`resolveSetup`), which is the only
  // way to make a dispatch fail on demand without a session ever starting.
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ repo: gitRepo, setup: 'exit 7' }, null, 2));
}

test('a promotion carries the record forward — same createdAt, new brief, model resolved now', async () => {
  const recorded = await api('POST', '/api/team/tasks', {
    folder: gitRepo,
    label: 'promote-me',
    body: 'the brief as it was recorded',
  });
  assert.equal(recorded.status, 200);
  const { createdAt } = recorded.body.task;
  assert.equal(recorded.body.task.model, null, 'recorded unresolved');

  await new Promise((r) => setTimeout(r, 10)); // so an unchanged updatedAt would be visible
  const started = await api('POST', '/api/team/dispatch', {
    folder: gitRepo,
    id: 'promote-me',
    body: 'the brief as it was rewritten at the last moment',
    startedBy: 'zzq-testname: "yes, go"',
  });
  // Stopped at setup, one step short of a session — which is exactly where this test
  // wants to be. The record has already been through promotion.
  assert.equal(started.status, 500);
  assert.match(started.body.error, /Setup failed/);

  const task = (await api('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'promote-me');
  assert.equal(task.createdAt, createdAt, 'the same record — how long the idea waited is not reset');
  assert.ok(task.updatedAt > createdAt, 'and it moved');
  assert.equal(task.body, 'the brief as it was rewritten at the last moment', 'the override reached the record');
  assert.equal(task.startedBy, 'zzq-testname: "yes, go"', 'what was said, on the task');
  assert.equal(task.branch, 'agent/promote-me');
  assert.ok(task.worktree, 'the worktree it got');
  assert.equal(task.model, 'claude-opus-5', 'the team default, resolved at the moment it started');
  // Past the worktree, a failure is `failed` and keeps the checkout as evidence. It must
  // never fall back to `pending` — a record that went back on the backlog with a
  // half-built checkout on disk is the one shape nothing downstream can reason about.
  assert.equal(task.state, 'failed');
  assert.ok(fs.existsSync(task.worktree), 'the evidence is still there');
  // `dispatchedAt` is stamped by the `state: 'dispatched'` update that follows a
  // successful launch, so it is still null here; `test/tasks.test.js` pins that half at
  // the store, and the end-to-end bench proves it on a real promotion.
  assert.equal(task.dispatchedAt, null);
});

test('modelReason is stored on an ordinary dispatch, not only posted to the room', async () => {
  // It has been validated at dispatch and posted to the room since the model argument
  // existed, and never written to the record — so every worker that has ever run carries
  // a blank one, and the reason behind a departure from the default was lost the moment
  // the room line scrolled away.
  const res = await api('POST', '/api/team/dispatch', {
    folder: gitRepo,
    label: 'reasoned',
    body: 'mechanical',
    model: 'claude-sonnet-5',
    modelReason: 'wide and mechanical, nothing to judge',
  });
  assert.equal(res.status, 500, res.body.error);
  assert.match(res.body.error, /Setup failed/);

  const task = (await api('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'reasoned');
  assert.equal(task.model, 'claude-sonnet-5');
  assert.equal(task.modelReason, 'wide and mechanical, nothing to judge');
  assert.equal(task.startedBy, null, 'nothing was promoted — this one was started directly');
});

test('a promotion at cap is refused like any other dispatch, and stays pending', async () => {
  // `pending` is outside `ACTIVE` so a backlog cannot fill the cap — which means starting
  // one moves a task *into* the counted set, and the cap has to see it coming.
  await api('POST', '/api/team/tasks', { folder: gitRepo, label: 'at-cap', body: 'waiting for a slot' });
  for (const n of [1, 2, 3]) {
    await api('POST', '/api/team/tasks', { folder: gitRepo, label: `filler-${n}`, body: 'x' });
    await api('PATCH', `/api/team/tasks/filler-${n}`, { state: 'working', summary: 'busy' });
  }

  const res = await api('POST', '/api/team/dispatch', { folder: gitRepo, id: 'at-cap' });
  assert.equal(res.status, 409);
  // The promotion phrasing: it already has a home to go back to, and the refusal says so.
  assert.equal(res.body.error, 'Already 3 active workers on this repo — at-cap stays pending.');

  const task = (await api('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'at-cap');
  assert.equal(task.state, 'pending', 'refused, and still on the backlog to try again later');
  assert.equal(task.body, 'waiting for a slot');
});

test('a plain dispatch at cap points at the backlog instead', async () => {
  // Reuses the cap the previous test filled: three `filler-*` tasks are `working` on
  // `gitRepo`. A dispatch with no `id` has no record to fall back to, so the refusal
  // names the way to get one instead of just saying no.
  const res = await api('POST', '/api/team/dispatch', { folder: gitRepo, label: 'once-more', body: 'x' });
  assert.equal(res.status, 409);
  assert.equal(
    res.body.error,
    'Already 3 active workers on this repo — record it with task_add and start it when a slot frees.',
  );
  assert.equal((await api('GET', '/api/team/tasks')).body.tasks.some((t) => t.id === 'once-more'), false);
});

/*
 * Cancelling a pending task — the same close endpoint, guarded at the top so it never
 * has to pretend a worktree existed or a task ran.
 */

test('closing a pending task with outcome:done is refused — nothing ran to be done', async () => {
  const recorded = await api('POST', '/api/team/tasks', {
    folder: gitRepo, label: 'never-started', body: 'an idea, nothing more',
  });
  assert.equal(recorded.status, 200);

  const res = await api('POST', '/api/team/tasks/never-started/close', { outcome: 'done' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'never-started never started — it cannot be done.');

  const task = (await api('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'never-started');
  assert.equal(task.state, 'pending', 'untouched by the refused close');
});

test('dropping a pending task marks it abandoned and says so, without claiming a worktree', async () => {
  const recorded = await api('POST', '/api/team/tasks', {
    folder: gitRepo, label: 'drop-me', body: 'kept, then reconsidered',
  });
  assert.equal(recorded.status, 200);

  const res = await api('POST', '/api/team/tasks/drop-me/close', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.task.state, 'abandoned');

  const task = (await api('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'drop-me');
  assert.equal(task.state, 'abandoned');

  const file = path.join(stateDir, 'teams', teamKeyFor(gitRepo), 'room.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const entry = lines.findLast((e) => e.about === 'drop-me');
  assert.equal(entry.kind, 'system');
  assert.equal(entry.text, 'Pending task drop-me dropped before it started.');
  assert.doesNotMatch(entry.text, /worktree/, 'nothing to claim was removed');
  assert.equal(entry.event, undefined, 'grey, not a colour — the drop is not the dispatch green');
});

/*
 * The mobile view's three additive API changes: `GET /api/teams`, the `folder`/`brief`
 * query params on `GET /api/team/tasks`, and `GET /api/team/tasks/:id`. None of them may
 * change what the desktop already gets from `GET /api/team/tasks` with no query string.
 */

/** Write a bare `team.json` straight to disk, the way `prepareTriggerTeam` does — no
 *  `ensureTeam`, so a directory with no team.json or unparseable JSON is also reachable. */
function writeTeamJson(dirName, contents) {
  const dir = path.join(stateDir, 'teams', dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'team.json'), contents);
}

test('GET /api/teams reads repo out of team.json, never reconstructs it from the directory name', async () => {
  const plainRepo = path.join(stateDir, 'TeamsListPlain');
  // A repo with a hyphenated path segment: teamKeyFor joins every `/` with `-`, so a
  // naive reverse (split every `-`, join with `/`) would turn this into
  // `.../Teams/List/Ambiguous`, not `.../Teams-List/Ambiguous`. Proves T1 is respected.
  const ambiguousRepo = path.join(stateDir, 'Teams-List', 'Ambiguous');

  writeTeamJson(teamKeyFor(plainRepo), JSON.stringify({ repo: plainRepo }));
  writeTeamJson(teamKeyFor(ambiguousRepo), JSON.stringify({ repo: ambiguousRepo }));
  writeTeamJson('junk-no-team-json'); // a directory with no team.json at all
  writeTeamJson('junk-bad-json', '{ not actually json');

  const res = await api('GET', '/api/teams');
  assert.equal(res.status, 200);

  const byName = Object.fromEntries(res.body.teams.map((t) => [t.name, t.repo]));
  assert.equal(byName.TeamsListPlain, plainRepo);
  assert.equal(byName.Ambiguous, ambiguousRepo, 'read out of team.json, not reconstructed from the dash-joined dir name');
  assert.equal(Object.prototype.hasOwnProperty.call(byName, 'junk-no-team-json'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(byName, 'junk-bad-json'), false);

  const names = res.body.teams.map((t) => t.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'sorted by name');
});

/*
 * `GET /api/config` carries what this software *is*, and the rail's footer draws it.
 *
 * Against the running panel rather than against `config.js`'s exports, because the fact
 * worth pinning is that the *response* carries it — the footer reads nothing else, and
 * `web/` is forbidden a second copy of either value. `package.json` is read here the same
 * way the server reads it, so a version bump can never leave the endpoint behind: this
 * asserts they agree, not that either is a particular string.
 */
test('GET /api/config carries the version and the browsable repository from package.json', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const res = await api('GET', '/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.version, pkg.version);
  assert.match(res.body.version, /^\d+\.\d+\.\d+/, 'a real version, not an empty string dressed as one');

  // Browsable, not a clone URL: the `.git` suffix `repository.url` carries is what the
  // server strips, and a footer link ending in `.git` is a download prompt.
  assert.equal(res.body.repoUrl, pkg.repository.url.replace(/\.git$/, ''));
  assert.equal(res.body.repoUrl, pkg.homepage, 'homepage and repository name the same place');
  assert.match(res.body.repoUrl, /^https:\/\//, 'something a browser can open');
});

test('GET /api/team/tasks: ?folder= is an exact match, ?brief=0 omits body, absent params are unchanged', async () => {
  const repoA = path.join(stateDir, 'MobileTeamA');
  const repoB = path.join(stateDir, 'MobileTeamB');
  await fsp.mkdir(repoA, { recursive: true });
  await fsp.mkdir(repoB, { recursive: true });

  await api('POST', '/api/team/tasks', { folder: repoA, label: 'mobile-a-one', body: 'brief a1' });
  await api('POST', '/api/team/tasks', { folder: repoA, label: 'mobile-a-two', body: 'brief a2' });
  await api('POST', '/api/team/tasks', { folder: repoB, label: 'mobile-b-one', body: 'brief b1' });

  const filtered = await api('GET', `/api/team/tasks?folder=${encodeURIComponent(repoA)}`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.tasks.length, 2, 'exact match on repo, not a substring match');
  assert.ok(filtered.body.tasks.every((t) => t.repo === repoA));

  const noBrief = await api('GET', `/api/team/tasks?folder=${encodeURIComponent(repoA)}&brief=0`);
  assert.equal(noBrief.status, 200);
  assert.equal(noBrief.body.tasks.length, 2);
  assert.ok(noBrief.body.tasks.every((t) => !('body' in t)), 'brief=0 strips body from every row');

  // The regression guard: no params at all must still carry body, for the desktop's own
  // 3-second poll, which this work must not change.
  const unfiltered = await api('GET', '/api/team/tasks');
  assert.equal(unfiltered.status, 200);
  assert.ok(unfiltered.body.tasks.length >= 3);
  assert.ok(unfiltered.body.tasks.every((t) => 'body' in t), 'no ?brief=0 means body stays, exactly as before');
});

test('GET /api/team/tasks/:id returns the one record with its body, and 404s for an unknown id', async () => {
  const found = await api('GET', '/api/team/tasks/mobile-a-one');
  assert.equal(found.status, 200);
  assert.equal(found.body.task.id, 'mobile-a-one');
  assert.equal(found.body.task.body, 'brief a1');

  const missing = await api('GET', '/api/team/tasks/no-such-task');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Unknown task/);
});

/*
 * `POST /api/trigger` — the webhook door.
 *
 * Everything a webhook can be told, short of the two answers that need a live tmux pane
 * (`delivered` and `queued`), which are benched by hand against a real lead. What is here
 * is every refusal, and — just as much the point — what each refusal does and does not
 * write into `room.jsonl`. A refused credential must reach stderr and nowhere else: the
 * room is append-only and it is the maintainer's scan surface, so anyone who could reach the port
 * and guess a folder would otherwise have a flood vector.
 *
 * No lead is running in any of these folders (there is no tmux here at all), so every
 * accepted phrase lands on the no-lead 409. That is the case worth pinning anyway — it is
 * the one ruled to refuse rather than launch a lead.
 */

let triggerRepo;

/** A folder with a team that has opted in to exactly one phrase. Not a git checkout —
 *  nothing here cuts a worktree. */
function prepareTriggerTeam() {
  triggerRepo = path.join(stateDir, 'TriggerRepo');
  fs.mkdirSync(triggerRepo, { recursive: true });
  const dir = path.join(stateDir, 'teams', teamKeyFor(triggerRepo));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'team.json'),
    JSON.stringify(
      { repo: triggerRepo, triggers: [{ id: 'feedback-review', match: '^review feedback issue \\d{1,6}$' }] },
      null,
      2,
    ),
  );
}

/** POST /api/trigger with whatever credential you hand it. `auth: null` sends no header
 *  at all, which is a different failure from sending a wrong one. */
async function trigger(body, { auth = TOKEN, at = port } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth !== null) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(`http://127.0.0.1:${at}/api/trigger`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Every line in a team's room, oldest first. */
function roomLines(dir) {
  const file = path.join(stateDir, 'teams', teamKeyFor(dir), 'room.jsonl');
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test('a trigger with no credential is a 401 that leaves no trace in the room', async () => {
  prepareTriggerTeam();
  const before = roomLines(triggerRepo).length;

  const none = await trigger({ folder: triggerRepo, text: 'review feedback issue 66' }, { auth: null });
  assert.equal(none.status, 401);

  const wrong = await trigger({ folder: triggerRepo, text: 'review feedback issue 66' }, { auth: 'nope' });
  assert.equal(wrong.status, 401, 'a wrong token is the same answer as no token');

  // …and one the right length, so the equal-length short-circuit is not what refused it.
  const sameLength = await trigger(
    { folder: triggerRepo, text: 'review feedback issue 66' },
    { auth: 'x'.repeat(TOKEN.length) },
  );
  assert.equal(sameLength.status, 401);

  assert.equal(roomLines(triggerRepo).length, before, 'three refused credentials, nothing appended');
});

test('a credential is checked before the folder is — an unauthenticated caller learns nothing', async () => {
  // The 404 below is the *authenticated* answer for this folder. Unauthenticated it must
  // be a 401, or the endpoint is a probe for which paths on this Mac have teams.
  const missing = path.join(stateDir, 'NoTeamHere');
  assert.equal((await trigger({ folder: missing, text: 'x' }, { auth: null })).status, 401);
  assert.equal((await trigger({ folder: missing, text: 'x' })).status, 404);
});

test('a folder that is not an absolute path is refused before anything is resolved', async () => {
  const res = await trigger({ folder: 'TriggerRepo', text: 'review feedback issue 66' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /absolute path/);
});

test('a phrase off the allow-list is a 403, and the room says loudly what was refused', async () => {
  const before = roomLines(triggerRepo).length;
  const res = await trigger({ folder: triggerRepo, text: 'review feedback issue 66 and also refactor auth' });
  assert.equal(res.status, 403);

  const lines = roomLines(triggerRepo);
  assert.equal(lines.length, before + 1);
  const entry = lines.at(-1);
  assert.equal(entry.kind, 'system');
  assert.equal(entry.event, 'trigger');
  assert.equal(entry.alert, true, 'a refused phrase is one the maintainer should see');
  assert.match(entry.text, /and also refactor auth/, 'quotes what it refused, verbatim');
});

test('a team with no triggers refuses everything — opting in is what adds the surface', async () => {
  // `gitRepo`'s team.json has no `triggers` key at all, so `DEFAULTS.triggers` is `[]`.
  const res = await trigger({ folder: gitRepo, text: 'review feedback issue 66' });
  assert.equal(res.status, 403);
  assert.equal(roomLines(gitRepo).at(-1).alert, true);
});

test('an allowed phrase with no lead running is a 409 and a room line — and launches nothing', async () => {
  const before = roomLines(triggerRepo).length;
  const res = await trigger({ folder: triggerRepo, text: 'review feedback issue 66' });
  assert.equal(res.status, 409);
  assert.equal(res.body.trigger, 'feedback-review', 'the allow-list said yes; the roster said no');

  const entry = roomLines(triggerRepo).at(-1);
  assert.equal(entry.event, 'trigger');
  assert.equal(entry.alert, true);
  assert.match(entry.text, /no lead is running/);
  assert.match(entry.text, /Nothing was launched/);
  assert.equal(roomLines(triggerRepo).length, before + 1);
});

test('the same phrase again inside the window is a duplicate, and posts nothing', async () => {
  // The retry a webhook sends when it times out. It is deduped *because the allow-list
  // accepted it*, not because it was delivered — so this holds even though the request
  // above ended on a 409. One phrase, one room line per window.
  const before = roomLines(triggerRepo).length;
  const res = await trigger({ folder: triggerRepo, text: 'review feedback issue 66' });
  assert.equal(res.status, 409);
  assert.equal(res.body.duplicate, true);
  assert.equal(roomLines(triggerRepo).length, before, 'a retry does not get its own line');

  // A different issue number is a different event, and goes through the whole path again.
  const other = await trigger({ folder: triggerRepo, text: 'review feedback issue 67' });
  assert.equal(other.status, 409);
  assert.equal(other.body.duplicate, undefined);
  assert.equal(roomLines(triggerRepo).length, before + 1);
});

test('with no FOREMAN_TRIGGER_TOKEN the endpoint is off — 503 even for a well-formed request', async () => {
  // A server of its own, because the token is read once at boot. Its own state dir too:
  // two panels must not run the queue at once, and a second one pointed anywhere real
  // boots its own worktree GC.
  const otherState = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-notoken-'));
  const otherPort = await freePort();
  const otherRepo = path.join(otherState, 'TriggerRepo');
  fs.mkdirSync(path.join(otherState, 'teams', teamKeyFor(otherRepo)), { recursive: true });
  fs.writeFileSync(
    path.join(otherState, 'teams', teamKeyFor(otherRepo), 'team.json'),
    JSON.stringify({ repo: otherRepo, triggers: [{ id: 'feedback-review', match: '^review feedback issue \\d{1,6}$' }] }),
  );

  const env = { ...process.env, FOREMAN_PORT: String(otherPort), FOREMAN_HOST: '127.0.0.1', FOREMAN_STATE_DIR: otherState };
  delete env.FOREMAN_TRIGGER_TOKEN;
  const off = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });
  process.on('exit', () => off.kill());

  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${otherPort}/api/team/tasks`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('the second scratch panel never came up');
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Everything about this request is right except the feature being on.
    const res = await trigger({ folder: otherRepo, text: 'review feedback issue 66' }, { at: otherPort });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /FOREMAN_TRIGGER_TOKEN/, 'names the one place to look');

    const file = path.join(otherState, 'teams', teamKeyFor(otherRepo), 'room.jsonl');
    assert.equal(fs.existsSync(file), false, 'off means off — nothing typed, nothing logged');
  } finally {
    await stop(off);
    await fsp.rm(otherState, { recursive: true, force: true });
  }
});

/*
 * `GET /api/team/merge` and `POST /api/team/merge` — the merge queue's door.
 *
 * Its own panel, its own state dir and its own repo, for one reason the file above cannot
 * give it: these need **review tasks with real branches**, and nothing reachable over HTTP
 * puts a task into `review` holding a branch — a dispatch would launch a Claude session.
 * So the records are fabricated on disk and the panel is started on top of them, which is
 * also the only way to bench this at all: all 89 records in the real store are `done` and
 * there are zero in `review`.
 *
 * No lead is running here (there is no tmux at all), so every well-formed press lands on
 * the no-lead 409 — which is the case ruled to refuse rather than launch one, and
 * is the case worth pinning. The two answers that need a live pane (`delivered` and
 * `queued`) are benched by hand against a real lead, exactly as the trigger's are.
 */

let mergeState;
let mergeRepo;
let mergePort;
let mergePanel;

/** A real checkout with three branches: two that both change `web/app.js`, one that
 *  changes only `server/own.js`. The Gitea #50/#51 shape, and a clean third beside it. */
function prepareMergeRepo(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first']);

  const branch = (name, files) => {
    git(['checkout', '-q', '-B', name, 'main']);
    for (const [file, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', name]);
    git(['checkout', '-q', 'main']);
  };
  branch('agent/trust-gate', { 'web/app.js': 'trust gate\n', 'web/m/cards.js': 'x\n' });
  branch('agent/permission-classify', { 'web/app.js': 'classify\n' });
  branch('agent/mobile-stop-icon', { 'server/own.js': 'y\n' });

  // A merge queue only exists on a repo with a forge — with none, the block is removed
  // rather than filled with rows nobody can press. The URL points nowhere and never
  // needs to: detection reads `.git/config`, never the network. Paired with the scratch
  // `.claude.json` below, which is what makes the `gitea` reading deterministic instead
  // of depending on what the person running this suite happens to have registered.
  git(['remote', 'add', 'origin', 'http://forge.example.com:3002/team/mergerepo.git']);
}

/** Three fabricated `review` records, written where the store will read them at boot. */
function writeMergeTasks(state, repo) {
  const rec = (id, over) => ({
    id, repo, kind: 'build', body: `${id} did a thing\nmore detail`, source: 'chat',
    state: 'review', branch: `agent/${id}`, worktree: null, base: 'main', staleBase: false,
    model: null, modelReason: null, startedBy: null, tmuxSession: null,
    createdAt: '2026-08-30T08:00:00.000Z', ...over,
  });
  fs.writeFileSync(
    path.join(state, 'tasks.json'),
    JSON.stringify({
      'trust-gate': rec('trust-gate', { pr: 'http://box/pulls/50', updatedAt: '2026-08-30T09:00:00.000Z' }),
      'permission-classify': rec('permission-classify', { pr: 'http://box/pulls/51', updatedAt: '2026-08-30T09:30:00.000Z' }),
      'mobile-stop-icon': rec('mobile-stop-icon', { pr: 'http://box/pulls/53', updatedAt: '2026-08-30T10:00:00.000Z' }),
      'no-pr-yet': rec('no-pr-yet', { pr: null, branch: null, updatedAt: '2026-08-30T10:30:00.000Z' }),
      'shape-it': rec('shape-it', { kind: 'plan', pr: null, branch: null, updatedAt: '2026-08-30T10:45:00.000Z' }),
      'long-done': rec('long-done', { state: 'done', pr: 'http://box/pulls/40', updatedAt: '2026-08-29T10:00:00.000Z' }),
    }, null, 2),
  );
}

async function mergeApi(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${mergePort}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const mergeRoom = () => {
  const file = path.join(mergeState, 'teams', teamKeyFor(mergeRepo), 'room.jsonl');
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

test.before(async () => {
  mergeState = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-merge-'));
  mergeRepo = path.join(mergeState, 'MergeRepo');
  prepareMergeRepo(mergeRepo);
  fs.mkdirSync(path.join(mergeState, 'teams', teamKeyFor(mergeRepo)), { recursive: true });
  fs.writeFileSync(
    path.join(mergeState, 'teams', teamKeyFor(mergeRepo), 'team.json'),
    JSON.stringify({ repo: mergeRepo }, null, 2),
  );
  writeMergeTasks(mergeState, mergeRepo);
  mergePort = await freePort();

  // Read, never written — and pointed at a scratch file so the forge reading is the
  // suite's own fact rather than the operator's installed MCP servers.
  fs.writeFileSync(
    path.join(mergeState, 'claude.json'),
    JSON.stringify({ mcpServers: { gitea: { type: 'http', url: 'http://mcp.example.com:8093/mcp' } } }, null, 2),
  );

  mergePanel = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOREMAN_PORT: String(mergePort),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: mergeState,
      FOREMAN_CLAUDE_CONFIG: path.join(mergeState, 'claude.json'),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  process.on('exit', () => mergePanel?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${mergePort}/api/team/tasks`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('the merge-queue scratch panel never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

test.after(async () => {
  await stop(mergePanel);
  if (mergeState) await fsp.rm(mergeState, { recursive: true, force: true });
});

test('the queue needs a folder, and an absolute one', async () => {
  assert.equal((await mergeApi('GET', '/api/team/merge')).status, 400);
  const relative = await mergeApi('GET', '/api/team/merge?folder=MergeRepo');
  assert.equal(relative.status, 400);
  assert.match(relative.body.error, /absolute path/);
});

test('the queue is every review task, oldest first, with the overlap named on the rows', async () => {
  const res = await mergeApi('GET', `/api/team/merge?folder=${encodeURIComponent(mergeRepo)}`);
  assert.equal(res.status, 200);
  // A row for every review task — including the one with no PR yet and the planner, which
  // is what keeps this count equal to the rail's amber `N in review` (`sessions.js:189`
  // filters on `state === 'review'` and nothing else). The `done` task is not one.
  assert.deepEqual(
    res.body.rows.map((r) => r.id),
    ['trust-gate', 'permission-classify', 'mobile-stop-icon', 'no-pr-yet', 'shape-it'],
  );
  const by = new Map(res.body.rows.map((r) => [r.id, r]));
  assert.equal(by.get('trust-gate').prNumber, 50);
  assert.equal(by.get('trust-gate').title, 'trust-gate did a thing');
  assert.deepEqual(by.get('trust-gate').shares, [{ id: 'permission-classify', paths: ['web/app.js'] }]);
  assert.equal(by.get('permission-classify').sharesNote, 'also changed by trust-gate: web/app.js');
  assert.deepEqual(by.get('mobile-stop-icon').shares, [], 'the clean third shares nothing');
  assert.equal(by.get('no-pr-yet').state, 'no-pr');
  assert.equal(by.get('no-pr-yet').prNumber, null);
  assert.equal(by.get('no-pr-yet').note, 'waiting on the lead to open the PR');
  // The planner shares that state — no new state was added for it, because items 2 and 3
  // are written against the six they were given — and is told apart by `kind`.
  assert.equal(by.get('shape-it').state, 'no-pr');
  assert.equal(by.get('shape-it').kind, 'plan');
  assert.equal(by.get('shape-it').note, 'a plan — read and approved, not merged');

  // `merge all` is withheld, and the sentence that replaces it names both tasks and the
  // file — computed here, so both clients say the same thing.
  assert.equal(res.body.batch.allowed, false);
  assert.match(res.body.batch.why, /trust-gate and permission-classify both change web\/app\.js/);
  // No tmux in a test run, so there is no lead; the rows still draw.
  assert.equal(res.body.lead, null);
});

test('a merge names its tasks, and says which PR each row was showing', async () => {
  const folder = mergeRepo;
  const bad = await Promise.all([
    mergeApi('POST', '/api/team/merge', { tasks: ['trust-gate'] }),
    mergeApi('POST', '/api/team/merge', { folder, tasks: [] }),
    mergeApi('POST', '/api/team/merge', { folder, tasks: ['trust-gate', 'trust-gate'] }),
    // `expect` is required, not optional: it is what catches a PR that moved under the
    // click, and optional safety is not safety.
    mergeApi('POST', '/api/team/merge', { folder, tasks: ['trust-gate'] }),
    mergeApi('POST', '/api/team/merge', { folder, tasks: ['trust-gate'], expect: [{ id: 'other', pr: 'x' }] }),
  ]);
  assert.deepEqual(bad.map((r) => r.status), [400, 400, 400, 400, 400]);
  assert.match(bad[3].body.error, /`expect`/);
  assert.match(bad[4].body.error, /exactly the tasks being merged/);

  const unknown = await mergeApi('POST', '/api/team/merge', {
    folder, tasks: ['no-such-task'], expect: [{ id: 'no-such-task', pr: 'x' }],
  });
  assert.equal(unknown.status, 404);

  // The row was drawn from a poll up to three seconds old, and the record has moved.
  const moved = await mergeApi('POST', '/api/team/merge', {
    folder, tasks: ['trust-gate'], expect: [{ id: 'trust-gate', pr: 'http://box/pulls/49' }],
  });
  assert.equal(moved.status, 409);
  assert.equal(moved.body.stale, true);
  assert.match(moved.body.error, /changed under the click/);

  const closed = await mergeApi('POST', '/api/team/merge', {
    folder, tasks: ['long-done'], expect: [{ id: 'long-done', pr: 'http://box/pulls/40' }],
  });
  assert.equal(closed.status, 409);
  assert.match(closed.body.error, /is done, not in review/);

  const noPr = await mergeApi('POST', '/api/team/merge', {
    folder, tasks: ['no-pr-yet'], expect: [{ id: 'no-pr-yet', pr: null }],
  });
  assert.equal(noPr.status, 409);
  assert.match(noPr.body.error, /no PR yet/);

  // A planner is refused **by kind**, and the message proves the ordering: it has no PR
  // either, so the check below would have caught it — and a rule that holds by accident
  // stops holding the day the data changes. The row is drawn so the count agrees; whether
  // it can be merged is the server's answer, never a habit of a client leaving it out.
  const planner = await mergeApi('POST', '/api/team/merge', {
    folder, tasks: ['shape-it'], expect: [{ id: 'shape-it', pr: null }],
  });
  assert.equal(planner.status, 409);
  assert.match(planner.body.error, /is a plan — it is read and approved, not merged/);
  assert.doesNotMatch(planner.body.error, /no PR yet/);
});

test('a batch that does not compose is refused by the server, naming both tasks', async () => {
  // The refusal is the panel's, not the browser's: a client that drew `merge all` anyway
  // still cannot merge these as one press. Three ids — two that share `web/app.js` and one
  // clean — and it is withheld **wholesale**, following `trigger.js`'s `compile()`.
  const before = mergeRoom().length;
  const res = await mergeApi('POST', '/api/team/merge', {
    folder: mergeRepo,
    tasks: ['trust-gate', 'permission-classify', 'mobile-stop-icon'],
    expect: [
      { id: 'trust-gate', pr: 'http://box/pulls/50' },
      { id: 'permission-classify', pr: 'http://box/pulls/51' },
      { id: 'mobile-stop-icon', pr: 'http://box/pulls/53' },
    ],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.batch, false);
  assert.match(res.body.error, /trust-gate and permission-classify both change web\/app\.js/);
  assert.match(res.body.error, /merge them one at a time/);
  assert.deepEqual(res.body.tasks, ['trust-gate', 'permission-classify', 'mobile-stop-icon']);
  assert.equal(mergeRoom().length, before, 'a refused batch types nothing and logs nothing');
});

test('an individual press is never refused by composition — it reaches the lead check', async () => {
  // The same overlapping task, alone. It gets past the composition gate that just refused
  // the batch and lands on the no-lead 409, which is the only thing left in a test run
  // with no tmux. That is the rule the whole design turns on.
  const before = mergeRoom().length;
  const res = await mergeApi('POST', '/api/team/merge', {
    folder: mergeRepo, tasks: ['trust-gate'], expect: [{ id: 'trust-gate', pr: 'http://box/pulls/50' }],
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /No lead is running/);
  assert.doesNotMatch(res.body.error, /both change/, 'the overlap annotated it, it did not refuse it');

  // No lead is a 409 **and a room line**, and nothing is launched to fix it.
  const lines = mergeRoom();
  assert.equal(lines.length, before + 1);
  const entry = lines.at(-1);
  assert.equal(entry.kind, 'system');
  assert.equal(entry.event, 'merge', 'keyed on `event`, so a reword can never turn its colour off');
  assert.equal(entry.alert, true);
  assert.equal(entry.from, 'panel');
  assert.deepEqual(entry.tasks, ['trust-gate']);
  assert.match(entry.text, /no lead is running/);
  assert.match(entry.text, /Nothing was launched, and nothing was merged\./);
});

test('a press with no lead is not deduped — the stamp is for a line that actually went', async () => {
  // `triggerSeen` stamps on arrival because a webhook retries and must be absorbed. A
  // human whose press was refused for want of a lead should be able to start one and press
  // again, so this stamps on success only — and the second attempt goes the whole way
  // through again rather than coming back `duplicate`.
  const before = mergeRoom().length;
  const res = await mergeApi('POST', '/api/team/merge', {
    folder: mergeRepo, tasks: ['trust-gate'], expect: [{ id: 'trust-gate', pr: 'http://box/pulls/50' }],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.duplicate, undefined);
  assert.match(res.body.error, /No lead is running/);
  assert.equal(mergeRoom().length, before + 1);
});

/* ------------------------------------------- the forge, and the close gate --- */

/*
 * A third scratch panel, on a repo that is deliberately on **`master`** and has no remote
 * at all — the shape a stranger's first dispatch actually has, and the shape `main`
 * hardcoded in four places made unusable.
 *
 * Two things are proved here that cannot be proved anywhere else, because both are the
 * *endpoint's* behaviour rather than a function's:
 *
 *   - `forgeResolved` and `baseResolved` are computed on the response and refused by
 *     PATCH, the same way `setupResolved` already is;
 *   - `task_close` with outcome "done" is **refused** while the branch is unmerged, the
 *     branch survives the refusal, and the close succeeds once it has been merged by hand.
 *     That gate is the only thing standing in front of `git branch -D`.
 */

let gatePanel;
let gatePort;
let gateState;
let gateRepo;

const gateApi = async (method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${gatePort}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test.before(async () => {
  gateState = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-gate-'));
  gateRepo = path.join(gateState, 'GateRepo');
  const git = (args, cwd = gateRepo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(gateRepo, { recursive: true });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(gateRepo, 'README.md'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first']);

  // A worker's checkout, made the way the panel makes one, with a commit on it that has
  // gone nowhere. This is the state a close must refuse.
  const wt = path.join(gateState, 'worktrees', 'GateRepo-unmerged');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(['worktree', 'add', '-q', wt, '-b', 'agent/unmerged', 'master']);
  fs.writeFileSync(path.join(wt, 'work.txt'), 'the work nobody merged\n');
  git(['add', '-A'], wt);
  git(['commit', '-q', '-m', 'work'], wt);

  fs.mkdirSync(path.join(gateState, 'teams', teamKeyFor(gateRepo)), { recursive: true });
  fs.writeFileSync(
    path.join(gateState, 'teams', teamKeyFor(gateRepo), 'team.json'),
    JSON.stringify({ repo: gateRepo }, null, 2),
  );
  fs.writeFileSync(
    path.join(gateState, 'tasks.json'),
    JSON.stringify({
      unmerged: {
        id: 'unmerged', repo: gateRepo, kind: 'build', body: 'work that was never merged',
        source: 'chat', state: 'review', branch: 'agent/unmerged', worktree: wt, base: 'master',
        staleBase: true, model: null, modelReason: null, startedBy: null, tmuxSession: null,
        pr: null, createdAt: '2026-08-31T08:00:00.000Z', updatedAt: '2026-08-31T09:00:00.000Z',
      },
    }, null, 2),
  );

  gatePort = await freePort();
  gatePanel = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOREMAN_PORT: String(gatePort),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: gateState,
      // No MCP servers registered at all: this repo has no remote, so the reading is
      // `no remote` whatever is installed — and the suite says so rather than inheriting it.
      FOREMAN_CLAUDE_CONFIG: path.join(gateState, 'claude.json'),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  fs.writeFileSync(path.join(gateState, 'claude.json'), JSON.stringify({ mcpServers: {} }, null, 2));
  process.on('exit', () => gatePanel?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${gatePort}/api/team/tasks`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('the close-gate scratch panel never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

test.after(async () => {
  await stop(gatePanel);
  if (gateState) await fsp.rm(gateState, { recursive: true, force: true });
});

test('the forge and the base branch are computed on the response, never stored', async () => {
  const res = await gateApi('GET', `/api/team/config?folder=${encodeURIComponent(gateRepo)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.forgeResolved.reading, 'no remote');
  assert.equal(res.body.forgeResolved.forge, null);
  assert.match(res.body.forgeResolved.reason, /no origin remote/);
  // The A3 defect, at the endpoint: this repo is on `master`, and the panel says so.
  assert.equal(res.body.baseResolved.branch, 'master');
  assert.equal(res.body.forge, undefined, 'nothing is stored — it is computed per response');
  assert.equal(res.body.base, undefined);

  const onDisk = JSON.parse(fs.readFileSync(path.join(gateState, 'teams', teamKeyFor(gateRepo), 'team.json'), 'utf8'));
  assert.equal(onDisk.forge, undefined);
  assert.equal(onDisk.forgeResolved, undefined);
  assert.equal(onDisk.base, undefined);
});

test('PATCH ignores a forge and a base, exactly the way it ignores setup', async () => {
  const res = await gateApi('PATCH', '/api/team/config', {
    folder: gateRepo, forge: 'github', base: 'main', setup: 'rm -rf /', maxWorkers: 2,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.maxWorkers, 2, 'the writable field did land');
  assert.equal(res.body.forgeResolved.reading, 'no remote', 'still detected, not what was sent');
  assert.equal(res.body.baseResolved.branch, 'master');

  const onDisk = JSON.parse(fs.readFileSync(path.join(gateState, 'teams', teamKeyFor(gateRepo), 'team.json'), 'utf8'));
  assert.equal(onDisk.forge, undefined, 'a control the user cannot answer correctly is not a control');
  assert.equal(onDisk.base, undefined);
  assert.equal(onDisk.setup, undefined);
});

test('with no forge there is no merge queue — the block is absent, not greyed', async () => {
  const res = await gateApi('GET', `/api/team/merge?folder=${encodeURIComponent(gateRepo)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.forge, 'no remote');
  // `unmerged` is in `review`, so with a forge it would be a row. `.composer-above:empty`
  // is what collapses the strip, so the rows have to be absent rather than styled away.
  assert.deepEqual(res.body.rows, []);
});

test('closing as done is refused while the branch is unmerged, and the branch survives it', async () => {
  const git = (args, cwd = gateRepo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const res = await gateApi('POST', '/api/team/tasks/unmerged/close', { outcome: 'done' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /agent\/unmerged is not merged into master/);
  assert.match(res.body.error, /checked origin\/master and master/);
  assert.match(res.body.error, /outcome "abandon"/, 'the way out is named, never hidden');

  // The whole point: `git branch -D` did not run.
  assert.equal(git(['rev-parse', '--verify', 'agent/unmerged']).trim().length, 40, 'the branch is still here');
  const task = (await gateApi('GET', '/api/team/tasks')).body.tasks.find((t) => t.id === 'unmerged');
  assert.equal(task.state, 'review', 'and the record was not touched');
});

test('…and once it is merged by hand, the close succeeds and sweeps', async () => {
  const git = (args, cwd = gateRepo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(['merge', '-q', '--no-ff', 'agent/unmerged', '-m', 'merged by hand']);

  const res = await gateApi('POST', '/api/team/tasks/unmerged/close', { outcome: 'done' });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.state, 'done');

  const branches = git(['branch', '--list', 'agent/unmerged']).trim();
  assert.equal(branches, '', 'the branch is gone, now that it is safe for it to be');
  assert.ok(!fs.existsSync(path.join(gateState, 'worktrees', 'GateRepo-unmerged')), 'and the worktree with it');
});

/* ------------------------------------------- the stale planFile fallback --- */

/*
 * `GET /api/team/plans/:id` again, this time for the fallback: `task.planFile` is
 * recorded at dispatch and can go stale — a state-dir or team-key rename leaves it naming
 * a directory that no longer exists, while the plan itself sits untouched at the computed
 * `planPath(repo, id)`. Nothing reachable over HTTP produces that mismatch (a promoted
 * planner's `planFile` always agrees with the computed path), so, same as the merge
 * queue's records above, the mismatch is fabricated on disk. No git repo needed — this
 * endpoint never touches one.
 */

let planState;
let planRepo;
let planPort;
let planPanel;

const planApi = async (method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${planPort}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test.before(async () => {
  planState = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-plans-'));
  planRepo = path.join(planState, 'PlanRepo');
  fs.mkdirSync(planRepo, { recursive: true });

  // Where the plan actually lives — `plansDir`/`planPath` in server/team.js, spelled out
  // here for the same reason `teamKeyFor` is: this suite only ever talks to the server
  // over HTTP, never imports it.
  const plansDir = path.join(planState, 'teams', teamKeyFor(planRepo), 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  // Only `stale-record` gets a file, and it is written at the *computed* path — not at
  // the stale one the record below claims.
  fs.writeFileSync(path.join(plansDir, 'stale-record.md'), '# The plan\n\nDo the thing.\n');

  const oldPlansDir = path.join(planState, 'teams', 'An-Old-Team-Key', 'plans');
  const rec = (id, over) => ({
    id, repo: planRepo, kind: 'plan', body: `plan ${id}`, source: 'chat', state: 'done',
    branch: null, worktree: null, base: null, staleBase: false, model: null, modelReason: null,
    startedBy: null, tmuxSession: null, pr: null, createdAt: '2026-08-30T08:00:00.000Z',
    updatedAt: '2026-08-30T08:00:00.000Z',
    planFile: path.join(oldPlansDir, `${id}.md`),
    ...over,
  });
  fs.writeFileSync(
    path.join(planState, 'tasks.json'),
    JSON.stringify({
      'stale-record': rec('stale-record'),
      'missing-everywhere': rec('missing-everywhere'),
    }, null, 2),
  );

  planPort = await freePort();
  planPanel = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOREMAN_PORT: String(planPort),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: planState,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  process.on('exit', () => planPanel?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${planPort}/api/team/tasks`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('the plan-path scratch panel never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

test.after(async () => {
  await stop(planPanel);
  if (planState) await fsp.rm(planState, { recursive: true, force: true });
});

test('a stale recorded planFile falls back to the computed path and reads the plan that is really there', async () => {
  const res = await planApi('GET', '/api/team/plans/stale-record');
  assert.equal(res.status, 200);
  assert.equal(res.body.text, '# The plan\n\nDo the thing.\n');
  // Not the recorded (stale) path in `tasks.json` — the one the file actually sits at.
  const computed = path.join(planState, 'teams', teamKeyFor(planRepo), 'plans', 'stale-record.md');
  assert.equal(res.body.path, computed);
});

test('neither the recorded path nor the computed one exists — 404 naming both', async () => {
  const res = await planApi('GET', '/api/team/plans/missing-everywhere');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /No plan has been written yet — missing-everywhere is done/);
  const stale = path.join(planState, 'teams', 'An-Old-Team-Key', 'plans', 'missing-everywhere.md');
  const computed = path.join(planState, 'teams', teamKeyFor(planRepo), 'plans', 'missing-everywhere.md');
  assert.deepEqual(res.body.triedPaths, [stale, computed]);
  assert.equal(res.body.path, computed, 'the last one tried — where it would land, same as before this fix');
});
