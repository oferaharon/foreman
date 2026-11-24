import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { plansDirOf } from './account.js';

/**
 * The plan file a plan-approval box names, read for the card that shows it.
 *
 * The path comes off scraped terminal text, which is not a source to hand to `readFile` —
 * so it is resolved and then refused unless it lands inside a `plans/` folder of a **known
 * config dir** (`KnownConfigDirs`: the default, plus every other account's dir the panel has
 * seen on a live pane). Plan mode writes under the session's *own* config dir, so a
 * second-account session names `~/.claude-<x>/plans/…`, which the one-folder check this
 * replaced refused outright (MEASURED on v2.1.331: nothing a second-account session writes
 * lands under `~/.claude`).
 *
 * Two things stay exactly as they were. Nothing here takes a path from the request — the
 * only input is the pane's own scraped line and the panel's own list of dirs, so widening
 * the allow-list from one folder to the known few widens nothing a caller can steer. And the
 * check is on the resolved path, so a `..` out of a plans folder is outside it.
 *
 * @param {string} planPath  what the box printed, `~`-led or absolute
 * @param {string[]} configDirs absolute config dirs, as `KnownConfigDirs#list()` answers
 * @returns {Promise<{status: number, body: object}>}
 */
export async function readPlanFile(planPath, configDirs, { home = os.homedir() } = {}) {
  const file = resolvePlanFile(planPath, configDirs, home);
  if (!file) return { status: 400, body: { error: 'That path is not in a Claude config dir’s plans folder.' } };
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return { status: 404, body: { error: 'Not a file.' } };
    if (stat.size > 256 * 1024) return { status: 413, body: { error: 'That plan is too big to show.' } };
    return { status: 200, body: { path: planPath, markdown: await fsp.readFile(file, 'utf8') } };
  } catch {
    return { status: 404, body: { error: 'That plan file is not there any more.' } };
  }
}

/** The absolute file, or `null` when it is not under any known config dir's `plans/`. */
export function resolvePlanFile(planPath, configDirs, home = os.homedir()) {
  if (typeof planPath !== 'string' || !planPath) return null;
  const file = path.resolve(planPath.replace(/^~(?=\/|$)/, home));
  for (const dir of configDirs || []) {
    const root = plansDirOf(dir);
    if (file === root || file.startsWith(`${root}${path.sep}`)) return file;
  }
  return null;
}
