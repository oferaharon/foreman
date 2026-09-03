#!/usr/bin/env node
/**
 * Installs (or removes) the LaunchAgent that keeps the panel running.
 *
 * Same shape as `install-hook.js` — load, back up, save, `--remove` at the bottom, a
 * summary naming the backup — because it is the same kind of job: write one file into
 * one of macOS's config directories without clobbering whatever is already there.
 *
 * What it is *for* is narrower than "start at login". The panel comes back after a
 * reboot or a crash with the settings it had before it went down — the bind host, which is
 * what decides whether a phone can reach it, and a `PATH` that has `npm` in it. Both were
 * being carried in whatever shell happened to start the panel, and on 2026-08-27 a power
 * cut proved what that is worth.
 *
 * The host it writes is **resolved, not hardcoded**: `$FOREMAN_HOST` → `<STATE_DIR>/config.json`
 * → `127.0.0.1`, and the key is left out of the plist entirely when it is the loopback
 * default. See `jobEnvironment` below for what that changed and why.
 *
 * It also **displaces an older job of this panel's own** before it bootstraps a new one —
 * `legacyJobs` below is the whole of that decision, and the reason it is written by shape
 * rather than by name.
 *
 * Two things it deliberately does not do:
 *
 *  - **It never touches the trigger token.** `config.js` reads it from
 *    `STATE_DIR/trigger-token` at every boot, by every way of starting the panel.
 *    Putting it in `EnvironmentVariables` would tie it to this one launch route *and*
 *    make it un-rotatable in practice, because `launchctl kickstart -k` does not re-read
 *    the plist (measured) — you would edit the value, run the documented restart, and
 *    still be running the old one. The summary reports whether triggers will be on. It
 *    never learns, copies or prints the value.
 *  - **It does not replace `npm start`.** That stays the scratch-server command —
 *    `FOREMAN_PORT=… FOREMAN_STATE_DIR=… npm start` — and that rule has teeth: a second server
 *    on the real state dir sweeps real worktrees and posts the receipt into a real
 *    team's room.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, HOST_SOURCE, STATE_DIR, HOME, CONFIG_FILE, TRIGGER_TOKEN_FILE, readTokenFile, resolveStateDir } from './config.js';
import { DEFAULT_BIND_HOST } from './settings-file.js';
import { AGENT_LABEL as LABEL, DEFAULT_AGENT_LABEL, LOG_DIR, DEFAULT_LOG_DIR, LOG_OUT, LOG_ERR } from './logs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO, 'server', 'index.js');

/*
 * The label and the two log paths come from `logs.js`, which owns both — including the
 * `FOREMAN_AGENT_LABEL` escape that lets the installer be benched without booting the real
 * job, and the scratch-log naming that goes with it. They live there rather than here
 * because `index.js` rotates those files at boot and needs the same two strings, and this
 * file's whole job is to install a LaunchAgent — a boot path that imported it would be one
 * import away from doing so. The guard at the bottom (`install()` only when this file is
 * the process's entry point) is what makes `jobEnvironment` testable; it is a second line
 * of defence for that split, not a replacement for it.
 */
const AGENTS_DIR = path.join(HOME, 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(AGENTS_DIR, `${LABEL}.plist`);

const DOMAIN = `gui/${process.getuid()}`;
const SERVICE = `${DOMAIN}/${LABEL}`;

/*
 * What `config.js` would resolve with no `$FOREMAN_STATE_DIR` set — which is what the job
 * will resolve too, since launchd inherits nothing. Written as a call rather than a
 * literal because the resolver has more than one rung: hardcoding `~/.foreman` here would
 * make the installer omit the key on a machine whose panel is in fact reading the other
 * directory, and the job would then come up against an empty one.
 */
const DEFAULT_STATE_DIR = resolveStateDir({ env: {}, home: HOME }).dir;

/** Absolute, like every other tool this repo shells out to — launchd's `PATH` is four
 *  directories and none of the interesting binaries are in them. */
const LAUNCHCTL = '/bin/launchctl';
const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';
const PLUTIL = '/usr/bin/plutil';

// ---------------------------------------------------------------------------- plist ---

/**
 * launchd's `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else (measured), which
 * is why the job carries its own.
 *
 * Item 1 taught the panel to find `tmux` by absolute path, so the roster no longer
 * depends on this — but `runSetup` (`worktree.js`) runs the worktree-prepare command
 * through `exec()` with the inherited environment, and that command is things like
 * `npm install`. `npm` is at `/opt/homebrew/bin/npm`. It fails quietly: `{ok: false}`, a
 * log under `worker-logs/`, and the dispatch carries on as though nothing happened.
 *
 * Built from the installing shell's own `PATH` plus the seven that must be there,
 * deduped in order. The one thing filtered out is npm's `node_modules/.bin` walk: `npm
 * run install-agent` prepends a chain of them up to `/node_modules/.bin`, which are an
 * artifact of how the installer was started rather than anything about this Mac, mostly
 * do not exist, and would quietly let a long-lived daemon resolve binaries out of a
 * checkout that can be deleted.
 */
const REQUIRED_PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(HOME, '.local', 'bin'),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function jobPath() {
  const seen = new Set();
  const dirs = [];
  for (const dir of [...(process.env.PATH || '').split(':'), ...REQUIRED_PATH]) {
    if (!dir || dir.endsWith('/node_modules/.bin') || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs.join(':');
}

/**
 * The job's environment. Every key follows one rule: **write it only when it is not the
 * default**, because a plist that spells out a default is a plist that has to be
 * re-installed when the default changes.
 *
 * The host used to be exempt from that rule — a literal wide bind written into *every*
 * plist this installer generated, with no condition on it at all. That was
 * correct for exactly one machine and wrong for everybody else: a stranger who ran
 * `npm run install-agent` got a panel answering on their whole local network and was never
 * asked. The maintainer's standing ruling of 2026-08-27 — the panel is reachable on the
 * LAN and gets no authentication in front of it — is *their* decision about *their*
 * machine, and it is now carried by `<STATE_DIR>/config.json` (`settings-file.js`), which
 * the panel seeds from the host it is actually running on. So the wide bind survives here
 * by having been *recorded*, rather than by being hardcoded for everyone.
 *
 * Carrying the host at all is still the point of the LaunchAgent: it is the setting a hand
 * restart drops, and a power cut on 2026-08-27 proved what that is worth.
 *
 * Parameterised so it can be tested without a plist, a job or a `launchctl` anywhere near
 * it — the defaults are the real resolved values and the installer calls it with none.
 */
export function jobEnvironment({
  host = HOST,
  port = PORT,
  stateDir = STATE_DIR,
  label = LABEL,
  logDir = LOG_DIR,
} = {}) {
  const env = {};
  if (host !== DEFAULT_BIND_HOST) env.FOREMAN_HOST = host;
  env.PATH = jobPath();
  if (port !== 48770) env.FOREMAN_PORT = String(port);
  if (stateDir !== DEFAULT_STATE_DIR) env.FOREMAN_STATE_DIR = stateDir;
  /*
   * The label has to reach the job, not just the plist.
   *
   * `StandardOutPath` below is derived from it, and so is the boot-time rotation in
   * `index.js` — from the *running process's* environment. Leave it out and a scratch job
   * writes to scratch logs while the panel inside it computes the default paths and
   * rotates the real panel's history. The plist and the job it starts must name the same
   * two files or the rotation is pointed at somebody else's.
   */
  if (label !== DEFAULT_AGENT_LABEL) env.FOREMAN_AGENT_LABEL = label;
  /*
   * …and so does the log *directory*, for the identical reason and by the identical rule.
   *
   * `StandardOutPath` below is `LOG_OUT`, which is now `$FOREMAN_LOG_DIR` plus a basename
   * derived from the label. Carry the label and not the directory and an install run with
   * `FOREMAN_LOG_DIR` set writes a plist pointing at one pair of files while the panel
   * inside it computes the default pair — `~/Library/Logs`, the real panel's — and
   * truncates those at boot. That is the same trap one line up wearing a different hat,
   * and the rule this file already carries is that anything the plist derives has to
   * reach the job.
   */
  if (logDir !== DEFAULT_LOG_DIR) env.FOREMAN_LOG_DIR = logDir;
  return env;
}

/**
 * The absolute node binary, captured now — but the *stable* spelling of it where there
 * is one.
 *
 * A bare `node` in `ProgramArguments` fails with exit 78 EX_CONFIG and writes nothing to
 * stdout or stderr (measured), so the job simply appears not to exist. `process.execPath`
 * is the right source and `index.js` already uses it for the MCP config — but on this Mac
 * it resolves the Homebrew symlink all the way to
 * `/opt/homebrew/Cellar/node/25.6.1_1/bin/node`, a path that `brew upgrade node` deletes.
 * The panel would then die at the next restart in exactly the silent way above.
 *
 * So: if `/opt/homebrew/bin/node` (or `/usr/local/bin/node`) is the *same file* — checked
 * by realpath, at install time, not assumed — prefer it. Still absolute, still captured
 * now, and it survives a version bump.
 */
function nodeBinary() {
  let real;
  try {
    real = fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch { /* not there, or a broken link — try the next one */ }
  }
  return process.execPath;
}

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistValue(value, indent) {
  const pad = '\t'.repeat(indent);
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
  if (Array.isArray(value)) {
    const items = value.map((v) => plistValue(v, indent + 1)).join('\n');
    return `${pad}<array>\n${items}\n${pad}</array>`;
  }
  if (value && typeof value === 'object') {
    const rows = Object.entries(value)
      .map(([k, v]) => `${'\t'.repeat(indent + 1)}<key>${escape(k)}</key>\n${plistValue(v, indent + 1)}`)
      .join('\n');
    return `${pad}<dict>\n${rows}\n${pad}</dict>`;
  }
  return `${pad}<string>${escape(value)}</string>`;
}

function plistXml() {
  const job = {
    Label: LABEL,
    ProgramArguments: [nodeBinary(), ENTRY],
    // Not load-bearing — nothing in `server/` reads `process.cwd()`; `WEB_DIR`, the
    // marked path and `PANEL_REPO` all resolve off `import.meta.url`. Matching what
    // `npm start` did costs nothing and makes a stray relative path behave the same.
    WorkingDirectory: REPO,
    EnvironmentVariables: jobEnvironment(),
    RunAtLoad: true,
    /*
     * A contract with the boot guard, not a preference.
     *
     * The panel exits **0** when it finds another panel already answering on its port,
     * and `SuccessfulExit: false` is what makes launchd stand down rather than
     * crash-loop against it. A genuine crash is a non-zero exit or a signal and still
     * gets restarted, which is the half that makes this worth having.
     */
    KeepAlive: { SuccessfulExit: false },
    // Matching another long-lived agent on this Mac, whose own comment says why: "so a
    // broken agent does not become its own incident." launchd appends to the log files
    // across restarts and nothing rotates them, so a crash-loop is measured in MB/hour.
    ThrottleInterval: 10,
    StandardOutPath: LOG_OUT,
    StandardErrorPath: LOG_ERR,
    // No `ProcessType`. That same agent sets `Background` and it is tempting to copy
    // its plist wholesale, but that asks for throttled CPU and low-priority I/O, and
    // this process polls tmux every 2s and holds websockets a human is watching.
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!--',
    '  Foreman panel. Generated by `npm run install-agent` — edit that, not this:',
    '  a hand-edited plist is picked up by `bootout` + `bootstrap` and NOT by',
    '  `launchctl kickstart -k`, so "restart" would silently keep the old settings.',
    '',
    '    restart the panel:  npm run restart-panel',
    '    stop it:            npm run stop-panel',
    '    change this file:   npm run install-agent',
    '-->',
    '<plist version="1.0">',
    plistValue(job, 0),
    '</plist>',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------------- launchctl ---

function run(bin, args) {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out, err: '' };
  } catch (err) {
    return { ok: false, out: err.stdout || '', err: (err.stderr || err.message || '').trim() };
  }
}

const launchctl = (...args) => run(LAUNCHCTL, args);

/** The running PID of our own label, or `null` if the job is unknown or not running. */
function jobPid() {
  const { ok, out } = launchctl('list', LABEL);
  if (!ok) return null;
  const m = out.match(/"PID"\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

const jobKnown = () => launchctl('list', LABEL).ok;

/**
 * Every PID listening on the port.
 *
 * A list, not one, because two panels *can* hold this port at once — one bound to
 * `0.0.0.0`, one to `127.0.0.1`, both succeed, no error, and they split traffic by
 * interface. That is the state this whole install exists to avoid walking into.
 */
function listeners(port) {
  const { out } = run(LSOF, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return [...new Set(out.split('\n').map((l) => Number(l.trim())).filter(Boolean))];
}

const commandOf = (pid) => run(PS, ['-o', 'command=', '-p', String(pid)]).out.trim() || '(gone)';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const sleep = (ms) => {
  // Deliberately synchronous: this script is a straight line of blocking `execFileSync`
  // calls, and an await here would only make the order harder to read.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Wait until nothing holds the port. Returns the PIDs still there when time ran out. */
function waitForPortFree(port, ms = 10_000) {
  const deadline = Date.now() + ms;
  let held = listeners(port);
  while (held.length && Date.now() < deadline) {
    sleep(250);
    held = listeners(port);
  }
  return held;
}

/**
 * Stop one process politely, then not.
 *
 * SIGTERM first because the panel now flushes every store on it — the queue, task
 * records, pins, group filings, read marks — and a SIGKILL throws away up to two seconds
 * of all of that. SIGKILL only after it has had five seconds to go on its own.
 */
function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') return true;
    console.error(`  could not signal ${pid}: ${err.code}`);
    return false;
  }
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) sleep(200);
  if (!alive(pid)) return true;
  console.log(`  ${pid} did not stop on SIGTERM — sending SIGKILL.`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* it went on its own between the check and the signal */ }
  const hard = Date.now() + 3000;
  while (alive(pid) && Date.now() < hard) sleep(200);
  return !alive(pid);
}

// ---------------------------------------------------------------------------- legacy ---

/**
 * Read one plist's `Label` and `ProgramArguments`, or `null` if it is not readable as a
 * job. `plutil` because a plist may be binary, XML or JSON and only the system tool knows
 * all three; a regex over the XML would quietly skip exactly the ones it could not parse,
 * which here means quietly leaving a job installed.
 */
function readJobPlist(file) {
  const { ok, out } = run(PLUTIL, ['-convert', 'json', '-o', '-', file]);
  if (!ok) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Jobs in `~/Library/LaunchAgents` that are **this panel under a name it no longer uses**.
 *
 * The problem this solves is silent and survives reboots. `ProgramArguments` is a *path*,
 * not a name — so a plist written under an older label goes on starting `server/index.js`
 * at every login, which after a rename is the *new* code under the *old* label. Two jobs
 * then race for one port, macOS lets both binds succeed, they split traffic by interface,
 * and `npm run restart-panel` kickstarts whichever one is not holding the port.
 *
 * **The old name is not in this file, and must not be.** Detection is by shape, and it is
 * deliberately narrow — two rungs, both of which mean "this plist starts a copy of this
 * panel that is not the one being installed":
 *
 *  1. its program is a `…/server/index.js` that **no longer exists** — the checkout moved
 *     out from under it, which is the whole reason the plist is now orphaned; or
 *  2. its program **is this very file**, by `realpath` — the same entry point, installed
 *     twice under two names.
 *
 * **A plist whose program exists and is a different file is left strictly alone**, and
 * that is the rung that matters most: it is what stops an installer run from inside a git
 * worktree — where `server/index.js` is a *copy* — from booting out the real job that
 * points at the real checkout. Anything unreadable, or with no `server/index.js` argument
 * at all, is likewise not ours and is not touched.
 *
 * Pure apart from the readers, which are injected so this can be asserted against a
 * scratch directory of plists rather than against whatever the machine happens to have.
 */
export function legacyJobs({
  dir = AGENTS_DIR,
  currentLabel = LABEL,
  entry = ENTRY,
  readPlist = readJobPlist,
  exists = fs.existsSync,
  realpath = fs.realpathSync,
} = {}) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.plist')).sort();
  } catch {
    return [];
  }

  let ourEntry = entry;
  try {
    ourEntry = realpath(entry);
  } catch { /* the installer's own file should exist, but never throw over it */ }

  const found = [];
  for (const name of files) {
    const file = path.join(dir, name);
    // Whatever the file actually contains, read defensively: a plist with no `Label`, or
    // one whose `ProgramArguments` is not a list, is not a job this installer understands
    // and is therefore not one it may stop.
    const job = readPlist(file);
    const label = job && typeof job.Label === 'string' ? job.Label : null;
    if (!label || label === currentLabel) continue;
    const args = Array.isArray(job.ProgramArguments) ? job.ProgramArguments : [];

    const program = args.find((a) => typeof a === 'string' && a.endsWith(`${path.sep}server${path.sep}index.js`));
    if (!program) continue;

    if (!exists(program)) {
      found.push({ file, label, program, why: 'its checkout is gone' });
      continue;
    }
    let resolved;
    try {
      resolved = realpath(program);
    } catch {
      continue;
    }
    if (resolved === ourEntry) {
      found.push({ file, label, program, why: 'it runs this same file' });
    }
    // …and otherwise: a real, different panel. Not ours to stop.
  }
  return found;
}

/**
 * Boot each legacy job out, back its plist up, and remove it. Prints one line each.
 *
 * **`bootout`, never a signal.** `KeepAlive: {SuccessfulExit: false}` reads a signal death
 * as a crash and starts the job straight back up, so killing the process is a fight with
 * launchd that launchd wins. Booting the job out is what actually ends it.
 *
 * The backup goes to `STATE_DIR`, not beside the original: a second file in
 * `~/Library/LaunchAgents` carrying the same `Label` is a duplicate job waiting for the
 * next login, which is the failure being cleaned up here.
 */
function displace(jobs) {
  const done = [];
  for (const job of jobs) {
    console.log(`Displacing ${job.label} — ${job.why}.`);
    const out = launchctl('bootout', `${DOMAIN}/${job.label}`);
    if (!out.ok && !/No such process/i.test(out.err)) {
      console.error(`  could not bootout ${job.label}: ${out.err}`);
      return { done, failed: job };
    }
    const bak = backup(job.file, job.label);
    try {
      fs.unlinkSync(job.file);
    } catch (err) {
      console.error(`  could not remove ${job.file}: ${err.code || err.message}`);
      return { done, failed: job };
    }
    console.log(`  booted out, plist backed up to ${bak}, and removed.`);
    done.push({ ...job, backup: bak });
  }
  return { done, failed: null };
}

// ----------------------------------------------------------------------------- files ---

function backup(file, name = LABEL) {
  if (!fs.existsSync(file)) return null;
  /*
   * Not beside the original.
   *
   * `install-hook.js` drops its backup next to `settings.json` and that is fine there.
   * Here the original lives in `~/Library/LaunchAgents`, a directory launchd reads — a
   * second file in it carrying the same `Label` is at best ignored and at worst a
   * duplicate job at the next login. So the backup goes to `STATE_DIR`, where launchd
   * never looks and where the panel's own state already lives.
   */
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const dest = path.join(STATE_DIR, `${name}.backup-foreman-${Date.now()}.plist`);
  fs.copyFileSync(file, dest);
  return dest;
}

// --------------------------------------------------------------------------- reports ---

/** The escape hatch, printed whether the install went ahead or refused. `say` so a
 *  refusal keeps all of itself on stderr rather than interleaving across two streams. */
function printCommands(say = console.log) {
  say('');
  say('  restart the panel:  npm run restart-panel');
  say('  stop it:            npm run stop-panel');
  say('  remove the job:     npm run uninstall-agent');
  say(`  is it running:      launchctl print ${SERVICE} | head -5`);
  say(`  what it said:       tail -f ${LOG_OUT}`);
}

/**
 * On or off, and nothing else — the value is never read into anything that outlives this
 * expression, never written anywhere, never printed.
 *
 * It goes through `config.js`'s own `readTokenFile` so this line and the panel's boot
 * line cannot disagree: a file that is empty, unreadable or beyond mode 600 is a file
 * the panel will refuse to use, and a bare existence check here would cheerfully say
 * "on" over a panel about to say "off".
 *
 * `$FOREMAN_TRIGGER_TOKEN` in the installing shell is deliberately ignored. launchd does not
 * inherit it, so a shell that has one would otherwise produce exactly the reassuring lie
 * this line exists to end.
 */
function triggerState() {
  const { token, notes } = readTokenFile(TRIGGER_TOKEN_FILE);
  return { on: Boolean(token), notes };
}

function printTriggerState() {
  const { on, notes } = triggerState();
  for (const note of notes) console.warn(note);
  // "no token file" only when there genuinely isn't one. A file that is empty, unreadable
  // or wrong is a different fact and the note above just said which — two adjacent lines
  // appearing to contradict each other is a small version of the ambiguity this whole
  // line exists to end. `index.js`'s boot line makes the same distinction, in the same
  // words, on purpose.
  const missing = notes.length ? 'no usable token' : 'no token file';
  console.log(on
    ? `Triggers: on — token file at ${TRIGGER_TOKEN_FILE}`
    : `Triggers: off — ${missing}, see docs/running.md (${TRIGGER_TOKEN_FILE})`);
}

// --------------------------------------------------------------------------- install ---

function refuse(pids) {
  console.error(`Port ${PORT} is already in use — nothing installed.`);
  console.error('');
  for (const pid of pids) {
    console.error(`  ${pid}  ${commandOf(pid)}`);
  }
  console.error('');
  console.error('Bootstrapping the job now would give you two panels on one port: macOS lets a');
  console.error('specific bind sit beside a wildcard one with no error, and they split traffic by');
  console.error('interface — hooks and lead tool calls to one, your phone to the other. Both would');
  console.error('poll tmux, both would flush the same queue, and both would run worktree GC.');
  console.error('');
  console.error('Stop it yourself and re-run, or hand over in one step:');
  console.error('');
  console.error('  npm run install-agent -- --takeover');
  printCommands(console.error);
}

function install() {
  const takeover = process.argv.includes('--takeover');

  /*
   * Displace any job that is this panel under a name it no longer uses — **first**, before
   * the port check below.
   *
   * Ordering matters and is not a preference. Such a job may well be the thing holding the
   * port, and the refusal below reads a held port as "somebody else is running a panel" and
   * stops the install. Refusing to displace the very job the install exists to replace
   * would leave the old plist in place, still starting the new code under the old label at
   * every login — which is the failure this whole step is for. Booting it out first means
   * the port is free by the time anything is asked about it, and anything *genuinely*
   * foreign still refuses.
   */
  const displaced = displace(legacyJobs());
  if (displaced.failed) {
    console.error(`Could not displace ${displaced.failed.label} — nothing installed.`);
    console.error('Its plist is still in place; stop it by hand and re-run.');
    process.exitCode = 1;
    return;
  }
  if (displaced.done.length) waitForPortFree(PORT);

  // Our own running job is not a foreign panel — it is the thing a re-install replaces,
  // and `bootout` below stops it properly. Only somebody *else* on the port is a refusal.
  const ours = jobPid();
  const foreign = listeners(PORT).filter((pid) => pid !== ours);

  if (foreign.length) {
    if (!takeover) {
      refuse(foreign);
      process.exitCode = 1;
      return;
    }
    console.log(`Taking over port ${PORT}:`);
    for (const pid of foreign) {
      console.log(`  stopping ${pid}  ${commandOf(pid)}`);
      if (!stopProcess(pid)) {
        console.error(`Could not stop ${pid} — nothing installed.`);
        process.exitCode = 1;
        return;
      }
    }
    const held = waitForPortFree(PORT);
    if (held.length) {
      console.error(`Port ${PORT} is still held by ${held.join(', ')} — nothing installed.`);
      process.exitCode = 1;
      return;
    }
  }

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const xml = plistXml();
  // A backup protects the file you are about to overwrite, so an identical file has
  // nothing to protect. Re-running the installer to make sure the job is up is a normal
  // thing to do, and it should not leave another copy of the same plist behind each time.
  const same = fs.existsSync(PLIST_PATH) && fs.readFileSync(PLIST_PATH, 'utf8') === xml;
  const bak = same ? null : backup(PLIST_PATH);
  if (!same) fs.writeFileSync(PLIST_PATH, xml);

  /*
   * Always bootout before bootstrap, even when the job looks fine.
   *
   * `launchctl kickstart -k` does **not** re-read the plist — measured: a job was
   * bootstrapped with one value, the file edited, kickstarted, and the old value came
   * back. Only bootout + bootstrap picks up a change. So a re-install that merely
   * restarted would be a re-install that did nothing, silently, which is the exact shape
   * of failure this issue exists to end.
   */
  if (jobKnown()) {
    const out = launchctl('bootout', SERVICE);
    // Exit 3 is "no such process" — a job that was known a moment ago and is gone now is
    // the outcome we wanted anyway.
    if (!out.ok && !/No such process/i.test(out.err)) {
      console.error(`launchctl bootout ${SERVICE} failed: ${out.err}`);
      process.exitCode = 1;
      return;
    }
    // The panel refuses to start beside anything already answering on its port, so the
    // old process has to be gone before the new one is asked to bind — otherwise the
    // fresh job stands down (exit 0) and launchd, honouring `SuccessfulExit: false`,
    // agrees with it. A re-install that leaves you with no panel.
    const held = waitForPortFree(PORT);
    if (held.length) {
      console.error(`Port ${PORT} is still held by ${held.join(', ')} after bootout — nothing started.`);
      console.error(`The plist is written. Free the port and run:  launchctl bootstrap ${DOMAIN} ${PLIST_PATH}`);
      process.exitCode = 1;
      return;
    }
  }

  const boot = launchctl('bootstrap', DOMAIN, PLIST_PATH);
  if (!boot.ok) {
    console.error(`launchctl bootstrap ${DOMAIN} ${PLIST_PATH} failed: ${boot.err}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Installed ${LABEL}.`);
  const env = jobEnvironment();
  const rows = [
    ['plist', same ? `${PLIST_PATH} (unchanged)` : PLIST_PATH],
    /*
     * Said in words, always, because the interesting case is the one with **no** row in
     * the environment below it: a loopback bind writes no `FOREMAN_HOST` key at all, and
     * "there is nothing here" is not a thing a person can read off a list. This is the one
     * line of this summary that describes who can reach the panel.
     */
    ['bind', env.FOREMAN_HOST
      ? `${HOST} — reachable from this network (from ${HOST_SOURCE === 'config.json' ? CONFIG_FILE : HOST_SOURCE})`
      : `${HOST} — loopback only, no FOREMAN_HOST in the plist (set bindHost in ${CONFIG_FILE} to widen it)`],
    ...(bak ? [['backup', bak]] : []),
    /*
     * Named in the summary because it is the one thing this run did that nobody asked for:
     * a job was stopped and its plist taken out of `~/Library/LaunchAgents`. Silence there
     * would be a reinstall that quietly ended something.
     */
    ...displaced.done.map((job) => ['displaced', `${job.label} — booted out, plist backed up to ${job.backup}`]),
    ['runs', `${nodeBinary()} ${ENTRY}`],
    ...Object.entries(env).map(([k, v]) => [k, k === 'PATH' ? `${v.split(':').length} entries` : v]),
    ['log', LOG_OUT],
    ['errors', LOG_ERR],
  ];
  const width = Math.max(...rows.map(([k]) => k.length)) + 1;
  for (const [key, value] of rows) console.log(`  ${`${key}:`.padEnd(width)} ${value}`);
  printCommands();
  console.log('');
  printTriggerState();
}

// ---------------------------------------------------------------------------- remove ---

function remove() {
  const known = jobKnown();
  if (known) {
    const out = launchctl('bootout', SERVICE);
    if (!out.ok && !/No such process/i.test(out.err)) {
      console.error(`launchctl bootout ${SERVICE} failed: ${out.err}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Stopped ${LABEL}.`);
  } else {
    console.log(`${LABEL} was not loaded.`);
  }

  if (!fs.existsSync(PLIST_PATH)) {
    console.log(`No plist at ${PLIST_PATH} — nothing to remove.`);
    return;
  }
  const bak = backup(PLIST_PATH);
  fs.unlinkSync(PLIST_PATH);
  console.log(`Removed ${PLIST_PATH}`);
  if (bak) console.log(`Backup: ${bak}`);
  console.log('');
  console.log('The panel is no longer started at login. To run one by hand:  npm start');
}

/*
 * Run only when this file *is* the command.
 *
 * `npm run install-agent` and `npm run uninstall-agent` are unaffected — they invoke this
 * path directly. What the guard buys is that `jobEnvironment` above can be imported and
 * asserted on (`test/install-agent.test.js`) without a test run writing a plist into
 * `~/Library/LaunchAgents` and bootstrapping a job. Compare by real path so a symlinked
 * checkout still matches, and fall back to a plain resolve if either side cannot be
 * realpath'd.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (invokedDirectly()) {
  process.argv.includes('--remove') ? remove() : install();
}
