import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FALLBACK, clearHumanNameCache, humanName } from '../server/human-name.js';

/*
 * Real throwaway repos, never a stub: this is a git wrapper, and stubbing git to test a
 * git wrapper proves nothing (CLAUDE.md, and every other git wrapper in this suite).
 *
 * The two config files this Mac actually has are pushed out of the way for the whole run
 * — `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` — because otherwise "no name configured"
 * is untestable anywhere except a machine that has never run `git config --global`, and
 * the assertions would silently start passing for the wrong reason (or asserting whoever
 * happens to own the machine, which is the defect this whole item is about).
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-human-'));
const globalConfig = path.join(scratch, 'gitconfig-global');
fs.writeFileSync(globalConfig, '');

const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedSystem = process.env.GIT_CONFIG_SYSTEM;
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

test.after(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = savedSystem;
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A real repo, optionally with a `user.name` of its own. */
function repo(name, localName = null) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (localName) execFileSync('git', ['config', 'user.name', localName], { cwd: dir });
  return dir;
}

const setGlobal = (name) => fs.writeFileSync(globalConfig, name ? `[user]\n\tname = ${name}\n` : '');

test('a repo with its own user.name answers with it', () => {
  clearHumanNameCache();
  assert.equal(humanName(repo('alpha', 'alpha-owner')), 'alpha-owner');
});

test('a repo with no user.name of its own falls through to the global one', () => {
  clearHumanNameCache();
  setGlobal('global-owner');
  assert.equal(humanName(repo('beta')), 'global-owner');
  setGlobal(null);
});

test('a local name beats the global one — which is why this is resolved per repo', () => {
  clearHumanNameCache();
  setGlobal('global-owner');
  assert.equal(humanName(repo('gamma', 'gamma-owner')), 'gamma-owner');
  setGlobal(null);
});

test('no name configured anywhere is an ordinary state, and answers the fallback', () => {
  clearHumanNameCache();
  assert.equal(humanName(repo('delta')), FALLBACK);
});

test('an empty or whitespace user.name is the same as none', () => {
  clearHumanNameCache();
  const dir = repo('epsilon');
  // `git config user.name ' '` is accepted and stored; git itself answers a blank line.
  execFileSync('git', ['config', 'user.name', '   '], { cwd: dir });
  assert.equal(humanName(dir), FALLBACK);
});

test('a handle is a name — nothing here prettifies, splits or title-cases it', () => {
  clearHumanNameCache();
  assert.equal(humanName(repo('zeta', 'someuser99')), 'someuser99');
  clearHumanNameCache();
  assert.equal(humanName(repo('eta', 'first.last-x_1')), 'first.last-x_1');
});

test('a multi-line name is read as its first line, so the markdown around it survives', () => {
  clearHumanNameCache();
  const dir = repo('theta');
  execFileSync('git', ['config', 'user.name', 'One Line\nsecond line'], { cwd: dir });
  assert.equal(humanName(dir), 'One Line');
});

test('a directory that is not a repo still answers, because git config is not repo-only', () => {
  clearHumanNameCache();
  setGlobal('global-owner');
  const plain = path.join(scratch, 'not-a-repo');
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(humanName(plain), 'global-owner');
  setGlobal(null);
});

test('a path that is not there, and no path at all, answer the fallback rather than the operator', () => {
  clearHumanNameCache();
  setGlobal('global-owner');
  // The important half: with no repo to ask in, reading the *global* name would quietly
  // put whoever owns the machine into a brief generated for a repo that isn't there.
  assert.equal(humanName(path.join(scratch, 'nope', 'nope')), FALLBACK);
  assert.equal(humanName(null), FALLBACK);
  assert.equal(humanName(), FALLBACK);
  assert.equal(humanName(path.join(scratch, 'gitconfig-global')), FALLBACK, 'a file is not a checkout');
  setGlobal(null);
});

test('the cache is per repo, so two repos with different names do not share one answer', () => {
  clearHumanNameCache();
  const one = repo('iota', 'one-owner');
  const two = repo('kappa', 'two-owner');
  assert.equal(humanName(one), 'one-owner');
  assert.equal(humanName(two), 'two-owner');
  assert.equal(humanName(one), 'one-owner', 'and the second read does not overwrite the first');

  // Cached, deliberately: a room line composed on every tick must not shell out on every
  // tick. The consequence is that a name changed under a running panel is not seen until
  // it restarts, which is what `clearHumanNameCache` exists to say out loud.
  execFileSync('git', ['config', 'user.name', 'renamed'], { cwd: one });
  assert.equal(humanName(one), 'one-owner', 'still the cached answer');
  clearHumanNameCache();
  assert.equal(humanName(one), 'renamed');
});
