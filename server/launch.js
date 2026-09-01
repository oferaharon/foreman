import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SESSION_PREFIX } from './config.js';
import { TMUX_ENV, tmuxPath } from './tmux.js';

const run = promisify(execFile);

/**
 * Start a new Claude Code session, the way the other launcher on this Mac starts one.
 *
 * This is a port, not an interpretation: the launcher this Mac also runs is the only other
 * thing on it that mints sessions, and a second one that named or launched them even
 * slightly differently would break every downstream assumption in this panel — the
 * `<prefix><folder>-<label>` name that `sessions.js` reads as a label, the `claude()`
 * wrapper's `--name`, the `<prefix>*` guard on the pbcopy binding. Each comment below that
 * says "load-bearing" is quoting a bug that has already happened over there.
 *
 * **The prefix is the one part that is configuration rather than contract.** It used to be
 * a literal here; it is now `SESSION_PREFIX`, resolved from `<STATE_DIR>/config.json` and
 * defaulting to `foreman-` (see `settings-file.js`). Everything else about the name — the
 * `sanitize` rule, the two components, the dash between them, the `-2` collision suffix —
 * is unchanged and must stay unchanged. The functions below take the prefix as a defaulted
 * parameter so tests can prove the round trip at the default *and* at a configured value;
 * nothing in `server/` passes one.
 */

/**
 * Every tmux call here reports its own failures — no swallowing, unlike the poller's in
 * `tmux.js`. That difference is deliberate (`confirmClaudeStarted` below relies on
 * `has-session` throwing rather than silently resolving to '' when nothing is up yet), so
 * this stays its own helper rather than importing the poller's — only the binary lookup
 * is shared.
 */
async function tmux(args) {
  const { stdout } = await run(await tmuxPath(), args, { maxBuffer: 4 * 1024 * 1024, env: TMUX_ENV });
  return stdout;
}

/* ------------------------------------------------------------------ naming --- */

/** Lowercase, and collapse everything outside `[a-z0-9-]` to `-`. TmuxNaming.sanitize. */
export const sanitize = (component) => String(component).toLowerCase().replace(/[^a-z0-9-]/g, '-');

/** `<prefix><folder>-<slug>`, the name every reader of a session name splits back up. */
export const sessionName = (folder, slug, prefix = SESSION_PREFIX) =>
  `${prefix}${sanitize(folder)}-${slug}`;

/**
 * The slug back out of a session name — `sessionName` run backwards.
 *
 * Needed because the roster's `label` is *not* the label you launched with: `sessions.js`
 * slices only the prefix, so `<prefix>alpha-main` arrives as `alpha-main`, folder and
 * all. Feed that back into `uniqueSessionName` and you get `<prefix>alpha-alpha-main` —
 * a session that no longer answers to the name it had. Anything restoring a session has to
 * come through here.
 *
 * @param {string} tmuxSession the live name, e.g. `<prefix>alpha-main`
 * @param {string} folder      the *path* it was launched in; only its basename matters
 * @param {string} [component] the naming component, when it isn't the folder's basename —
 *                             a worker launches in a *worktree* but is named for the
 *                             *repo* (`<prefix><repo>-<label>`), so recovering its label
 *                             needs the component the name was actually minted from
 * @param {string} [prefix]    the session prefix; defaults to the configured one, and is a
 *                             parameter only so the tests can walk the round trip at both
 *                             the default and a configured value
 * @returns {string|null} the slug, or null for a name that was never minted this way
 */
export function slugFor(tmuxSession, folder, component = null, prefix = SESSION_PREFIX) {
  const dir = String(folder || '').trim();
  const name = String(tmuxSession || '');
  if ((!dir && !component) || !name) return null;
  const base = component || path.basename(dir.replace(/\/+$/, ''));
  const stem = sessionName(base, '', prefix);
  if (!name.startsWith(stem) || name.length === stem.length) return null;
  return name.slice(stem.length);
}

/**
 * Is this session the team lead of the folder it runs in?
 *
 * The lead's identity **is** its name: `launchLead` forces the label `lead`, which is what
 * makes "one lead per project" a detectable collision rather than a promise. So one
 * function answers it for everyone — the rail badges the row with it (`sessions.js`), and
 * the snapshot decides which launcher to put a saved entry back through (`snapshot.js`).
 *
 * Two spellings of this rule could disagree, and both ways of disagreeing are bad: a row
 * the rail calls a lead but the restore starts as an ordinary session comes back wearing
 * the chip with no brief, no `foreman` tools and no permission stance, and a row the restore
 * calls a lead but the rail doesn't builds a team dir for something nothing on screen
 * names. Keep it here, keep it single.
 */
export const isLeadName = (tmuxSession, folder, prefix = SESSION_PREFIX) =>
  slugFor(tmuxSession, folder, null, prefix) === 'lead';

export async function liveSessionNames() {
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}']);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // no server running yet — this session will be the first
  }
}

/**
 * A name no live session is using.
 *
 * A label becomes the slug; a collision with something already running takes `-2`, `-3`.
 * No label falls back to the smallest free integer for that folder, which is what makes
 * two quick clicks in the same directory produce `-1` and `-2` rather than a clash.
 */
export function uniqueSessionName(folder, label, live = new Set(), prefix = SESSION_PREFIX) {
  const base = sanitize(String(label ?? '').trim());
  if (base) {
    let candidate = sessionName(folder, base, prefix);
    let n = 2;
    while (live.has(candidate)) {
      candidate = sessionName(folder, `${base}-${n}`, prefix);
      n += 1;
    }
    return candidate;
  }
  let n = 1;
  while (live.has(sessionName(folder, String(n), prefix))) n += 1;
  return sessionName(folder, String(n), prefix);
}

/* ------------------------------------------------------------------ claude --- */

const CLAUDE_CANDIDATES = [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  path.join(os.homedir(), '.local/bin/claude'),
  path.join(os.homedir(), '.claude/local/claude'),
  '/usr/bin/claude',
];

/**
 * Where claude lives — a pre-flight check only, never used to launch (see below).
 *
 * The login-shell fallback uses `whence -p`, not `command -v`: this machine wraps claude
 * in a shell function, and `command -v` would answer with the bare word `claude` rather
 * than a path.
 */
export async function resolveClaudePath() {
  for (const p of CLAUDE_CANDIDATES) {
    try {
      await fsp.access(p, fsp.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  try {
    const { stdout } = await run('/bin/zsh', ['-ilc', 'whence -p claude'], { env: TMUX_ENV });
    // ~/.zshrc may print banners, so take the last line that is actually executable.
    for (const line of stdout.split('\n').map((l) => l.trim()).reverse()) {
      if (!line) continue;
      try {
        await fsp.access(line, fsp.constants.X_OK);
        return line;
      } catch {
        /* keep looking */
      }
    }
  } catch {
    /* no shell, no claude */
  }
  return null;
}

/** PIDs of claude-ish processes under a pane, by walking the process table. */
async function claudePids(paneId) {
  let rootPid;
  try {
    const out = await tmux(['display-message', '-p', '-t', paneId, '#{pane_pid}']);
    rootPid = Number(out.trim());
  } catch {
    return [];
  }
  if (!rootPid) return [];

  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { maxBuffer: 8 * 1024 * 1024 });
  const children = new Map();
  const comm = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, command] = m;
    if (!children.has(Number(ppid))) children.set(Number(ppid), []);
    children.get(Number(ppid)).push(Number(pid));
    comm.set(Number(pid), command.toLowerCase());
  }

  // `pane_current_command` is no good for this: while claude runs a Bash tool the pane's
  // foreground command is the tool, which must not read as "claude exited".
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop();
    const c = comm.get(pid);
    if (c && (c.includes('claude') || c === 'node' || c.endsWith('/node'))) found.push(pid);
    queue.push(...(children.get(pid) || []));
  }
  return found;
}

/*
 * Whether a session is running with permission prompts off is read off the pane, not out
 * of the process table — `parseBypass` in `tmux.js`. The mode line Claude Code already
 * draws (`⏵⏵ bypass permissions on`) is free, it is on screen every poll, and it is the
 * live answer rather than the launch argument. An earlier version here walked `ps` for
 * `--dangerously-skip-permissions` and could only ever report how the session started.
 */

/**
 * Block until claude is actually up in the session, or say what the pane printed instead.
 *
 * Without this a failed launch leaves a Terminal window attached to a corpse — the "no
 * sessions" bug in the other launcher. `remain-on-exit` is what keeps the corpse readable long
 * enough to quote; it goes off again the moment we're past startup, so a normal exit
 * later closes the pane rather than leaving one behind.
 */
async function confirmClaudeStarted(name, { timeoutMs = 6000, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs;
  try {
    while (now() < deadline) {
      try {
        await tmux(['has-session', '-t', `=${name}`]);
      } catch {
        throw new Error('claude exited immediately in the new tmux session.');
      }

      const dead = (await tmux(['display-message', '-p', '-t', name, '#{pane_dead}'])).trim();
      if (dead === '1') {
        const tail = (await tmux(['capture-pane', '-p', '-t', name]))
          .split('\n')
          .filter((l) => l.trim())
          .slice(-5)
          .join('\n');
        await tmux(['kill-session', '-t', `=${name}`]).catch(() => {});
        throw new Error(`claude exited immediately in the new tmux session:\n${tail}`);
      }

      const pane = (await tmux(['list-panes', '-t', name, '-F', '#{pane_id}'])).trim().split('\n')[0];
      if (pane && (await claudePids(pane)).length) return pane;
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await tmux(['set-option', '-w', '-t', name, 'remain-on-exit', 'off']).catch(() => {});
  }
  // Never confirmed, never died — a slow boot. Let the caller proceed; nothing types into
  // a pane without re-reading it anyway.
  return null;
}

/* ------------------------------------------------------------------ Finder --- */

/**
 * The macOS folder chooser, opened on the machine the server is running on.
 *
 * The other launcher puts the label field and the skip-permissions checkbox inside this panel as
 * an accessory view. A browser can't reach into a native dialog, so those two live in the
 * panel's own dialog and this is only the folder half — the Finder button is still what
 * commits, which keeps the gesture the same.
 */
export async function chooseFolder(defaultPath) {
  const script = [
    'tell application "System Events" to activate',
    `POSIX path of (choose folder with prompt "Choose a folder to run Claude in"${
      defaultPath ? ` default location POSIX file ${JSON.stringify(defaultPath)}` : ''
    })`,
  ];
  try {
    const { stdout } = await run('/usr/bin/osascript', script.flatMap((s) => ['-e', s]));
    const chosen = stdout.trim();
    return chosen ? { path: chosen.replace(/\/$/, '') } : { cancelled: true };
  } catch (err) {
    // -128 is the user pressing Cancel, which is not an error worth reporting as one.
    if (/-128|User canceled/i.test(err.stderr || err.message || '')) return { cancelled: true };
    throw new Error(`Could not open the folder chooser: ${(err.stderr || err.message).trim()}`);
  }
}

/**
 * Open a folder in Finder, on the Mac the server is running on.
 *
 * Lives here beside `chooseFolder` because this is the other end of the same idea: the
 * panel is a web page, but the machine it talks about is this one, and `open` needs no
 * Automation permission to show a directory.
 */
export async function revealInFinder(dir) {
  const target = String(dir || '').trim();
  if (!target) throw new Error('Which folder?');
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Not a folder any more: ${target}`);
  await run('/usr/bin/open', [target]);
  return target;
}

/* ------------------------------------------------------------------ launch --- */

/**
 * Open a real Terminal window attached to the session.
 *
 * Writing a `.command` file and `open`ing it needs no Automation permission — Terminal
 * just runs a script. The filename is what Terminal puts in its title bar, so it drops
 * the internal session prefix; the prefix stays in the tmux target.
 *
 * Exported because it is no longer only the tail of a launch: a session started headless
 * (`terminal: false`) can be given a window later, from the button in its header. Same
 * call either way, and it is safe to run against a session that is already attached —
 * tmux simply adds a second client.
 *
 * Deliberately sets no size. Attaching resizes the pane to the window Terminal opens, so a
 * narrow window narrows the pane and every parser here starts seeing wrapped text; forcing
 * 220 columns back would instead leave you scrolling a pane wider than the window you
 * opened to read it. The window you get is the window you asked for.
 */
export async function attachTerminal(name) {
  const display = name.startsWith(SESSION_PREFIX) ? name.slice(SESSION_PREFIX.length) : name;
  const file = path.join(os.tmpdir(), `${display}.command`);
  await fsp.writeFile(file, `#!/bin/zsh\nexec ${await tmuxPath()} attach -t ${name}\n`, { mode: 0o755 });
  await run('/usr/bin/open', ['-a', 'Terminal', file]);
}

/** A conservative escape for the one place we build a shell string: the `zsh -ilc` body. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Mint a session. Always a new one — there is no reuse-if-exists, same as the other launcher.
 *
 * `nameComponent` exists for workers: they launch in a *worktree* whose basename is
 * `<repo>-<label>`, but their session must read `<prefix><repo>-<label>` like any other
 * session in that repo — not `<prefix><repo>-<label>-<label>`. Every existing caller keeps
 * the default (the folder's own basename) and nothing changes for them.
 *
 * `extraArgs` are appended to the `claude` invocation (each shell-escaped); the wrapper
 * forwards `"$@"`, so they compose with its `--name` — measured in Wave 0, all four of
 * `--settings` / `--system-prompt` / `--mcp-config` / `--strict-mcp-config`.
 *
 * `resume` is a Claude Code session id, and it makes this the same launch with one more
 * flag — deliberately not a second launcher. Three things about it were measured on a
 * scratch session before it was plumbed here, because all three decide how the panel
 * behaves around a resumed session rather than merely whether the flag works:
 *
 *   It **continues the same transcript file**. 42,438 bytes before, 52,190 after, one
 *   `sessionId` throughout — so a resumed session keeps the identity every binding rule in
 *   `binding.js` is written against. Nothing rotates, nothing re-adopts, the rail row does
 *   not move.
 *
 *   It **composes with the launch flags above**, and the flags win. Resumed with an
 *   `--append-system-prompt-file` whose contents had been rewritten between the two runs,
 *   the session answered out of the *new* brief while still remembering the *old*
 *   conversation. That is what makes a resumed team lead honest: `launchLead` regenerates
 *   the brief, the MCP config and the settings from today's code, and a resume does not
 *   quietly replay yesterday's.
 *
 *   It **replays the history onto the screen**, so the pane a resumed session comes up in
 *   is one whose earlier turns are visible, not merely on disk.
 *
 * @param {{folder: string, label?: string, skipPermissions?: boolean, terminal?: boolean,
 *          nameComponent?: string|null, extraArgs?: string[], resume?: string|null}} opts
 * @returns {Promise<{name: string, paneId: string|null, folder: string}>}
 */
export async function createSession({
  folder,
  label = null,
  skipPermissions = false,
  terminal = true,
  nameComponent = null,
  extraArgs = [],
  resume = null,
}) {
  const dir = String(folder || '').trim();
  if (!dir) throw new Error('Which folder?');
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Not a folder: ${dir}`);

  if (!(await resolveClaudePath())) {
    throw new Error(
      'claude not found. Looked in the usual install paths and asked a login shell ' +
        "(`zsh -ilc 'whence -p claude'`).",
    );
  }

  const component = nameComponent || path.basename(dir);
  const name = uniqueSessionName(component, label, new Set(await liveSessionNames()));

  // Load-bearing, every word of it:
  //   • `-ilc`, not `-lc`: only an *interactive* shell sources ~/.zshrc, and that's where
  //     PATH is built. Without it the pane dies instantly and Terminal attaches to a corpse.
  //   • the bare word `claude`, never an exec of the resolved path: the word lets the
  //     `claude()` wrapper in ~/.zshrc apply, and that wrapper is what passes
  //     `--name "<repo>-<branch>"`. Exec the binary and the session is unnamed everywhere.
  //   • the flag composes with the wrapper's own arguments, since it forwards "$@".
  const flags = [
    ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
    // Before the caller's own flags, so a `--resume` can never be read as the value of a
    // trailing option somebody adds to `extraArgs` later.
    ...(resume ? ['--resume', shq(resume)] : []),
    ...extraArgs.map(shq),
  ];
  const cmd = ['claude', ...flags].join(' ');
  await tmux([
    'new-session', '-d', '-s', name, '-c', dir,
    '-x', '220', '-y', '50',
    '/bin/zsh', '-ilc', cmd,
    ';', 'set-option', '-w', '-t', name, 'remain-on-exit', 'on',
  ]);

  const paneId = await confirmClaudeStarted(name);

  // Smooth wheel scrolling. With mouse off, wheel notches reach the Claude TUI as arrow
  // keys and the view crawls. Session-scoped, never `-g`: hand-driven sessions on the
  // same server are not ours to reconfigure.
  await tmux(['set-option', '-t', name, 'mouse', 'on']).catch(() => {});

  // Drag-select to the system clipboard, now that `mouse on` captures the drag. Key
  // tables are server-global, so the binding is guarded on the session name: only our own
  // sessions pipe through pbcopy, everything else keeps tmux's default.
  //
  // The guard takes the *configured* prefix, which is the whole reason it is built here
  // rather than written as a literal. On a machine whose prefix is set to a second
  // launcher's, this rewrites that launcher's own binding with an identical one and
  // nothing changes; set to anything else, panel sessions get the copy binding and the
  // other tool's keep whatever it bound. Either way the pattern and the sessions it
  // matches are the same string, which is what a literal here could not promise.
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    await tmux([
      'bind-key', '-T', table, 'MouseDragEnd1Pane',
      'if-shell', '-F', `#{m:${SESSION_PREFIX}*,#{session_name}}`,
      'send-keys -X copy-pipe-and-cancel pbcopy',
      'send-keys -X copy-pipe-and-cancel',
    ]).catch(() => {});
  }

  const pane =
    paneId || (await tmux(['list-panes', '-t', name, '-F', '#{pane_id}'])).trim().split('\n')[0] || null;

  if (terminal) await attachTerminal(name);

  return { name, paneId: pane, folder: dir };
}
