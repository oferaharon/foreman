import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmuxPath } from '../server/tmux.js';

const run = promisify(execFile);

/*
 * launchd gives a job PATH=/usr/bin:/bin:/usr/sbin:/sbin (VERIFIED against a real
 * LaunchAgent), and tmux lives outside that PATH on this Mac. This is a real subprocess
 * against a real restricted PATH and the real filesystem — not a stub of either — so it
 * reproduces the bug and proves the fix rather than asserting an implementation detail.
 */

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

test('tmuxPath resolves an absolute, executable path on this machine', async () => {
  const p = await tmuxPath();
  assert.ok(path.isAbsolute(p), `expected an absolute path, got ${p}`);
  await assert.doesNotReject(() => fsp.access(p, fsp.constants.X_OK));
});

test('tmuxPath is memoised — repeat calls return the same answer', async () => {
  const [first, second] = await Promise.all([tmuxPath(), tmuxPath()]);
  assert.equal(first, second);
});

test('a bare "tmux" fails under a launchd-shaped PATH; the resolved path does not', async () => {
  const restrictedEnv = { ...process.env, PATH: LAUNCHD_PATH };

  await assert.rejects(
    () => run('tmux', ['-V'], { env: restrictedEnv }),
    /ENOENT/,
    'bare "tmux" should not resolve under a launchd-shaped PATH — if it does, this test no longer proves anything on this machine',
  );

  const resolved = await tmuxPath();
  const { stdout } = await run(resolved, ['-V'], { env: restrictedEnv });
  assert.match(stdout, /tmux/i);
});
