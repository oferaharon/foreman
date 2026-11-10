import { STOP_AND_EXIT, isExitBox, parseExitBox, stopAndExitOption } from './exit-box.js';
import { heldBy } from './snapshot.js';

/*
 * Ending a session and knowing it ended.
 *
 * `/exit` is typed the way a person would type it, and for most of this panel's life every
 * caller then *assumed* it worked. It does not always: with background work running, Claude
 * Code answers `/exit` with a box (`server/exit-box.js`) and stays up. A task close that
 * slept 700 ms and swept anyway left a live session sitting in a deleted worktree with no
 * task to show it under — an orphan, announced as "merged and cleaned up".
 *
 * So the one thing every caller that ends a session needs is the wait: the **name** leaving
 * tmux, bounded. `waitNamesGone` is that wait, shared by the relaunch loop and the close; the
 * close adds the one answer it is entitled to give (`exitAndWait`).
 *
 * Everything that touches tmux is injected, so the sequence is tested against the committed
 * captures and a fake clock rather than a real session (`test/exit-session.test.js`).
 */

/**
 * How long to wait for a session to actually go after `/exit`.
 *
 * The name is the thing being waited on, not the process: `uniqueSessionName` reads the
 * live list, so relaunching while the old `<prefix>alpha-main` is still in it mints
 * `<prefix>alpha-main-2` — a session that no longer answers to the name anybody saved,
 * pinned or filed. Measured at about three seconds for one session on this Mac; the
 * ceiling is generous because the failure it guards against is silent and permanent, while
 * waiting a few seconds longer costs nothing.
 */
export const EXIT_GONE_TIMEOUT_MS = 20000;

/** Why a session that was sent `/exit` was not started again, or not swept: its name never freed. */
export const STILL_UP = 'did not close in time — still running';

const POLL_MS = 300;

/** How long the cursor is given to redraw after an arrow key, before the box is re-read. */
const SETTLE_MS = 250;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for these tmux session names to leave tmux, up to `timeoutMs`.
 *
 * A name list that cannot be read is not "gone" — it is a poll that told us nothing, and the
 * wait goes on; if the very last read failed, every name still counts as up. `onPoll` runs
 * once per poll while anything is still up, and may answer `'stop'` to end the wait early.
 *
 * @param {Iterable<string>} names
 * @param {{liveSessionNames: () => Promise<string[]>, timeoutMs?: number, pollMs?: number,
 *          sleep?: (ms: number) => Promise<void>, now?: () => number,
 *          onPoll?: () => Promise<'stop'|void>}} deps
 * @returns {Promise<string[]>} the names still up when the wait ended — empty when all went
 */
export async function waitNamesGone(names, deps) {
  const {
    liveSessionNames,
    timeoutMs = EXIT_GONE_TIMEOUT_MS,
    pollMs = POLL_MS,
    sleep = realSleep,
    now = Date.now,
    onPoll = async () => {},
  } = deps;
  const wanted = new Set([...names].filter(Boolean));
  if (!wanted.size) return [];
  const deadline = now() + timeoutMs;
  for (;;) {
    const live = await liveSessionNames().catch(() => null);
    const stillUp = live ? [...wanted].filter((n) => live.includes(n)) : [...wanted];
    if (!stillUp.length || now() > deadline) return stillUp;
    if ((await onPoll()) === 'stop') return stillUp;
    await sleep(pollMs);
  }
}

/**
 * Walk the box's cursor onto `Exit and stop tasks` and press Enter — the only answer the
 * panel ever gives this box, and only from `exitAndWait`.
 *
 * The `confirmGateOption` walk, for the same measured reasons: a digit on this box commits
 * (so none is sent), and the list wraps (so presses are never counted). Each step re-reads
 * the box, finds the row **by its label**, and sends `Enter` only when the pane's own `❯` is
 * on it; until then it sends arrow keys, which commit nothing here.
 *
 * @returns {Promise<{ok: true, stopped: string[]} | {ok: false, vanished: true} | {ok: false, why: string}>}
 */
async function answerStopAndExit(paneId, d) {
  for (let step = 0; step <= 6; step += 1) {
    const text = await d.capturePane(paneId).catch(() => null);
    const box = text ? parseExitBox(text) : null;
    if (!box) {
      if (text && isExitBox(text)) return { ok: false, why: 'the background-work box is drawn in a shape the panel cannot read' };
      return { ok: false, vanished: true };
    }
    const target = stopAndExitOption(box);
    if (!target) return { ok: false, why: `the background-work box offers no “${STOP_AND_EXIT}” row` };
    if (target.selected) {
      await d.sendKeys(paneId, 'Enter');
      return { ok: true, stopped: box.stopping };
    }
    await d.sendKeys(paneId, box.cursor && target.index < box.cursor ? 'Up' : 'Down');
    await d.sleep(SETTLE_MS);
  }
  return { ok: false, why: `the cursor never reached “${STOP_AND_EXIT}”` };
}

/**
 * `/exit` a session and wait for its name to leave tmux — answering the background-work box
 * with `Exit and stop tasks` if `/exit` raises it, and nothing else.
 *
 * For the task close only. The close is already the order to end this session and delete its
 * folder; of the box's three rows, `Move to background and exit` leaves work running detached
 * in a folder about to be deleted, and `Stay` is the orphan. That choice is the lead's,
 * recorded in the team's decisions, and the maintainer may reverse it.
 *
 * What it will not do:
 *   - answer a box it did not raise. The caller refuses a pane that is holding anything
 *     *before* this runs, and `sendText` refuses again, so any box seen here came up after
 *     the `/exit` went in.
 *   - answer any other box. A frame from the middle of an exit can read as a box
 *     (`docs/traps/launch.md`, hibernation), so anything that is not positively this one is
 *     waited past, and the name decides.
 *   - leave its own box up. If the box cannot be answered by label, it is Escaped — measured
 *     to put the session back on its composer with its tasks running — and the close refuses.
 *
 * @param {{paneId: string, name: string}} target
 * @param {{sendText: (paneId: string, text: string) => Promise<void>,
 *          sendKeys: (paneId: string, ...keys: string[]) => Promise<void>,
 *          capturePane: (paneId: string) => Promise<string>,
 *          readPaneState: (paneId: string) => Promise<object>,
 *          liveSessionNames: () => Promise<string[]>,
 *          sleep?: (ms: number) => Promise<void>, now?: () => number}} deps
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{gone: true, stopped: string[]} | {gone: false, stopped: string[], why: string}>}
 *          `stopped` is the box's own list of what Enter ended — empty when there was no box.
 *          Throws only when `/exit` itself was refused, before anything was typed, with the
 *          session still up.
 */
export async function exitAndWait({ paneId, name }, deps, { timeoutMs = EXIT_GONE_TIMEOUT_MS } = {}) {
  const d = { sleep: realSleep, now: Date.now, ...deps };
  try {
    await d.sendText(paneId, '/exit');
  } catch (err) {
    // `sendText` also refuses a pane that has just gone — the roster is a poll behind — and
    // a session that ended on its own between the two reads is the outcome being asked for.
    const live = await d.liveSessionNames().catch(() => null);
    if (live && !live.includes(name)) return { gone: true, stopped: [] };
    throw err;
  }

  let stopped = [];
  let answered = false;
  let refused = null;
  const stillUp = await waitNamesGone([name], {
    liveSessionNames: d.liveSessionNames,
    timeoutMs,
    sleep: d.sleep,
    now: d.now,
    onPoll: async () => {
      if (answered) return;
      const text = await d.capturePane(paneId).catch(() => null);
      if (!text || !isExitBox(text)) return;
      const result = await answerStopAndExit(paneId, d);
      if (result.ok) {
        answered = true;
        stopped = result.stopped;
        return;
      }
      if (result.vanished) return; // gone between two reads: the name decides, next poll
      refused = `/exit raised “Background work is running” and ${result.why}; pressed Escape, so it is still running`;
      await d.sendKeys(paneId, 'Escape').catch(() => {});
      return 'stop';
    },
  });
  if (!stillUp.length) return { gone: true, stopped };
  if (refused) return { gone: false, stopped, why: refused };

  // Out of time. Never leave this box up behind a refusal: it was raised by this `/exit`.
  const text = await d.capturePane(paneId).catch(() => null);
  if (text && isExitBox(text)) await d.sendKeys(paneId, 'Escape').catch(() => {});
  const held = heldBy(await d.readPaneState(paneId).catch(() => null));
  const after = stopped.length ? `; it was told to stop ${stopped.join('; ')}` : '';
  return { gone: false, stopped, why: `${STILL_UP}${held ? ` — ${held}` : ''}${after}` };
}
