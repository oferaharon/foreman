import fsp from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './config.js';
import { capturePane, sendKeys } from './tmux.js';

/**
 * The pieces of dispatching a worker that aren't worktree or task bookkeeping: the
 * per-session settings file, and the trust gate.
 */

export const WORKER_SETTINGS_DIR = path.join(STATE_DIR, 'worker-settings');

/**
 * The models a worker may be launched with, and nothing else. The value becomes a
 * `--model` launch flag, so this list is the wall between "the lead picks a model" and
 * "the lead picks launch flags" — an id not on it fails the dispatch before a worktree
 * exists. A `[1m]` suffix (the 1M-context variant) is accepted on any of them.
 *
 * Haiku is on the list because it is a real model id, but it cannot run auto mode
 * (measured, Wave 0) — a Haiku worker prompts on everything. The tool description
 * carries that warning; the panel does not second-guess an explicit choice.
 */
export const WORKER_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
];

/** Used when neither the lead nor team.json names one. The maintainer's ruling (2026-08-26). */
export const DEFAULT_WORKER_MODEL = 'claude-opus-5';

const validModel = (id) => {
  const base = String(id).endsWith('[1m]') ? String(id).slice(0, -4) : String(id);
  return WORKER_MODELS.includes(base);
};

/**
 * The one answer to "what model does this worker launch with".
 *
 * Explicit beats the team default beats Opus. Both the request and the stored default
 * are validated — a team.json hand-edited into an unknown id must fail loudly here, not
 * launch whatever the CLI makes of the string — and the default is checked even when an
 * explicit choice would mask it, so a corrupted file surfaces on the next dispatch
 * rather than on the one unlucky enough to omit `model`.
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
 * workers must not be three phone buzzes. `allow` is the repo's own build/test commands;
 * the deny floor rides along always.
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
      allow: [...allow],
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
 * folder, so dispatch eats it once per task. This is the one place the panel answers a
 * security gate, and the guard is the point: the capture must contain the gate's own
 * text, the *worktree's* name (so a gate for some other folder is never confirmed), and
 * the cursor must be sitting on the Yes row — then a single Enter confirms it, the same
 * key a human presses. Seeding `hasTrustDialogAccepted` into `~/.claude.json` was
 * rejected: every live session rewrites that file, and racing them risks all of it.
 *
 * @returns {Promise<'answered'|'absent'|'unrecognised'>}
 */
export async function answerTrustGate(paneId, worktreeDir, { tries = 10, delayMs = 1000, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = path.basename(worktreeDir);
  for (let i = 0; i < tries; i += 1) {
    const text = await capturePane(paneId, 60).catch(() => '');
    const flat = text.replace(/\s+/g, ' ');
    const isGate = /Yes, I trust this folder/.test(flat) && /Do you trust|safety check/i.test(flat);
    if (isGate) {
      if (!flat.includes(base)) return 'unrecognised'; // a gate, but not ours — never answer it
      if (!/❯\s*1\./.test(flat)) return 'unrecognised'; // cursor not on Yes — don't guess
      await sendKeys(paneId, 'Enter');
      return 'answered';
    }
    // No gate. If the composer is up, the folder was already trusted and there is
    // nothing to answer; keep polling briefly otherwise — the gate takes a few seconds.
    if (/bypass permissions|mode on|\bctx:\s*\d+%/.test(flat)) return 'absent';
    await wait(delayMs);
  }
  return 'absent';
}
