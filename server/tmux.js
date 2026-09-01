import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import { SESSION_PREFIX } from './config.js';
import { parsePrompt } from './permission.js';
import { parseQuestion } from './question.js';
import { parsePlanPrompt } from './plan.js';

const run = promisify(execFile);

/** Unit separator — safe inside file paths, unlike '|'. */
const SEP = '\x1f';

const FORMAT = [
  '#{pane_id}',
  '#{session_name}',
  '#{window_index}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{pane_pid}',
  '#{session_created}',
  // Whether a Terminal window is looking at this session right now. Live, not a record of
  // how it was launched — close the window an hour later and this goes back to 0, which is
  // the whole reason the panel reads it here rather than remembering a flag from `+ new`.
  '#{session_attached}',
].join(SEP);

/**
 * Force a UTF-8 locale for every tmux call.
 *
 * Without it, `send-keys -l` mangles non-ASCII — accents, smart quotes, emoji, Hebrew.
 * It works from a normal terminal because the shell already exports a sensible LANG,
 * and breaks the moment the server is started by something that doesn't (launchd, a
 * daemon, a bare cron). The other launcher on this Mac hit exactly this.
 */
export const TMUX_ENV = { ...process.env, LC_ALL: process.env.LC_ALL || 'en_US.UTF-8' };

let tmuxPathPromise;

/**
 * Absolute path to the tmux binary, resolved once and memoised.
 *
 * launchd gives a job `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; tmux lives at
 * `/opt/homebrew/bin/tmux` (Apple Silicon) or `/usr/local/bin/tmux` (Intel), neither of
 * which is on that PATH — VERIFIED, a bare `execFile('tmux', …)` gives `spawn tmux ENOENT`
 * from a real LaunchAgent. Falls back to the bare word so a normal login shell's own PATH
 * still resolves it if none of the well-known locations exist.
 */
export async function tmuxPath() {
  if (!tmuxPathPromise) {
    tmuxPathPromise = (async () => {
      for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
        try {
          await fsp.access(p, fsp.constants.X_OK);
          return p;
        } catch {
          /* next */
        }
      }
      return 'tmux'; // last resort: whatever the login shell's PATH turns up
    })();
  }
  return tmuxPathPromise;
}

async function tmux(args) {
  try {
    const { stdout } = await run(await tmuxPath(), args, { maxBuffer: 4 * 1024 * 1024, env: TMUX_ENV });
    return stdout;
  } catch (err) {
    // No server running is the normal "nothing open" case, not a failure.
    if (/no server running|no current client|error connecting/i.test(err.stderr || '')) return '';
    throw err;
  }
}

/**
 * Every pane on the tmux server, whether or not it is running Claude.
 * @returns {Promise<Array<{paneId,tmuxSession,windowIndex,cwd,command,pid,attached}>>}
 */
export async function listPanes() {
  const stdout = await tmux(['list-panes', '-a', '-F', FORMAT]);
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [paneId, tmuxSession, windowIndex, cwd, command, pid, created, attached] =
        line.split(SEP);
      return {
        paneId,
        tmuxSession,
        windowIndex,
        cwd,
        command,
        pid: Number(pid),
        // Epoch seconds. A transcript last written before this cannot belong to
        // this pane — that's what stops a new session adopting old history.
        createdMs: Number(created) * 1000,
        attached: Number(attached) > 0,
        // The configured session prefix sliced off, or null. `sessions.js` does the same
        // read against the bound pane; both go through `SESSION_PREFIX` so there is one
        // answer to "what is this session's label" rather than two spellings of it.
        label: tmuxSession?.startsWith(SESSION_PREFIX)
          ? tmuxSession.slice(SESSION_PREFIX.length)
          : null,
      };
    });
}

/** Panes whose foreground process looks like the Claude Code CLI. */
export async function listClaudePanes() {
  const panes = await listPanes();
  return panes.filter((p) => /(^|\/)claude(\.exe)?$/i.test(p.command || ''));
}

/** Scrape the visible pane contents — the status fallback for unbound sessions. */
export async function capturePane(paneId, lines = 40) {
  const stdout = await tmux(['capture-pane', '-p', '-t', paneId, '-S', `-${lines}`]);
  return stdout;
}

/*
 * Reading state off the TUI.
 *
 * Sessions that started before the hook was registered never call it — Claude Code
 * reads its hook config once at launch. For those, the rendered pane is the only
 * signal available, so we read the same cues a person would.
 */

/** `✳ Ideating… (7m 41s · ↓ 39.9k tokens)` or `⎿  Running…` — a live timer means busy. */
const WORKING_RE = /⎿\s+Running…|\S+…\s*\(/;

/** The permission box, which stops everything until answered. */
const DECISION_RE = /Do you want to|^\s*❯?\s*1\.\s+Yes\b|\(esc to (?:reject|cancel)\)/im;

/*
 * Modal dialogs — `/model`, `/effort`, `/config`, `/resume`, the startup trust box.
 *
 * These are the other thing that swallows keystrokes. Nothing is running and no
 * permission box is open, so v1 read the session as plain `idle` and would happily type
 * a message into the picker, where the characters select options instead of being read.
 *
 * The test is the *absence of the composer*, and nothing else.
 *
 * The first version also required a line of key hints (`Esc to cancel`) before believing
 * a dialog was open. That was too clever: the "Review your answers" screen a multi-select
 * question ends on carries no hint line at all, so it read as plain `idle` — and its two
 * options are "1. Submit answers" and "2. Cancel", which is about the worst place a
 * stray keystroke could land.
 *
 * If Claude Code is willing to accept typing, it draws the box to type into. No box means
 * no typing, whatever else is or isn't on screen. Erring toward "can't reach it" costs a
 * held message; erring the other way answers a question on your behalf.
 *
 * Verified against v2.1.232; `test/fixtures/dialog-*.txt` are real captures.
 */

/**
 * The composer's own footer — `<project> (main) | Opus 5 | ctx: 4%` and the mode line
 * below it. Present whenever Claude Code is showing its input box, *including* while it
 * is working, and gone the moment a dialog takes over.
 *
 * `❯` is no help here: the dialogs mark their selected row with the same glyph.
 */
function hasComposer(recent) {
  return recent
    .slice(-6)
    .some((line) => /[⏵⏸]/.test(line) || (line.includes('|') && MODEL_RE.test(line)));
}

/** `─────` above the dialog's heading. Solid rule only — the box-drawing kind is inner. */
const TOP_RULE_RE = /^\s*─{6,}\s*$/;

/**
 * Lines that can't be a dialog's name: transcript rows, and the numbered option rows —
 * which matters because a question box puts a rule *between* its options and its last
 * one ("6. Chat about this"), so the naive "line under the last rule" is an option.
 */
const NOT_A_TITLE_RE = /^\s*(?:[⏺✻✳✽❯⎿⚠·]|\d{1,2}\.\s)/;

/** A name, not a paragraph — this lands in a rail row and a one-line composer hint. */
const clip = (s) => (s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s);

/**
 * What to call the dialog that's in the way.
 *
 * A question wins over a heading — `AskUserQuestion` renders its question above the
 * options, and "Which fruits do you like?" tells you far more than "Fruits" does.
 * Otherwise it's the heading under the box's rule: "Select model", "Resume session".
 */
function dialogTitle(nonEmpty) {
  // The box's top rule, and the heading directly under it. Walking up past a rule whose
  // heading is an option row is what handles a question box, which fences its last
  // option ("6. Chat about this") off with a rule of its own.
  let ruleAt = -1;
  for (let i = nonEmpty.length - 1; i >= 0 && nonEmpty.length - i < 40; i -= 1) {
    if (!TOP_RULE_RE.test(nonEmpty[i])) continue;
    if (nonEmpty[i + 1] && !NOT_A_TITLE_RE.test(nonEmpty[i + 1])) {
      ruleAt = i;
      break;
    }
  }

  // Bounded to inside the box, so a question sitting in the transcript above it can't be
  // mistaken for the one being asked.
  for (let i = nonEmpty.length - 1; i > ruleAt; i -= 1) {
    const line = nonEmpty[i].trim();
    if (!line.endsWith('?') || NOT_A_TITLE_RE.test(nonEmpty[i])) continue;

    // The `?` is the *end* of the question, and a question worth asking wraps — so walk
    // back up its own lines. Without this, "…so that related work stays visually
    // clustered together?" named the dialog `together?`, and the composer's hint read
    // "together? is open in the terminal".
    const parts = [line];
    for (let j = i - 1; j > ruleAt && i - j < 6; j -= 1) {
      const above = nonEmpty[j];
      if (NOT_A_TITLE_RE.test(above) || TOP_RULE_RE.test(above) || /[☐☒✔←→]/.test(above)) break;
      parts.unshift(above.trim());
    }
    return clip(parts.join(' '));
  }

  return ruleAt >= 0 ? clip(nonEmpty[ruleAt + 1].trim()) : null;
}

/*
 * Footer: `  Alpha (main) | Opus 5 (1M context) | ctx: 14%`
 * ...but the real line is padded to terminal width and can carry a right-aligned
 * hint ("new task? /clear to save 146.1k tokens"), so pull the fields out by name
 * rather than anchoring to the end of the line.
 */
const MODEL_RE = /\b((?:Opus|Sonnet|Haiku|Fable)\s+[\d.]+(?:\s*\([^)]*\))?)/;
const CTX_RE = /\bctx:\s*(\d+)%/;

/**
 * Effort sits at the right-hand end of the same footer, behind a glyph that changes with
 * the level — `○ low`, `◐ medium`, `● high`, `◉ xhigh`, `◈ max`, `✦ ultracode`. Match the
 * word rather than the glyph, since the glyph set is decoration and liable to change.
 */
const EFFORT_RE = /[○◐●◉◈✦]\s*(low|medium|high|xhigh|max|ultracode)\b/i;

/**
 * `✳ Ideating… (7m 41s · ↓ 39.9k tokens)` -> "Ideating", 461 (seconds)
 *
 * The `(…)` cluster is wrapped as one optional group, not just the digits inside it: the
 * very first spinner frame of a turn — the same ~1.8s gap `WORKING_RE` already documents —
 * draws a bare `✢ Burrowing…` with no parenthesised tail at all, and a version of this
 * pattern that required the `(` failed the whole match there, leaving `activity` null on a
 * session the hook correctly reports as working. Verified against a real scratch session.
 *
 * The leading glyph is deliberately not `⎿` — that shape also matches a tool call's own
 * `⎿  Running…` placeholder line, which is the previous tool's output, not the model's
 * current activity word.
 */
const ACTIVITY_RE =
  /^\s*[^\s⎿]\s+(\w[\w -]*?)…\s*(?:\((?:(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s)?)?/;

/**
 * Permission mode, from the footer line the TUI already prints.
 *
 * shift+tab cycles them in this order — observed, not assumed:
 *   auto -> manual -> accept edits -> plan -> auto
 *
 * The order is what makes a dropdown possible at all: the terminal only offers a cycle,
 * so selecting a mode means stepping until it matches. `changeMode` verifies after each
 * step rather than counting presses blind.
 */
export const MODES = [
  { id: 'auto', label: 'auto', match: /auto mode on/i },
  { id: 'manual', label: 'manual', match: /manual mode on/i },
  { id: 'acceptEdits', label: 'accept edits', match: /accept edits on/i },
  { id: 'plan', label: 'plan', match: /plan mode on/i },
];

function parseMode(recent) {
  for (const line of recent.slice(-5)) {
    if (!/[⏵⏸]/.test(line)) continue;
    const hit = MODES.find((m) => m.match.test(line));
    if (hit) return hit.id;
  }
  return null;
}

/**
 * Whether this session is running with permission prompts turned off.
 *
 * Read off the same mode line as `parseMode`, in Claude Code's own words — a session
 * started with `--dangerously-skip-permissions` draws `⏵⏵ bypass permissions on` where
 * every other session draws `auto mode on`. Deliberately *not* an entry in `MODES`:
 * that list is the shift+tab cycle `changeMode` steps through, and putting bypass in it
 * would offer the panel a way to switch a session into it.
 *
 * `null` means the mode line wasn't on screen at all — a permission box or a dialog owns
 * the footer — which is not the same as "off", and the caller keeps its last answer.
 *
 * @returns {boolean|null}
 */
function parseBypass(recent) {
  for (const line of recent.slice(-5)) {
    if (!/[⏵⏸]/.test(line)) continue;
    if (/bypass(ing)? permissions/i.test(line)) return true;
    if (MODES.some((m) => m.match.test(line))) return false;
  }
  return null;
}

export function parsePane(text) {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  const recent = nonEmpty.slice(-14);
  const blob = recent.join('\n');

  // The composer is the arbiter of all of it. If Claude Code is drawing somewhere to
  // type, then nothing above it is a box waiting on an answer — whatever it looks like.
  //
  // This is not hypothetical: a session editing *this* repo scrolls `Esc to cancel`,
  // `Do you want to proceed?` and a numbered run of options through its pane every time
  // it shows a diff of the permission fixtures, and the panel read its own test data as
  // a live prompt. The session was working the whole time.
  const composer = hasComposer(recent);

  // A parsed permission box is the strongest possible signal, and it carries the
  // options we need in order to answer safely.
  const prompt = composer ? null : parsePrompt(text);

  // A dialog is the same test without the parse: something owns the keystrokes, and we
  // can only name it. Tried before the working check, because where the keys would land
  // matters more than what the session is doing.
  const dialog = !prompt && !composer ? (dialogTitle(nonEmpty) ?? 'dialog') : null;

  // Dialogs the panel can actually do something about. Everything else it can only name
  // and wait out. Two of them now: the plan approval that ends plan mode, and the question
  // box. Plan first because it is the more specific shape — a numbered run under one of
  // three known headers — while `parseQuestion` matches on structure alone.
  const plan = dialog ? parsePlanPrompt(text) : null;
  const question = dialog && !plan ? parseQuestion(text) : null;

  let state = 'idle';
  // `DECISION_RE` is a loose shape-match, so it is held to the composer test too —
  // "Do you want to" is a sentence people write, not only one Claude Code renders.
  if (prompt || (!composer && DECISION_RE.test(blob))) state = 'needs-decision';
  else if (dialog) state = 'dialog';
  else if (WORKING_RE.test(blob)) state = 'working';

  // The footer sits near the bottom, below it mode and monitor lines. Take the
  // last pipe-delimited line naming a model — that shape is unique to the footer.
  let model = null;
  let contextPct = null;
  let effort = null;
  for (const line of recent.slice(-6)) {
    if (!line.includes('|')) continue;
    const m = MODEL_RE.exec(line);
    if (!m) continue;
    model = m[1].trim();
    const ctx = CTX_RE.exec(line);
    contextPct = ctx ? Number(ctx[1]) : null;
    const eff = EFFORT_RE.exec(line);
    effort = eff ? eff[1].toLowerCase() : null;
  }

  let activity = null;
  let activitySeconds = null;
  for (const line of recent) {
    const m = ACTIVITY_RE.exec(line);
    if (m) {
      activity = m[1].trim();
      activitySeconds =
        m[4] != null ? Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4]) : null;
    }
  }

  return {
    state,
    model,
    contextPct,
    effort,
    activity,
    activitySeconds,
    prompt,
    dialog,
    plan,
    question,
    mode: parseMode(recent),
    bypass: parseBypass(recent),
  };
}

export async function readPaneState(paneId) {
  try {
    return parsePane(await capturePane(paneId, 24));
  } catch {
    return {
      state: 'unknown',
      model: null,
      contextPct: null,
      effort: null,
      activity: null,
      activitySeconds: null,
      prompt: null,
      dialog: null,
      plan: null,
      question: null,
      mode: null,
      bypass: null,
    };
  }
}

/**
 * Refuse to type into a pane that is no longer running Claude.
 *
 * The roster is up to a poll interval stale, so a session that exited in the meantime
 * would leave a plain shell sitting at the same pane id — and the next message, followed
 * by Enter, would be *executed* rather than read. The other launcher on this Mac
 * guards the same way; it is worth the extra tmux call every time.
 */
async function assertClaudePane(paneId) {
  const panes = await listPanes();
  const pane = panes.find((p) => p.paneId === paneId);
  if (!pane) throw new Error('That pane no longer exists.');
  if (!/(^|\/)claude(\.exe)?$/i.test(pane.command || '')) {
    throw new Error(
      `Refusing to send: pane ${paneId} is running "${pane.command}", not Claude. ` +
        'The session may have exited.',
    );
  }
}

/**
 * Something is on screen that would eat the keystrokes. Carries a reason so the caller
 * can tell "hold this for later" apart from "this pane is gone".
 */
export class PaneBlockedError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'PaneBlockedError';
    this.reason = reason; // 'needs-decision' | 'dialog'
  }
}

/**
 * Refuse to type into a pane whose keystrokes would go somewhere other than the prompt.
 *
 * Two ways that happens, and both are silent failures rather than errors: a permission
 * box turns digits into answers, and a `/model` or `/effort` dialog turns them into
 * selections. Either way the message is never read and something else happens instead.
 *
 * This is about *where* the text would land. Whether the session is merely busy is the
 * caller's call — that decides queueing, and is answered from the roster, which has the
 * hook's word for it and is better informed than the pane.
 */
async function assertNotBlocked(paneId) {
  const live = await readPaneState(paneId);
  if (live.prompt || live.state === 'needs-decision') {
    throw new PaneBlockedError(
      'This session is waiting on a permission prompt — answer that first.',
      'needs-decision',
    );
  }
  if (live.state === 'dialog') {
    throw new PaneBlockedError(
      `A ${live.dialog === 'dialog' ? 'dialog' : `“${live.dialog}”`} dialog is open in the terminal — ` +
        'the message would be typed into it. Close it and this will go through.',
      'dialog',
    );
  }
}

/**
 * Deliver text to a pane, then submit.
 *
 * Two paths, because neither alone is right:
 *
 *   Single line -> `send-keys -l`, literally typed. This is what makes slash commands
 *   work: Claude Code executes a complete command line even with its autocomplete popup
 *   open. Bracketed-pasted content can instead be folded into a "[Pasted text]" chip,
 *   which would quietly turn `/clear` into a message about clearing.
 *
 *   Multiple lines -> bracketed paste. Here `-l` is wrong: every newline arrives as its
 *   own Enter and a three-line message becomes three submissions.
 */
export async function sendText(paneId, text, { submit = true } = {}) {
  if (!text) return;
  await assertClaudePane(paneId);
  await assertNotBlocked(paneId);

  // Start from an empty prompt — anything half-typed in the pane would otherwise be
  // prefixed onto this message.
  await tmux(['send-keys', '-t', paneId, 'C-u']);

  if (text.includes('\n')) {
    await tmux(['set-buffer', '--', text]);
    await tmux(['paste-buffer', '-d', '-p', '-t', paneId]);
  } else {
    await tmux(['send-keys', '-t', paneId, '-l', '--', text]);
  }

  if (submit) {
    // Give the TUI a beat to finish absorbing the input before Enter lands.
    await new Promise((r) => setTimeout(r, 60));
    await tmux(['send-keys', '-t', paneId, 'Enter']);
  }
}

/** Named keys — Escape to interrupt, arrows/Enter to answer a permission prompt. */
export async function sendKeys(paneId, ...keys) {
  await tmux(['send-keys', '-t', paneId, ...keys]);
}

/**
 * Type into a box that is deliberately holding the pane — the plan approval's own
 * feedback row, reached by pressing its digit first.
 *
 * `sendText` is the wrong tool there and would refuse anyway: it asserts the pane is *not*
 * blocked, which is the whole state we are in, and it leads with `C-u` to clear a composer
 * that isn't the thing receiving these characters. Still checks the pane is running Claude,
 * because that guard is about not typing into a shell that would execute the text.
 */
export async function sendLiteral(paneId, text) {
  if (!text) return;
  await assertClaudePane(paneId);
  if (text.includes('\n')) {
    await tmux(['set-buffer', '--', text]);
    await tmux(['paste-buffer', '-d', '-p', '-t', paneId]);
  } else {
    await tmux(['send-keys', '-t', paneId, '-l', '--', text]);
  }
}

export async function isAvailable() {
  try {
    await run(await tmuxPath(), ['-V']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Step the pane's permission mode until it reaches `target`.
 *
 * The TUI gives no way to jump straight to a mode, so this presses shift+tab and re-reads
 * the footer each time. Verifying beats counting: if the cycle ever changes, or a press
 * is swallowed, this stops rather than landing somewhere unintended.
 */
export async function changeMode(paneId, target, { maxSteps = MODES.length + 2 } = {}) {
  if (!MODES.some((m) => m.id === target)) throw new Error(`Unknown mode: ${target}`);

  for (let step = 0; step <= maxSteps; step += 1) {
    const state = await readPaneState(paneId);
    if (state.prompt) {
      throw new Error('This session is waiting on a permission prompt — answer that first.');
    }
    // On the plan-approval box shift+tab does not cycle anything — it *approves the plan*,
    // passing whatever is in the feedback row along with it. This currently also trips the
    // `mode === null` guard below, but only by luck: a parser change that made the mode
    // readable there would quietly turn the mode picker into a plan approver.
    if (state.plan) {
      throw new Error(
        'This session is waiting on a plan approval — shift+tab means "approve" there. Answer it first.',
      );
    }
    // shift+tab means something else again inside a picker, and the footer we verify
    // against isn't even on screen.
    if (state.state === 'dialog') {
      throw new Error('A dialog is open in the terminal — close it before switching mode.');
    }
    if (state.mode === target) return { mode: target, steps: step };
    if (state.mode === null) throw new Error('Could not read the mode from this session.');
    await sendKeys(paneId, 'BTab');
    await new Promise((r) => setTimeout(r, 350));
  }
  const final = await readPaneState(paneId);
  throw new Error(`Mode did not settle on "${target}" — it is "${final.mode ?? 'unknown'}".`);
}
