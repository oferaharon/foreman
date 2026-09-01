import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { rotateLogs, rotationLines, formatBytes, LOG_FILES, LOG_OUT, LOG_ERR, DEFAULT_AGENT_LABEL } from '../server/logs.js';
import { STATE_DIR_NAME, LEGACY_STATE_DIR_NAME } from '../server/config.js';

const run = promisify(execFile);

/*
 * Real files, and — for the one that matters — a real child process holding a real open
 * descriptor on them, opened the way launchd opens `StandardOutPath`: O_WRONLY|O_CREAT|
 * O_APPEND, handed to the child as fd 1 and never reopened. Nothing here is stubbed,
 * because the entire subject of this file is what an *already-open descriptor* does when
 * the file underneath it moves or shrinks, and a stub of a file descriptor cannot have an
 * opinion about that.
 */

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A process whose stdout is an appending descriptor on `file`, exactly like a launchd job. */
function daemon(t, file) {
  const fd = fs.openSync(file, 'a');
  const child = spawn(process.execPath, ['-e', "const fs=require('fs');process.stdin.on('data',(d)=>fs.writeSync(1,d));"], {
    stdio: ['pipe', fd, 'ignore'],
  });
  fs.closeSync(fd); // the child owns it now — the same asymmetry launchd has
  t.after(() => child.kill('SIGKILL'));
  return child;
}

/** Make it log a line, and wait until the bytes have actually landed somewhere. */
async function say(child, text, watch) {
  const before = watch.map((f) => (fs.existsSync(f) ? fs.statSync(f).size : -1));
  child.stdin.write(`${text}\n`);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const now = watch.map((f) => (fs.existsSync(f) ? fs.statSync(f).size : -1));
    if (now.some((size, i) => size !== before[i])) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`nothing was written after "${text}"`);
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

// ------------------------------------------------------------------- the trap itself ---

/*
 * The reason this feature is copy-then-truncate and not `mv`. Seeing it fail once is
 * worth more than the paragraph in `logs.js` saying it will.
 */
test('renaming the log does NOT make the writer reopen it — the "fresh" log never appears', async (t) => {
  const dir = scratch(t);
  const live = path.join(dir, 'foreman.log');
  const moved = `${live}.1`;

  const child = daemon(t, live);
  await say(child, 'before the rotation', [live]);

  fs.renameSync(live, moved);
  await say(child, 'after the rotation', [live, moved]);

  // Both lines are in the archive; the live path does not exist at all. A `tail -f` on it
  // would sit there forever showing nothing while the daemon logs happily into `.1`.
  assert.equal(read(live), null, 'the renamed-away log should not have been recreated');
  assert.match(read(moved), /before the rotation/);
  assert.match(read(moved), /after the rotation/, 'the descriptor followed the inode, not the path');
});

test('truncating it does — the writer keeps landing in the live path, from zero', async (t) => {
  const dir = scratch(t);
  const live = path.join(dir, 'foreman-error.log');
  const keep = `${live}.1`;

  const child = daemon(t, live);
  await say(child, 'old noise', [live]);
  fs.appendFileSync(live, 'x'.repeat(4096));

  const { rotated } = rotateLogs([{ file: live, limit: 1024 }]);
  assert.equal(rotated.length, 1);
  assert.equal(fs.statSync(live).size, 0, 'the live log should be empty right after the rotation');
  assert.match(read(keep), /old noise/, 'the history should be in .1');

  await say(child, 'still writing here', [live]);
  const after = read(live);
  assert.match(after, /still writing here/);
  // The O_APPEND proof: the descriptor was sitting at a 4 KB offset. If it had kept that
  // offset we would get a sparse file of NULs with the line at the end.
  assert.equal(fs.statSync(live).size, Buffer.byteLength(after), 'no sparse hole left by the old offset');
  assert.ok(after.startsWith('still writing here'), `expected a fresh file, got ${JSON.stringify(after.slice(0, 40))}`);
});

// ------------------------------------------------------------------------- the policy ---

test('a log under its threshold is untouched, and reported as nothing', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'small.log');
  fs.writeFileSync(file, 'a'.repeat(500));

  const { rotated, notes } = rotateLogs([{ file, limit: 1024 }]);
  assert.deepEqual(rotated, []);
  assert.deepEqual(notes, []);
  assert.equal(fs.statSync(file).size, 500);
  assert.equal(fs.existsSync(`${file}.1`), false);
  assert.deepEqual(rotationLines(rotated), []);
});

test('exactly at the threshold is under it — rotation is for logs that have grown past', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'edge.log');
  fs.writeFileSync(file, 'a'.repeat(1024));

  assert.deepEqual(rotateLogs([{ file, limit: 1024 }]).rotated, []);
  assert.equal(fs.statSync(file).size, 1024);
});

test('a missing log is a no-op, not an error — that is the plain `npm start` case', (t) => {
  const dir = scratch(t);
  const missing = path.join(dir, 'never-existed.log');

  const { rotated, notes } = rotateLogs([{ file: missing, limit: 1 }]);
  assert.deepEqual(rotated, []);
  assert.deepEqual(notes, [], 'a panel started by hand has no launchd log and must not complain about it');
  assert.equal(fs.existsSync(missing), false, 'and nothing may be created on its way past');
  assert.equal(fs.existsSync(`${missing}.1`), false);
});

test('a second rotation overwrites .1 rather than accumulating', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'busy.log');

  fs.writeFileSync(file, `first generation${'.'.repeat(4096)}`);
  rotateLogs([{ file, limit: 1024 }]);
  assert.match(read(`${file}.1`), /first generation/);

  fs.writeFileSync(file, `second generation${'.'.repeat(4096)}`);
  const { rotated } = rotateLogs([{ file, limit: 1024 }]);

  assert.equal(rotated.length, 1);
  assert.match(read(`${file}.1`), /second generation/);
  assert.doesNotMatch(read(`${file}.1`), /first generation/, 'one previous copy, not two');
  assert.equal(fs.existsSync(`${file}.2`), false, 'no .2, no dated archive — a bounded floor, not an archive');
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['busy.log', 'busy.log.1'],
    'the whole floor is two files per log',
  );
});

test('both logs rotate in one pass, and only the ones over their own threshold', (t) => {
  const dir = scratch(t);
  const out = path.join(dir, 'out.log');
  const err = path.join(dir, 'err.log');
  fs.writeFileSync(out, 'a'.repeat(100));
  fs.writeFileSync(err, 'b'.repeat(9000));

  const { rotated } = rotateLogs([{ file: out, limit: 1024 }, { file: err, limit: 1024 }]);
  assert.deepEqual(rotated.map((r) => r.file), [err]);
  assert.equal(fs.existsSync(`${out}.1`), false);
  assert.equal(fs.statSync(err).size, 0);
});

test('a log that cannot be copied is a note, not a thrown boot', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'stuck.log');
  fs.writeFileSync(file, 'z'.repeat(4096));
  // `.1` is a directory: `copyFileSync` fails, and the original must survive intact —
  // a truncate whose copy failed has thrown the history away for nothing.
  fs.mkdirSync(`${file}.1`);

  const { rotated, notes } = rotateLogs([{ file, limit: 1024 }]);
  assert.deepEqual(rotated, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /could not rotate/);
  assert.equal(fs.statSync(file).size, 4096, 'the log is still there — nothing was truncated');
});

// -------------------------------------------------------------------------- reporting ---

test('the report names the file, the size it had, and where it went', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'foreman-error.log');
  fs.writeFileSync(file, Buffer.alloc(12_400_000));

  const { rotated } = rotateLogs([{ file, limit: 1024 }]);
  assert.deepEqual(rotationLines(rotated), [
    'Rotated foreman-error.log (12.4 MB → foreman-error.log.1)',
  ]);
});

test('formatBytes scales, and never dresses a small file up as a big one', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(172), '172 B');
  assert.equal(formatBytes(12_400), '12.4 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.2 MB');
});

// ----------------------------------------------------------------------------- naming ---

test('the default log paths are the two the plist names', () => {
  assert.equal(path.basename(LOG_OUT), 'foreman.log');
  assert.equal(path.basename(LOG_ERR), 'foreman-error.log');
  assert.equal(path.dirname(LOG_OUT), path.join(os.homedir(), 'Library', 'Logs'));
  assert.deepEqual(LOG_FILES.map((f) => f.file), [LOG_OUT, LOG_ERR]);
});

test('the thresholds are the measured ones — 1 MiB out, 5 MiB error', () => {
  const [out, err] = LOG_FILES;
  assert.equal(out.limit, 1024 * 1024, '172 bytes a boot: a megabyte is thousands of them');
  assert.equal(err.limit, 5 * 1024 * 1024, '430 KB/hour in a crash-loop: five megabytes is an overnight');
});

/*
 * The bench-isolation contract. Every launchd finding in this repo was measured with a
 * throwaway `FOREMAN_AGENT_LABEL`, and rotation is the first thing that *destroys* data — so
 * a scratch label that resolved to the real log would delete the real panel's history on
 * the first run of the first bench. Read at import, so it takes a subprocess to prove.
 */
test('FOREMAN_AGENT_LABEL moves the logs somewhere a bench cannot hurt the real ones', async () => {
  const { stdout } = await run(process.execPath, [
    '--input-type=module',
    '-e', "import { LOG_OUT, LOG_ERR } from './server/logs.js'; console.log(LOG_OUT); console.log(LOG_ERR);",
  ], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, FOREMAN_AGENT_LABEL: 'com.example.foreman-scratch' } });

  const [out, err] = stdout.trim().split('\n');
  assert.equal(path.basename(out), 'com.example.foreman-scratch.log');
  assert.equal(path.basename(err), 'com.example.foreman-scratch-error.log');
  assert.notEqual(out, LOG_OUT);
  assert.notEqual(err, LOG_ERR);
});

/*
 * The label has **three** copies, and two of them are outside JavaScript.
 *
 * `logs.js` owns it; `package.json` bakes it into the `restart-panel` and `stop-panel`
 * scripts; `scripts/backup-state.sh` hardcodes it as the fallback for when the repo is not
 * beside the script. Rename one and miss the others and `npm run restart-panel` kickstarts
 * a job that does not exist — no error, no output, nothing restarted — while the backup
 * captures the wrong plist or none.
 *
 * Neither of those two can import anything, so nothing but a test can hold them together.
 * This is the same shape as the naming contract `slugFor` and `isLeadName` share, except
 * that here the copies live in three different languages.
 */
test('all three copies of the launchd label agree', async () => {
  const repo = path.resolve(import.meta.dirname, '..');

  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.ok(
    pkg.scripts['restart-panel'].includes(DEFAULT_AGENT_LABEL),
    `restart-panel names a different label: ${pkg.scripts['restart-panel']}`,
  );
  assert.ok(
    pkg.scripts['stop-panel'].includes(DEFAULT_AGENT_LABEL),
    `stop-panel names a different label: ${pkg.scripts['stop-panel']}`,
  );

  const sh = fs.readFileSync(path.join(repo, 'scripts', 'backup-state.sh'), 'utf8');
  assert.ok(
    sh.includes(`DEFAULT_AGENT_LABEL="${DEFAULT_AGENT_LABEL}"`),
    'backup-state.sh hardcodes a different label',
  );
});

/*
 * …and `backup-state.sh` carries a second copy of the state-dir rungs, for the same reason
 * it carries the label: bash cannot import, and a copy of the script without the repo
 * beside it still has to find the directory the panel is actually reading. A drift here is
 * a backup of an empty directory that reports success.
 */
test('backup-state.sh resolves the same two state directories the panel does', () => {
  const sh = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'backup-state.sh'), 'utf8');
  assert.ok(sh.includes(`$HOME/${STATE_DIR_NAME}`), 'backup-state.sh does not name the current state dir');
  assert.ok(sh.includes(`$HOME/${LEGACY_STATE_DIR_NAME}`), 'backup-state.sh does not name the older state dir');
  assert.ok(sh.includes('${FOREMAN_STATE_DIR:-}'), 'backup-state.sh does not read $FOREMAN_STATE_DIR');
});
