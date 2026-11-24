import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  bypassConfirmProblem,
  configDirOfTranscript,
  defaultConfigDirFor,
  launchConfigDir,
  projectsDirOf,
  rowConfigDir,
  sameConfigDir,
  shortPath,
} from './account.js';
import { STILL_UP } from './exit-session.js';
import { SESSION_ID_RE, UNKNOWN_ACCOUNT_WHY, isLeadEntry, relaunchOne } from './snapshot.js';

/*
 * **Moving a session to another Claude account** — the multi-account plan's item 8.
 *
 * MEASURED on v2.1.331 (the plan's M10): a conversation `cp`'d from one account's
 * `projects/<folder>/` into the same folder name under the other account's `projects/`, then
 * started there with `CLAUDE_CONFIG_DIR=<other> claude --resume <id>`, replays its history
 * and remembers it — one `sessionId` throughout, the copy growing and the original
 * byte-identical. So a move is a restart-one whose resume lands on the other account, with a
 * copy in the middle:
 *
 *   1. read the pinned group by name (the pane holding the pin is about to go),
 *   2. `/exit` through `exitAndWait`, which answers the background-work box by label,
 *   3. wait for the **name** to leave tmux — the transcript is final only then,
 *   4. copy `<id>.jsonl` and any `<id>/` sibling (subagents, tool results) into
 *      `projectsDirOf(target)/<same folder name>/`,
 *   5. verify every copied file is byte-equal to its source,
 *   6. `startEntries` with the target's `configDir` and `resume: <id>`,
 *   7. re-pin (inside `startEntries`), and
 *   8. say so in a system line.
 *
 * Three rules the steps are built around:
 *
 *   **The original is never touched** (the maintainer's answer to the plan's Q2). Nothing
 *   here opens a source file for writing, renames one or deletes one. The scan already prefers
 *   the newer of one id seen under two roots, and the copy is written fresh — not
 *   `fs.copyFile`, which on macOS goes through `copyfile(3)` and carries the source's mtime
 *   over — so the new copy is the newer one from the first poll.
 *
 *   **Never overwrite.** A target that already holds `<id>.jsonl` or `<id>/` is refused
 *   before anything ends, and every file is created with `wx` so a target that appeared since
 *   is a failure rather than a clobber. Note what that means for a round trip: a moved
 *   session's original is still on the account it left, so moving it *back* is refused by
 *   this rule, by construction.
 *
 *   **A failure after the `/exit` stops and says where.** The session is down by then, but
 *   its original is untouched, so `--resume` on the old account still brings it back — the
 *   message says so. A partial copy is reported, never deleted silently.
 *
 * Everything that touches tmux, the panes or the room is injected (`moveSession`'s `deps`),
 * so the sequence is tested against a temp tree (`test/move-session.test.js`).
 */

/** The account's name in words: its nickname, else its folder (`default`, `.claude-c4l`). Never an email. */
export function accountLabel(account, dir, home = os.homedir()) {
  if (account?.nickname) return account.nickname;
  if (account?.folder) return account.folder;
  if (!dir || sameConfigDir(dir, defaultConfigDirFor(home))) return 'default';
  return path.basename(dir);
}

/**
 * Where this row could move: every signed-in account choice (`launchAccountChoices`, keyed by
 * index into the known dirs) other than the one it runs on. Empty for a row whose account
 * cannot be said — there is no "other" to name.
 *
 * @param {object} session the live roster row
 * @param {Array<{key: number, nickname: string|null, folder: string}>} choices
 * @param {string[]} dirs `KnownConfigDirs#list()` — `choices[i].key` indexes it
 */
export function moveTargets(session, choices, dirs, home = os.homedir()) {
  const source = rowConfigDir(session, home);
  if (source === undefined) return [];
  const sourceDir = source ?? defaultConfigDirFor(home);
  const out = [];
  for (const c of choices || []) {
    const dir = dirs?.[c.key];
    if (!dir || sameConfigDir(dir, sourceDir)) continue;
    out.push({ key: c.key, label: c.nickname || c.folder, dir });
  }
  return out;
}

/** Where a conversation's files are, and where they would go on `targetDir`. */
export function conversationFiles(transcriptPath, id, targetDir) {
  const folder = path.basename(path.dirname(transcriptPath));
  const fromDir = path.dirname(transcriptPath);
  const toDir = path.join(projectsDirOf(targetDir), folder);
  return {
    folder,
    file: { from: transcriptPath, to: path.join(toDir, `${id}.jsonl`) },
    sibling: { from: path.join(fromDir, id), to: path.join(toDir, id) },
    toDir,
  };
}

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Restart-one's refusals, reworded for a move (`relaunchOne`'s `why`). */
const MOVE_REFUSALS = {
  worker: () => 'A worker runs on its lead’s account and can’t be moved on its own.',
  folder: () => 'There is no folder to start it again in.',
  account: (p) => `Not moved: ${p.reason}.`,
  name: () =>
    'It wasn’t started under a name the panel can give back, so a move would bring it back as a ' +
    'different session. Close it and start a new one on the other account instead.',
  holding: (p) => p.error.replace('Not restarted', 'Not moved'),
};

/**
 * Whether this row may move to `targetDir`, and the entry and files if so — every refusal
 * made **before anything ends**, each with its reason in words.
 *
 * The entry is restart-one's (`relaunchOne` in `resume` mode), which already refuses a
 * worker, a name the panel could not give back and a pane holding something — the same
 * three a move needs, from the one place that decides them. Its account check is about the
 * account the row is *on*, so only its "which account can't be said" half is kept; the bypass
 * check is asked again here, of the account it is going *to*.
 *
 * @param {object|null} session the live roster row
 * @param {{targetDir: string, targetLabel?: string, live?: object|null, asleep?: boolean,
 *          home?: string}} opts `live` is the pane as just read (omitted, the pane is not
 *          judged — the box asks before it has anything to judge)
 * @returns {{entry: object, files: object, source: string|null, target: string|null,
 *            sourceLabel: string, targetLabel: string} | {status: number, why: string, error: string}}
 */
export function planMove(session, { targetDir, targetLabel, live = null, asleep = false, home = os.homedir() } = {}) {
  const refuse = (status, why, error) => ({ status, why, error });

  if (asleep) {
    return refuse(409, 'asleep', 'It is asleep. Wake it first, then move it.');
  }
  if (!session?.paneId) return refuse(404, 'unknown', 'Unknown or read-only session.');
  const role = session.team?.role ?? null;
  if (role !== null && role !== 'lead') {
    return refuse(409, 'worker', 'A worker runs on its lead’s account and can’t be moved on its own.');
  }

  // Asked with bypass off: a bypass check here would be about the account it is leaving,
  // and the one that matters is the account it is going to (below).
  const plan = relaunchOne({ ...session, bypass: false }, { mode: 'resume', live });
  if (plan.error) return refuse(plan.status, plan.why, MOVE_REFUSALS[plan.why]?.(plan) ?? plan.error);
  const entry = { ...plan.entry, skipPermissions: Boolean(session.bypass) };

  const id = String(session.id || '');
  const transcriptPath = session.transcriptPath;
  if (!transcriptPath || !SESSION_ID_RE.test(id)) {
    return refuse(409, 'no-transcript', 'It has no saved conversation yet, so there is nothing to move. Start a new session on the other account instead.');
  }
  if (path.basename(transcriptPath) !== `${id}.jsonl` || !configDirOfTranscript(transcriptPath)) {
    return refuse(409, 'no-transcript', 'Its conversation file isn’t where Claude Code files one, so the panel can’t tell what to copy.');
  }

  const source = rowConfigDir(session, home);
  if (source === undefined) return refuse(409, 'account', `Not moved: ${UNKNOWN_ACCOUNT_WHY}.`);
  const sourceDir = source ?? defaultConfigDirFor(home);
  if (!targetDir || !path.isAbsolute(targetDir)) return refuse(400, 'target', 'Which account? Reopen the box and pick again.');
  const target = launchConfigDir(targetDir, home);
  const sourceLabel = accountLabel(session.account, sourceDir, home);
  const toLabel = targetLabel || accountLabel(null, targetDir, home);
  if (sameConfigDir(targetDir, sourceDir)) {
    return refuse(409, 'same', `It already runs on ${sourceLabel}.`);
  }
  // The conversation must be filed under the account it runs on: a row whose transcript lives
  // under a third root is not one this can reason about.
  if (!sameConfigDir(configDirOfTranscript(transcriptPath), sourceDir)) {
    return refuse(409, 'account', 'Its conversation is filed under a different account from the one it runs on, so the panel won’t guess which copy to move.');
  }

  const files = conversationFiles(transcriptPath, id, targetDir);
  if (exists(files.file.to) || exists(files.sibling.to)) {
    return refuse(
      409,
      'exists',
      `${toLabel} already has a copy of this conversation (${shortPath(exists(files.file.to) ? files.file.to : files.sibling.to, home)}), ` +
        'and a move never overwrites one. That happens when it was moved from there before — the copy there is the older one.',
    );
  }

  if (entry.skipPermissions) {
    const stop = bypassConfirmProblem(target);
    if (stop) return refuse(409, 'bypass', `Not moved: ${stop}.`);
  }

  return {
    entry: { ...entry, configDir: target, resume: id, transcriptPath: files.file.to, skip: undefined },
    files,
    source,
    target,
    sourceLabel,
    targetLabel: toLabel,
    lead: isLeadEntry(entry),
  };
}

/* ------------------------------------------------------------------ the copy --- */

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Every file under `dir`, relative, depth first; anything not a file or a folder throws. */
async function walk(dir, rel = '') {
  const out = { dirs: [], files: [] };
  for (const d of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, d.name);
    if (d.isDirectory()) {
      out.dirs.push(r);
      const inner = await walk(dir, r);
      out.dirs.push(...inner.dirs);
      out.files.push(...inner.files);
    } else if (d.isFile()) {
      out.files.push(r);
    } else {
      throw new Error(`${path.join(dir, r)} is neither a file nor a folder, so it can’t be copied safely`);
    }
  }
  return out;
}

/** A copy that stopped part-way: what was written, so it can be reported rather than deleted. */
export class CopyError extends Error {
  constructor(message, written) {
    super(message);
    this.written = written;
  }
}

/**
 * Copy the conversation into the target account, then prove it: every file created with `wx`
 * (a target that appeared since the check is a failure, never a clobber), written fresh so its
 * mtime is now, then each one hashed against its source.
 *
 * @returns {Promise<{files: number, bytes: number, written: string[]}>}
 * @throws {CopyError} with `written`, the paths it created before it stopped
 */
export async function copyConversation(files) {
  const written = [];
  const pairs = [[files.file.from, files.file.to]];
  try {
    await fsp.mkdir(files.toDir, { recursive: true });
    if (exists(files.sibling.from)) {
      const st = await fsp.lstat(files.sibling.from);
      if (!st.isDirectory()) throw new Error(`${files.sibling.from} is not a folder`);
      const tree = await walk(files.sibling.from);
      await fsp.mkdir(files.sibling.to); // throws if it appeared since the check
      written.push(files.sibling.to);
      for (const d of tree.dirs) {
        await fsp.mkdir(path.join(files.sibling.to, d));
      }
      for (const f of tree.files) pairs.push([path.join(files.sibling.from, f), path.join(files.sibling.to, f)]);
    }
    for (const [from, to] of pairs) {
      const out = fs.createWriteStream(to, { flags: 'wx' });
      // Recorded once the open succeeded — a `wx` that failed created nothing to report.
      await new Promise((resolve, reject) => {
        out.once('open', resolve);
        out.once('error', reject);
      });
      written.push(to);
      await pipeline(fs.createReadStream(from), out);
    }
  } catch (err) {
    throw new CopyError(err.message, written);
  }

  const bytes = await verifyCopy(pairs).catch((err) => {
    throw new CopyError(err.message, written);
  });
  return { files: pairs.length, bytes, written };
}

/**
 * Every `[original, copy]` pair hashed and compared; the copy's total size, or a throw naming
 * the first file that differs. Exported so the refusal is tested on a pair that really differs.
 */
export async function verifyCopy(pairs) {
  let bytes = 0;
  for (const [from, to] of pairs) {
    let a;
    let b;
    try {
      [a, b] = await Promise.all([sha256(from), sha256(to)]);
    } catch (err) {
      throw new Error(`the copy could not be read back to check (${err.message})`);
    }
    if (a !== b) throw new Error(`the copy of ${path.basename(to)} is not byte-for-byte the same as the original`);
    bytes += (await fsp.stat(to)).size;
  }
  return bytes;
}

/* ------------------------------------------------------------------ the move --- */

/**
 * Move one session to another account. The caller has made the refusals (`planMove`, with the
 * pane just read) and holds whatever flag keeps relaunches, restores and wakes out of the way;
 * this runs the steps in the header's order and stops at the first that fails.
 *
 * @param {ReturnType<typeof planMove>} plan a plan without `error`
 * @param {{paneId: string}} session
 * @param {{pinnedNames: () => Promise<Array<string|null>>,
 *          exit: (target: {paneId: string, name: string}) => Promise<{gone: boolean, why?: string}>,
 *          startEntries: (entries: object[], opts: object) => Promise<object[]>,
 *          reserved: () => Set<string>,
 *          post?: (line: {text: string, lead: boolean, folder: string}) => void,
 *          copy?: typeof copyConversation,
 *          home?: string}} deps
 * @param {{terminal?: boolean}} [opts]
 * @returns {Promise<{ok: true, name: string, paneId: string|null, lead: boolean, from: string, to: string}
 *   | {ok: false, status: number, stage: string, error: string, written?: string[]}>}
 */
export async function moveSession(plan, session, deps, { terminal = false } = {}) {
  const home = deps.home ?? os.homedir();
  const name = plan.entry.tmuxSession;
  const from = plan.sourceLabel;
  const to = plan.targetLabel;
  const back = `Its conversation is untouched on ${from} — \`claude --resume ${plan.entry.resume}\` there${
    plan.source ? ` (with CLAUDE_CONFIG_DIR=${shortPath(plan.source, home)})` : ''
  } brings it back as it was.`;

  // 1. The pinned group by name, before the pane holding the pin goes.
  const pinOrder = await deps.pinnedNames();

  // 2 + 3. `/exit`, and the name gone from tmux — the file is final only then.
  let exit;
  try {
    exit = await deps.exit({ paneId: session.paneId, name });
  } catch (err) {
    return { ok: false, status: 409, stage: 'exit', error: `Not moved: /exit was refused (${err.message}). ${name} was left as it is.` };
  }
  if (!exit.gone) {
    const why = exit.why === STILL_UP || !exit.why ? 'had not closed in time' : exit.why;
    return {
      ok: false,
      status: 409,
      stage: 'exit',
      error: `Not moved: ${name} was sent /exit but ${why}. Nothing was copied — check its terminal.`,
    };
  }

  // 4 + 5. Copy, then prove the copy.
  let copied;
  try {
    copied = await (deps.copy ?? copyConversation)(plan.files);
  } catch (err) {
    const written = err.written || [];
    const partial = written.length
      ? ` A partial copy was left on ${to} and not deleted: ${written.map((p) => shortPath(p, home)).join(', ')} — remove it before trying again.`
      : ' Nothing was written on the other account.';
    return {
      ok: false,
      status: 500,
      stage: 'copy',
      error: `${name} closed, but copying its conversation to ${to} failed: ${err.message}.${partial} ${back}`,
      written,
    };
  }

  // 6 + 7. Start it on the target, resuming the copy, and put the pin back.
  let result;
  try {
    [result] = await deps.startEntries([plan.entry], { terminal, pinOrder, reserved: deps.reserved() });
  } catch (err) {
    result = { state: 'failed', error: err.message };
  }
  if (result?.state !== 'started') {
    const why = result?.error || result?.reason || (result?.state === 'skipped' ? 'its name was taken' : 'it did not start');
    return {
      ok: false,
      status: 500,
      stage: 'start',
      error:
        `${name} closed and its conversation was copied to ${to} (checked byte for byte), ` +
        `but it did not start there: ${why}. ${back}`,
      written: copied.written,
    };
  }

  // 8. Say so.
  const text =
    `${plan.lead ? 'The lead' : name} was moved from ${from} to ${to} — same conversation, resumed there. ` +
    `The copy on ${from} was left as it was.`;
  try {
    deps.post?.({ text, lead: plan.lead, folder: plan.entry.folder });
  } catch {
    /* a line not posted is not a move undone */
  }

  return { ok: true, name: result.name ?? name, paneId: result.paneId ?? null, lead: plan.lead, from, to, files: copied.files };
}
