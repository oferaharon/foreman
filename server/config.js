import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readConfigFile,
  resolveBindHost,
  resolveSessionPrefix,
  allowedOriginsFrom,
} from './settings-file.js';

export const PORT = Number(process.env.FOREMAN_PORT || 48770);

export const HOME = os.homedir();
export const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
export const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
/**
 * Claude Code's user config — where MCP servers are registered. **Read, never written**:
 * the panel copies a chosen entry into a lead's `mcp.json` and asks it which forge tools
 * exist, and that is the whole of its interest in this file.
 *
 * Overridable for the same reason `FOREMAN_STATE_DIR` and `FOREMAN_PANEL_REPO` are: a scratch
 * panel has to be able to answer "is a gitea server registered?" deterministically,
 * instead of against whatever the person running the suite happens to have installed.
 */
export const USER_CLAUDE_CONFIG = process.env.FOREMAN_CLAUDE_CONFIG || path.join(HOME, '.claude.json');
/**
 * Where the panel keeps everything that is not in git: queue, pins, groups, snapshot,
 * read marks, tasks, the room, the trigger token, `config.json`.
 *
 * **`$FOREMAN_STATE_DIR` → `~/.foreman` if it exists → `~/.agenticdevui` if it exists →
 * `~/.foreman`.** Five lines, and the third rung is the only place in this code where the
 * name this project used to have legitimately survives.
 *
 * That rung is a **path**, not a name anything reads as configuration, and it is dead on
 * any machine that has never run the old build — a fresh clone creates `~/.foreman` on its
 * first boot and never learns the old directory existed. It is here so that the one
 * machine that *does* have a populated `~/.agenticdevui` keeps reading it after a code
 * update, with no migration and no first-run surprise.
 *
 * **It is not a migration and must never become one.** Nothing here moves, copies or
 * merges a directory: a first-run auto-move is exactly the shape that was rejected, because
 * the failure mode of a half-finished automatic move is a person's task history in two
 * places with no way to tell which is live. Moving is a deliberate step somebody takes with
 * the panel stopped.
 *
 * The environment rung stays first for the reason it always existed: a second server
 * started for testing (`FOREMAN_PORT`) has to be pointable at a scratch directory. Two
 * servers sharing one state dir would both flush the same queue, and a test run would be
 * saving snapshots over the bench you actually rely on.
 *
 * Pure and parameterised so the rungs can be asserted with a temporary `HOME` rather than
 * against whatever the machine running the suite happens to have in its own. It answers
 * `{ dir, source }` and the boot prints the source, because a resolver that silently
 * picked the other directory is indistinguishable from a panel whose history vanished.
 */
export const STATE_DIR_NAME = '.foreman';

/**
 * The directory name an older build of this tool used, and the **only** place that
 * spelling legitimately appears in this code. Named once so the test suite and the boot
 * line can both refer to it without a second copy — a name with two spellings is the
 * `isLeadName` lesson, and this one would fail silently by reading an empty directory.
 */
export const LEGACY_STATE_DIR_NAME = '.agenticdevui';

export function resolveStateDir({ env = process.env, home = HOME, exists = fs.existsSync } = {}) {
  if (env.FOREMAN_STATE_DIR) return { dir: env.FOREMAN_STATE_DIR, source: '$FOREMAN_STATE_DIR' };
  const current = path.join(home, STATE_DIR_NAME);
  if (exists(current)) return { dir: current, source: 'it exists' };
  const legacy = path.join(home, LEGACY_STATE_DIR_NAME);
  if (exists(legacy)) return { dir: legacy, source: 'the directory this project used to use' };
  return { dir: current, source: 'the default, created now' };
}

const state = resolveStateDir();

export const STATE_DIR = state.dir;

/** Which rung answered, for the boot line. */
export const STATE_DIR_SOURCE = state.source;
export const PANES_DIR = path.join(STATE_DIR, 'panes');

/**
 * The panel's own settings file. Seeded by the panel at first boot, never written by
 * hand — `settings-file.js` is the whole of the reasoning, and it is worth reading before
 * changing anything here.
 *
 * Under `STATE_DIR` so scratch isolation comes free, exactly like `queue.json` and
 * `trigger-token`: a server started with `FOREMAN_STATE_DIR=/tmp/scratch` seeds and reads
 * `/tmp/scratch/config.json` and can never widen the real panel's bind.
 */
export const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

const settings = readConfigFile(CONFIG_FILE);

/** The parsed settings file, `{}` when there isn't one (or it could not be parsed).
 *  §B2's settings surface writes this file; nothing in `server/` writes it today except
 *  the boot seed. */
export const CONFIG = settings.config;

const prefix = resolveSessionPrefix({ config: CONFIG, file: CONFIG_FILE });

/**
 * The prefix every tmux session this panel mints carries, and the only prefix it
 * recognises: **`config.json`'s `sessionPrefix` → `foreman-`**, resolved once at boot.
 *
 * One prefix, not two. There is no compatibility mode that mints under one name and also
 * answers to another — the panel would then claim sessions it did not start and could not
 * name back. What that means in practice on a machine running a second launcher of its
 * own: set this to *that* tool's prefix and the panel keeps recognising its sessions; set
 * it to anything else and it does not see them at all. That is why a machine with such a
 * launcher records its prefix here rather than taking the default.
 *
 * `launch.js` mints with it, `sessions.js` and `tmux.js` slice it off to recover a label,
 * `slugFor` is the tested inverse and `isLeadName` reads it. Every one of those takes it
 * as a defaulted parameter so the tests can cover both a configured value and the
 * default, which is the only way the round trip is proven for a stranger as well as here.
 */
export const SESSION_PREFIX = prefix.prefix;

/** Which rung answered, for the boot line. */
export const SESSION_PREFIX_SOURCE = prefix.source;

/** What `readConfigFile` and `resolveSessionPrefix` had to say, for the boot block to
 *  print. Empty is the good case — a `sessionPrefix` that was written down and then
 *  rejected is exactly the fact that must not arrive as silence. */
export const CONFIG_NOTES = [...settings.notes, ...(prefix.note ? [prefix.note] : [])];

const bind = resolveBindHost({ env: process.env, config: CONFIG });

/**
 * The address `server.listen` binds. **`$FOREMAN_HOST` → `config.json`'s `bindHost` →
 * `127.0.0.1`**, resolved once at boot.
 *
 * The default is loopback and always has been; what actually decides a machine's exposure
 * is the LaunchAgent's job environment, which `install-agent.js` writes — and it now
 * writes this same resolved value instead of a hardcoded `0.0.0.0`, so a stranger who runs
 * the installer gets the default they never had to know about, and a machine that has
 * chosen the wide bind kept it across the rename these env names have since been through.
 */
export const HOST = bind.host;

/** Which of the three rungs answered, for the boot line. */
export const HOST_SOURCE = bind.source;

/**
 * Extra browser origins from the settings file, handed to `origin.js`'s `buildAllowed`
 * beside `$FOREMAN_ALLOWED_ORIGIN`. Loopback, this Mac's own private-LAN addresses and its
 * `.local` name are rules rather than list entries and need no help from here.
 */
export const ALLOWED_ORIGINS = allowedOriginsFrom(CONFIG);

/** How far back a transcript must have been touched to appear in the roster. */
export const RECENT_WINDOW_MS = Number(process.env.FOREMAN_WINDOW_HOURS || 48) * 3600_000;

/** Bytes of transcript tail to read on first open. */
export const BACKFILL_BYTES = 256 * 1024;

/** How often the tmux pane roster is re-read. */
export const ROSTER_POLL_MS = 2000;

/** A session with no hook traffic for this long falls back to unknown-but-idle. */
export const STATUS_STALE_MS = 10 * 60_000;

/**
 * Where the trigger secret lives when it isn't in the environment.
 *
 * Under `STATE_DIR`, not `HOME`, so scratch isolation comes free — exactly like
 * `queue.json` and `tasks.json`. A server started with `FOREMAN_STATE_DIR=/tmp/scratch` looks
 * for `/tmp/scratch/trigger-token`, finds nothing, and runs with triggers off. A scratch
 * panel must never inherit the real token and fire real triggers into a real lead.
 */
export const TRIGGER_TOKEN_FILE = path.join(STATE_DIR, 'trigger-token');

/**
 * Read the token file, or explain why there isn't one.
 *
 * Returns `{ token, notes }` and prints nothing. `config.js` is imported by every server
 * module and transitively by most of the tests, and a module that talks at import time
 * talks in all of them — so the boot block in `index.js` owns the printing, beside the
 * two lines already there.
 *
 * The notes are the point of this function existing at all. "There is no file here" and
 * "there is a file here I could not read" are different facts that produce the same
 * silence, and that silence is what cost an hour on 2026-08-27: the panel was restarted
 * by hand after a power cut without the token, every trigger since answered 503, and 503
 * logs nothing on either side of the wire.
 */
export function readTokenFile(file) {
  const notes = [];
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    // ENOENT is the ordinary case and the boot line already says so. Anything else — a
    // directory we can't traverse, a broken symlink — is worth a line of its own.
    if (err.code !== 'ENOENT') {
      notes.push(`Trigger token at ${file} could not be checked (${err.code}) — treating it as absent.`);
    }
    return { token: '', notes };
  }

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Never fatal. A secret that can't be read is a feature that's off, not a panel that
    // won't boot — and the note is the difference between an hour and a minute.
    notes.push(`Trigger token at ${file} exists but could not be read (${err.code}) — triggers stay off.`);
    return { token: '', notes };
  }

  // A trailing newline is what an editor or `echo` leaves behind, and it makes
  // `triggerAuthorized`'s length check fail, so every request 401s with a token that
  // looks right in every way you would inspect it.
  const token = raw.trim();
  if (!token) {
    notes.push(`Trigger token at ${file} is empty — triggers stay off.`);
    return { token: '', notes };
  }

  // Warn, don't refuse: a hard failure for a soft problem would take the feature down
  // over file permissions. Group or other bits are what "wider than 600" means here.
  if (stat.mode & 0o077) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    notes.push(`Trigger token at ${file} is mode ${mode} — readable beyond you. \`chmod 600\` it.`);
  }
  return { token, notes };
}

const trigger = process.env.FOREMAN_TRIGGER_TOKEN
  ? { token: process.env.FOREMAN_TRIGGER_TOKEN, notes: [], source: '$FOREMAN_TRIGGER_TOKEN' }
  : { ...readTokenFile(TRIGGER_TOKEN_FILE), source: TRIGGER_TOKEN_FILE };

/**
 * The shared secret `POST /api/trigger` checks, and the switch that turns that route on.
 *
 * Read **once at boot**, like `PORT` and `STATE_DIR`, and for the same reason: one place
 * to look, and no chance of the answer changing between the check and the send. Absent
 * means the trigger endpoint answers **503 to everything**, including a well-formed
 * request — the feature is off rather than open, because a trigger is a sentence typed
 * into a lead that dispatches workers on the maintainer's behalf.
 *
 * `$FOREMAN_TRIGGER_TOKEN` first, then `TRIGGER_TOKEN_FILE`. Env first so a one-off override
 * still works and nothing that already runs changes behaviour; the file is what makes the
 * token survive a restart, which is the failure that actually happened — a hand restart
 * dropping it, silently.
 *
 * Still never `team.json`, and the file violates none of the three reasons why: that file
 * is rewritten on every `ensureTeam`, served straight to the browser by
 * `GET /api/team/config`, and sits in a directory the planner role is allowed to write to.
 * `STATE_DIR/trigger-token` is written by nobody, served by nothing, and sits one level
 * above every team's write grant (`team.js`'s `Edit(//…/teams/<key>/**)`).
 *
 * And deliberately **not** in the LaunchAgent plist: `launchctl kickstart -k` does not
 * re-read the plist (measured — a job bootstrapped with one value, the plist edited,
 * kickstarted, and the old value came back; only `bootout` + `bootstrap` picks up a
 * change). A token there would survive its own rotation invisibly, and the documented
 * restart command would keep using the old one. A file is read at every boot by every
 * way of starting the panel, including `npm start`.
 */
export const TRIGGER_TOKEN = trigger.token;

/** Where `TRIGGER_TOKEN` came from, for the boot line. Never the token itself. */
export const TRIGGER_SOURCE = trigger.source;

/** What `readTokenFile` had to say, for the boot block to print. Empty is the good case. */
export const TRIGGER_NOTES = trigger.notes;

/** How long an identical phrase from the same team is treated as a retry, not a second
 *  event. Guards the one failure that actually happens: a webhook retrying on a timeout. */
export const TRIGGER_DEDUPE_MS = 10 * 60_000;
