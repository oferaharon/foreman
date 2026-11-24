import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  configDirArg,
  installAccount,
  installRows,
  installTarget,
  resolveInstallKey,
} from '../server/account-install.js';
import { hookState, planHookInstall } from '../server/hook-settings.js';
import {
  REFUSALS,
  SIDECAR_FILENAME,
  WRAPPER_FILENAME,
  configDirSuffix,
  looksLikeAWrapper,
  planInstall,
  shellQuote,
  wrapperNameIn,
} from '../server/statusline.js';
import { installConfirmLines, installRowView } from '../web/account-install.js';

/*
 * The two settings entries per Claude config dir — the default `~/.claude` and a second
 * account's `CLAUDE_CONFIG_DIR` — against real files in a throwaway `HOME`, never the
 * maintainer's. Every CLI run is a child with `HOME` and `FOREMAN_STATE_DIR` pointed at the
 * scratch tree and a scratch `FOREMAN_PORT`; the in-process calls are handed explicit
 * targets under it. The first CLI test proves the child really writes there.
 */

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..');
const HOOK_CLI = path.join(REPO, 'server', 'install-hook.js');
const LINE_CLI = path.join(REPO, 'server', 'install-statusline.js');
const PORT = 48996;
const MAIN_LINE = 'bash /scratch/alpha/line.sh';

function scratch(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-acct-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const main = path.join(home, '.claude');
  const second = path.join(home, '.claude-beta');
  const state = path.join(home, 'state');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  return {
    home,
    main,
    second,
    state,
    settings: (dir) => path.join(dir, 'settings.json'),
    write: (dir, obj) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(obj, null, 2)),
    read: (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')),
    hash: (dir) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'settings.json'))).digest('hex'),
    backups: (dir) => fs.readdirSync(dir).filter((n) => /^settings\.backup-foreman-\d+\.json$/.test(n)),
    target: (dir) => installTarget(dir, { stateDir: state, defaultDir: main }),
  };
}

async function cli(box, script, args = []) {
  const env = { ...process.env, HOME: box.home, FOREMAN_STATE_DIR: box.state, FOREMAN_PORT: String(PORT) };
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

/* ------------------------------------------------------------- names and shapes --- */

test('a config dir suffix is its folder name, dots dropped, so no two names nest', () => {
  assert.equal(configDirSuffix('/Users/x/.claude-beta'), 'claude-beta');
  assert.equal(configDirSuffix('/Users/x/.claude-beta/'), 'claude-beta');
  assert.equal(configDirSuffix('/tmp/cfg'), 'cfg');
  assert.equal(configDirSuffix('/tmp/my cfg.d'), 'my-cfg-d');
  assert.equal(configDirSuffix('/tmp/...'), 'config');
  // With dots kept, `x` and `x.sh` would name wrappers one of which contains the other.
  assert.notEqual(configDirSuffix('/a/x.sh'), 'x.sh');
});

test('looksLikeAWrapper sees the suffixed wrapper too, or one dir would wrap another', () => {
  assert.equal(wrapperNameIn("'/s/statusline-wrapper.sh'"), WRAPPER_FILENAME);
  assert.equal(wrapperNameIn("'/s/statusline-wrapper-claude-beta.sh'"), 'statusline-wrapper-claude-beta.sh');
  assert.equal(wrapperNameIn('/s/statusline-wrapper-cfg.sh --flag'), 'statusline-wrapper-cfg.sh');
  assert.ok(looksLikeAWrapper('bash /s/statusline-wrapper-cfg.sh'));
  assert.ok(!looksLikeAWrapper('bash /s/my-statusline-wrapper.sh.bak'));
  assert.ok(!looksLikeAWrapper('bash /s/statusline-wrapper-.sh'));
  assert.ok(!looksLikeAWrapper(MAIN_LINE));
});

test('the default target keeps the old names, a second dir gets its own', (t) => {
  const box = scratch(t);
  const def = box.target(box.main);
  assert.equal(def.isDefault, true);
  assert.equal(path.basename(def.wrapperPath), WRAPPER_FILENAME);
  assert.equal(path.basename(def.sidecarPath), SIDECAR_FILENAME);
  assert.equal(def.settingsPath, path.join(box.main, 'settings.json'));
  const other = box.target(box.second);
  assert.equal(other.isDefault, false);
  assert.equal(path.basename(other.wrapperPath), 'statusline-wrapper-claude-beta.sh');
  assert.equal(path.basename(other.sidecarPath), 'statusline-claude-beta.json');
  assert.equal(other.settingsPath, path.join(box.second, 'settings.json'));
});

test('--config-dir reads both spellings, expands ~, and refuses an empty value', () => {
  const home = '/Users/someone';
  assert.equal(configDirArg([], { home }).configDir.endsWith(`${path.sep}.claude`), true);
  assert.equal(configDirArg(['--config-dir', '~/.claude-beta'], { home }).configDir, '/Users/someone/.claude-beta');
  assert.equal(configDirArg(['--config-dir=/tmp/cfg'], { home }).configDir, '/tmp/cfg');
  assert.equal(configDirArg(['--config-dir', 'cfg'], { home, cwd: '/tmp' }).configDir, '/tmp/cfg');
  assert.ok(configDirArg(['--config-dir'], { home }).error);
  assert.ok(configDirArg(['--config-dir', '--remove'], { home }).error);
  assert.ok(configDirArg(['--config-dir='], { home }).error);
});

/* ------------------------------------------------------------- import is inert --- */

test('importing either installer writes nothing — not even a settings file that was absent', async (t) => {
  const box = scratch(t);
  box.write(box.main, { theme: 'dark' });
  const before = box.hash(box.main);
  const env = { ...process.env, HOME: box.home, FOREMAN_STATE_DIR: box.state, FOREMAN_PORT: String(PORT) };
  // Imported from another entry point, the way an endpoint or a test loads them.
  const probe = `await import(${JSON.stringify(HOOK_CLI)}); await import(${JSON.stringify(LINE_CLI)}); console.log('loaded');`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', probe], { env });
  assert.equal(stdout.trim(), 'loaded');
  assert.equal(box.hash(box.main), before, 'the default settings file is byte-identical');
  assert.deepEqual(box.backups(box.main), [], 'and nothing was backed up, because nothing ran');
  assert.ok(!fs.existsSync(box.settings(box.second)), 'no second-dir settings file appeared');
  assert.ok(!fs.existsSync(box.state), 'no wrapper, no sidecar, no state dir');
});

/* ------------------------------------------------------------- the default dir --- */

test('the default dir: no flag and an explicit --config-dir ~/.claude write the same bytes', async (t) => {
  const a = scratch(t);
  const b = scratch(t);
  const seed = { theme: 'dark', statusLine: { type: 'command', command: MAIN_LINE } };
  a.write(a.main, seed);
  b.write(b.main, seed);
  for (const script of [HOOK_CLI, LINE_CLI]) {
    assert.equal((await cli(a, script)).code, 0);
    assert.equal((await cli(b, script, ['--config-dir', '~/.claude'])).code, 0);
  }
  const norm = (box) => fs.readFileSync(box.settings(box.main), 'utf8').replaceAll(box.home, 'HOME');
  assert.equal(norm(a), norm(b));
  // The default's record and script are the shape every earlier install wrote.
  const sidecar = JSON.parse(fs.readFileSync(path.join(a.state, SIDECAR_FILENAME), 'utf8'));
  assert.deepEqual(Object.keys(sidecar).sort(), ['addedRefreshInterval', 'original', 'port', 'version', 'wrappedAt']);
  const script = fs.readFileSync(path.join(a.state, WRAPPER_FILENAME), 'utf8');
  assert.match(script, /# `npm run install-statusline` rewrites this file from <STATE_DIR>\/statusline\.json,/);
  assert.ok(!fs.existsSync(a.settings(a.second)));
});

test('the Install button and the two CLIs leave the default settings file identical', async (t) => {
  const a = scratch(t);
  const b = scratch(t);
  const seed = {
    theme: 'dark',
    statusLine: { type: 'command', command: MAIN_LINE },
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other' }] }] },
  };
  a.write(a.main, seed);
  b.write(b.main, seed);
  await cli(a, HOOK_CLI);
  await cli(a, LINE_CLI);
  const out = installAccount(b.target(b.main), { port: PORT });
  assert.equal(out.ok, true);
  const norm = (box) => fs.readFileSync(box.settings(box.main), 'utf8').replaceAll(box.home, 'HOME');
  assert.equal(norm(b), norm(a));
  // One backup for one write, where the two CLIs made two.
  assert.equal(b.backups(b.main).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.main, b.backups(b.main)[0]), 'utf8')), seed);
});

/* --------------------------------------------------------------- a second dir --- */

test('--config-dir installs into that dir only, backs up beside it, and the default is untouched', async (t) => {
  const box = scratch(t);
  box.write(box.main, { theme: 'dark', statusLine: { type: 'command', command: MAIN_LINE } });
  box.write(box.second, { theme: 'light' });
  const mainBefore = box.hash(box.main);
  const secondBefore = box.read(box.second);

  const hook = await cli(box, HOOK_CLI, ['--config-dir', box.second]);
  assert.equal(hook.code, 0, hook.stderr);
  const line = await cli(box, LINE_CLI, ['--config-dir', box.second]);
  assert.equal(line.code, 0, line.stderr);

  assert.equal(box.hash(box.main), mainBefore, 'the default account’s file is byte-identical');
  assert.deepEqual(box.backups(box.main), []);
  const after = box.read(box.second);
  assert.equal(after.theme, 'light');
  assert.equal(hookState(after, PORT), 'installed');
  const wrapper = path.join(box.state, 'statusline-wrapper-claude-beta.sh');
  assert.equal(after.statusLine.command, shellQuote(wrapper));
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755);
  assert.ok(!fs.existsSync(path.join(box.state, WRAPPER_FILENAME)), 'the default wrapper is not written');

  const backups = box.backups(box.second);
  assert.equal(backups.length, 2, 'one per installer, beside the file they wrote');
  const oldest = backups.sort()[0];
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(box.second, oldest), 'utf8')), secondBefore);
});

test('a second dir with no status line runs the main account’s, and --remove never writes it in', async (t) => {
  const box = scratch(t);
  box.write(box.main, { statusLine: { type: 'command', command: MAIN_LINE } });
  box.write(box.second, {});
  // The main account wrapped first: its command now lives only in the default sidecar.
  await cli(box, LINE_CLI);
  assert.ok(looksLikeAWrapper(box.read(box.main).statusLine.command));

  const run = await cli(box, LINE_CLI, ['--config-dir', box.second]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /runs the default account's: bash \/scratch\/alpha\/line\.sh/);
  const script = fs.readFileSync(path.join(box.state, 'statusline-wrapper-claude-beta.sh'), 'utf8');
  assert.match(script, /printf '%s' "\$payload" \| bash \/scratch\/alpha\/line\.sh/);
  assert.match(script, /--config-dir /, 'the per-dir header names the flag that reaches it');
  const sidecar = JSON.parse(fs.readFileSync(path.join(box.state, 'statusline-claude-beta.json'), 'utf8'));
  assert.equal(sidecar.original, null, 'what this file held');
  assert.deepEqual(sidecar.borrowed, { type: 'command', command: MAIN_LINE }, 'what the wrapper runs');
  assert.equal(sidecar.configDir, box.second);

  const rm = await cli(box, LINE_CLI, ['--config-dir', box.second, '--remove']);
  assert.equal(rm.code, 0, rm.stderr);
  assert.equal(box.read(box.second).statusLine, undefined, 'the key goes; the main command is never written in');
  assert.ok(!fs.existsSync(path.join(box.state, 'statusline-wrapper-claude-beta.sh')));
  assert.ok(fs.existsSync(path.join(box.state, WRAPPER_FILENAME)), 'the default wrapper stays');
});

test('a second dir with a status line of its own keeps it', (t) => {
  const box = scratch(t);
  box.write(box.main, { statusLine: { type: 'command', command: MAIN_LINE } });
  box.write(box.second, { statusLine: { type: 'command', command: 'bash /scratch/beta/own.sh' } });
  const out = installAccount(box.target(box.second), { port: PORT });
  assert.equal(out.ok, true);
  assert.equal(out.statusLine.borrowed, null);
  const script = fs.readFileSync(path.join(box.state, 'statusline-wrapper-claude-beta.sh'), 'utf8');
  assert.match(script, /\| bash \/scratch\/beta\/own\.sh/);
  assert.doesNotMatch(script, /alpha/);
});

test('a re-run is idempotent: nothing written to settings, no new backup', async (t) => {
  const box = scratch(t);
  box.write(box.second, { theme: 'light' });
  assert.equal(installAccount(box.target(box.second), { port: PORT }).changed, true);
  const hash = box.hash(box.second);
  const backups = box.backups(box.second).length;
  const again = installAccount(box.target(box.second), { port: PORT });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.backup, null);
  assert.equal(box.hash(box.second), hash);
  assert.equal(box.backups(box.second).length, backups);
  // And the CLIs agree.
  await cli(box, HOOK_CLI, ['--config-dir', box.second]);
  await cli(box, LINE_CLI, ['--config-dir', box.second]);
  assert.equal(box.hash(box.second), hash);
  assert.equal(box.backups(box.second).length, backups);
});

test('another dir’s wrapper is refused, never wrapped — and the default’s is too', async (t) => {
  const box = scratch(t);
  for (const theirs of [
    path.join(box.state, 'statusline-wrapper-claude-gamma.sh'),
    path.join(box.state, WRAPPER_FILENAME),
  ]) {
    const seed = { statusLine: { type: 'command', command: shellQuote(theirs) } };
    box.write(box.second, seed);
    const before = box.hash(box.second);
    const run = await cli(box, LINE_CLI, ['--config-dir', box.second]);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /FOREIGN_WRAPPER/);
    const out = installAccount(box.target(box.second), { port: PORT });
    assert.equal(out.ok, false);
    assert.equal(out.code, REFUSALS.FOREIGN_WRAPPER);
    assert.equal(box.hash(box.second), before, 'nothing written, the hook included');
  }
});

test('a default status line that is itself a wrapper is never borrowed', () => {
  const plan = planInstall({
    settings: {},
    wrapperPath: '/s/statusline-wrapper-cfg.sh',
    port: PORT,
    target: { configDir: '/tmp/cfg', settingsPath: '/tmp/cfg/settings.json', sidecarName: 'statusline-cfg.json' },
    borrowed: { type: 'command', command: "'/s/statusline-wrapper.sh'" },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.borrowed, null);
  assert.doesNotMatch(plan.script, /statusline-wrapper\.sh/);
  assert.ok(plan.warnings.some((w) => /not a plain command/.test(w)));
});

test('two dirs whose names clean up alike do not share one record', (t) => {
  const box = scratch(t);
  const a = path.join(box.home, 'x', '.cfg');
  const b = path.join(box.home, 'y', 'cfg');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  assert.equal(installAccount(box.target(a), { port: PORT }).ok, true);
  const before = fs.existsSync(box.settings(b));
  const out = installAccount(box.target(b), { port: PORT });
  assert.equal(out.ok, false);
  assert.equal(out.code, REFUSALS.SIDECAR_CLASH);
  assert.equal(fs.existsSync(box.settings(b)), before, 'nothing written');
});

test('an unparseable settings file is refused and left exactly as it was', (t) => {
  const box = scratch(t);
  fs.writeFileSync(box.settings(box.second), '{ "theme": ');
  const out = installAccount(box.target(box.second), { port: PORT });
  assert.equal(out.ok, false);
  assert.equal(fs.readFileSync(box.settings(box.second), 'utf8'), '{ "theme": ');
  assert.ok(!fs.existsSync(box.state));
});

/* ------------------------------------------------------------------- the rows --- */

test('the rows read each dir’s own file: missing, then installed and wrapped', (t) => {
  const box = scratch(t);
  box.write(box.main, { statusLine: { type: 'command', command: MAIN_LINE } });
  box.write(box.second, {});
  const opts = { port: PORT, stateDir: box.state, defaultDir: box.main };
  let [def, other] = installRows([box.main, box.second], opts);
  assert.deepEqual([def.key, def.isDefault, def.hook, def.statusLine], [0, true, 'missing', 'missing']);
  assert.deepEqual([other.key, other.isDefault, other.hook, other.statusLine], [1, false, 'missing', 'missing']);
  assert.equal(other.runs, MAIN_LINE);
  assert.equal(other.runsBorrowed, true);

  installAccount(box.target(box.second), { port: PORT });
  [def, other] = installRows([box.main, box.second], opts);
  assert.deepEqual([def.hook, def.statusLine], ['missing', 'missing'], 'the default is not touched');
  assert.deepEqual([other.hook, other.statusLine], ['installed', 'wrapped']);
  assert.equal(other.runs, MAIN_LINE, 'from its own record now');
});

test('an older spelling of our own hook reads as out of date, not installed', () => {
  const old = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `curl -s http://127.0.0.1:${PORT}/hook` }] }] } };
  assert.equal(hookState(old, PORT), 'outdated');
  assert.equal(hookState({}, PORT), 'missing');
  assert.equal(hookState(planHookInstall({}, PORT).settings, PORT), 'installed');
  assert.equal(hookState(null, PORT), 'unreadable');
});

/* --------------------------------------------------------- the endpoint's input --- */

test('the Install key is an index into the known list, and nothing path-shaped gets through', () => {
  const dirs = ['/h/.claude', '/h/.claude-beta'];
  assert.deepEqual(resolveInstallKey('1', {}, dirs), { ok: true, dir: '/h/.claude-beta' });
  assert.deepEqual(resolveInstallKey('0', undefined, dirs), { ok: true, dir: '/h/.claude' });
  assert.equal(resolveInstallKey('2', {}, dirs).status, 404);
  for (const key of ['/etc', '../x', '..%2F..', '1/../0', '-1', '01', '1.0', ' 1', '~/.claude', '', '1e1']) {
    assert.equal(resolveInstallKey(key, {}, dirs).status, 400, key);
  }
  for (const body of [{ configDir: '/tmp/x' }, { path: '/tmp/x' }, { key: 1 }]) {
    assert.equal(resolveInstallKey('1', body, dirs).status, 400);
  }
});

/* --------------------------------------------------------------- the confirm --- */

test('the confirm says what is written, that live sessions pick it up, and what it runs', () => {
  const row = {
    key: 1,
    folder: '.claude-beta',
    configDir: '~/.claude-beta',
    isDefault: false,
    settingsPath: '~/.claude-beta/settings.json',
    wrapperPath: '~/.foreman/statusline-wrapper-claude-beta.sh',
    hook: 'missing',
    statusLine: 'missing',
    runs: MAIN_LINE,
    runsBorrowed: true,
  };
  const text = installConfirmLines(row).join('\n');
  assert.match(text, /~\/\.claude-beta\/settings\.json, after a backup beside it/);
  assert.match(text, /within seconds/);
  assert.match(text, /runs the default account’s, so both terminals look alike: bash \/scratch\/alpha\/line\.sh/);
  assert.match(text, /usage bars are one set for now/);
  const view = installRowView(row);
  assert.deepEqual(view.facts.map((f) => f.text), ['status hook: missing', 'status line: missing']);
  assert.equal(view.offer, true);

  const done = installRowView({ ...row, hook: 'installed', statusLine: 'wrapped' });
  assert.equal(done.offer, false);
  const foreign = installRowView({ ...row, statusLine: 'foreign' });
  assert.equal(foreign.offer, false);
  assert.match(foreign.blocked, /another Foreman wrapper/);
  assert.match(installConfirmLines({ ...row, runs: null, runsBorrowed: false }).join('\n'), /blank row/);
});

/* ------------------------------------------------- T13: the account witness --- */

/*
 * Neither payload names an account. What says which one a hook or a status-line render came
 * from is `transcript_path`, whose root is the config dir (MEASURED on v2.1.331, multi-account
 * plan M6). These are real captures from a sandbox `alpha` session on a second account,
 * driven by a `--settings` file built from this installer's output — paths, ids, the
 * percentages and the cost rewritten to fakes, every key kept. The per-account gauges key on
 * this field; a Claude Code that dropped it would show here first rather than as blank bars.
 */
const FIXTURES = path.join(REPO, 'test', 'fixtures');
const PAYLOADS = ['hook-SessionStart', 'hook-UserPromptSubmit', 'hook-Stop', 'hook-SessionEnd', 'statusline'];

test('every hook and status-line payload carries transcript_path under its own config dir', async () => {
  const { configDirOfTranscript } = await import('../server/account.js');
  for (const name of PAYLOADS) {
    const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, `payload-${name}.json`), 'utf8'));
    assert.equal(typeof payload.transcript_path, 'string', `${name} has transcript_path`);
    assert.equal(configDirOfTranscript(payload.transcript_path), '/Users/someone/.claude-work', name);
    assert.equal(typeof payload.session_id, 'string', `${name} has session_id`);
    for (const key of Object.keys(payload)) assert.doesNotMatch(key, /account|email|org/i, `${name} names no account`);
  }
  const line = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'payload-statusline.json'), 'utf8'));
  assert.deepEqual(Object.keys(line.rate_limits).sort(), ['five_hour', 'seven_day']);
  const hook = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'payload-hook-Stop.json'), 'utf8'));
  assert.equal(hook.hook_event_name, 'Stop');
});
