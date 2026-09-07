/**
 * `foreman-panel setup` — the one command a Homebrew install needs after `brew install`.
 *
 * Four commands and a README paragraph used to stand between `brew install` and a panel
 * you can open: register the hook, wrap the status line, start the service, find the URL.
 * Every one of them is still here as plumbing and none is removed — this is the order
 * they go in, printed as it happens, so the README can be two lines.
 *
 * ## Why this is a module and not fifty lines in `bin/foreman-panel.js`
 *
 * The shim's own header says it re-implements nothing, and that stays true: every step
 * here is the existing installer, spawned exactly the way the shim already spawns it.
 * What the shim cannot hold is the *seam* — `runSetup` takes its shell-outs, its PATH
 * lookup and its HTTP probe as arguments, so the suite can prove the order and the
 * refusals without running an installer or shelling `brew`. A `bin/` script is only
 * testable as a child process, and a child process cannot be handed a fake `brew`.
 *
 * **Not `setup.js`.** `server/setup-detect.js` already owns that word for something
 * entirely different — the *worktree prepare* command a dispatched worker runs. Two files
 * a letter apart doing unrelated things is the sibling-name mistake this repo has made
 * once already; the command's name is `setup`, so the file is `setup-command.js`.
 *
 * ## Three decisions worth reading before changing anything
 *
 * **"Already done" is a fact about the file, never a sentence from the child.** Both
 * installers refuse to rewrite what is already there and say so in their own words — and
 * their words will be reworded, the way every human-facing string here eventually is. So
 * the verdict is a byte comparison of `~/.claude/settings.json` taken either side of the
 * spawn: unchanged means nothing was written, whatever the child called it. The child's
 * own output is still printed verbatim underneath, indented, because it carries the one
 * thing this cannot reconstruct — where the backup went.
 *
 * **The service step probes before it starts, and skips.** `brew services start` on a
 * running service is harmless, but "already running" is a fact worth printing and the
 * only honest source of it is the port. Anything answering on `127.0.0.1:<port>` is
 * treated as the panel, which is the same stance `index.js`'s own boot guard takes one
 * floor down — and for the same reason: two panels on one port is the silent failure this
 * project has already been bitten by.
 *
 * **It starts no session and touches no pane.** The whole of what it changes is
 * `~/.claude/settings.json`, through the two existing installers that back it up first,
 * and the Homebrew service. Nothing here knows what tmux is.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PORT, SETTINGS_PATH } from './config.js';
import { FORMULA, brewBinary, panelIsHomebrew } from './homebrew.js';
import { onPath } from './forge.js';

const execFileAsync = promisify(execFile);
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The steps, in the order they run and in the words they print.
 *
 * One list, read by three things that would otherwise drift: the command itself, the
 * `--help` line, and `docs/running.md` — `test/setup.test.js` asserts the documentation
 * names these five in this order, which is the only mechanism that holds prose to code.
 */
export const SETUP_STEPS = [
  { key: 'prereqs', line: 'Checking prerequisites.' },
  { key: 'hook', line: 'Registering the status hook.' },
  { key: 'statusline', line: 'Wrapping the status line.' },
  { key: 'service', line: 'Starting the panel.' },
  { key: 'done', line: 'Done.' },
];

/** Run a child to completion. Never throws — the exit code is the answer. */
async function defaultRun(command, args, { timeout = 0 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    // A spawn failure puts a string in `code` (`ENOENT`); an exit puts a number there.
    const code = typeof err.code === 'number' ? err.code : 127;
    const out = `${err.stdout || ''}${err.stderr || ''}` || String(err.message || err);
    return { code, out };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One HTTP GET. Any response at all is an answer; a timeout or a refusal is not. */
function knock(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** Knock until something answers or the budget runs out. Always knocks at least once. */
async function defaultProbe(url, budgetMs, { attemptMs = 1000, gapMs = 400 } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await knock(url, attemptMs)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(gapMs);
  }
}

/** macOS only, like everything else here. Failure to open is not a failure to install. */
async function defaultOpen(url) {
  await defaultRun('/usr/bin/open', [url], { timeout: 5000 });
}

/** The bytes of `settings.json`, or `null` if it is not there. The "already done" witness. */
function snapshot(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

const same = (a, b) => (a === null || b === null ? a === b : a.equals(b));

/**
 * Run the whole thing. Returns the process exit code; prints everything it does.
 *
 * Every outward-facing thing is a parameter, and that is the point: the suite runs this
 * with a fake `run`, a fake `probe` and a fake PATH, so it can assert that a machine
 * without `claude` reaches no installer at all.
 */
export async function runSetup({
  env = process.env,
  isHomebrew = () => panelIsHomebrew(env),
  which = (program) => onPath(program),
  run = defaultRun,
  probe = defaultProbe,
  openUrl = defaultOpen,
  log = (line) => console.log(line),
  fail = (line) => console.error(line),
  node = process.execPath,
  serverDir = SERVER_DIR,
  settingsPath = SETTINGS_PATH,
  port = PORT,
  probeBudgetMs = 10_000,
  runningBudgetMs = 1_000,
} = {}) {
  const url = `http://127.0.0.1:${port}`;
  const total = SETUP_STEPS.length;
  const at = (key) => {
    const i = SETUP_STEPS.findIndex((s) => s.key === key);
    log(`${i + 1}/${total} ${SETUP_STEPS[i].line}`);
  };
  const detail = (text) => {
    for (const line of String(text).split('\n')) {
      if (line.trim()) log(`    ${line.trimEnd()}`);
    }
  };
  const verdict = (word) => log(`    -> ${word}`);

  // The gate, ahead of the five steps because it is about the command and not about the
  // machine: from a checkout there is no `brew services` entry to start, and the panel's
  // own LaunchAgent installer is a different command with different arguments.
  if (!isHomebrew()) {
    fail(`${FORMULA} setup brings up the Homebrew service, and this is not a Homebrew install.`);
    fail("You're in a checkout — use `npm run install-agent`.");
    return 1;
  }

  // --- 1. prerequisites -------------------------------------------------------------
  at('prereqs');
  // Claude Code is not a Homebrew dependency — it is not packaged there — so this is the
  // one prerequisite an otherwise perfect install can be missing, and the panel does
  // nothing at all without it.
  if (!which('claude')) {
    detail('claude: not found');
    fail('');
    fail('Claude Code is not installed. The panel has nothing to show without it.');
    fail('Install it first, then run this again.');
    return 1;
  }
  detail('claude: found');
  // tmux is a formula dependency, so this only ever fires on an install that is already
  // broken — but it is the roster and the channel every keystroke goes through, and a
  // panel without it is an empty page with no explanation.
  if (!which('tmux')) {
    detail('tmux: not found');
    fail('');
    fail('tmux is missing. It ships as a dependency of this formula, so something is wrong');
    fail('with the install — `brew install tmux` fixes it directly.');
    return 1;
  }
  detail('tmux: found');
  // `gh` is a warning and never a failure: it is needed only by a team on a GitHub-hosted
  // repository, and everything else in the panel works without it.
  const ghAdvice = 'teams need `gh auth login` and `gh auth setup-git` later; everything else works.';
  if (!which('gh')) {
    detail('gh: not found');
    log(`!   gh is not installed — ${ghAdvice}`);
  } else {
    const auth = await run('gh', ['auth', 'status'], { timeout: 15_000 });
    // 127 is `defaultRun`'s spawn failure, not an exit code: `onPath` looks in the
    // directories a login shell would have, which is a wider question than "can this
    // process spawn it". Say which of the two it was rather than calling it a logout.
    if (auth.code === 0) detail('gh: logged in');
    else {
      detail(auth.code === 127 ? 'gh: could not be run' : 'gh: not logged in');
      log(`!   ${ghAdvice}`);
    }
  }
  verdict('ok');

  // --- 2. the hook ------------------------------------------------------------------
  at('hook');
  const beforeHook = snapshot(settingsPath);
  const hook = await run(node, [path.join(serverDir, 'install-hook.js')]);
  detail(hook.out);
  if (hook.code !== 0) {
    fail('');
    fail(`Registering the hook failed (exit ${hook.code}). Nothing else was changed.`);
    return 1;
  }
  verdict(same(beforeHook, snapshot(settingsPath)) ? 'already done' : 'done');

  // --- 3. the status line -----------------------------------------------------------
  at('statusline');
  const beforeLine = snapshot(settingsPath);
  const line = await run(node, [path.join(serverDir, 'install-statusline.js')]);
  detail(line.out);
  if (line.code !== 0) {
    fail('');
    fail(`Wrapping the status line failed (exit ${line.code}). The hook is registered.`);
    return 1;
  }
  log('    The gauges need a subscription account — an API-key account has no usage');
  log('    percentage in the payload, so they simply never appear.');
  verdict(same(beforeLine, snapshot(settingsPath)) ? 'already done' : 'done');

  // --- 4. the service ---------------------------------------------------------------
  at('service');
  let up = await probe(`${url}/`, runningBudgetMs);
  if (up) {
    detail(`something is already answering on ${url}`);
    verdict('already done');
  } else {
    const started = await run(brewBinary(env), ['services', 'start', FORMULA]);
    detail(started.out);
    if (started.code !== 0) {
      fail('');
      fail(`\`brew services start ${FORMULA}\` failed (exit ${started.code}).`);
      return 1;
    }
    up = await probe(`${url}/`, probeBudgetMs);
    detail(up ? `${url} answered` : `${url} did not answer`);
    verdict(up ? 'done' : 'no answer');
  }

  // --- 5. done ----------------------------------------------------------------------
  at('done');
  if (!up) {
    log(`    The panel is at ${url}, but nothing is answering there yet.`);
    log('    Check `brew services list` and `foreman-panel logs`.');
    return 1;
  }
  log(`    ${url}`);
  await openUrl(url);
  return 0;
}
