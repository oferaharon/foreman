import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/*
 * `server/briefs.js` — the one assembly of what a session is launched reading, shared by
 * `launchLead` and by `GET /api/briefs`.
 *
 * Two claims are worth pinning and they are different in kind. The **agreement** claim is
 * about drift: the modal's whole promise is "this is what the next lead will read", so the
 * launch and the route have to come out byte-identical for one repo, and the only input
 * they differ on (`fresh`, which is a cache decision and not a content one) must not change
 * a character. The **no-writes** claim is about blast radius: reading a brief for a repo
 * nobody has started a team on must not seed that team's directory, `team.json` or
 * `decisions.md` — a read-only view that creates state is not read-only.
 *
 * Real throwaway repos, the way every other git wrapper here is tested, because the brief
 * is generated from `git remote get-url`, `git symbolic-ref` and `git config user.name` and
 * stubbing git to test what git said proves nothing.
 */

// Above the import, and the import below is `await import()` for the reason
// `worktree.test.js`'s own comment gives: ESM hoists every *static* import above every
// statement, so a static one here would freeze `STATE_DIR` against the real `~/.foreman`
// before this line ran — and this suite's whole second half is an assertion about what is
// and is not in the state dir. `test/state-dir.test.js` fails if this file goes static.
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-briefs-state-'));

const { assembleLead, briefsFor, foremanEntry, mcpFilePath } = await import('../server/briefs.js');
const { resetForgeCache } = await import('../server/forge.js');
const { resetBaseBranchCache } = await import('../server/base-branch.js');
const { teamDir, teamDefaults, readTeam } = await import('../server/team.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-briefs-'));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A throwaway repo on `branch`, with `origin` pointing wherever the caller says. */
function makeRepo(name, { branch = 'main', origin = null } = {}) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', branch], dir);
  git(['config', 'user.email', 'test@test'], dir);
  // Not a name anyone has: the brief interpolates this, and a literal that could also be
  // the machine's own git identity would let an assertion pass for the wrong reason.
  git(['config', 'user.name', 'zzq-testname'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'first'], dir);
  if (origin) git(['remote', 'add', 'origin', origin], dir);
  return dir;
}

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

/* ------------------------------------------- one assembly, two callers --- */

test('the launch path and the briefs route build the same lead brief', async () => {
  const repo = makeRepo('alpha', { origin: 'https://github.com/example/alpha.git' });
  const tDir = teamDir(repo);
  const decisionsFile = path.join(tDir, 'decisions.md');

  // What `launchLead` calls: `fresh: true`, because a launch is rare and a minute-stale
  // forge cache is exactly wrong on the launch after a `git remote add`.
  const launch = await assembleLead({
    repo,
    teamDir: tDir,
    decisionsFile,
    config: teamDefaults(repo),
    fresh: true,
  });

  // What the route calls. Same repo, no `fresh`.
  const route = await briefsFor(repo);

  assert.equal(route.briefs.lead, launch.brief, 'byte-identical, or the modal is a lie');
  assert.ok(launch.brief.includes(repo), 'the real repo path is in it');
  assert.ok(launch.brief.includes(decisionsFile), 'and the real decisions file');
  assert.match(launch.brief, /zzq-testname/, 'and the repo’s own git identity');
});

test('a repo on master gets a brief that says master, through both callers', async () => {
  // `gamma`'s reason for existing, one floor down: `main` was hardcoded in four places and
  // the team feature was simply unusable on a repo that does not have one.
  const repo = makeRepo('gamma', { branch: 'master', origin: 'https://github.com/example/gamma.git' });
  resetForgeCache();
  resetBaseBranchCache();

  const route = await briefsFor(repo);
  assert.equal(route.base, 'master');
  assert.ok(!/\bbranched from `?main`?\b/.test(route.briefs.planner), 'no assumed main');
  assert.ok(route.briefs.planner.includes('master'), 'the planner is told the real base');
  assert.ok(route.briefs.worker.includes('master'), 'and so is the worker');
});

test('the forge the brief describes is the demoted one, not the one detected', async () => {
  // The load-bearing half of sharing the assembly. A registered MCP entry carrying a
  // credential is refused at launch (`mcp.json` is world-readable) and the forge is demoted
  // to `push only` *before* the brief is written — so a route that resolved the forge and
  // skipped the demotion would show a lead being handed tools it will not have.
  const repo = makeRepo('beta', { origin: 'https://gitea.example.test/x/beta.git' });
  const userConfig = path.join(scratch, 'claude-with-token.json');
  fs.writeFileSync(
    userConfig,
    JSON.stringify({ mcpServers: { gitea: { type: 'stdio', env: { GITEA_ACCESS_TOKEN: 'nope' } } } }),
  );
  resetForgeCache();
  resetBaseBranchCache();

  const demoted = await assembleLead({
    repo,
    teamDir: teamDir(repo),
    decisionsFile: path.join(teamDir(repo), 'decisions.md'),
    config: teamDefaults(repo),
    deps: { userConfigFile: userConfig },
  });

  assert.equal(demoted.detected.reading, 'Gitea', 'detection still saw the forge');
  assert.equal(demoted.forge.reading, 'push only', 'and it was demoted before the brief');
  assert.equal(demoted.forge.forge, null);
  assert.equal(demoted.notes.length, 1, 'the refusal is said out loud, never dropped');
  assert.match(demoted.notes[0], /GITEA_ACCESS_TOKEN/);
  assert.match(demoted.notes[0], /mcp\.json is world-readable/);
  assert.ok(
    !demoted.mcpServers.gitea,
    'and the credential-carrying entry is not copied into the tool surface',
  );
  // The whole point: what the brief says matches what the file beside it would contain.
  // `push only` renders the no-PR section — a lead told its work stops at the branch, and
  // told nothing at all about gitea tools it does not have.
  assert.ok(demoted.brief.includes('No PRs on this repo'), 'the brief describes the demoted forge');
  assert.ok(!demoted.brief.includes('## Gitea'), 'and never the section for tools it was refused');
});

test('an entry with no credential is copied, and the forge stays what was detected', async () => {
  const repo = makeRepo('beta-clean', { origin: 'https://gitea.example.test/x/beta.git' });
  const userConfig = path.join(scratch, 'claude-clean.json');
  fs.writeFileSync(userConfig, JSON.stringify({ mcpServers: { gitea: { type: 'sse', url: 'http://x.test' } } }));
  resetForgeCache();
  resetBaseBranchCache();

  const out = await assembleLead({
    repo,
    teamDir: teamDir(repo),
    decisionsFile: path.join(teamDir(repo), 'decisions.md'),
    config: teamDefaults(repo),
    deps: { userConfigFile: userConfig },
  });

  assert.equal(out.forge.reading, 'Gitea', 'nothing to refuse, nothing demoted');
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.mcpServers.gitea, { type: 'sse', url: 'http://x.test' }, 'copied verbatim');
});

test('the self-merge paragraphs follow the team’s own toggle, not a default', async () => {
  const repo = makeRepo('toggles', { origin: 'https://github.com/example/toggles.git' });
  resetForgeCache();
  resetBaseBranchCache();
  const args = { repo, teamDir: teamDir(repo), decisionsFile: path.join(teamDir(repo), 'decisions.md') };

  const off = await assembleLead({ ...args, config: teamDefaults(repo) });
  const on = await assembleLead({ ...args, config: { ...teamDefaults(repo), toggles: { leadDecidesMerges: true } } });

  assert.notEqual(on.brief, off.brief, 'the toggle reaches the brief through the shared assembly');
  assert.ok(on.brief.includes('task_merge_check'), 'on: the lead is told how to decide');
  assert.ok(!off.brief.includes('task_merge_check'), 'off: it is not');
});

test('the foreman MCP entry has one spelling, and a worker’s carries its task', () => {
  const lead = foremanEntry({ repo: '/x/alpha', role: 'lead', port: 1234 });
  assert.equal(lead.type, 'stdio');
  assert.equal(lead.command, process.execPath);
  assert.equal(lead.args.length, 1);
  assert.ok(lead.args[0].endsWith(path.join('mcp', 'foreman.js')), 'resolved, never a bare name');
  assert.deepEqual(lead.env, { FOREMAN_PORT: '1234', FOREMAN_REPO: '/x/alpha', FOREMAN_ROLE: 'lead' });
  assert.ok(!('FOREMAN_TASK' in lead.env), 'a lead is not scoped to a task');

  const worker = foremanEntry({ repo: '/x/alpha', role: 'worker', task: 'issue-9-thing', port: 1234 });
  assert.equal(worker.env.FOREMAN_TASK, 'issue-9-thing');
  assert.equal(worker.env.FOREMAN_ROLE, 'worker');
});

/* --------------------------------------------------- and it writes nothing --- */

test('reading briefs for a repo with no team creates nothing on disk', async () => {
  const repo = makeRepo('untouched', { origin: 'https://github.com/example/untouched.git' });
  const tDir = teamDir(repo);
  resetForgeCache();
  resetBaseBranchCache();

  assert.ok(!fs.existsSync(tDir), 'precondition: no team dir');

  const out = await briefsFor(repo);

  assert.ok(!fs.existsSync(tDir), 'the team dir was not seeded');
  assert.ok(!fs.existsSync(path.join(tDir, 'team.json')));
  assert.ok(!fs.existsSync(path.join(tDir, 'decisions.md')));
  assert.ok(!fs.existsSync(path.join(tDir, 'plans')));
  assert.ok(!fs.existsSync(mcpFilePath(tDir)), 'and no tool surface was written either');
  assert.equal(readTeam(repo), null, 'still no team, after being read');

  // It still answers, with the defaults dispatch would have used.
  assert.equal(out.hasTeam, false);
  assert.deepEqual(Object.keys(out.briefs).sort(), ['lead', 'planner', 'standalone', 'worker']);
  for (const [kind, text] of Object.entries(out.briefs)) {
    assert.ok(text.length > 200, `${kind} is a real brief`);
    assert.ok(!text.includes('undefined'), `${kind} never prints undefined`);
  }
});

test('the placeholder task id is a placeholder, in the brief and in the plan path', async () => {
  const repo = makeRepo('placeholder', { origin: 'https://github.com/example/placeholder.git' });
  resetForgeCache();
  resetBaseBranchCache();
  const out = await briefsFor(repo);

  assert.equal(out.taskId, '<task>');
  assert.ok(out.briefs.worker.includes('agent/<task>'), 'the worker’s branch is plainly a blank');
  assert.ok(out.briefs.planner.includes(path.join('plans', '<task>.md')), 'and so is the plan file');
});

test('no repo still answers the standalone brief, which is one file for the machine', async () => {
  const out = await briefsFor(null);
  assert.deepEqual(Object.keys(out.briefs), ['standalone']);
  assert.equal(out.repo, null);
  assert.ok(out.briefs.standalone.length > 200);
});

test('the standalone brief does not change with the repo, because it cannot', async () => {
  const a = makeRepo('same-a', { origin: 'https://github.com/example/a.git' });
  const b = makeRepo('same-b', { branch: 'master' });
  resetForgeCache();
  resetBaseBranchCache();
  const [one, two, none] = [await briefsFor(a), await briefsFor(b), await briefsFor(null)];
  assert.equal(one.briefs.standalone, two.briefs.standalone);
  assert.equal(one.briefs.standalone, none.briefs.standalone);
});

/* ------------------------------------ the launch path goes through here --- */

/*
 * A source scan, the mechanism `session-launch.test.js` and `logs.test.js` already use for
 * the same class of defect: the day somebody adds a second `leadBrief(...)` call to the
 * launch, nothing at run time notices, and the modal starts showing a brief no session is
 * given. The rule is structural — `index.js` must reach the lead brief only through
 * `briefs.js` — rather than a list of call sites, because a list goes stale the way the
 * thing it is guarding does.
 */
test('server/index.js builds the lead brief only through the shared assembly', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'server', 'index.js'), 'utf8');
  assert.ok(src.includes("from './briefs.js'"), 'it imports the shared assembly');
  assert.match(src, /await assembleLead\(/, 'and the launch calls it');
  assert.ok(
    !/from '\.\/lead-brief\.js'/.test(src),
    'index.js must not import leadBrief directly — that is the second copy this file exists to stop',
  );
  assert.ok(!/\bleadBrief\s*\(/.test(src), 'and must not call it');
});
