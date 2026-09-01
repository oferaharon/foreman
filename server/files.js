import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Files under a session's working directory, for `@` mentions.
 *
 * `git ls-files` does the hard part where it applies: it is fast, already honours
 * .gitignore, and never wanders into node_modules or build output. Outside a repo we
 * fall back to a bounded walk with the usual suspects skipped by hand.
 */

const IGNORED = new Set([
  'node_modules', '.git', '.build', 'dist', 'build', '.next', 'target',
  'venv', '.venv', '__pycache__', '.DS_Store', 'Pods', 'DerivedData', '.cache',
]);

const MAX_FILES = 20_000;
const WALK_DEPTH = 8;

const cache = new Map(); // cwd -> { at, files }
const TTL_MS = 30_000;

async function gitFiles(cwd) {
  // `-co --exclude-standard` = tracked plus untracked-but-not-ignored, i.e. what you'd
  // actually want to mention, including files you just created.
  const { stdout } = await run('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split('\n').filter(Boolean);
}

async function walkFiles(cwd) {
  const out = [];
  const walk = async (dir, rel, depth) => {
    if (depth > WALK_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || IGNORED.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), child, depth + 1);
      else if (e.isFile()) out.push(child);
    }
  };
  await walk(cwd, '', 0);
  return out;
}

async function allFiles(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;

  let files;
  try {
    files = await gitFiles(cwd);
  } catch {
    files = await walkFiles(cwd);
  }
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

/**
 * Subsequence match, the way editors do it: `svtmx` finds `server/tmux.js`.
 * Scores prefer matches in the basename, earlier hits, and shorter paths — so typing a
 * filename doesn't bury it under deep directories that happen to contain the letters.
 */
function score(pathStr, query) {
  const hay = pathStr.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 1;

  let i = 0;
  let firstHit = -1;
  let lastHit = -1;
  for (let n = 0; n < needle.length; n += 1) {
    i = hay.indexOf(needle[n], i);
    if (i === -1) return 0;
    if (firstHit === -1) firstHit = i;
    lastHit = i;
    i += 1;
  }

  const base = hay.slice(hay.lastIndexOf('/') + 1);
  let s = 1000;
  if (base.includes(needle)) s += 500; // contiguous, in the filename
  if (base.startsWith(needle)) s += 300;
  if (hay.includes(needle)) s += 200; // contiguous anywhere
  s -= lastHit - firstHit; // tightly clustered beats scattered
  s -= pathStr.length / 4; // prefer the shallower of two equal matches
  return Math.max(1, s);
}

export async function findFiles(cwd, query, limit = 20) {
  if (!cwd) return [];
  const files = await allFiles(cwd);
  const q = (query || '').trim();

  if (!q) {
    return files.slice(0, limit).map((f) => ({ path: f }));
  }

  const scored = [];
  for (const f of files) {
    const s = score(f, q);
    if (s > 0) scored.push({ path: f, s });
  }
  scored.sort((a, b) => b.s - a.s || a.path.length - b.path.length);
  return scored.slice(0, limit).map(({ path: p }) => ({ path: p }));
}
