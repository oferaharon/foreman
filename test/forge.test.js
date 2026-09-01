import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  READINGS,
  credentialKeys,
  detectForge,
  onPath,
  readingFor,
  remoteHost,
  resetForgeCache,
  resolveForge,
} from '../server/forge.js';

/*
 * The host parser and the pair→reading table are pure, so they are tested as pure
 * functions; the git read is tested against real throwaway repos, the way every other git
 * wrapper in this suite is (stubbing git to test a git wrapper proves nothing).
 *
 * No real host appears anywhere in here. `git.example.com` and friends stand in for the
 * self-hosted case — a fixture that named the real one would publish it the moment this
 * branch is pushed.
 */

test('a remote host is read out of both spellings, and out of neither', () => {
  assert.equal(remoteHost('https://github.com/oferaharon/foreman.git'), 'github.com');
  assert.equal(remoteHost('git@github.com:oferaharon/foreman.git'), 'github.com', 'scp-like, no scheme');
  assert.equal(remoteHost('ssh://git@git.example.com:2222/team/api.git'), 'git.example.com', 'a port is not the host');
  assert.equal(remoteHost('http://git.example.com:3002/admin/api.git'), 'git.example.com');
  assert.equal(remoteHost('GIT@GitHub.com:o/r.git'), 'github.com', 'case folds');
  assert.equal(remoteHost('git://git.example.com/o/r.git'), 'git.example.com');

  // No host at all: a local path is a perfectly ordinary remote and names no forge.
  assert.equal(remoteHost('/Users/x/Code/mirror.git'), null);
  assert.equal(remoteHost('../sibling'), null);
  assert.equal(remoteHost('file:///Users/x/Code/mirror.git'), null);
  assert.equal(remoteHost(''), null);
  assert.equal(remoteHost(null), null);
});

test('the pair is what decides, and there are exactly four readings', () => {
  const gh = { gh: true };
  const ghMcp = { githubMcp: true };
  const gitea = { giteaMcp: true };

  const github = readingFor({ remote: 'git@github.com:o/r.git', host: 'github.com', tools: gh });
  assert.equal(github.reading, READINGS.github);
  assert.equal(github.forge, 'github');
  assert.equal(github.via, 'gh', '`gh` is preferred: its credential is in the keychain');

  assert.equal(readingFor({ remote: 'x', host: 'github.com', tools: ghMcp }).via, 'mcp');

  const self = readingFor({ remote: 'x', host: 'git.example.com', tools: gitea });
  assert.equal(self.reading, READINGS.gitea);
  assert.equal(self.forge, 'gitea');

  // A remote and no tools for it — GitLab, Bitbucket, Forgejo, anything else.
  const push = readingFor({ remote: 'https://gitlab.com/o/r.git', host: 'gitlab.com', tools: {} });
  assert.equal(push.reading, READINGS.push);
  assert.equal(push.forge, null, 'nothing branches on a forge that has no tools');

  const none = readingFor({ remote: null, host: null, tools: gh });
  assert.equal(none.reading, READINGS.none);
  assert.equal(none.forge, null);
});

test('the two questions are independent — tooling for the wrong forge is no tooling', () => {
  // The measured reason the questions are separate: matching the remote's host against a
  // registered MCP server's URL is not a detector. Here the tools exist and belong to the
  // other forge, and the answer must be `push only` rather than either forge's name.
  assert.equal(readingFor({ remote: 'x', host: 'github.com', tools: { giteaMcp: true } }).reading, READINGS.push);
  assert.equal(readingFor({ remote: 'x', host: 'git.example.com', tools: { gh: true } }).reading, READINGS.push);
});

test('a local-path remote is `push only`, never `no remote`', () => {
  // Something is configured that a branch can be pushed to, so saying "no remote" would
  // be a lie the pushed branch contradicts — the same reasoning that named `push only`.
  const local = readingFor({ remote: '/Users/x/Code/mirror.git', host: null, tools: {} });
  assert.equal(local.reading, READINGS.push);
});

test('GitHub Enterprise reads as the self-hosted case, and that limit is deliberate', () => {
  // A host-based rule cannot tell Enterprise from Gitea. It fails towards "the lead tries
  // a tool and is told no", never towards a wrong merge — the documented cost of
  // detecting instead of asking.
  const ghe = readingFor({ remote: 'x', host: 'github.example.com', tools: { giteaMcp: true } });
  assert.equal(ghe.reading, READINGS.gitea);
});

test('an MCP entry carrying a credential is named, so it can be refused', () => {
  assert.deepEqual(credentialKeys({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }), ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.deepEqual(credentialKeys({ API_KEY: 'x', PORT: '3002' }), ['API_KEY']);
  assert.deepEqual(credentialKeys({ GITEA_PASSWORD: 'x' }), ['GITEA_PASSWORD']);
  // The maintainer's own entry, which is why they were safe by luck: no env at all.
  assert.deepEqual(credentialKeys(undefined), []);
  assert.deepEqual(credentialKeys({ TOKEN: '' }), [], 'an empty value is not a credential');
  assert.deepEqual(credentialKeys({ LOG_LEVEL: 'debug' }), []);
});

test('a program is found on the PATH a session would have, without spawning one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-forge-bin-'));
  const exe = path.join(dir, 'pretend-gh');
  fs.writeFileSync(exe, '#!/bin/sh\n');
  fs.chmodSync(exe, 0o755);
  assert.equal(onPath('pretend-gh', { pathValue: dir, extra: [] }), true);
  assert.equal(onPath('pretend-gh', { pathValue: '/nowhere', extra: [] }), false);
  // The extra directories are how a launchd-run panel still sees a Homebrew install: the
  // session that will run the program is a login shell, not this process.
  assert.equal(onPath('pretend-gh', { pathValue: '/nowhere', extra: [dir] }), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------- against real repos --- */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-forge-'));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repoWith(name, origin) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test'], dir);
  git(['config', 'user.name', 'test'], dir);
  if (origin) git(['remote', 'add', 'origin', origin], dir);
  return dir;
}

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('a repo with no origin reads `no remote`, whatever is installed', async () => {
  const dir = repoWith('bare', null);
  const seen = await detectForge(dir, { mcp: async () => ({ gitea: {}, github: {} }), hasGh: () => true });
  assert.equal(seen.reading, READINGS.none);
  assert.equal(seen.remote, null);
});

test('a github.com origin plus `gh` reads GitHub, off the real .git/config', async () => {
  const dir = repoWith('gh-repo', 'https://github.com/oferaharon/foreman-bench.git');
  const seen = await detectForge(dir, { mcp: async () => ({}), hasGh: () => true });
  assert.equal(seen.reading, READINGS.github);
  assert.equal(seen.via, 'gh');
  assert.equal(seen.host, 'github.com');
});

test('the same repo with no tooling reads `push only`', async () => {
  const dir = path.join(scratch, 'gh-repo');
  const seen = await detectForge(dir, { mcp: async () => ({}), hasGh: () => false });
  assert.equal(seen.reading, READINGS.push);
  assert.equal(seen.forge, null);
});

test('a self-hosted origin plus a registered gitea server reads Gitea', async () => {
  const dir = repoWith('self-hosted', 'http://git.example.com:3002/admin/api.git');
  const seen = await detectForge(dir, { mcp: async () => ({ gitea: { type: 'http', url: 'http://mcp.example.com:8093/mcp' } }), hasGh: () => false });
  assert.equal(seen.reading, READINGS.gitea);
  // The remote and the MCP server are different hosts here on purpose: they are on this
  // Mac too (same IP by coincidence, different port), which is why "match them" is not a
  // detector and the two questions stay independent.
  assert.equal(seen.host, 'git.example.com');
});

test('a not-a-repo answers `no remote` rather than throwing', async () => {
  const dir = path.join(scratch, 'not-a-repo');
  fs.mkdirSync(dir);
  const seen = await detectForge(dir, { mcp: async () => ({ gitea: {} }), hasGh: () => false });
  assert.equal(seen.reading, READINGS.none);
});

test('the cache answers twice and `fresh` goes back to the repo', async () => {
  resetForgeCache();
  const dir = repoWith('cached', null);
  let reads = 0;
  const deps = {
    remote: async () => {
      reads += 1;
      return null;
    },
    mcp: async () => ({}),
    hasGh: () => false,
  };
  await resolveForge(dir, deps);
  await resolveForge(dir, deps);
  assert.equal(reads, 1, 'the paint path does not shell out twice');
  await resolveForge(dir, { ...deps, fresh: true });
  assert.equal(reads, 2, 'a launch asks again — `git remote add` happens while we run');
  resetForgeCache();
});

test('a public forge that is neither GitHub nor Gitea reads `push only`, tools or not', () => {
  // Found on the bench, and it is the ruling's own example: with a `gitea` MCP server
  // registered — true on this Mac — "any non-GitHub host is self-hosted" made a GitLab
  // repo read `Gitea` and handed its lead the gitea tools. `push only` is the whole
  // reason that fourth reading exists.
  for (const host of ['gitlab.com', 'bitbucket.org', 'git.sr.ht']) {
    const seen = readingFor({ remote: `https://${host}/o/r.git`, host, tools: { giteaMcp: true, gh: true } });
    assert.equal(seen.reading, READINGS.push, host);
    assert.equal(seen.forge, null);
    assert.match(seen.reason, /only GitHub and Gitea/);
  }
});

test('codeberg is Forgejo, and Forgejo is untested — so it reads `push only` too', () => {
  // Its API is close to Gitea's and it may well work. That is exactly why it must not be
  // implied to work: nobody has run it. `push only` until somebody does.
  const seen = readingFor({ remote: 'https://codeberg.org/o/r.git', host: 'codeberg.org', tools: { giteaMcp: true } });
  assert.equal(seen.reading, READINGS.push);
});

test('a self-hosted host is still read as Gitea, and that limit is named not hidden', () => {
  // A self-hosted GitLab is indistinguishable from a self-hosted Gitea by host alone, so
  // it reads `Gitea` and fails loudly at the lead's first tool call. Pinned so the day
  // somebody "fixes" it by guessing from the hostname, this test says what the trade was.
  const seen = readingFor({ remote: 'x', host: 'gitlab.example.com', tools: { giteaMcp: true } });
  assert.equal(seen.reading, READINGS.gitea);
});
