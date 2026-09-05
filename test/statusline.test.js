import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  DEFAULT_REFRESH_INTERVAL,
  REFUSALS,
  SIDECAR_FILENAME,
  WRAPPER_FILENAME,
  isOurs,
  looksLikeAWrapper,
  planInstall,
  planRemove,
  shellQuote,
  wrapperScript,
} from '../server/statusline.js';

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..');
const INSTALLER = path.join(REPO, 'server', 'install-statusline.js');

/*
 * Two halves, and the split is the point.
 *
 * The planners are pure — no `fs`, no `process` — so most of this file is ordinary
 * function calls with objects. The rest drives `server/install-statusline.js` as a child
 * process against a scratch `$HOME`, the way `test/cli.test.js` drives the bin shim,
 * because the one thing that must never happen is a test run that rewrites the
 * maintainer's real `~/.claude/settings.json`. Merely *importing* `install-hook.js` does
 * exactly that, which is why it has no test; the guard at the bottom of
 * `install-statusline.js` is what makes this file possible at all.
 */

/** A scratch `$HOME` with a `.claude` in it. Removed when the test ends. */
function scratchHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-statusline-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Run the installer. Never throws on a non-zero exit — a refusal is usually the subject.
 *
 * `FOREMAN_STATE_DIR` is deleted rather than inherited unless a test names one, so the
 * default rung (`$HOME/.foreman`) is what gets exercised even when the suite happens to
 * be run inside a scratch panel's environment.
 */
async function cli(home, args = [], extra = {}) {
  const env = { ...process.env, HOME: home, FOREMAN_PORT: '48770', ...extra };
  if (!('FOREMAN_STATE_DIR' in extra)) delete env.FOREMAN_STATE_DIR;
  try {
    const { stdout, stderr } = await exec(process.execPath, [INSTALLER, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

const settingsPath = (home) => path.join(home, '.claude', 'settings.json');
const statePath = (home, name) => path.join(home, '.foreman', name);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeSettings = (home, obj) =>
  fs.writeFileSync(settingsPath(home), `${JSON.stringify(obj, null, 2)}\n`);

const WRAPPER = '/scratch/state/statusline-wrapper.sh';

// ------------------------------------------------------------------ the pure planners ---

test('a plain command status line is wrapped, and the whole object is recorded', () => {
  const settings = {
    statusLine: { type: 'command', command: 'bash /scratch/alpha/line.sh', padding: 0 },
  };
  const plan = planInstall({ settings, wrapperPath: WRAPPER, port: 48770, now: 0 });

  assert.equal(plan.ok, true);
  assert.equal(plan.settings.statusLine.command, shellQuote(WRAPPER));
  assert.equal(plan.settings.statusLine.type, 'command');
  // Every other key on the object survives — `padding` today, whatever a later Claude
  // Code adds tomorrow. Only `command` is ours to change.
  assert.equal(plan.settings.statusLine.padding, 0);
  assert.deepEqual(plan.sidecar.original, settings.statusLine);
  assert.equal(plan.sidecar.port, 48770);
  assert.equal(plan.sidecar.wrappedAt, '1970-01-01T00:00:00.000Z');
  // The input is never mutated — the caller still has the file it read, to back up.
  assert.equal(settings.statusLine.command, 'bash /scratch/alpha/line.sh');
});

test('no statusLine at all installs anyway, and says the footer keeps a blank row', () => {
  const plan = planInstall({ settings: {}, wrapperPath: WRAPPER, port: 48770 });
  assert.equal(plan.ok, true);
  assert.equal(plan.sidecar.original, null);
  assert.match(plan.warnings.join('\n'), /nothing to wrap/i);
  assert.match(plan.warnings.join('\n'), /blank row/i);
  // Nothing to run, so nothing is printed and the exit code is a plain success.
  assert.doesNotMatch(plan.script, /^printf '%s' "\$payload" \| \S/m);
  assert.match(plan.script, /^exit 0$/m);
});

test('a type this installer has never met is refused by name, and nothing is planned', () => {
  const plan = planInstall({
    settings: { statusLine: { type: 'plugin', command: 'whatever' } },
    wrapperPath: WRAPPER,
    port: 48770,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, REFUSALS.UNKNOWN_TYPE);
  assert.match(plan.message, /"plugin"/, 'the refusal should name the type it found');
  assert.equal(plan.settings, undefined, 'a refusal must not carry something to write');
});

test('settings that did not parse are refused rather than merged into', () => {
  for (const settings of [null, undefined, 'a string', ['an array']]) {
    const plan = planInstall({ settings, wrapperPath: WRAPPER, port: 48770 });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, REFUSALS.UNREADABLE_SETTINGS);
  }
  const removal = planRemove({ settings: null, wrapperPath: WRAPPER });
  assert.equal(removal.ok, false);
  assert.equal(removal.code, REFUSALS.UNREADABLE_SETTINGS);
});

/*
 * The wrapper must never wrap a wrapper: the POST and the original nest one level deeper
 * on every run, and the sidecar of the *first* install is the only record of the real
 * original. Ours is regenerated from the sidecar; anybody else's is refused.
 */
test('an already-wrapped status line regenerates from the sidecar instead of nesting', () => {
  const sidecar = {
    original: { type: 'command', command: 'bash /scratch/alpha/line.sh' },
    port: 48770,
    version: 1,
  };
  // `refreshInterval` is already on it, because the first install put it there — so a
  // regeneration has nothing at all to write back into settings.json.
  const settings = {
    statusLine: { type: 'command', command: shellQuote(WRAPPER), refreshInterval: 60 },
  };
  const plan = planInstall({ settings, sidecar, wrapperPath: WRAPPER, port: 48770 });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.sidecar.original, sidecar.original);
  assert.match(plan.script, /bash \/scratch\/alpha\/line\.sh/);
  assert.doesNotMatch(plan.script, /statusline-wrapper\.sh/, 'the wrapper must not run itself');
  assert.equal(plan.changed, false, 'nothing about settings.json needs rewriting');
});

test('a wrapper belonging to another state dir is refused, not wrapped again', () => {
  const plan = planInstall({
    settings: { statusLine: { type: 'command', command: "'/somewhere/else/statusline-wrapper.sh'" } },
    wrapperPath: WRAPPER,
    port: 48770,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, REFUSALS.FOREIGN_WRAPPER);
  assert.match(plan.message, /uninstall-statusline/);
});

test('wrapped with the sidecar gone, the loss is said out loud rather than guessed at', () => {
  const plan = planInstall({
    settings: { statusLine: { type: 'command', command: shellQuote(WRAPPER) } },
    sidecar: null,
    wrapperPath: WRAPPER,
    port: 48770,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.sidecar.original, null);
  assert.match(plan.warnings.join('\n'), /settings\.backup-foreman-/, 'point at where the original is');
});

// ------------------------------------------------------------------ refreshInterval ---

test('refreshInterval is set when absent, left alone when present, and the fact is recorded', () => {
  const fresh = planInstall({
    settings: { statusLine: { type: 'command', command: 'x' } },
    wrapperPath: WRAPPER,
    port: 48770,
  });
  assert.equal(fresh.settings.statusLine.refreshInterval, DEFAULT_REFRESH_INTERVAL);
  assert.equal(fresh.sidecar.addedRefreshInterval, true);
  assert.match(fresh.notes.join('\n'), /refreshInterval/, 'the installer has to say it did this');

  const theirs = planInstall({
    settings: { statusLine: { type: 'command', command: 'x', refreshInterval: 5 } },
    wrapperPath: WRAPPER,
    port: 48770,
  });
  assert.equal(theirs.settings.statusLine.refreshInterval, 5, 'never overwrite a value somebody set');
  assert.equal(theirs.sidecar.addedRefreshInterval, false);
  // …and the sidecar's `original` keeps their number, so `--remove` puts it back.
  assert.equal(theirs.sidecar.original.refreshInterval, 5);
});

/*
 * A second install must not forget what the first one did. By then the key is present —
 * because we put it there — so the "is it absent?" test answers no, and the flag has to
 * come from the sidecar or it silently flips to false on every regeneration.
 */
test('a regeneration inherits the added-it flag rather than recomputing it', () => {
  const sidecar = {
    original: { type: 'command', command: 'bash /scratch/alpha/line.sh' },
    addedRefreshInterval: true,
    port: 48770,
    version: 1,
  };
  const plan = planInstall({
    settings: { statusLine: { type: 'command', command: shellQuote(WRAPPER), refreshInterval: 60 } },
    sidecar,
    wrapperPath: WRAPPER,
    port: 48770,
  });
  assert.equal(plan.sidecar.addedRefreshInterval, true);
});

// ------------------------------------------------------------------------- removal ---

test('removal restores the recorded object, and removal of nothing of ours changes nothing', () => {
  const original = { type: 'command', command: 'bash /scratch/alpha/line.sh', padding: 0 };
  const settings = {
    hooks: { Stop: [{ matcher: '' }] },
    statusLine: { type: 'command', command: shellQuote(WRAPPER), padding: 0, refreshInterval: 60 },
  };
  const plan = planRemove({ settings, sidecar: { original }, wrapperPath: WRAPPER });
  assert.equal(plan.ok, true);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.settings.statusLine, original);
  // The whole object is the unit that was replaced, so the whole object goes back — which
  // is what takes the refreshInterval with it.
  assert.equal(Object.hasOwn(plan.settings.statusLine, 'refreshInterval'), false);
  assert.deepEqual(plan.settings.hooks, settings.hooks, 'the hooks block is a different feature');

  const foreign = planRemove({
    settings: { statusLine: { type: 'command', command: 'somebody elses line' } },
    sidecar: { original },
    wrapperPath: WRAPPER,
  });
  assert.equal(foreign.changed, false);
  assert.deepEqual(foreign.settings.statusLine, { type: 'command', command: 'somebody elses line' });
});

test('removal with nothing recorded deletes the key rather than inventing a status line', () => {
  const plan = planRemove({
    settings: { statusLine: { type: 'command', command: shellQuote(WRAPPER) } },
    sidecar: { original: null },
    wrapperPath: WRAPPER,
  });
  assert.equal(Object.hasOwn(plan.settings, 'statusLine'), false);
});

// --------------------------------------------------------------- recognising our own ---

test('a command is ours by the wrapper path, quoted or bare, and never by shape alone', () => {
  assert.equal(isOurs(shellQuote(WRAPPER), WRAPPER), true);
  assert.equal(isOurs(WRAPPER, WRAPPER), true);
  assert.equal(isOurs('/somewhere/else/statusline-wrapper.sh', WRAPPER), false);
  assert.equal(isOurs('bash /scratch/alpha/line.sh', WRAPPER), false);
  assert.equal(isOurs(undefined, WRAPPER), false);
  // The shape test is the one that catches another install's wrapper — deliberately
  // broader, and deliberately only ever used to refuse.
  assert.equal(looksLikeAWrapper("'/somewhere/else/statusline-wrapper.sh'"), true);
  assert.equal(looksLikeAWrapper('bash /scratch/alpha/line.sh'), false);
});

test('a path with a quote in it still comes back out of the shell in one piece', () => {
  const nasty = "/scratch/it's here/statusline-wrapper.sh";
  assert.equal(shellQuote(nasty), `'/scratch/it'\\''s here/statusline-wrapper.sh'`);
  assert.equal(isOurs(shellQuote(nasty), nasty), true);
});

// ------------------------------------------------------------------- the script text ---

test('the generated script captures stdin once and forks the POST', () => {
  const script = wrapperScript({
    original: { type: 'command', command: 'bash /scratch/alpha/line.sh' },
    port: 48770,
  });
  // stdin is a pipe and is readable once: capture, then print into each consumer. Counted
  // over the code alone, since the comment above the line quotes `input=$(cat)` too.
  const code = script.split('\n').filter((l) => !l.startsWith('#'));
  assert.equal(code.filter((l) => l.includes('$(cat)')).length, 1);
  // Forked in a subshell with both descriptors closed — a bare `&` leaves curl holding
  // the status line's stdout and stderr.
  assert.match(script, /\( printf '%s' "\$payload" \| curl .* & \) >\/dev\/null 2>&1/s);
  // The whole payload, never a filtered subset: no jq, no field names, `--data-binary @-`.
  assert.match(script, /--data-binary @-/);
  assert.doesNotMatch(script, /rate_limits|jq /);
  assert.match(script, /-H 'Content-Type: application\/json'/);
  assert.match(script, /-H "X-Tmux-Pane: \$TMUX_PANE"/);
  assert.match(script, /-m 2\b/, 'the POST must not be able to hang the terminal line');
  assert.match(script, /PORT=48770/, 'the port is baked in at install, like install-hook.js');
  assert.match(script, /^exit \$\?$/m, "the exit code is the original's");
});

test('the script is a pure function of the sidecar, so a re-run regenerates byte-identically', () => {
  const args = { original: { type: 'command', command: 'bash /scratch/alpha/line.sh' }, port: 48770 };
  assert.equal(wrapperScript(args), wrapperScript(args));
  assert.notEqual(wrapperScript(args), wrapperScript({ ...args, port: 48771 }));
});

// ------------------------------------------------------------------------ the CLI ---

test('installing against a scratch HOME wraps, records, and leaves the hooks alone', async (t) => {
  const home = scratchHome(t);
  writeSettings(home, {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'curl -s x' }] }] },
    model: 'opus',
    statusLine: { type: 'command', command: 'bash /scratch/alpha/line.sh', padding: 0 },
  });
  const before = readJson(settingsPath(home));

  const run = await cli(home, []);
  assert.equal(run.code, 0, run.stderr);

  const after = readJson(settingsPath(home));
  assert.equal(after.statusLine.command, shellQuote(statePath(home, WRAPPER_FILENAME)));
  assert.equal(after.statusLine.padding, 0);
  assert.equal(after.statusLine.refreshInterval, DEFAULT_REFRESH_INTERVAL);
  // Same file, different feature. A whole-object rewrite that dropped a hook would be
  // invisible until a session stopped binding.
  assert.deepEqual(after.hooks, before.hooks);
  assert.equal(after.model, 'opus');

  const wrapper = statePath(home, WRAPPER_FILENAME);
  assert.ok(fs.existsSync(wrapper), 'the wrapper is written before the settings that name it');
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755);
  assert.deepEqual(readJson(statePath(home, SIDECAR_FILENAME)).original, before.statusLine);

  // A timestamped backup beside settings.json — where install-hook.js already puts one.
  const backups = fs.readdirSync(path.join(home, '.claude'))
    .filter((f) => /^settings\.backup-foreman-\d+\.json$/.test(f));
  assert.equal(backups.length, 1, `expected one backup, got ${backups.join(', ')}`);
  assert.deepEqual(readJson(path.join(home, '.claude', backups[0])), before);
});

test('a second install regenerates and rewrites nothing, and a third is the same again', async (t) => {
  const home = scratchHome(t);
  writeSettings(home, { statusLine: { type: 'command', command: 'bash /scratch/alpha/line.sh' } });

  assert.equal((await cli(home, [])).code, 0);
  const wrapped = fs.readFileSync(settingsPath(home), 'utf8');
  const script = fs.readFileSync(statePath(home, WRAPPER_FILENAME), 'utf8');

  const again = await cli(home, []);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already wrapped/i);
  assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), wrapped);
  assert.equal(fs.readFileSync(statePath(home, WRAPPER_FILENAME), 'utf8'), script);
  assert.doesNotMatch(script, /statusline-wrapper\.sh['"]?\s*$/m, 'the wrapper never runs itself');

  const third = await cli(home, []);
  assert.equal(third.code, 0);
  assert.equal(fs.readFileSync(statePath(home, WRAPPER_FILENAME), 'utf8'), script);
  // Nothing changed, so nothing was backed up — a run that writes no settings must not
  // leave a backup of a file it did not touch.
  const backups = fs.readdirSync(path.join(home, '.claude')).filter((f) => f.includes('backup'));
  assert.equal(backups.length, 1, 'only the first install should have backed anything up');
});

test('--remove puts the statusLine back byte for byte and sweeps both files', async (t) => {
  const home = scratchHome(t);
  const original = { type: 'command', command: 'bash /scratch/alpha/line.sh', padding: 0 };
  writeSettings(home, { hooks: { Stop: [] }, statusLine: original });
  const before = readJson(settingsPath(home));

  assert.equal((await cli(home, [])).code, 0);
  const removed = await cli(home, ['--remove']);
  assert.equal(removed.code, 0, removed.stderr);

  const after = readJson(settingsPath(home));
  assert.equal(
    JSON.stringify(after.statusLine, null, 2),
    JSON.stringify(before.statusLine, null, 2),
    'the statusLine object should come back exactly as it was found',
  );
  assert.deepEqual(after, before, 'and so should the rest of the file');
  assert.equal(fs.existsSync(statePath(home, WRAPPER_FILENAME)), false);
  assert.equal(fs.existsSync(statePath(home, SIDECAR_FILENAME)), false);
});

test('with no statusLine, install adds one and --remove takes the key away again', async (t) => {
  const home = scratchHome(t);
  writeSettings(home, { model: 'opus' });

  const run = await cli(home, []);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr + run.stdout, /blank row/i, 'the cost of wrapping nothing has to be said');
  const wrapped = readJson(settingsPath(home));
  assert.equal(wrapped.statusLine.refreshInterval, DEFAULT_REFRESH_INTERVAL);

  assert.equal((await cli(home, ['--remove'])).code, 0);
  const after = readJson(settingsPath(home));
  assert.equal(Object.hasOwn(after, 'statusLine'), false, 'the key we invented goes away again');
  assert.equal(after.model, 'opus');
});

test('a refreshInterval somebody set survives the install and comes back after --remove', async (t) => {
  const home = scratchHome(t);
  const original = { type: 'command', command: 'bash /scratch/alpha/line.sh', refreshInterval: 5 };
  writeSettings(home, { statusLine: original });

  assert.equal((await cli(home, [])).code, 0);
  assert.equal(readJson(settingsPath(home)).statusLine.refreshInterval, 5);
  assert.equal(readJson(statePath(home, SIDECAR_FILENAME)).addedRefreshInterval, false);

  assert.equal((await cli(home, ['--remove'])).code, 0);
  assert.deepEqual(readJson(settingsPath(home)).statusLine, original);
});

test('an unparseable settings.json is refused, and left exactly as it was', async (t) => {
  const home = scratchHome(t);
  const broken = '{ "statusLine": { "type": "command", }\n';
  fs.writeFileSync(settingsPath(home), broken);

  const run = await cli(home, []);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /UNREADABLE_SETTINGS/);
  assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), broken, 'a typo is recoverable; a rewrite is not');
  assert.equal(fs.existsSync(statePath(home, WRAPPER_FILENAME)), false);

  const removal = await cli(home, ['--remove']);
  assert.notEqual(removal.code, 0);
  assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), broken);
});

test('a type other than command is refused by the CLI too, and writes nothing at all', async (t) => {
  const home = scratchHome(t);
  writeSettings(home, { statusLine: { type: 'something-new', command: 'x' } });
  const before = fs.readFileSync(settingsPath(home), 'utf8');

  const run = await cli(home, []);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /UNKNOWN_TYPE/);
  assert.match(run.stderr, /something-new/);
  assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), before);
  assert.equal(fs.existsSync(statePath(home, WRAPPER_FILENAME)), false);
});

// ------------------------------------------------------- the script, actually running ---

/*
 * The three claims that reasoning cannot settle, put to a real shell: the original's
 * stdout and exit code come through untouched, the POST arrives as JSON with the pane
 * header and the *whole* body, and a panel that is not there costs the terminal nothing.
 *
 * The "original" here is a scratch script in the sandbox's own idiom — `input=$(cat)`,
 * exactly the first line of a real one — so nothing on this machine is read or run.
 */
const PAYLOAD = JSON.stringify({
  session_id: 'sess-1',
  workspace: { current_dir: '/scratch/alpha' },
  model: { display_name: 'a model' },
  cost: { total_cost_usd: 0.3 },
  rate_limits: {
    five_hour: { used_percentage: 55.00000000000001, resets_at: 1788571200 },
    seven_day: { used_percentage: 5, resets_at: 1789084800 },
  },
});

function fakeOriginal(dir, { exitCode = 0 } = {}) {
  const file = path.join(dir, 'line.sh');
  fs.writeFileSync(file, [
    '#!/usr/bin/env bash',
    'input=$(cat)',
    `printf 'alpha (main) | %s' "$(printf '%s' "$input" | sed -n 's/.*"display_name":"\\([^"]*\\)".*/\\1/p')"`,
    `exit ${exitCode}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}

/** A one-shot sink. Resolves with the first request it is given, or rejects on timeout. */
function sink() {
  let settle;
  const got = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no POST arrived within 5s')), 5000);
    settle = (v) => { clearTimeout(timer); resolve(v); };
  });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(204).end();
      settle({ url: req.url, headers: req.headers, body });
    });
  });
  return { server, got };
}

test('the wrapper prints what the original printed, and exits with its code', async (t) => {
  const home = scratchHome(t);
  const original = fakeOriginal(home, { exitCode: 3 });
  writeSettings(home, { statusLine: { type: 'command', command: `bash ${original}` } });
  assert.equal((await cli(home, [])).code, 0);

  const bare = await exec('bash', ['-c', `printf '%s' '${PAYLOAD}' | bash ${original}`])
    .catch((err) => ({ stdout: err.stdout, code: err.code }));
  const wrapped = await exec('bash', ['-c', `printf '%s' '${PAYLOAD}' | ${statePath(home, WRAPPER_FILENAME)}`])
    .catch((err) => ({ stdout: err.stdout, code: err.code }));

  assert.equal(wrapped.stdout, bare.stdout, 'the terminal line must be unchanged');
  assert.equal(wrapped.stdout, 'alpha (main) | a model');
  assert.equal(wrapped.code, 3, "`exit $?` is the original's status, not the wrapper's");
});

test('the POST carries the whole payload, as JSON, with the pane header', async (t) => {
  const home = scratchHome(t);
  const original = fakeOriginal(home);
  writeSettings(home, { statusLine: { type: 'command', command: `bash ${original}` } });

  const { server, got } = sink();
  t.after(() => server.close());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  assert.equal((await cli(home, [], { FOREMAN_PORT: String(port) })).code, 0);
  await exec('bash', [
    '-c',
    `printf '%s' '${PAYLOAD}' | TMUX_PANE=%42 ${statePath(home, WRAPPER_FILENAME)}`,
  ]);

  const req = await got;
  assert.equal(req.url, '/status');
  // The content-type lesson, from the other end: the hook was dropped for years because
  // curl labels a body form-urlencoded unless told otherwise.
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers['x-tmux-pane'], '%42');
  // The *whole* payload, not a filtered subset — this is what leaves the door open for
  // everything else already in the body.
  assert.equal(req.body, PAYLOAD);
  assert.deepEqual(JSON.parse(req.body).rate_limits.five_hour.resets_at, 1788571200);
});

test('a panel that is not running costs the status line nothing it can see', async (t) => {
  const home = scratchHome(t);
  const original = fakeOriginal(home);
  writeSettings(home, { statusLine: { type: 'command', command: `bash ${original}` } });
  // A port nothing is listening on: curl fails instantly with a connection refused, in a
  // forked subshell whose descriptors are closed, so neither the output nor the exit code
  // can carry it. Bound and closed rather than picked, so the number is certainly free.
  const idle = http.createServer(() => {});
  await new Promise((r) => idle.listen(0, '127.0.0.1', r));
  const dead = idle.address().port;
  await new Promise((r) => idle.close(r));

  assert.equal((await cli(home, [], { FOREMAN_PORT: String(dead) })).code, 0);
  const run = await exec('bash', [
    '-c',
    `printf '%s' '${PAYLOAD}' | ${statePath(home, WRAPPER_FILENAME)}`,
  ]);
  assert.equal(run.stdout, 'alpha (main) | a model');
  assert.equal(run.stderr, '', 'a panel being down must never show up in the terminal');
});
