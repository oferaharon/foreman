import fs from 'node:fs';
import path from 'node:path';

/**
 * The node binary to write into anything that outlives this process — the LaunchAgent's
 * `ProgramArguments`, and every MCP config the panel hands a session it launches.
 *
 * A leaf with no imports from this repo, because the installer (`install-agent.js`) and the
 * two config writers (`briefs.js`, `session-launch.js`) all need the one answer, and the
 * installer must stay importable without dragging the panel's boot in behind it.
 *
 * **`process.execPath` is the wrong thing to write down.** On a Homebrew Mac it is already
 * resolved through the symlink to a versioned keg — `/opt/homebrew/Cellar/node/<version>/bin/node`
 * — and that path stops working the moment Homebrew moves node on. Measured on 2026-10-13:
 * a `brew install` upgraded node and repointed `simdjson` while the panel was running, the
 * old keg's binary now aborted in dyld before running any JS, and every session the panel
 * launched afterwards — lead, worker and standalone — failed its `foreman` server at spawn
 * (`CONNECTION_CLOSED`, under `failedMcpServers` in the transcript's first attachment
 * record). `/mcp` could not help: it respawns the same dead path. The plist had been
 * protected from exactly this since it was written; the MCP configs had not.
 *
 * So prefer a **stable spelling** of the same file: `/opt/homebrew/bin/node`, then
 * `/usr/local/bin/node`, then the formula's own `opt` link (`…/opt/<formula>/bin/node`,
 * derived from the keg path — the one stable spelling a keg-only `node@NN` has). Each is
 * taken only when its realpath is *the binary actually running* — checked, not assumed —
 * so a machine whose `node` on PATH is somebody else's (nvm, a second install) is written
 * the path it is really running, exactly as before.
 */
export const STABLE_NODE_PATHS = Object.freeze(['/opt/homebrew/bin/node', '/usr/local/bin/node']);

/** `…/Cellar/<formula>/<version>/bin/node` → `…/opt/<formula>/bin/node`, or null. */
export function optLinkFor(execPath) {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  return m ? path.join(m[1], 'opt', m[2], 'bin', 'node') : null;
}

/**
 * Resolve the stable spelling of `execPath`, or `execPath` itself when nothing stable
 * points at it. Every input is a parameter so the suite can run it against a real
 * throwaway keg layout of symlinks rather than this Mac's own Homebrew.
 *
 * Do not call this per launch — read `NODE_BINARY` below. See there for why.
 */
export function stableNodePath({ execPath = process.execPath, candidates = STABLE_NODE_PATHS } = {}) {
  let real;
  try {
    real = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  const opt = optLinkFor(real);
  for (const candidate of opt ? [...candidates, opt] : candidates) {
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch { /* not there, or a broken link — try the next one */ }
  }
  return execPath;
}

/**
 * **Resolved once, at module load — which for the panel is boot — and that is the whole
 * trap.** The realpath check above only passes while the stable link still points at the
 * binary this process is running. After an upgrade it points at the *new* keg, the check
 * fails, and the fallback is `process.execPath`: the old keg, the dead path. So a
 * resolution made per launch would be right every day except the one that matters, and
 * would write the broken path into every config from the moment of the upgrade until the
 * next restart — the incident above, reproduced by the fix meant to prevent it. Captured
 * at boot, the answer is the stable link, which after an upgrade simply runs the new node.
 *
 * Read it, never re-derive it: `foremanEntry` and `sessionMcpConfig` default to it, and the
 * installer writes it into the plist.
 */
export const NODE_BINARY = stableNodePath();
