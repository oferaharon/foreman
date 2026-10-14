import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_BINARY, STABLE_NODE_PATHS, optLinkFor, stableNodePath } from '../server/node-binary.js';

/*
 * The node path the panel writes into anything that outlives it, and the upgrade that
 * broke every session launched after it (2026-10-13; the story is in `node-binary.js` and
 * `docs/traps/platform-launchd.md#a-homebrew-upgrade-breaks-the-mcp-configs-node-path`).
 *
 * Run against a real throwaway Homebrew-shaped tree of symlinks, never this Mac's own
 * Homebrew — and never by installing or upgrading anything, which is how the incident
 * began. The resolver only ever calls `realpathSync`, so a tree of real links and one real
 * file each is the whole of what it can observe: no stub is standing in for anything.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const scratch = [];
process.on('exit', () => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A prefix shaped like `/opt/homebrew`: a keg per version, a `bin/node` link, an `opt` link. */
function brewPrefix(formula = 'node') {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-node-binary-')));
  scratch.push(prefix);
  const keg = (version) => {
    const bin = path.join(prefix, 'Cellar', formula, version, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), '', { mode: 0o755 });
    return path.join(bin, 'node');
  };
  const link = (target, at) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.rmSync(at, { force: true });
    fs.symlinkSync(path.relative(path.dirname(at), target), at);
  };
  /** What `brew upgrade` does to the links: point both at the new keg. */
  const pointAt = (version) => {
    if (formula === 'node') link(path.join(prefix, 'Cellar', formula, version, 'bin', 'node'), path.join(prefix, 'bin', 'node'));
    link(path.join(prefix, 'Cellar', formula, version), path.join(prefix, 'opt', formula));
  };
  return { prefix, keg, pointAt, stable: path.join(prefix, 'bin', 'node') };
}

/* ------------------------------------------------------------- the resolution --- */

test('a stable link that resolves to the running node wins over the Cellar path', () => {
  const brew = brewPrefix();
  const running = brew.keg('26.8.1');
  brew.pointAt('26.8.1');

  // `pointAt` made the `opt` link too, and it also matches: the fixed spelling still wins,
  // so the plist this Mac already has comes out byte-identical.
  const got = stableNodePath({ execPath: running, candidates: [brew.stable] });
  assert.equal(got, brew.stable);
  assert.ok(!got.includes('/Cellar/'), `wrote the versioned keg path: ${got}`);
});

test('with no stable link matching, the fallback is the real path, unchanged', () => {
  const brew = brewPrefix();
  const running = brew.keg('26.8.1');
  const other = brew.keg('99.0.0');
  // `bin/node` exists but is somebody else's node — nvm, a second install. Taking it would
  // hand every session a different binary from the one the panel was proven on.
  fs.symlinkSync(other, path.join(brew.prefix, 'elsewhere-node'));

  assert.equal(
    stableNodePath({ execPath: running, candidates: [path.join(brew.prefix, 'elsewhere-node'), path.join(brew.prefix, 'missing')] }),
    running,
  );
});

test('a keg-only formula falls back to its own opt link, the one stable spelling it has', () => {
  const brew = brewPrefix('node@22');
  const running = brew.keg('22.11.0');
  brew.pointAt('22.11.0');

  assert.equal(optLinkFor(running), path.join(brew.prefix, 'opt', 'node@22', 'bin', 'node'));
  assert.equal(
    stableNodePath({ execPath: running, candidates: [path.join(brew.prefix, 'bin', 'node')] }),
    path.join(brew.prefix, 'opt', 'node@22', 'bin', 'node'),
  );
  assert.equal(optLinkFor('/usr/bin/node'), null, 'only a keg path has an opt link');
});

/* ------------------------------------------------- why it is resolved once, at boot --- */

test('an upgrade under a running panel: boot-time resolution survives it, per-launch resolution does not', () => {
  const brew = brewPrefix();
  const running = brew.keg('26.8.1');
  brew.pointAt('26.8.1');

  // Boot: the stable link still points at the binary this process is running.
  const atBoot = stableNodePath({ execPath: running, candidates: [brew.stable] });
  assert.equal(atBoot, brew.stable);

  // `brew install` upgrades node underneath the panel. The old keg is still on disk — on
  // 2026-10-13 it was, and its binary aborted in dyld because a library it linked had moved.
  const upgraded = brew.keg('26.11.1');
  brew.pointAt('26.11.1');

  // Resolved again now, as a per-launch resolution would be: the realpath check fails and
  // the fallback is the old keg — the dead path, written into every config from here on.
  const perLaunch = stableNodePath({ execPath: running, candidates: [brew.stable] });
  assert.equal(perLaunch, running, 'the per-launch answer is the dead keg — the incident, reproduced');
  assert.ok(perLaunch.includes('/Cellar/'));

  // The answer captured at boot names the link, which now simply runs the new node.
  assert.equal(fs.realpathSync(atBoot), upgraded);

  // And after `brew cleanup` removes the old keg outright, a fresh resolution cannot even
  // realpath what is running, and still answers the dead path.
  fs.rmSync(path.join(brew.prefix, 'Cellar', 'node', '26.8.1'), { recursive: true });
  assert.equal(stableNodePath({ execPath: running, candidates: [brew.stable] }), running);
  assert.equal(fs.realpathSync(atBoot), upgraded);
});

/* ---------------------------------------------------------- the constant itself --- */

test('NODE_BINARY is a value captured at import, and on a stable install it is no Cellar path', () => {
  assert.equal(typeof NODE_BINARY, 'string', 'a constant, not a function a writer could call per launch');
  // Nothing has been upgraded since this process started, so a fresh resolution agrees.
  assert.equal(NODE_BINARY, stableNodePath());

  const real = fs.realpathSync(process.execPath);
  const opt = optLinkFor(real);
  const stableHere = [...STABLE_NODE_PATHS, ...(opt ? [opt] : [])].some((c) => {
    try { return fs.realpathSync(c) === real; } catch { return false; }
  });
  if (stableHere) {
    assert.ok(!NODE_BINARY.includes('/Cellar/'), `a stable link resolves to the running node, yet NODE_BINARY is ${NODE_BINARY}`);
  }
  assert.equal(fs.realpathSync(NODE_BINARY), real, 'whatever it is spelled, it is the binary running');
  assert.equal(execFileSync(NODE_BINARY, ['-p', '6 * 7'], { encoding: 'utf8' }).trim(), '42');
});

/* ------------------------------------------- nothing else writes the raw execPath --- */

/*
 * The incident's cause was two writers that each spelled the node path themselves. A third
 * would reintroduce it silently, so any code line in `server/` or `mcp/` that reads
 * `process.execPath` has to be on this list with its reason. Comment lines are skipped.
 */
const EXEC_PATH_ALLOWED = new Map([
  ['server/node-binary.js', 'the one resolver — reads it to find the stable spelling'],
  ['server/setup-command.js', 'runs the two installers as children that exit; written nowhere'],
]);

test('no code in server/ or mcp/ reads process.execPath except the resolver and a child that exits', () => {
  const offenders = [];
  for (const dir of ['server', 'mcp']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue;
      const rel = `${dir}/${name}`;
      if (EXEC_PATH_ALLOWED.has(rel)) continue;
      const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
        if (line.includes('process.execPath')) offenders.push(`${rel}:${i + 1}: ${t}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'process.execPath is the versioned Cellar path on a Homebrew Mac, and a brew upgrade breaks ' +
      'it under a running panel. Write NODE_BINARY (server/node-binary.js) into anything that ' +
      'outlives the process, or add the file to EXEC_PATH_ALLOWED with its reason.',
  );
});
