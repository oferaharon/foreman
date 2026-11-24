import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CONFIG_DIR,
  KnownConfigDirs,
  configDirOfTranscript,
  defaultConfigDirFor,
  isOtherConfigDir,
  peersDirOf,
  projectsDirOf,
  sameConfigDir,
} from '../server/account.js';
import { PEER_SESSIONS_DIR, PROJECTS_DIR } from '../server/config.js';
import { probe } from '../server/transcript.js';

/*
 * `server/account.js` as the one spelling of account roots: where a config dir keeps its
 * transcripts and peers, which root a transcript belongs to, and the known-dirs list the
 * roster scans. Fake paths and fake ids throughout.
 */

const HOME = '/Users/tester';
const SESSION = '0f0f0f0f-1111-4222-8333-444444444444';

test('the default dir is ~/.claude, and config.js’s two constants are its spellings', () => {
  assert.equal(defaultConfigDirFor(HOME), '/Users/tester/.claude');
  assert.equal(DEFAULT_CONFIG_DIR, path.join(os.homedir(), '.claude'));
  // `PROJECTS_DIR` and `PEER_SESSIONS_DIR` stay as the default root's names; they must never
  // drift from the helpers that compute every other root's.
  assert.equal(PROJECTS_DIR, projectsDirOf(DEFAULT_CONFIG_DIR));
  assert.equal(PEER_SESSIONS_DIR, peersDirOf(DEFAULT_CONFIG_DIR));
});

test('a transcript’s root is the folder above its projects/ — either account', () => {
  assert.equal(configDirOfTranscript(`${HOME}/.claude/projects/-Code-alpha/${SESSION}.jsonl`), `${HOME}/.claude`);
  assert.equal(
    configDirOfTranscript(`${HOME}/.claude-two/projects/-Code-alpha/${SESSION}.jsonl`),
    `${HOME}/.claude-two`,
  );
  // A subagent's file walks up to the same root as its parent conversation's.
  assert.equal(
    configDirOfTranscript(`${HOME}/.claude-two/projects/-Code-alpha/${SESSION}/subagents/agent-1.jsonl`),
    `${HOME}/.claude-two`,
  );
  // The nearest `projects` wins, so a config dir that itself sits under a `projects` folder
  // is not mistaken for that folder's parent.
  assert.equal(
    configDirOfTranscript(`${HOME}/projects/cfg/projects/-Code-alpha/${SESSION}.jsonl`),
    `${HOME}/projects/cfg`,
  );
  // A folder named after a cwd containing the word starts with a dash, so it is never the root.
  assert.equal(
    configDirOfTranscript(`${HOME}/.claude/projects/-Users-tester-projects/${SESSION}.jsonl`),
    `${HOME}/.claude`,
  );
});

test('a path with no projects/ above it, or a relative one, has no root', () => {
  assert.equal(configDirOfTranscript(`${HOME}/elsewhere/${SESSION}.jsonl`), null);
  assert.equal(configDirOfTranscript(`.claude/projects/-a/${SESSION}.jsonl`), null);
  assert.equal(configDirOfTranscript(null), null);
  assert.equal(configDirOfTranscript(''), null);
});

test('two config dirs are the same only when both are named and resolve alike', () => {
  assert.equal(sameConfigDir(`${HOME}/.claude`, `${HOME}/.claude/`), true);
  assert.equal(sameConfigDir(`${HOME}/.claude`, `${HOME}/.claude-two`), false);
  assert.equal(sameConfigDir(null, null), false);
  assert.equal(sameConfigDir(`${HOME}/.claude`, null), false);
});

test('probe says which root a transcript is under', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-roots-'));
  try {
    const cfg = path.join(root, '.claude-two');
    const dir = path.join(projectsDirOf(cfg), '-Code-alpha');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${SESSION}.jsonl`);
    await fsp.writeFile(
      file,
      `${JSON.stringify({ type: 'user', sessionId: SESSION, cwd: '/Code/alpha', timestamp: '2026-11-23T10:00:00.000Z', message: { content: 'hi' } })}\n`,
    );
    const meta = await probe(file);
    assert.equal(meta.sessionId, SESSION);
    assert.equal(meta.configDir, cfg);
    assert.equal(meta.projectDir, '-Code-alpha');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/* ─────────────────────────────────────────────────────────── the known dirs ── */

async function tmpState() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-known-'));
  return { dir, file: path.join(dir, 'accounts.json') };
}

test('the known list starts as the default alone and writes nothing until a dir is seen', async () => {
  const s = await tmpState();
  try {
    const known = new KnownConfigDirs({ file: s.file, defaultDir: `${HOME}/.claude` });
    assert.deepEqual(known.list(), [`${HOME}/.claude`]);
    assert.equal(known.note([]), false);
    assert.equal(fs.existsSync(s.file), false);
  } finally {
    await fsp.rm(s.dir, { recursive: true, force: true });
  }
});

test('a dir seen on a live pane is kept, once, across a restart — the default is never stored', async () => {
  const s = await tmpState();
  try {
    const known = new KnownConfigDirs({ file: s.file, defaultDir: `${HOME}/.claude` });
    assert.equal(known.note([`${HOME}/.claude-two`, `${HOME}/.claude`, `${HOME}/.claude-two/`]), true);
    assert.equal(known.note([`${HOME}/.claude-two`]), false); // nothing new, no write
    assert.deepEqual(known.list(), [`${HOME}/.claude`, `${HOME}/.claude-two`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), { dirs: [`${HOME}/.claude-two`] });
    // A restart with nothing running on that account still scans it.
    const again = new KnownConfigDirs({ file: s.file, defaultDir: `${HOME}/.claude` });
    assert.deepEqual(again.list(), [`${HOME}/.claude`, `${HOME}/.claude-two`]);
  } finally {
    await fsp.rm(s.dir, { recursive: true, force: true });
  }
});

test('a relative or non-string dir is never learned', async () => {
  const s = await tmpState();
  try {
    const known = new KnownConfigDirs({ file: s.file, defaultDir: `${HOME}/.claude` });
    assert.equal(known.note(['work', '~/.claude-two', null, 42]), false);
    assert.deepEqual(known.list(), [`${HOME}/.claude`]);
  } finally {
    await fsp.rm(s.dir, { recursive: true, force: true });
  }
});

test('unknown keys are carried through a rewrite, and junk entries in the file are dropped', async () => {
  const s = await tmpState();
  try {
    fs.writeFileSync(
      s.file,
      JSON.stringify({ dirs: [`${HOME}/.claude-two`, 'relative', `${HOME}/.claude`], laterField: { keep: true } }),
    );
    const known = new KnownConfigDirs({ file: s.file, defaultDir: `${HOME}/.claude` });
    assert.deepEqual(known.list(), [`${HOME}/.claude`, `${HOME}/.claude-two`]);
    known.note([`${HOME}/.claude-three`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), {
      laterField: { keep: true },
      dirs: [`${HOME}/.claude-two`, `${HOME}/.claude-three`],
    });
  } finally {
    await fsp.rm(s.dir, { recursive: true, force: true });
  }
});

test('an unparseable file is never replaced; what is learned meanwhile lives in memory', async () => {
  const s = await tmpState();
  try {
    fs.writeFileSync(s.file, '{ not json');
    const known = new KnownConfigDirs({ file: s.file, defaultDir: `${HOME}/.claude` });
    known.note([`${HOME}/.claude-two`]);
    assert.deepEqual(known.list(), [`${HOME}/.claude`, `${HOME}/.claude-two`]);
    assert.equal(fs.readFileSync(s.file, 'utf8'), '{ not json');
  } finally {
    await fsp.rm(s.dir, { recursive: true, force: true });
  }
});

test('one spelling of “another account’s folder”: an explicit ~/.claude is not one', () => {
  assert.equal(isOtherConfigDir({ configDir: `${HOME}/.claude-two`, explicit: true }, HOME), true);
  assert.equal(isOtherConfigDir({ configDir: `${HOME}/.claude`, explicit: true }, HOME), false);
  assert.equal(isOtherConfigDir({ configDir: `${HOME}/.claude/`, explicit: true }, HOME), false);
  assert.equal(isOtherConfigDir({ configDir: `${HOME}/.claude-two`, explicit: false }, HOME), false);
  assert.equal(isOtherConfigDir(null ?? undefined, HOME), false);
});
