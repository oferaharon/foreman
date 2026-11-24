import fs from 'node:fs';
import path from 'node:path';
import { SESSION_PREFIX } from './config.js';
import { DEFAULT_CONFIG_DIR, peersDirOf } from './account.js';

/**
 * Reads Claude Code's own peer-session registry — `<config dir>/sessions/`, the directory
 * `ListAgents` reads to build its roster, one `<pid>.json` per live session, gone within
 * seconds of that session exiting.
 *
 * **There is one registry per config dir, not one per machine** (MEASURED on v2.1.331: a
 * second-account session registers under `<its dir>/sessions/<pid>.json` and writes nothing
 * under `~/.claude/sessions`). So every reader here takes a list of registry folders — the
 * known config dirs' `peersDirOf` — and a pid is looked up in each in turn: a pid is unique
 * on the machine, so the first file that exists is the right one, and the default dir's is
 * asked first, which is exactly what a machine with one account has always done.
 *
 * Every entry comes from a process this code does not control, so every read here fails
 * closed rather than throws: a file can vanish between `readdir` and `readFile`, arrive
 * mid-write, or predate a field this code expects.
 *
 * `tmux` is `"<session>:@<window>.%<pane>"` — split on the first `:` for the session name
 * and take the `%<digits>` tail for the pane id (`%167`, not `@167.%167`).
 */

const PID_JSON_RE = /^(\d+)\.json$/;

function tmuxFields(tmux) {
  if (typeof tmux !== 'string' || !tmux) return { tmuxSession: null, paneId: null };
  const sep = tmux.indexOf(':');
  if (sep === -1) return { tmuxSession: null, paneId: null };
  const session = tmux.slice(0, sep);
  const pane = tmux.slice(sep + 1).match(/%\d+/);
  return { tmuxSession: session || null, paneId: pane ? pane[0] : null };
}

/** The default dir's registry — what a reader with no known-dirs list asks. */
export const DEFAULT_PEER_DIRS = Object.freeze([peersDirOf(DEFAULT_CONFIG_DIR)]);

/** One registry folder or several, as a list. */
const asList = (dirs) => (Array.isArray(dirs) ? dirs : [dirs]);

/**
 * One peer's registry entry, or `null` if it cannot be read as one — absent file,
 * unparseable JSON, or a record with no usable shape. Never throws. `dirs` is one registry
 * folder or a list of them (`peersDirOf` of each known config dir), asked in order.
 */
export function readPeer(pid, dirs = DEFAULT_PEER_DIRS) {
  for (const dir of asList(dirs)) {
    const peer = readPeerIn(pid, dir);
    if (peer) return peer;
  }
  return null;
}

function readPeerIn(pid, dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8');
  } catch {
    return null;
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object') return null;

  const { tmuxSession, paneId } = tmuxFields(rec.tmux);
  return {
    pid: Number(pid),
    name: rec.name ?? null,
    nameSource: rec.nameSource ?? null,
    tmuxSession,
    paneId,
    cwd: rec.cwd ?? null,
    sessionId: rec.sessionId ?? null,
  };
}

/**
 * Every readable entry in the registry, for possible later use. **Not** the participant
 * picker's source: the roster is, per the discovery's own warning against
 * `ListAgents`-shaped thinking.
 */
export function listPeers(dirs = DEFAULT_PEER_DIRS) {
  const peers = [];
  for (const dir of asList(dirs)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = name.match(PID_JSON_RE);
      if (!match) continue;
      const peer = readPeerIn(match[1], dir);
      if (peer) peers.push(peer);
    }
  }
  return peers;
}

/**
 * A **guess** at the tmux session name a peer's own name would produce, not a resolution —
 * named this way so nobody mistakes it for one. The real value, when there is one, is
 * `readPeer(pid).tmuxSession`.
 */
export const guessTmuxSession = (name) => `${SESSION_PREFIX}${name}`;
