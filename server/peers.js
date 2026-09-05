import fs from 'node:fs';
import path from 'node:path';
import { PEER_SESSIONS_DIR, SESSION_PREFIX } from './config.js';

/**
 * Reads Claude Code's own peer-session registry (`PEER_SESSIONS_DIR`) — the directory
 * `ListAgents` reads to build its roster, one `<pid>.json` per live session, gone within
 * seconds of that session exiting. Nothing in this repo reads it today.
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

/**
 * One peer's registry entry, or `null` if it cannot be read as one — absent file,
 * unparseable JSON, or a record with no usable shape. Never throws.
 */
export function readPeer(pid, dir = PEER_SESSIONS_DIR) {
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
export function listPeers(dir = PEER_SESSIONS_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const peers = [];
  for (const name of names) {
    const match = name.match(PID_JSON_RE);
    if (!match) continue;
    const peer = readPeer(match[1], dir);
    if (peer) peers.push(peer);
  }
  return peers;
}

/**
 * A **guess** at the tmux session name a peer's own name would produce, not a resolution —
 * named this way so nobody mistakes it for one. The real value, when there is one, is
 * `readPeer(pid).tmuxSession`.
 */
export const guessTmuxSession = (name) => `${SESSION_PREFIX}${name}`;
