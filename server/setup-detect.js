import fs from 'node:fs';

/**
 * Work out a repo's worktree-prepare command from its own files, so nobody has to type one
 * into a box. The maintainer's ruling (2026-08-26, decisions.md): a control the user cannot
 * answer correctly should not be a control — detect, show what was detected, and say "can't
 * tell" only when it is genuinely ambiguous.
 *
 * Pure file-existence work: one readdir, no network, no shelling out to package
 * managers. It runs while the panel paints, so it must stay instant and side-effect
 * free. And the bias is deliberate: **unknown beats plausible-but-wrong.** A wrong
 * command fails every dispatch on that repo; a missing one just means the worker
 * installs things itself.
 */

/**
 * Each ecosystem looks at the top-level entries and returns null (not this ecosystem)
 * or `{ eco, command, reason }` — where `command` may itself be null when the ecosystem
 * is present but its prepare step isn't knowable (an Xcode project, a bare
 * requirements.txt).
 */
const ECOSYSTEMS = [
  {
    eco: 'Node',
    detect(has, entries) {
      const locks = [
        ['package-lock.json', 'npm ci'],
        ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
        ['yarn.lock', 'yarn install --frozen-lockfile'],
      ].filter(([file]) => has(file));
      if (!locks.length && !has('package.json')) return null;
      if (locks.length > 1) {
        return {
          eco: 'Node',
          command: null,
          reason: `found ${locks.map(([f]) => f).join(' and ')} — can't tell which package manager owns the project`,
        };
      }
      if (locks.length === 1) {
        return { eco: 'Node', command: locks[0][1], reason: `found ${locks[0][0]}` };
      }
      return { eco: 'Node', command: 'npm install', reason: 'found package.json with no lockfile' };
    },
  },
  {
    eco: 'Swift',
    detect(has, entries) {
      if (has('Package.swift')) return { eco: 'Swift', command: 'swift build', reason: 'found Package.swift' };
      const xcode = entries.find((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'));
      if (xcode) {
        return {
          eco: 'Swift',
          command: null,
          reason: `found ${xcode} but no Package.swift — an Xcode project has no obviously headless build`,
        };
      }
      return null;
    },
  },
  {
    eco: 'Rust',
    detect(has) {
      return has('Cargo.toml') ? { eco: 'Rust', command: 'cargo fetch', reason: 'found Cargo.toml' } : null;
    },
  },
  {
    eco: 'Go',
    detect(has) {
      return has('go.mod') ? { eco: 'Go', command: 'go mod download', reason: 'found go.mod' } : null;
    },
  },
  {
    eco: 'Python',
    detect(has) {
      const uv = has('uv.lock');
      const poetry = has('poetry.lock');
      if (uv && poetry) {
        return { eco: 'Python', command: null, reason: "found both uv.lock and poetry.lock — can't tell which owns the project" };
      }
      if (uv) return { eco: 'Python', command: 'uv sync', reason: 'found uv.lock' };
      if (poetry) return { eco: 'Python', command: 'poetry install', reason: 'found poetry.lock' };
      // A bare requirements.txt (or lockless pyproject) needs a virtualenv the worker
      // may not have — guessing `pip install -r` here is exactly the plausible-but-wrong
      // command this module exists to refuse.
      const bare = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'].find(has);
      if (bare) {
        return {
          eco: 'Python',
          command: null,
          reason: `found ${bare} but no uv.lock or poetry.lock — it needs a virtualenv the worker may not have`,
        };
      }
      return null;
    },
  },
];

/**
 * Given a repo (or worktree) path, return `{ command, reason }`. `command` is null when
 * detection genuinely can't tell — the reason always says why, in words a non-developer
 * can act on.
 */
export function detectSetup(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return { command: null, reason: `could not read ${dir}: ${err.message}` };
  }
  const set = new Set(entries);
  const has = (name) => set.has(name);
  const found = ECOSYSTEMS.map((e) => e.detect(has, entries)).filter(Boolean);
  if (!found.length) {
    return { command: null, reason: 'no recognisable project files at the top level' };
  }
  if (found.length > 1) {
    return {
      command: null,
      reason: `found ${found.map((f) => f.eco).join(' and ')} files at the top level — can't tell which prepares the project`,
    };
  }
  return { command: found[0].command, reason: found[0].reason };
}

/**
 * The one answer to "what will run in a fresh worktree": a `setup` an existing team.json
 * already carries wins (teams configured before detection existed keep their behaviour —
 * nothing can *write* that field any more), otherwise whatever detection says.
 */
export function resolveSetup(stored, dir) {
  if (stored) {
    return { command: stored, reason: 'set in team.json before detection existed', source: 'stored' };
  }
  const detected = detectSetup(dir);
  return { ...detected, source: detected.command ? 'detected' : 'none' };
}
