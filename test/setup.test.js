import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { FORMULA } from '../server/homebrew.js';
import { SETUP_STEPS, runSetup } from '../server/setup-command.js';

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..');
const BIN = path.join(REPO, 'bin', `${FORMULA}.js`);

/*
 * `foreman-panel setup`.
 *
 * Everything that reaches outside the process is injected — `run`, `probe`, `openUrl` and
 * the PATH lookup — so **no test here spawns an installer, shells `brew`, or goes near the
 * real `~/.claude/settings.json`**. A recorded `run` is also the only way to assert the
 * thing that matters most about the prerequisite check: that it happens *before* anything
 * is written, which a test of the resulting state could never distinguish from a step that
 * ran and happened to change nothing.
 *
 * The two refusals are additionally run end to end through the shim, because both of them
 * print and exit without touching anything — which is exactly what makes them safe to run
 * for real, and what makes them worth proving through the real entry point.
 */

/** A `runSetup` harness: records every shell-out and prints into an array. */
function harness(over = {}) {
  const calls = [];
  const lines = [];
  const opened = [];
  const deps = {
    isHomebrew: () => true,
    which: () => true,
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, out: '' };
    },
    probe: async () => true,
    openUrl: async (url) => opened.push(url),
    log: (line) => lines.push(line),
    fail: (line) => lines.push(line),
    settingsPath: path.join(os.tmpdir(), 'foreman-setup-no-such-file'),
    port: 48771,
    ...over,
  };
  return { calls, lines, opened, deps, text: () => lines.join('\n') };
}

// -------------------------------------------------------------------- the step order ---

/*
 * The order is asserted against the *documentation*, because the order is the whole of
 * what `setup` is: five existing commands, in a sequence somebody agreed to. Prose is the
 * only other place that sequence is written down, and nothing but a test holds the two
 * together — the same mechanism `test/logs.test.js` uses for the launchd label, which is
 * likewise spelled in a file that cannot import anything.
 */
test('docs/running.md names the steps in the order they run', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'running.md'), 'utf8');
  let at = -1;
  for (const step of SETUP_STEPS) {
    const found = doc.indexOf(step.line, at + 1);
    assert.notEqual(found, -1, `docs/running.md never says "${step.line}"`);
    assert.ok(found > at, `"${step.line}" is out of order in docs/running.md`);
    at = found;
  }
});

test('the steps print in that order, numbered, and nothing else claims to be a step', async () => {
  const h = harness();
  assert.equal(await runSetup(h.deps), 0);
  const printed = h.lines.filter((l) => /^\d+\/\d+ /.test(l));
  assert.deepEqual(
    printed,
    SETUP_STEPS.map((s, i) => `${i + 1}/${SETUP_STEPS.length} ${s.line}`),
  );
});

test('--help lists setup first, and still lists every other subcommand', async () => {
  const { stdout } = await exec(process.execPath, [BIN, '--help']);
  const listed = stdout
    .split('\n')
    .map((l) => l.match(/^ {2}(\S+) {2,}\S/))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.equal(listed[0], 'setup', `setup should head the list, not: ${listed.join(', ')}`);
  for (const name of ['serve', 'start', 'stop', 'restart', 'install-hook', 'uninstall-hook',
    'install-statusline', 'uninstall-statusline', 'logs', 'version']) {
    assert.ok(listed.includes(name), `--help no longer lists ${name}`);
  }
});

// ---------------------------------------------------------------------- the refusals ---

/*
 * The prerequisite that stops everything. `claude` is not a Homebrew dependency — it is
 * not packaged there — so this is the one thing an otherwise perfect install can be
 * missing, and a panel without it has nothing to show.
 *
 * The assertion that carries the weight is `calls`: not one installer was spawned, so the
 * settings file was never a candidate for being written.
 */
test('no claude: exits non-zero, says so plainly, and reaches no installer', async () => {
  const h = harness({ which: (program) => program !== 'claude' });
  assert.equal(await runSetup(h.deps), 1);
  assert.deepEqual(h.calls, [], 'nothing may run before the prerequisites are met');
  assert.match(h.text(), /claude: not found/);
  assert.match(h.text(), /Claude Code is not installed/);
  assert.equal(h.opened.length, 0);
});

test('no tmux: the same, and it names the formula dependency it should have arrived as', async () => {
  const h = harness({ which: (program) => program !== 'tmux' });
  assert.equal(await runSetup(h.deps), 1);
  assert.deepEqual(h.calls, []);
  assert.match(h.text(), /brew install tmux/);
});

/*
 * `gh` is the opposite call and the distinction is the point: a team on a GitHub-hosted
 * repository needs it, everything else in the panel does not, so a missing or logged-out
 * `gh` warns and the run finishes.
 */
test('gh missing or logged out warns, and setup finishes anyway', async () => {
  for (const h of [
    harness({ which: (program) => program !== 'gh' }),
    harness({
      run: async (command, args) => (command === 'gh' ? { code: 1, out: '' } : { code: 0, out: '' }),
    }),
  ]) {
    assert.equal(await runSetup(h.deps), 0);
    assert.match(h.text(), /gh auth login/);
    assert.match(h.text(), /gh auth setup-git/);
    assert.match(h.text(), /everything else works/);
  }
});

/*
 * From a checkout there is no `brew services` entry to start and the LaunchAgent installer
 * is a different command — so `setup` refuses rather than guessing, and names the command
 * that does work. Run through the shim as well, since the refusal is the whole of what
 * happens and it touches nothing.
 */
test('a checkout is refused, and pointed at npm run install-agent', async () => {
  const h = harness({ isHomebrew: () => false });
  assert.equal(await runSetup(h.deps), 1);
  assert.deepEqual(h.calls, []);
  assert.match(h.text(), /npm run install-agent/);

  const away = { ...process.env, HOMEBREW_PREFIX: path.join(os.tmpdir(), 'foreman-not-a-prefix') };
  const shim = await exec(process.execPath, [BIN, 'setup'], { env: away }).then(
    () => ({ code: 0, stderr: '' }),
    (err) => ({ code: err.code ?? 1, stderr: err.stderr || '' }),
  );
  assert.notEqual(shim.code, 0, 'a refusal must not look like success to a shell script');
  assert.match(shim.stderr, /npm run install-agent/);
});

// ------------------------------------------------------------------------ the service ---

test('the service is started with brew, by formula name, and the panel is opened', async () => {
  const h = harness({ probe: async (url, budget) => budget > 2000 });
  assert.equal(await runSetup(h.deps), 0);
  assert.deepEqual(
    h.calls.filter(([command]) => /brew$/.test(command) || command === 'brew').map((c) => c.slice(1)),
    [['services', 'start', FORMULA]],
  );
  assert.deepEqual(h.opened, ['http://127.0.0.1:48771']);
});

/*
 * "Already running" is decided by the port and by nothing else — the same stance the
 * panel's own boot guard takes, one floor down. A service that is up is not started
 * again, and the step says so.
 */
test('a panel already answering is not started again', async () => {
  const h = harness({ probe: async () => true });
  assert.equal(await runSetup(h.deps), 0);
  assert.equal(
    h.calls.some(([, verb]) => verb === 'services'),
    false,
    'brew services start must be skipped when something already answers',
  );
  assert.match(h.text(), /already done/);
});

/*
 * "Done" means reachable. A probe that never answers is a non-zero exit, the URL printed
 * rather than opened, and a pointer at the two commands that say why — opening a page that
 * will not load is the "showing something wrong" this project keeps choosing against.
 */
test('a service that never answers does not get opened, and does not report success', async () => {
  const h = harness({ probe: async () => false });
  assert.equal(await runSetup(h.deps), 1);
  assert.deepEqual(h.opened, [], 'a page that will not load must not be opened');
  assert.match(h.text(), /brew services list/);
  assert.match(h.text(), /http:\/\/127\.0\.0\.1:48771/);
});

// --------------------------------------------------------------------- idempotency ---

/*
 * **The "already done" verdict is a fact about the file, not a sentence from the child.**
 * Both installers refuse to rewrite what is already there and say so in their own words,
 * and those words will be reworded — so the witness is the settings file's own bytes,
 * taken either side of the spawn. Here the installers are stubs that write nothing, which
 * is exactly the shape of a second run.
 */
test('a second run reports already done, because settings.json did not change', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, '{"hooks":{}}\n');

  const h = harness({ settingsPath: settings });
  assert.equal(await runSetup(h.deps), 0);
  const verdicts = h.lines.filter((l) => l.startsWith('    ->'));
  assert.deepEqual(verdicts, ['    -> ok', '    -> already done', '    -> already done', '    -> already done']);
});

test('an installer that writes is reported as done, not as already done', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = path.join(dir, 'settings.json');

  // The stub *is* the installer here: it writes the file the way a first run would.
  const h = harness({
    settingsPath: settings,
    probe: async (url, budget) => budget > 2000,
    run: async (command, args) => {
      if (/install-hook\.js$/.test(args[0] || '')) fs.writeFileSync(settings, '{"hooks":{"Stop":[]}}\n');
      if (/install-statusline\.js$/.test(args[0] || '')) fs.writeFileSync(settings, '{"hooks":{"Stop":[]},"statusLine":{}}\n');
      return { code: 0, out: '' };
    },
  });
  assert.equal(await runSetup(h.deps), 0);
  const verdicts = h.lines.filter((l) => l.startsWith('    ->'));
  assert.deepEqual(verdicts, ['    -> ok', '    -> done', '    -> done', '    -> done']);
});

/*
 * A refusal from either installer stops the run and is the exit code. `install-statusline`
 * refuses an unparseable settings.json, and a `setup` that carried on past that would go
 * on to start a panel with no status line and report success.
 */
test('an installer that refuses stops the run and is not reported as success', async () => {
  for (const script of ['install-hook.js', 'install-statusline.js']) {
    const h = harness({
      run: async (command, args) =>
        (String(args[0] || '').endsWith(script) ? { code: 1, out: 'Refused (UNREADABLE_SETTINGS)' } : { code: 0, out: '' }),
    });
    assert.equal(await runSetup(h.deps), 1, `${script} refusing should not exit 0`);
    assert.equal(h.calls.some(([, verb]) => verb === 'services'), false, 'the service must not start after a refusal');
    assert.equal(h.opened.length, 0);
  }
});

// ------------------------------------------------------------------------ the caveat ---

test('the status-line step says the gauges need a subscription account', async () => {
  const h = harness();
  assert.equal(await runSetup(h.deps), 0);
  assert.match(h.text(), /subscription account/);
  assert.match(h.text(), /API-key account/);
});
