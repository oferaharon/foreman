/*
 * Preferences that belong to a *browser* rather than to the panel.
 *
 * There is exactly one so far, and it is here rather than in either client because both
 * clients need it: the desktop's settings modal is where it is set, and the phone's lead
 * screen is where it most gets used. Two spellings of one key is the `isLeadName` lesson
 * in another costume — a desktop writing `foreman.ghostSend` and a phone reading
 * `foreman.ghost-send` would be a setting that appears to work and silently does nothing.
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
 */

/** The one key. Named once, exported so a test can name the same one. */
export const GHOST_SEND_KEY = 'foreman.ghostSend';

function read() {
  try {
    return localStorage.getItem(GHOST_SEND_KEY) === '1';
  } catch {
    /* private mode, or site data blocked — off is a perfectly good answer */
    return false;
  }
}

let on = read();

/**
 * Whether "use" on a ghost-text suggestion sends it, or only writes it into the box.
 *
 * Off by default and deliberately so: with it on, one press on a muted line sends a
 * message the model wrote into a live session. That is a real thing to hand a control, and
 * it is worth having to ask for.
 */
export const ghostSend = {
  get on() {
    return on;
  },
  /** Set it and remember it. Returns what it now is, which is what it is whether or not
   *  the write survived — a window whose storage is blocked still behaves for this visit. */
  set(next) {
    on = Boolean(next);
    try {
      localStorage.setItem(GHOST_SEND_KEY, on ? '1' : '0');
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
