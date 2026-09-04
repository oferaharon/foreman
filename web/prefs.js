/*
 * Preferences that belong to a *browser* rather than to the panel.
 *
 * They are here rather than in either client because both clients may need them: the
 * desktop's settings modal is where `ghostSend` is set, and the phone's lead screen is
 * where it most gets used. Two spellings of one key is the `isLeadName` lesson in another
 * costume — a desktop writing `foreman.ghostSend` and a phone reading `foreman.ghost-send`
 * would be a setting that appears to work and silently does nothing.
 *
 * `/` and `/m/` are the same origin, so a browser that opens both shares this. That is the
 * right reading of "per browser": your phone and the Mac's browser are different browsers
 * and answer separately, while two tabs of the same browser are one answer.
 *
 * Every read and write is wrapped, and not out of habit. `localStorage` is a *getter* that
 * **throws** where a browser blocks site data — it does not answer `null` — and the
 * desktop already has one paragraph about the module-scope read that took the whole page
 * down before a single row was drawn. Off is the correct answer with nothing stored and
 * the correct answer when storage is denied, which is what makes the guard cheap here.
 *
 * One thing in here is not a preference: `CLOSED_TASK_STATES`. It sits beside
 * `hideFinished` because it *is* that key's meaning — the flag says "hide finished" and
 * this set is the only definition of what finished covers. Two spellings of the set would
 * be the same failure as two spellings of the key, one level down, so they travel together.
 */

/**
 * One stored on/off flag, read once at import and remembered for the visit.
 *
 * A factory rather than two hand-written objects: the guard below is the interesting part
 * and it must be identical for every flag, since the thing it guards against — a
 * `localStorage` getter that throws — takes the page down at module scope wherever it is
 * missed.
 */
function flag(key) {
  const read = () => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      /* private mode, or site data blocked — off is a perfectly good answer */
      return false;
    }
  };
  let on = read();
  return {
    get on() {
      return on;
    },
    /** Set it and remember it. Returns what it now is, which is what it is whether or not
     *  the write survived — a window whose storage is blocked still behaves for this visit. */
    set(next) {
      on = Boolean(next);
      try {
        localStorage.setItem(key, on ? '1' : '0');
      } catch {
        /* storage blocked — this window still behaves, the answer just won't survive a reload */
      }
      return on;
    },
    /** Re-read from storage. For a test, and for a page that wants the current answer after
     *  another tab has changed it. */
    reload() {
      on = read();
      return on;
    },
  };
}

/** The keys. Named once, exported so a test can name the same ones. */
export const GHOST_SEND_KEY = 'foreman.ghostSend';
export const HIDE_FINISHED_KEY = 'foreman.hideFinished';

/**
 * Whether "use" on a ghost-text suggestion sends it, or only writes it into the box.
 *
 * Off by default and deliberately so: with it on, one press on a muted line sends a
 * message the model wrote into a live session. That is a real thing to hand a control, and
 * it is worth having to ask for.
 */
export const ghostSend = flag(GHOST_SEND_KEY);

/**
 * Whether the lead aside's TASKS block hides the tasks nobody is waiting on.
 *
 * Off by default, because a list that starts out shorter than the team's real history is
 * a list that has to explain itself before you have asked it anything. On, it is a *view*
 * filter and nothing else: no task changes state, nothing is deleted, and the server is
 * never told. That is also why it lives in a browser rather than in `team.json` — the
 * autonomy dials in there change what the panel *does*, and this changes only what you are
 * looking at.
 */
export const hideFinished = flag(HIDE_FINISHED_KEY);

/**
 * What `hideFinished` hides: exactly the three closed states of `TASK_STATES`
 * (`server/tasks.js`) — the ones nobody is waiting on.
 *
 * **`review` is not in here and must never be.** In plain English a task in `review` is
 * finished — the worker has stopped and the PR is open — but it is finished only in the
 * sense that it is now waiting on a human, and it is the single row that most needs to be
 * seen. It is an open state and it stays. If a future label for this control could be read
 * as covering `review`, the label is wrong, not this set.
 *
 * **And no state named `finished` exists.** "finished" is the *button's* word, needed
 * because one control hides three states and "done" would be lying about two of them. The
 * chips go on reading `done`, `failed` and `abandoned`.
 */
export const CLOSED_TASK_STATES = new Set(['done', 'failed', 'abandoned']);

/**
 * Is this the state of a row the filter hides?
 *
 * Takes the state a row **displays** — `taskChipState`'s answer, not the stored record's
 * `state` — and that is the whole rule: a row is hidden exactly when the word on its own
 * chip is one of the three. Two consequences, both deliberate and both in the direction of
 * *showing*:
 *
 * - `stuck` and `blocked` are derived from the live pane and are not in `TASK_STATES` at
 *   all. Neither is in this set, so a row whose chip reads `stuck` survives the filter even
 *   if its record says `done` — which is right twice over: something is holding a pane
 *   *now*, and hiding a row that visibly does not say "done" under a control that says
 *   "hide finished" would be the control lying about itself.
 * - A state this set has never heard of — the next one added to `TASK_STATES` — is
 *   **shown**. A new state landing silently on the hidden side of a filter is the failure
 *   nobody would notice; landing on the visible side is the one that gets reported.
 */
export function isFinishedState(chipState) {
  return CLOSED_TASK_STATES.has(chipState);
}
