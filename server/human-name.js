import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Who the team is working for — read from git, never hardcoded.
 *
 * Every piece of runtime prose in this project used to name one person: the lead's brief,
 * the worker and planner briefs, the `foreman` tool descriptions, the room's nudge and stuck
 * lines. A stranger's lead would call them by somebody else's first name. So the name is
 * **detected**, from the one place a git user has already written it down.
 *
 * Three things about the shape, each of them a ruling rather than a preference:
 *
 *   - **Run it in the repo.** `git config user.name` resolves local-then-global, so a
 *     per-repo identity beats the machine-wide one — which is the whole point for anyone
 *     who commits to work and to personal projects under different names.
 *   - **Fall back to "the human", not to a guess.** No name configured is a completely
 *     ordinary state, and every sentence in every brief has to read correctly with the
 *     fallback substituted in. That is what the tests pin.
 *   - **No prettifying.** A handle is a name. `jdoe` stays `jdoe`; nothing
 *     here title-cases it, splits it, or tries to find a first name inside it. Guessing
 *     at somebody's real name from their git handle is worse than using the handle.
 *
 * Resolve it **once per brief generation and pass it in** as a parameter. It must never
 * become a module-level constant in a consumer: briefs are generated per repo, and a repo
 * can carry its own `user.name`. Caching here is keyed by repo for exactly that reason.
 *
 * Cost: one `git` subprocess per repo, then a cache hit. Callers are launch and dispatch
 * paths — never the paint path — so a subprocess is not a problem, and the cache is
 * belt-and-braces rather than load-bearing.
 */

/** What a brief says when nobody has told git who they are. */
export const FALLBACK = 'the human';

const cache = new Map(); // repo path (or '') -> resolved name

/** Tests only: forget what git said, so a `user.name` set mid-test is seen. */
export function clearHumanNameCache() {
  cache.clear();
}

/**
 * The human this repo's team reports to.
 *
 * @param {string|null} repo  the checkout to ask in. A path that is not an existing
 *   directory answers the fallback rather than silently reading the *global* name from
 *   whatever directory this process happens to be sitting in — a brief generated for a
 *   repo that isn't there should not quietly acquire the operator's name.
 * @returns {string} a single trimmed line, or `FALLBACK`.
 */
export function humanName(repo = null) {
  const key = repo || '';
  if (cache.has(key)) return cache.get(key);
  const name = read(repo);
  cache.set(key, name);
  return name;
}

function read(repo) {
  if (!repo) return FALLBACK;
  try {
    if (!fs.statSync(repo).isDirectory()) return FALLBACK;
  } catch {
    return FALLBACK;
  }
  let out = '';
  try {
    out = execFileSync('git', ['config', 'user.name'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Unset (git exits 1), no git, or a hung read. All of them mean "nobody said".
    return FALLBACK;
  }
  // First line only: a multi-line value would otherwise break the markdown around it.
  const name = String(out).split('\n')[0].trim();
  return name || FALLBACK;
}

/**
 * How a brief *introduces* the human, as opposed to naming them mid-sentence.
 *
 * "The human (someuser) talks to you" is the ruled shape, and it is the one place the
 * name cannot simply be substituted: with the fallback in it the sentence reads "The
 * human (the human) talks to you". Measured on a scratch panel against a repo with no
 * `user.name`, which is exactly the case a stranger hits first.
 */
export const humanPhrase = (human = FALLBACK, { capital = false } = {}) =>
  `${capital ? 'The' : 'the'} human${human === FALLBACK ? '' : ` (${human})`}`;
