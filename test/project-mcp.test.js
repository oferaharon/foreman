import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/*
 * `server/project-mcp.js` — which of a repo's own `.mcp.json` servers a team's lead and
 * build workers carry, and the allow rules that come with them.
 *
 * Real files in throwaway folders, never a stubbed `fs`: the whole question is what the
 * repo's own `.mcp.json` and `.claude/settings*.json` say, and those are files.
 *
 * The approval matrix below is **measured**, not designed: each row is one combination of
 * the two settings files that Claude Code v2.1.280 was given in the sandbox and read back
 * through `claude mcp list`. If Claude Code changes its precedence, these rows are what to
 * re-measure — not what to edit until the suite is green.
 */

// Above the imports, and the imports are dynamic: `dispatch.js` and `team.js` reach
// `config.js`, which freezes `STATE_DIR` at import (`test/state-dir.test.js`).
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-project-mcp-state-'));

const {
  approval,
  entryCredentials,
  mcpServerRule,
  nameProblem,
  normalizeProjectMcpServers,
  projectMcpCatalogue,
  resolveProjectMcp,
  workerProjectMcp,
  RESERVED_SERVER_NAMES,
  MAX_PROJECT_MCP_SERVERS,
} = await import('../server/project-mcp.js');
const { leadToolSurface, assembleLead, briefsFor } = await import('../server/briefs.js');
const { leadSettings, teamDir, teamDefaults } = await import('../server/team.js');
const { writeWorkerSettings, GIT_DENY } = await import('../server/dispatch.js');
const { TASK_KINDS } = await import('../server/tasks.js');
const { resetForgeCache } = await import('../server/forge.js');
const { resetBaseBranchCache } = await import('../server/base-branch.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-project-mcp-'));

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

/** A clean stdio entry — the shape the motivating repo declares: a command, an arg, no env. */
const CLEAN = { type: 'stdio', command: 'sim-bridge', args: ['serve'] };

let n = 0;
/** A folder with whatever `.mcp.json` and settings the caller says; `undefined` writes nothing. */
function makeRepo({ servers, shared, local, rawMcp } = {}) {
  const dir = path.join(scratch, `alpha-${(n += 1)}`);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (rawMcp !== undefined) fs.writeFileSync(path.join(dir, '.mcp.json'), rawMcp);
  else if (servers) fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  if (shared) fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(shared));
  if (local) fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(local));
  return dir;
}

/* ------------------------------------------------- the measured matrix --- */

test('approval follows the precedence Claude Code was measured to use', () => {
  // [shared, local, approved?] for the server `hello`, as Claude Code v2.1.280 read it.
  const rows = [
    ['1 local enables it', {}, { enabledMcpjsonServers: ['hello'] }, true],
    ['2 shared enables it', { enabledMcpjsonServers: ['hello'] }, {}, true],
    ['3 the lists add up', { enabledMcpjsonServers: ['hello'] }, { enabledMcpjsonServers: ['nope'] }, true],
    ['4 a local false closes a shared enable-all', { enableAllProjectMcpServers: true }, { enableAllProjectMcpServers: false }, false],
    ['5 a local true opens over a shared false', { enableAllProjectMcpServers: false }, { enableAllProjectMcpServers: true }, true],
    ['6 disabled in local beats enabled in shared', { enabledMcpjsonServers: ['hello'] }, { disabledMcpjsonServers: ['hello'] }, false],
    ['7 disabled in shared beats enabled in local', { disabledMcpjsonServers: ['hello'] }, { enabledMcpjsonServers: ['hello'] }, false],
    ['8 disabled beats enable-all in the same file', {}, { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['hello'] }, false],
    ['9 shared enable-all alone', { enableAllProjectMcpServers: true }, {}, true],
    ['10 disabled beats enabled in the same file', {}, { enabledMcpjsonServers: ['hello'], disabledMcpjsonServers: ['hello'] }, false],
    ['11 nothing approves it', {}, {}, false],
  ];
  for (const [label, shared, local, expected] of rows) {
    const verdict = approval('hello', { shared, local });
    assert.equal(verdict.approved, expected, label);
    assert.ok(verdict.reason, `${label}: a reason in words either way`);
  }
  // Row 3's other half: `nope` is approved by the local list alone.
  assert.equal(approval('nope', { shared: { enabledMcpjsonServers: ['hello'] }, local: { enabledMcpjsonServers: ['nope'] } }).approved, true);
});

test('the reason names the file that decided', () => {
  assert.match(approval('hello', { local: { enabledMcpjsonServers: ['hello'] } }).reason, /settings\.local\.json/);
  assert.match(approval('hello', { shared: { enableAllProjectMcpServers: true } }).reason, /enableAllProjectMcpServers in \.claude\/settings\.json/);
  assert.match(approval('hello', { shared: { disabledMcpjsonServers: ['hello'] } }).reason, /disabledMcpjsonServers in \.claude\/settings\.json/);
});

test('a malformed approval list is read as no approval, never as a crash', () => {
  assert.equal(approval('hello', { local: { enabledMcpjsonServers: 'hello' } }).approved, false, 'a string is not a list');
  assert.equal(approval('hello', { local: { enableAllProjectMcpServers: 'true' } }).approved, false, 'nor is "true" a boolean');
});

/* ------------------------------------------------------------ names --- */

test('the panel’s own server names, and both forge names, are refused', () => {
  assert.deepEqual(RESERVED_SERVER_NAMES, ['foreman', 'gitea', 'github']);
  for (const name of ['foreman', 'gitea', 'github', 'Foreman', 'GITHUB']) {
    assert.match(nameProblem(name), /panel's own servers/, name);
  }
});

test('a name that would bend the allow rule is refused', () => {
  // `__` is the separator inside a tool name: this one would make `mcp__gitea__pull_request_write`.
  assert.match(nameProblem('gitea__pull_request_write'), /separator/);
  assert.match(nameProblem('a__b'), /separator/);
  for (const bad of ['my.server', 'my server', 'a/b', '', 'x'.repeat(65), 'mcp__*']) {
    assert.ok(nameProblem(bad), `refused: ${JSON.stringify(bad)}`);
  }
  for (const good of ['sim', 'hello', 'my-server', 'my_server', 'Sim2']) {
    assert.equal(nameProblem(good), null, good);
  }
  assert.ok(nameProblem(7));
  assert.ok(nameProblem(null));
});

test('PATCH’s normaliser trims, de-duplicates and sorts — and refuses the whole list over one bad name', () => {
  assert.deepEqual(normalizeProjectMcpServers(undefined), []);
  assert.deepEqual(normalizeProjectMcpServers([]), []);
  assert.deepEqual(normalizeProjectMcpServers([' sim ', 'hello', 'sim']), ['hello', 'sim']);
  assert.throws(() => normalizeProjectMcpServers('sim'), /list of server names, not string/);
  assert.throws(() => normalizeProjectMcpServers(null), /not null/);
  assert.throws(() => normalizeProjectMcpServers(['sim', 'foreman']), /"foreman"/);
  assert.throws(() => normalizeProjectMcpServers(['github']), /panel's own servers/);
  assert.throws(() => normalizeProjectMcpServers(['a__b']), /separator/);
  assert.throws(() => normalizeProjectMcpServers([3]), /not a server name/);
  const tooMany = Array.from({ length: MAX_PROJECT_MCP_SERVERS + 1 }, (_, i) => `s${i}`);
  assert.throws(() => normalizeProjectMcpServers(tooMany), /at most/);
});

/* ------------------------------------------------------- credentials --- */

test('a credential is found wherever an entry can carry one', () => {
  assert.deepEqual(entryCredentials(CLEAN), [], 'the motivating entry carries nothing');
  assert.deepEqual(entryCredentials({ ...CLEAN, env: { LABEL: 'x' } }), [], 'an ordinary env var is fine');
  assert.deepEqual(entryCredentials({ ...CLEAN, env: { API_TOKEN: 'abc' } }), ['API_TOKEN'], 'env, the forge rule');
  assert.deepEqual(entryCredentials({ ...CLEAN, env: { API_TOKEN: '${API_TOKEN}' } }), ['API_TOKEN'], 'a reference counts, as it does for the forge');
  assert.deepEqual(entryCredentials({ ...CLEAN, env: { API_TOKEN: '' } }), [], 'an empty value carries nothing');
  assert.deepEqual(entryCredentials({ type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer abc' } }), ['Authorization']);
  assert.deepEqual(entryCredentials({ type: 'http', url: 'https://x.test/mcp', headers: { 'X-Api-Key': 'abc' } }), ['X-Api-Key']);
  assert.deepEqual(entryCredentials({ type: 'http', url: 'https://u:p@x.test/mcp' }), ['url (user:password)']);
  assert.deepEqual(entryCredentials({ type: 'http', url: 'https://x.test/mcp?token=abc' }), ['url ?token=']);
  assert.deepEqual(entryCredentials({ command: 'srv', args: ['--api-key=abc'] }), ['--api-key']);
  assert.deepEqual(entryCredentials({ command: 'srv', args: ['--token', 'abc'] }), ['--token']);
  assert.deepEqual(entryCredentials({ command: 'srv', args: ['--verbose', 'serve'] }), []);
  assert.deepEqual(entryCredentials(null), []);
});

/* -------------------------------------------- the one resolution, as a matrix --- */

test('listed × declared × approved × credential-free is the only way on, and every other way is a note', () => {
  const repo = makeRepo({
    servers: {
      hello: CLEAN,
      unapproved: CLEAN,
      leaky: { ...CLEAN, env: { SANDBOX_API_TOKEN: 'sandbox-not-a-secret' } },
      unlisted: CLEAN,
    },
    local: { enabledMcpjsonServers: ['hello', 'leaky', 'unlisted'] },
  });
  const out = resolveProjectMcp({ repo, allow: ['hello', 'unapproved', 'leaky', 'missing'], taken: ['foreman'] });

  assert.deepEqual(out.names, ['hello'], 'one of four asked for qualifies');
  assert.deepEqual(out.servers.hello, CLEAN, 'copied verbatim from the repo’s own file');
  assert.ok(!('unlisted' in out.servers), 'declared and approved is not enough — it was never ticked');

  assert.equal(out.notes.length, 3, 'one note per name asked for and not given');
  const noteFor = (name) => out.notes.find((note) => note.includes(`\`${name}\``));
  assert.match(noteFor('unapproved'), /not approved/);
  assert.match(noteFor('leaky'), /SANDBOX_API_TOKEN/);
  assert.match(noteFor('leaky'), /world-readable/);
  assert.ok(!out.notes.join('\n').includes('sandbox-not-a-secret'), 'a note names the key, never the value');
  assert.match(noteFor('missing'), /does not declare it/);
});

test('an empty list reads nothing at all — not even a broken .mcp.json', () => {
  const repo = makeRepo({ rawMcp: '{ not json' });
  assert.deepEqual(resolveProjectMcp({ repo, allow: [] }), { servers: {}, names: [], notes: [] });
});

test('an unreadable .mcp.json is said, not read as "declares nothing" in silence', () => {
  const repo = makeRepo({ rawMcp: '{ not json', local: { enableAllProjectMcpServers: true } });
  const out = resolveProjectMcp({ repo, allow: ['hello'] });
  assert.deepEqual(out.names, []);
  assert.ok(out.notes.some((note) => /\.mcp\.json could not be read: not valid JSON/.test(note)));
});

test('a hand-edited team.json with a reserved or bent name is a note at launch, never a throw', () => {
  const repo = makeRepo({ servers: { foreman: CLEAN, a__b: CLEAN }, local: { enableAllProjectMcpServers: true } });
  const out = resolveProjectMcp({ repo, allow: ['foreman', 'a__b', 42] });
  assert.deepEqual(out.names, []);
  assert.equal(out.notes.length, 3);
});

test('a name already on the surface is never overwritten', () => {
  const repo = makeRepo({ servers: { hello: CLEAN }, local: { enableAllProjectMcpServers: true } });
  const out = resolveProjectMcp({ repo, allow: ['hello'], taken: ['hello'] });
  assert.deepEqual(out.names, []);
  assert.match(out.notes[0], /already on this surface/);
});

test('approval is read from the folder it is given, and a worktree without settings.local.json approves nothing', () => {
  // The reason every caller passes the main checkout: `.claude/settings.local.json` is
  // normally gitignored, so a worktree of the same repo has the `.mcp.json` and not the yes.
  const main = makeRepo({ servers: { hello: CLEAN }, local: { enabledMcpjsonServers: ['hello'] } });
  const worktreeLike = makeRepo({ servers: { hello: CLEAN } });
  assert.deepEqual(resolveProjectMcp({ repo: main, allow: ['hello'] }).names, ['hello']);
  assert.deepEqual(resolveProjectMcp({ repo: worktreeLike, allow: ['hello'] }).names, []);
});

/* ------------------------------------------------- planners, by kind --- */

test('a build worker carries the team’s servers and every other kind carries none', () => {
  const repo = makeRepo({ servers: { hello: CLEAN }, local: { enabledMcpjsonServers: ['hello'] } });
  assert.deepEqual(workerProjectMcp({ kind: 'build', repo, allow: ['hello'] }).names, ['hello']);
  assert.deepEqual(workerProjectMcp({ kind: 'plan', repo, allow: ['hello'] }), { servers: {}, names: [], notes: [] });
  assert.deepEqual(workerProjectMcp({ kind: 'something-new', repo, allow: ['hello'] }).names, [], 'an allow-list on kind');
  assert.deepEqual(TASK_KINDS, ['build', 'plan'], 'if a kind is added, decide here whether it carries project tools');
});

test('the dispatch asks workerProjectMcp, and threads its answer into all four things it writes', () => {
  // The dispatch is inline in index.js and launches a real session, so the end-to-end proof
  // is the sandbox bench; this pins that the wiring goes through the one function.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(src, /workerProjectMcp\(\{ kind, repo, allow: team\?\.projectMcpServers \?\? \[\] \}\)/);
  assert.match(src, /projectServers: project\.names,\n\s+\}\);/, 'the settings file');
  assert.match(src, /\.\.\.project\.servers \} \}/, 'the MCP config');
  assert.match(src, /projectServers: project\.names,\n\s+\}\),/, 'the brief');
  assert.ok(!/resolveProjectMcp\(/.test(src), 'and nothing in index.js resolves a second way');
});

/* ------------------------------------------- lead and worker agree --- */

function makeGitRepo(opts) {
  const dir = makeRepo(opts);
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'zzq-testname']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'first']);
  return dir;
}

test('a lead and a build worker of one team are handed the same servers', async () => {
  const repo = makeRepo({
    servers: { hello: CLEAN, unapproved: CLEAN },
    local: { enabledMcpjsonServers: ['hello'] },
  });
  const allow = ['hello', 'unapproved'];
  const lead = await leadToolSurface({ repo, teamDir: teamDir(repo), forge: null, projectMcpServers: allow });
  const worker = workerProjectMcp({ kind: 'build', repo, allow });

  assert.deepEqual(lead.projectServers, worker.names);
  assert.deepEqual(lead.mcpServers.hello, worker.servers.hello);
  assert.deepEqual(Object.keys(lead.mcpServers), ['foreman', 'hello'], 'foreman first, then the repo’s');
  assert.deepEqual(lead.notes, worker.notes, 'and the same notes for what neither got');
});

test('the lead’s brief, settings and tool surface all come from the copied set', async () => {
  const repo = makeGitRepo({
    servers: { hello: CLEAN, leaky: { ...CLEAN, env: { SANDBOX_API_TOKEN: 'x' } } },
    local: { enabledMcpjsonServers: ['hello', 'leaky'] },
  });
  resetForgeCache();
  resetBaseBranchCache();
  const config = { ...teamDefaults(repo), projectMcpServers: ['hello', 'leaky'] };
  const out = await assembleLead({
    repo,
    teamDir: teamDir(repo),
    decisionsFile: path.join(teamDir(repo), 'decisions.md'),
    config,
  });
  assert.deepEqual(out.projectServers, ['hello']);
  assert.ok(out.mcpServers.hello && !out.mcpServers.leaky);
  assert.match(out.brief, /## Project tools from this repo/);
  assert.match(out.brief, /`mcp__hello__\*`/);
  assert.ok(!out.brief.includes('leaky'), 'the brief never names a server the file does not carry');
  assert.match(out.brief, /run at most one\s+worker at a time whose task drives it/);
  assert.ok(out.notes.some((note) => /`leaky`/.test(note)));

  const settings = leadSettings({ repo, dir: teamDir(repo), projectServers: out.projectServers });
  assert.ok(settings.permissions.allow.includes('mcp__hello'));
  assert.ok(!settings.permissions.allow.includes('mcp__leaky'), 'no rule for a server that was not copied');
});

test('a team that carries none reads exactly the brief it always did', async () => {
  const repo = makeGitRepo({ servers: { hello: CLEAN }, local: { enabledMcpjsonServers: ['hello'] } });
  resetForgeCache();
  resetBaseBranchCache();
  const out = await assembleLead({
    repo,
    teamDir: teamDir(repo),
    decisionsFile: path.join(teamDir(repo), 'decisions.md'),
    config: teamDefaults(repo),
  });
  assert.deepEqual(teamDefaults(repo).projectMcpServers, [], 'empty by default');
  assert.deepEqual(out.projectServers, []);
  assert.deepEqual(Object.keys(out.mcpServers), ['foreman'], 'declared and approved is not ticked');
  assert.ok(!/Project tools/.test(out.brief));
});

test('the briefs modal shows the worker brief a build worker would get, and writes nothing', async () => {
  // A repo with no team: the modal must not seed one. Its config is the defaults, so the
  // worker brief has no project section; the lead's own answer is what the worker's is.
  const repo = makeGitRepo({ servers: { hello: CLEAN }, local: { enabledMcpjsonServers: ['hello'] } });
  resetForgeCache();
  resetBaseBranchCache();
  const out = await briefsFor(repo);
  assert.ok(!/Project tools/.test(out.briefs.worker));
  assert.ok(!fs.existsSync(teamDir(repo)), 'reading a brief created nothing');

  fs.mkdirSync(teamDir(repo), { recursive: true });
  fs.writeFileSync(path.join(teamDir(repo), 'team.json'), JSON.stringify({ repo, projectMcpServers: ['hello'] }));
  const ticked = await briefsFor(repo);
  assert.match(ticked.briefs.lead, /`mcp__hello__\*`/);
  assert.match(ticked.briefs.worker, /## Project tools, and what they share/);
  assert.match(ticked.briefs.worker, /`mcp__hello__\*`/);
  assert.ok(!/Project tools/.test(ticked.briefs.planner), 'a planner is never told it has them');
});

/* ------------------------------------------------------- allow rules --- */

test('the rule is the bare server form, one per copied server, and foreman stays unconditional', async () => {
  assert.equal(mcpServerRule('hello'), 'mcp__hello');

  const lead = leadSettings({ repo: '/Users/x/Code/Api', dir: '/s/teams/x', projectServers: ['hello', 'sim'] });
  assert.ok(lead.permissions.allow.includes('mcp__foreman'));
  assert.ok(lead.permissions.allow.includes('mcp__hello') && lead.permissions.allow.includes('mcp__sim'));
  const bare = leadSettings({ repo: '/Users/x/Code/Api', dir: '/s/teams/x' });
  assert.ok(!bare.permissions.allow.some((r) => r.startsWith('mcp__') && r !== 'mcp__foreman'), 'none by default');

  const file = await writeWorkerSettings({ repo: '/Users/x/Code/Api', label: 'carries', allow: ['Bash(npm test:*)'], projectServers: ['hello'] });
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.permissions.allow, ['mcp__foreman', 'mcp__hello', 'Bash(npm test:*)']);
  assert.deepEqual(s.permissions.deny, GIT_DENY, 'the destructive-git floor is untouched');

  const planner = JSON.parse(fs.readFileSync(await writeWorkerSettings({ repo: '/Users/x/Code/Api', label: 'plans' }), 'utf8'));
  assert.deepEqual(planner.permissions.allow, ['mcp__foreman'], 'a planner’s dispatch passes none');
});

/* --------------------------------------------------- the panel listing --- */

test('the panel lists every declared server with its verdict, plus any stale tick — and no entries', () => {
  const repo = makeRepo({
    servers: { hello: CLEAN, nope: CLEAN, leaky: { ...CLEAN, env: { API_TOKEN: 'x' } } },
    local: { enabledMcpjsonServers: ['hello', 'leaky'] },
  });
  const { servers, problems } = projectMcpCatalogue(repo, ['hello', 'gone']);
  assert.deepEqual(problems, []);
  const by = Object.fromEntries(servers.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by), ['gone', 'hello', 'leaky', 'nope'], 'sorted, the stale tick included');
  assert.deepEqual(
    [by.hello.available, by.hello.listed, by.nope.available, by.leaky.available, by.gone.available, by.gone.listed],
    [true, true, false, false, false, true],
  );
  assert.equal(by.nope.approved, false);
  assert.equal(by.leaky.approved, true, 'approved, and still refused for its credential');
  assert.equal(by.gone.declared, false);
  assert.ok(!JSON.stringify(servers).includes('sim-bridge'), 'a command line never goes to the browser');
});
