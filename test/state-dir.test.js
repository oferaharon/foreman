import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveStateDir, STATE_DIR_NAME, LEGACY_STATE_DIR_NAME } from '../server/config.js';

/*
 * `STATE_DIR` — four rungs, and the third one is the whole reason this file exists.
 *
 * **`$FOREMAN_STATE_DIR` → `~/.foreman` if it exists → the directory this project used to
 * use if *that* exists → `~/.foreman`.** A fresh clone only ever meets the first and last;
 * the middle two exist so a machine carrying a populated older directory goes on reading it
 * after a code update, with no migration and no first-run surprise.
 *
 * Nothing here moves, copies or merges anything, and the tests below assert that as
 * directly as they assert which directory is chosen: an automatic first-run move is exactly
 * the shape that was rejected, and it is the kind of thing a later "helpful" edit adds.
 *
 * Two layers, on purpose. The unit tests drive the pure resolver against real directories
 * under a temporary `HOME`. The last one boots the actual panel as a child process with
 * `HOME` pointed at a temp dir and reads the `State:` line off its own stdout — because the
 * thing that can silently go wrong is not the arithmetic, it is `config.js` resolving at
 * import time against a home nobody injected.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO, 'server', 'index.js');

let home;

test.beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-statedir-'));
});

test.afterEach(async () => {
  if (home) await fsp.rm(home, { recursive: true, force: true });
});

test('with neither directory present the answer is ~/.foreman', () => {
  const { dir, source } = resolveStateDir({ env: {}, home });
  assert.equal(dir, path.join(home, STATE_DIR_NAME));
  assert.match(source, /default/);
});

test('an existing ~/.foreman wins, and is named as existing rather than as the default', () => {
  fs.mkdirSync(path.join(home, STATE_DIR_NAME));
  const { dir, source } = resolveStateDir({ env: {}, home });
  assert.equal(dir, path.join(home, STATE_DIR_NAME));
  assert.equal(source, 'it exists');
});

test('with only the older directory present, that is what the panel reads', () => {
  // The one rung that keeps an existing install working across the rename. It is a path,
  // not a name anything reads as configuration, and it is dead on a fresh machine.
  fs.mkdirSync(path.join(home, LEGACY_STATE_DIR_NAME));
  const { dir } = resolveStateDir({ env: {}, home });
  assert.equal(dir, path.join(home, LEGACY_STATE_DIR_NAME));
});

test('with both present the current name wins', () => {
  // The state a machine is in for as long as somebody has moved the directory but left the
  // old one behind. Preferring the new one is what makes the move take effect the moment it
  // happens rather than at some later cleanup.
  fs.mkdirSync(path.join(home, STATE_DIR_NAME));
  fs.mkdirSync(path.join(home, LEGACY_STATE_DIR_NAME));
  assert.equal(resolveStateDir({ env: {}, home }).dir, path.join(home, STATE_DIR_NAME));
});

test('$FOREMAN_STATE_DIR beats both, which is what isolates a scratch panel', () => {
  fs.mkdirSync(path.join(home, STATE_DIR_NAME));
  fs.mkdirSync(path.join(home, LEGACY_STATE_DIR_NAME));
  const { dir, source } = resolveStateDir({ env: { FOREMAN_STATE_DIR: '/tmp/scratch-state' }, home });
  assert.equal(dir, '/tmp/scratch-state');
  assert.equal(source, '$FOREMAN_STATE_DIR');
});

test('resolving is not a migration: nothing is created, moved or copied', () => {
  // The rejected shape, pinned. A resolver that "helpfully" renamed the older directory on
  // first run would pass every assertion above and lose somebody's history to a crash
  // halfway through.
  fs.mkdirSync(path.join(home, LEGACY_STATE_DIR_NAME));
  fs.writeFileSync(path.join(home, LEGACY_STATE_DIR_NAME, 'tasks.json'), '{}');

  resolveStateDir({ env: {}, home });
  resolveStateDir({ env: {}, home });

  assert.deepEqual(fs.readdirSync(home).sort(), [LEGACY_STATE_DIR_NAME]);
  assert.deepEqual(fs.readdirSync(path.join(home, LEGACY_STATE_DIR_NAME)), ['tasks.json']);
});

/*
 * The end-to-end half. `config.js` resolves at import time off `os.homedir()`, which reads
 * `$HOME` on POSIX — so the only honest way to prove the rungs reach a running panel is to
 * start one with `HOME` pointed somewhere else and read what it says about itself.
 *
 * A scratch port and a scratch label, always: the port so it cannot collide with a real
 * panel (and so the boot guard does not make it stand down against one), the label so its
 * boot-time log rotation cannot touch the real panel's two files.
 */
function bootAndReadStateLine(env) {
  const port = 48900 + Math.floor(process.hrtime()[1] % 90);
  let out = '';
  try {
    out = execFileSync(process.execPath, ['-e', `
      import(${JSON.stringify(ENTRY)}).catch((e) => { console.error(e); process.exit(1); });
      setTimeout(() => process.exit(0), 1500);
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        FOREMAN_PORT: String(port),
        FOREMAN_AGENT_LABEL: 'dev.foreman.state-dir-test',
        FOREMAN_STATE_DIR: '',
      },
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = err.stdout || '';
  }
  const line = out.split('\n').find((l) => l.startsWith('State: '));
  assert.ok(line, `no State: line in the boot output:\n${out}`);
  return line;
}

test('a real boot reads the older directory when that is the only one there', () => {
  fs.mkdirSync(path.join(home, LEGACY_STATE_DIR_NAME));
  const line = bootAndReadStateLine({ HOME: home });
  assert.ok(
    line.includes(path.join(home, LEGACY_STATE_DIR_NAME)),
    `expected the older directory in: ${line}`,
  );
});

test('a real boot with neither directory present names ~/.foreman and creates only that', () => {
  const line = bootAndReadStateLine({ HOME: home });
  assert.ok(line.includes(path.join(home, STATE_DIR_NAME)), `expected ~/.foreman in: ${line}`);
  assert.ok(fs.existsSync(path.join(home, STATE_DIR_NAME)), 'the panel created the directory it named');
  assert.ok(!fs.existsSync(path.join(home, LEGACY_STATE_DIR_NAME)), 'and nothing under the older name');
});

/*
 * And the shape that made a suite write into the *real* state dir while looking correct.
 *
 * A test that wants its own state dir sets `process.env.FOREMAN_STATE_DIR` at the top of
 * the file — but **ESM hoists every static `import` above every statement**, so a static
 * import of anything that reaches `config.js` evaluates it, and freezes `STATE_DIR`,
 * before that assignment has run. Position in the file makes no difference: the comment
 * saying "above the imports" is true of the source and false of the execution order.
 * `base-branch.test.js` and `worktree.test.js` both had it, and both cut their scratch
 * worktrees straight into `~/.foreman/worktrees/` beside real workers' — every `npm test`,
 * silently, with the suite's own teardown removing only the empty temp dir it made.
 *
 * The scan is deliberately structural rather than a list of modules known to reach
 * `config.js`: the import graph moves, and a module that is pure today reaches it tomorrow.
 * So the rule is that a file which sets the variable at all loads *every* repo module with
 * `await import()`, which is one line per import and always correct. Same reasoning as
 * `session-launch.test.js` reading `server/index.js` and `logs.test.js` reading the shell
 * script — a source-level scan is the only mechanism, because the defect is invisible at
 * run time.
 */
const ASSIGNS_STATE_DIR = /^process\.env(?:\.FOREMAN_STATE_DIR|\['FOREMAN_STATE_DIR'\]|\["FOREMAN_STATE_DIR"\])\s*=/m;
const STATIC_IMPORTS = [
  /^import\s+[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/gm, // import x from '…' / import { a, b } from '…'
  /^import\s*['"]([^'"]+)['"]/gm, //                  import '…'  (side effect only)
];

test('a test that sets $FOREMAN_STATE_DIR loads repo modules dynamically, never statically', () => {
  const dir = path.join(REPO, 'test');
  const offenders = [];

  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const assignment = src.match(ASSIGNS_STATE_DIR);
    if (!assignment) continue;

    const line = src.slice(0, assignment.index).split('\n').length;
    for (const re of STATIC_IMPORTS) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        if (!m[1].startsWith('.')) continue; // node: and package imports cannot reach config.js
        offenders.push(`${name}:${line} sets FOREMAN_STATE_DIR, then statically imports '${m[1]}'`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these are hoisted above the assignment and resolve STATE_DIR against the real ~/.foreman — `
      + `use \`const { … } = await import('…')\` after the assignment:\n  ${offenders.join('\n  ')}`,
  );
});
