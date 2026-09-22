import fsp from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './config.js';
import { trustOption } from '../web/trust-gate.js';
import { WORKER_MODELS, DEFAULT_WORKER_MODEL } from './worker-models.js';
import { capturePane, confirmGateOption, gatePrompt } from './tmux.js';

/**
 * The pieces of dispatching a worker that aren't worktree or task bookkeeping: the
 * per-session settings file, and the trust gate.
 */

export const WORKER_SETTINGS_DIR = path.join(STATE_DIR, 'worker-settings');

/*
 * The model list and the default live one file down, in `worker-models.js`, and are
 * re-exported here so every existing importer of `dispatch.js` is unchanged. They moved
 * because `mcp/foreman.js` needs the same list for its `task_dispatch` description and
 * cannot import this file — that would drag `tmux.js` and the pane parsers into a stdio
 * MCP child. One spelling, imported at both ends; see `docs/traps/one-spelling.md`.
 */
export {
  WORKER_MODELS,
  DEFAULT_WORKER_MODEL,
  WORKER_MODEL_NAMES,
  modelLabel,
  workerModelNames,
} from './worker-models.js';

const validModel = (id) => {
  const base = String(id).endsWith('[1m]') ? String(id).slice(0, -4) : String(id);
  return WORKER_MODELS.includes(base);
};

/**
 * The one answer to "what model does this worker launch with".
 *
 * Explicit beats the team default beats `DEFAULT_WORKER_MODEL`. Both the request and the
 * stored default are validated — a team.json hand-edited into an unknown id must fail
 * loudly here, not launch whatever the CLI makes of the string — and the default is
 * checked even when an explicit choice would mask it, so a corrupted file surfaces on the
 * next dispatch rather than on the one unlucky enough to omit `model`.
 *
 * @param {string|null|undefined} requested  the lead's choice, if any
 * @param {string|null|undefined} teamDefault  team.json's `defaultModel`
 * @returns {{model: string, defaultModel: string, isDefault: boolean}}
 *          isDefault: the worker gets what the default would have given it anyway —
 *          the room only hears about departures.
 */
export function resolveWorkerModel(requested, teamDefault) {
  const fallback = String(teamDefault ?? '').trim() || DEFAULT_WORKER_MODEL;
  if (!validModel(fallback)) {
    throw new Error(
      `team.json's defaultModel "${fallback}" is not a model this panel knows — fix it in the team panel.`,
    );
  }
  const asked = String(requested ?? '').trim();
  if (asked && !validModel(asked)) {
    throw new Error(
      `Unknown model "${asked}" — this panel launches workers only on: ${WORKER_MODELS.join(', ')} (optionally with a [1m] suffix).`,
    );
  }
  const model = asked || fallback;
  return { model, defaultModel: fallback, isDefault: model === fallback };
}

/**
 * Destructive git, denied for every worker regardless of anything else in its file.
 *
 * A worktree isolates *files*, not history — it shares the parent's `.git`, so any of
 * these reaches the real repository from inside one. A floor, not a ceiling: per-repo
 * config can add to it, nothing may subtract. Per-session `permissions.deny` in a
 * `--settings` file is measured to fire (Wave A.0 — the same command shape the classifier
 * allowed was refused by the entry).
 */
export const GIT_DENY = [
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
  'Bash(git push --delete:*)',
  'Bash(git push origin --delete:*)',
  'Bash(git gc:*)',
  'Bash(git reflog expire:*)',
  'Bash(git worktree remove:*)',
  'Bash(git branch -D:*)',
];

/**
 * Write the settings file a worker launches with (`--settings <file>`).
 *
 * Push notifications off — the lead is the single notifying entity, three blocked
 * workers must not be three phone buzzes. `allow` is the repo's own build/test commands
 * plus `mcp__foreman`, unconditionally — a build worker's whole tool surface there is
 * `room_post` and `task_report` (`WORKER_TOOLS`), and a planner's is identical, so there is
 * nothing to gate the rule behind and no reason it should ever be missing from either. The
 * deny floor rides along always.
 *
 * The bare server form (never a per-tool list) is the same choice `leadSettings` makes and
 * for the same two reasons: it is confirmed to match every tool a `foreman` role exposes
 * (`### MCP`, the installed Claude Code's own permissions docs, v2.1.257 — "`mcp__puppeteer`
 * matches any tool provided by the `puppeteer` server"), and it needs no update if
 * `WORKER_TOOLS` ever grows. It is an allow rule and nothing more: `assertNotBlocked`,
 * `PaneLock`, and every other guard behind these tools are untouched by it.
 *
 * `deny` is the per-kind stance on top of that floor — for a planner, the rules that
 * make "cannot write code" a wall rather than a request (`plannerStance` in team.js
 * builds them; this only guarantees the floor underneath, which is why the two live
 * apart). A build worker passes none and gets exactly what it always got.
 *
 * @returns {Promise<string>} the file path, for `extraArgs`
 */
export async function writeWorkerSettings({ repo, label, allow = [], deny = [] }) {
  await fsp.mkdir(WORKER_SETTINGS_DIR, { recursive: true });
  const file = path.join(WORKER_SETTINGS_DIR, `${path.basename(repo)}-${label}.json`);
  const settings = {
    agentPushNotifEnabled: false,
    permissions: {
      // Skips the auto-mode classifier for every `foreman` tool call — see the doc
      // comment. First, so the file reads as "the panel's own tools, then this kind's own".
      allow: ['mcp__foreman', ...allow],
      // The floor first, so reading the file top-down reads as "never these, plus
      // whatever this kind of worker also may not do".
      deny: [...GIT_DENY, ...deny],
    },
  };
  await fsp.writeFile(file, JSON.stringify(settings, null, 2));
  return file;
}

/**
 * Answer the startup trust gate — for a worktree this dispatch just created, and for
 * nothing else.
 *
 * The gate fires once per fresh folder (measured, Wave 0), and every worktree is a fresh
 * folder, so dispatch eats it once per task. Since the 2026-09-19 ruling this is no longer
 * the *only* place the panel answers a security gate — the cards and `/answer` do too —
 * but it is still the only place it answers one **unattended**, which is why the guard is
 * stricter here than anywhere else: the capture must read as the gate through `gatePrompt`,
 * it must carry the *worktree's* own name (so a gate for some other folder is never
 * confirmed), and the row that grants must name itself. Seeding `hasTrustDialogAccepted`
 * into `~/.claude.json` was rejected: every live session rewrites that file, and racing
 * them risks all of it.
 *
 * **It used to require `❯ 1.` and so it stopped working entirely.** Claude Code v2.1.257
 * draws this box with unnumbered options and the cursor on **No**, so the old test could
 * never pass and every dispatched worker sat on an unanswered gate. The answer is now the
 * cursor walk — press, re-read, confirm the `❯` is on the trust row, then `Enter` — which
 * `confirmGateOption` owns and which reads both layouts. See `web/trust-gate.js`.
 *
 * @returns {Promise<'answered'|'absent'|'unrecognised'>}
 */
export async function answerTrustGate(paneId, worktreeDir, { tries = 10, delayMs = 1000, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = path.basename(worktreeDir);
  for (let i = 0; i < tries; i += 1) {
    const text = await capturePane(paneId, 60).catch(() => '');
    const flat = text.replace(/\s+/g, ' ');
    const prompt = gatePrompt(text);
    if (prompt) {
      if (!flat.includes(base)) return 'unrecognised'; // a gate, but not ours — never answer it
      const yes = trustOption(prompt);
      if (!yes) return 'unrecognised'; // no row says it grants — don't guess which does
      try {
        await confirmGateOption(paneId, yes.label, { sleep });
      } catch {
        return 'unrecognised'; // the cursor would not land on it; nothing was confirmed
      }
      return 'answered';
    }
    // No gate. If the composer is up, the folder was already trusted and there is
    // nothing to answer; keep polling briefly otherwise — the gate takes a few seconds.
    if (/bypass permissions|mode on|\bctx:\s*\d+%/.test(flat)) return 'absent';
    await wait(delayMs);
  }
  return 'absent';
}
