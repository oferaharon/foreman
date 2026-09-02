import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { FORMULA, brewPrefixes, isHomebrewPath, isUnderPrefix, panelIsHomebrew } from '../server/homebrew.js';

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..');
const BIN = path.join(REPO, 'bin', `${FORMULA}.js`);

/*
 * The `bin/` shim, run as a child process — which is the only honest way to test a thing
 * whose whole job is to be an executable. `--help`, `version` and a bad subcommand are
 * cheap; `serve` is deliberately never run here, because it binds a port and would race
 * the panel this machine is actually running.
 *
 * The two subcommands that reach outside the process are covered by what they must *not*
 * do: `install-hook` writes into a scratch `$HOME` and nowhere near the real one, and the
 * service verbs are only ever exercised on the not-a-Homebrew-install branch, which
 * prints and exits rather than shelling `brew`.
 */

/** Run the shim. Never throws on a non-zero exit — the exit code is usually the subject. */
async function cli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function scratchHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cli-home-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ------------------------------------------------------------------- the bin contract ---

/*
 * `std_npm_args(prefix: libexec)` creates `libexec/bin/*` **only** from the package's own
 * `bin` field — so a missing or misspelled entry here is a formula that installs silently
 * with no command at all. There is nothing else in the repository that would notice.
 */
test('package.json declares the binary, and it is there and executable', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const declared = pkg.bin?.[FORMULA];
  assert.ok(declared, `package.json has no bin entry for ${FORMULA}: ${JSON.stringify(pkg.bin)}`);

  const target = path.resolve(REPO, declared);
  assert.equal(target, BIN, 'the bin entry should point at bin/<formula>.js');
  assert.ok(fs.existsSync(target), `${declared} does not exist`);
  // npm copies the mode across, and a shim without the bit set is a `Permission denied`
  // that only happens on somebody else's machine.
  assert.ok(fs.statSync(target).mode & 0o111, `${declared} is not executable`);
  assert.ok(
    fs.readFileSync(target, 'utf8').startsWith('#!/usr/bin/env node'),
    'the shim needs a shebang — npm links it, it is not run through `node`',
  );
});

/*
 * The name is spelled twice and cannot be spelled once: npm reads `package.json` before
 * any of this code runs, so the `bin` key cannot import `FORMULA`. Same shape as the
 * launchd label's three copies, and pinned the same way — by the only mechanism there is.
 */
test('the command name is the formula name', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.bin), [FORMULA]);
  assert.equal(FORMULA, 'foreman-panel', 'homebrew-core already owns `foreman` — see server/homebrew.js');
});

// ------------------------------------------------------------------------ subcommands ---

test('--help lists every subcommand, and exits 0', async () => {
  const { code, stdout } = await cli(['--help']);
  assert.equal(code, 0);
  for (const name of ['serve', 'start', 'stop', 'restart', 'install-hook', 'uninstall-hook', 'logs', 'version']) {
    assert.match(stdout, new RegExp(`\\b${name}\\b`), `--help does not mention ${name}`);
  }
});

test('no arguments is the same help, not an error', async () => {
  const bare = await cli([]);
  const asked = await cli(['--help']);
  assert.equal(bare.code, 0);
  assert.equal(bare.stdout, asked.stdout);
});

test('version prints the version in package.json and nothing else', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const { code, stdout } = await cli(['version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), pkg.version);
});

test('an unknown subcommand exits non-zero and says what the subcommands are', async () => {
  const { code, stdout, stderr } = await cli(['sevre']);
  assert.notEqual(code, 0, 'a typo must not look like success to a shell script');
  assert.match(stderr, /unknown command "sevre"/);
  assert.match(stderr, /\bserve\b/, 'the message should name the real subcommands');
  assert.equal(stdout, '', 'the complaint belongs on stderr');
});

/*
 * `foreman-panel logs` is the one-look check that the service definition and the process
 * agree about where output goes, so it prints two paths and nothing else — a header line
 * would break `tail -f $(foreman-panel logs)`.
 */
test('logs prints exactly the two resolved paths', async () => {
  const { code, stdout } = await cli(['logs']);
  assert.equal(code, 0);
  // Compared against `logs.js` itself rather than against a literal, so this stays true
  // of whatever moves those paths — the label today, the log directory next.
  const { LOG_OUT, LOG_ERR } = await import('../server/logs.js');
  assert.deepEqual(stdout.trim().split('\n'), [LOG_OUT, LOG_ERR]);
});

/*
 * The service verbs from a checkout. `HOMEBREW_PREFIX` is pointed at a directory this
 * repository is certainly not inside, so the branch is decided by the detector and not by
 * where the suite happens to be running — and `brew` is never shelled.
 */
test('a service verb outside a Homebrew install refuses, and names the command that does work', async () => {
  const away = { HOMEBREW_PREFIX: path.join(os.tmpdir(), 'foreman-not-a-prefix') };
  for (const [verb, npm] of [['restart', 'npm run restart-panel'], ['stop', 'npm run stop-panel'], ['start', 'npm run install-agent']]) {
    const { code, stderr } = await cli([verb], away);
    assert.notEqual(code, 0, `${verb} should not report success when it did nothing`);
    assert.match(stderr, new RegExp(npm.replace(/ /g, '\\s')), `${verb} should point at \`${npm}\``);
  }
});

// ------------------------------------------------------------------------- the spawn ---

/*
 * **`server/install-hook.js` runs on import.** It calls `install()` at module scope with
 * no `invokedDirectly()` guard, so a shim that imported it would register a hook in
 * `~/.claude/settings.json` as a side effect of printing its own help.
 *
 * Both halves are proved against a scratch `$HOME`, never the real one: help writes
 * nothing, and the subcommand writes the hook.
 */
test('--help registers no hook — the installer is spawned, never imported', async (t) => {
  const home = scratchHome(t);
  const settings = path.join(home, '.claude', 'settings.json');

  const { code } = await cli(['--help'], { HOME: home });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(settings), false, 'printing help must not touch ~/.claude/settings.json');
});

test('install-hook registers the hook, and uninstall-hook takes it back out', async (t) => {
  const home = scratchHome(t);
  const settings = path.join(home, '.claude', 'settings.json');

  const added = await cli(['install-hook'], { HOME: home });
  assert.equal(added.code, 0, added.stderr);
  const withHook = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(withHook.hooks?.Stop?.length, 'no Stop hook was written');
  assert.match(JSON.stringify(withHook.hooks), /\/hook/, 'the hook should post to the panel');

  const removed = await cli(['uninstall-hook'], { HOME: home });
  assert.equal(removed.code, 0, removed.stderr);
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(after.hooks?.Stop, undefined, 'the entry should be gone again');
});

// --------------------------------------------------------------------- the detector ---

/*
 * Pure path arithmetic, so it is asserted with paths that need not exist. The one that
 * matters is the refusal: a string-prefix test reads `/usr/local-scratch` as being inside
 * `/usr/local`, and a panel that believed it would print `brew services` advice to
 * somebody with no formula installed.
 */
test('a path under a Homebrew prefix is a Homebrew install; a lookalike is not', () => {
  const env = { HOMEBREW_PREFIX: '/opt/homebrew' };
  assert.equal(isHomebrewPath('/opt/homebrew/Cellar/foreman-panel/0.1.0/libexec/bin/foreman-panel', env), true);
  assert.equal(isHomebrewPath('/opt/homebrew-scratch/bin/foreman-panel', env), false);
  assert.equal(isHomebrewPath('/Users/someone/code/foreman/bin/foreman-panel.js', env), false);
  // The prefix itself is not "under" the prefix, and neither is its parent.
  assert.equal(isUnderPrefix('/opt/homebrew', '/opt/homebrew'), false);
  assert.equal(isUnderPrefix('/opt', '/opt/homebrew'), false);
});

test('$HOMEBREW_PREFIX wins alone; without it both standard prefixes are tried', () => {
  assert.deepEqual(brewPrefixes({ HOMEBREW_PREFIX: '/somewhere/else' }), ['/somewhere/else']);
  assert.deepEqual(brewPrefixes({}), ['/opt/homebrew', '/usr/local']);
  // An empty or whitespace value is not an answer — fall back rather than test against ''.
  assert.deepEqual(brewPrefixes({ HOMEBREW_PREFIX: '  ' }), ['/opt/homebrew', '/usr/local']);
});

test('this checkout is not a Homebrew install', () => {
  // The self-answer, which is what every caller actually asks. Pointed at a prefix that
  // cannot contain a git checkout, so the assertion does not depend on where the suite
  // was cloned to.
  assert.equal(panelIsHomebrew({ HOMEBREW_PREFIX: path.join(os.tmpdir(), 'foreman-not-a-prefix') }), false);
});
