/**
 * Whether this panel was installed by Homebrew, and the one name Homebrew knows it by.
 *
 * Two things live here and they are here together because everything that asks the first
 * question goes on to spell the second: the `bin/` shim (which command to tell you to
 * type, and whether `brew services` is the right way to restart), the boot block in
 * `index.js` (the same, one line earlier), and `scripts/backup-state.sh`, which carries
 * its own copy in bash because bash cannot import — the same arrangement the launchd
 * label already has, and for the same reason.
 *
 * ## The name
 *
 * **`foreman-panel`, not `foreman`.** homebrew-core already ships a `foreman` — the
 * Procfile process manager — and it installs `bin/foreman`. A keg lives at
 * `<prefix>/Cellar/<name>`, so two formulae called `foreman` cannot both be installed;
 * an unqualified `brew install foreman` resolves to core's; and `brew services start
 * foreman` takes a *short* name, so it would be ambiguous forever on any Mac that had
 * tapped both. The maintainer's ruling of 2026-09-02: give up eight characters in the one
 * place a computer has to disambiguate, and keep the project's name everywhere it is
 * read.
 *
 * ## The detection
 *
 * **The install location is the fact.** No build-time flag, no marker file written at
 * install, no environment variable the formula has to remember to set — resolve the real
 * path of a file that ships with the package and ask whether it sits under a Homebrew
 * prefix. A flag or a marker is a second copy of a truth the filesystem already holds,
 * and the failure mode is a panel that thinks it is something it is not and prints
 * commands that do not exist.
 *
 * `$HOMEBREW_PREFIX` is authoritative when it is set — it is exported by `brew shellenv`
 * and by every `brew` invocation — and when it is not, the two standard prefixes are
 * tried: `/opt/homebrew` (Apple silicon) and `/usr/local` (Intel).
 *
 * What a wrong answer costs, in both directions, because it is what keeps this simple:
 * a false positive prints `brew services …` on a machine with no such formula, and brew
 * says so; a false negative prints `npm run …` to somebody without a checkout. Neither
 * touches anything. That is why this is nine lines of path arithmetic and not a probe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The formula, the command and the `brew services` name — one string, one place.
 *
 * `package.json`'s `bin` field spells it a second time and cannot import this (npm reads
 * that file before any of our code runs), so `test/cli.test.js` holds the two together.
 */
export const FORMULA = 'foreman-panel';

/**
 * The launchd label a `brew services` job runs under: `homebrew.mxcl.` + the formula name.
 *
 * **This is not the panel's own label and must not be confused with it.** `logs.js` owns
 * `AGENT_LABEL` (`dev.foreman.panel` by default), which the checkout's `install-agent.js`
 * writes into the plist it generates *and* which the log basenames are derived from. Under
 * Homebrew nobody generates that plist: `brew services` writes
 * `~/Library/LaunchAgents/homebrew.mxcl.<formula>.plist` from the formula's `service do`
 * block, so `dev.foreman.panel.plist` names no file on disk — which is how
 * `scripts/backup-state.sh` came to look for a plist that was never there and report it
 * MISSING with nothing else wrong.
 *
 * So there are two labels, and exactly one thing may read this one: whatever needs to
 * *find the plist launchd is really using*. The log basenames stay derived from
 * `AGENT_LABEL`, because the formula's `service do` block spells `foreman.log` /
 * `foreman-error.log` and a panel deriving them from this label instead would trim two
 * files nobody writes while the ones launchd appends to grow without bound — the exact
 * cascade `logs.js` already warns about, arriving from the other end.
 *
 * `homebrew.mxcl.` is Homebrew's own prefix, not ours; the half that is ours is `FORMULA`,
 * and it is spelled once. `scripts/backup-state.sh` reads this export rather than carrying
 * the composed string, the same way it reads `AGENT_LABEL` off `logs.js`.
 */
export const BREW_LAUNCHD_LABEL = `homebrew.mxcl.${FORMULA}`;

/** Tried in order when `$HOMEBREW_PREFIX` says nothing: Apple silicon, then Intel. */
export const FALLBACK_PREFIXES = ['/opt/homebrew', '/usr/local'];

/** Resolve symlinks where we can; a path that is not there yet is still a path. */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The prefixes to test against. `$HOMEBREW_PREFIX` wins alone when it is set. */
export function brewPrefixes(env = process.env) {
  const named = (env.HOMEBREW_PREFIX || '').trim();
  return named ? [named] : [...FALLBACK_PREFIXES];
}

/**
 * Is `target` inside `prefix`?
 *
 * Via `path.relative`, never a string prefix: `/usr/local-scratch/x` starts with
 * `/usr/local` as text and is not under it, and a panel that read it as one would print
 * `brew services` advice at somebody who has no formula installed.
 */
export function isUnderPrefix(target, prefix) {
  if (!target || !prefix) return false;
  const rel = path.relative(real(prefix), real(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Does this path live inside a Homebrew prefix? */
export function isHomebrewPath(target, env = process.env) {
  return brewPrefixes(env).some((prefix) => isUnderPrefix(target, prefix));
}

/**
 * Is *this copy of the panel* a Homebrew install?
 *
 * Answered from this module's own file, so it is the same answer for the `bin/` shim, the
 * boot block and anything else that asks — a caller passing its own path could disagree
 * with another caller passing theirs, which is exactly the split this module exists to
 * prevent. Under Homebrew this file is at
 * `<prefix>/Cellar/foreman-panel/<version>/libexec/lib/node_modules/foreman/server/homebrew.js`;
 * from a checkout it is wherever you cloned to.
 *
 * Not memoised: it is two `realpath` calls, and `$HOMEBREW_PREFIX` is an argument in the
 * tests.
 */
export function panelIsHomebrew(env = process.env) {
  return isHomebrewPath(fileURLToPath(import.meta.url), env);
}

/**
 * How to invoke `brew`.
 *
 * `brew` is on the `PATH` of a login shell and this shim is run from one, so the bare
 * word is nearly always right — but launchd's `PATH` is four directories and none of them
 * is Homebrew's, and a `foreman-panel restart` fired from anywhere with that environment
 * would fail with `ENOENT` for a reason nobody would guess. So: the prefix's own `bin/brew`
 * when it is really there, the bare word otherwise.
 */
export function brewBinary(env = process.env) {
  for (const prefix of brewPrefixes(env)) {
    const candidate = path.join(prefix, 'bin', 'brew');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not this prefix — try the next */ }
  }
  return 'brew';
}
