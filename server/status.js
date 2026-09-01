import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PANES_DIR, STATUS_STALE_MS } from './config.js';

/**
 * Turns Claude Code hook traffic into two things the panel needs and cannot get
 * anywhere else: which transcript a pane is writing, and what that session is
 * doing right now.
 */

const WORKING = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop']);
const IDLE = new Set(['Stop', 'SessionStart', 'TaskCompleted', 'TeammateIdle']);
const DECISION = new Set(['PermissionRequest']);

export class StatusEngine extends EventEmitter {
  constructor() {
    super();
    this.bindings = new Map(); // paneId -> { sessionId, cwd, transcriptPath, ts }
    this.states = new Map(); // sessionId -> { state, ts }
    this.#restore();
  }

  #restore() {
    try {
      fs.mkdirSync(PANES_DIR, { recursive: true });
      for (const name of fs.readdirSync(PANES_DIR)) {
        if (!name.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(PANES_DIR, name), 'utf8'));
          if (rec?.paneId && rec?.sessionId) this.bindings.set(rec.paneId, rec);
        } catch {
          /* ignore a corrupt receipt */
        }
      }
    } catch {
      /* state dir is best-effort */
    }
  }

  #persist(rec) {
    try {
      // '%3' is not filename-safe on every volume; strip the sigil.
      const safe = rec.paneId.replace(/[^\w.-]/g, '_');
      fs.writeFileSync(path.join(PANES_DIR, `${safe}.json`), JSON.stringify(rec, null, 2));
    } catch {
      /* best-effort */
    }
  }

  paneBinding(paneId) {
    return this.bindings.get(paneId)?.sessionId || null;
  }

  paneFor(sessionId) {
    for (const [paneId, rec] of this.bindings) if (rec.sessionId === sessionId) return paneId;
    return null;
  }

  stateOf(sessionId) {
    const rec = this.states.get(sessionId);
    if (!rec) return 'unknown';
    if (rec.state !== 'needs-decision' && Date.now() - rec.ts > STATUS_STALE_MS) return 'idle';
    return rec.state;
  }

  /**
   * Forget what the hook last said about a session, because the panel just stopped it.
   *
   * An interrupt fires **no hook**. `Escape` is not a natural stop, so `Stop` never runs
   * and the last receipt — `working`, from whatever `PreToolUse` fired before it — goes
   * on standing for the full `STATUS_STALE_MS`. Ten minutes of a roster insisting a
   * session is busy while the pane sits at a composer, which is the panel's own
   * definition of "will accept typing". The send button reads `queue`, `claim()` refuses,
   * and the terminal is the faster route — which is exactly how it was found.
   *
   * The precedence in `sessions.js` is not the bug and is not touched here: the hook
   * still wins over the scrape for anything that is not a prompt, plan or dialog. What
   * is wrong is the *receipt*, and this is the one place that can possibly know it —
   * nothing else will ever be told the interrupt happened.
   *
   * Dropped rather than asserted `idle`. `stateOf` answers `unknown` for a session it
   * has no record of, and `unknown` is the one word the hook precedence hands straight
   * back to the pane scrape. That is the honest claim: the panel knows it pressed
   * Escape, and it does not know what the session does next — the Escape may have landed
   * on a box, or the run may not have stopped at all. Writing `idle` would be asserting
   * an outcome we did not observe; dropping the record asks the screen instead.
   *
   * The join is the part that can silently do nothing. `states` is keyed by the Claude
   * Code `session_id` off the hook payload, and the caller holds a pane id and the
   * registry's session id. Those are normally the same string — the registry keys on the
   * transcript's own id and the two namespaces agree — but they come apart for a beat
   * after a `/clear`, when the pane's binding still names the session that just rotated
   * away. So both are cleared: whatever id the pane is currently answering to, the
   * receipt for it is the one now known to be stale.
   *
   * @param {string} paneId       the tmux pane the Escape was sent to
   * @param {string|null} sessionId  the registry's id for that pane, if it has one
   * @returns {string[]} the session ids whose receipt was actually dropped
   */
  interrupted(paneId, sessionId = null) {
    const ids = new Set();
    const bound = paneId ? this.paneBinding(paneId) : null;
    if (bound) ids.add(bound);
    if (sessionId) ids.add(sessionId);

    const cleared = [];
    for (const id of ids) {
      if (!this.states.delete(id)) continue;
      cleared.push(id);
      // Listened to in `index.js` as a refresh trigger, so the roster re-reads the pane
      // now rather than at the next poll.
      this.emit('changed', id, 'unknown');
    }
    return cleared;
  }

  /**
   * @param {string} event      hook_event_name
   * @param {object} payload    the hook's JSON body
   * @param {string|null} paneId  from the X-Tmux-Pane header
   */
  ingest(event, payload, paneId) {
    const sessionId = payload?.session_id || payload?.sessionId || null;
    if (!sessionId) return;

    if (paneId) {
      const prev = this.bindings.get(paneId);
      if (!prev || prev.sessionId !== sessionId) {
        const rec = {
          paneId,
          sessionId,
          cwd: payload.cwd || null,
          transcriptPath: payload.transcript_path || null,
          ts: Date.now(),
        };
        this.bindings.set(paneId, rec);
        this.#persist(rec);
        this.emit('binding', rec);
      }
    }

    let state = null;
    if (event === 'SessionEnd') {
      this.states.delete(sessionId);
      if (paneId) this.bindings.delete(paneId);
      this.emit('changed', sessionId, 'inactive');
      return;
    }

    if (DECISION.has(event)) state = 'needs-decision';
    else if (event === 'Notification') {
      // Only the permission flavour blocks; the rest are chatter.
      const kind = payload.notification_type || payload.matcher || payload.message || '';
      state = /permission/i.test(String(kind)) ? 'needs-decision' : null;
    } else if (WORKING.has(event)) state = 'working';
    else if (IDLE.has(event)) state = 'idle';

    if (!state) return;
    const prev = this.states.get(sessionId);
    this.states.set(sessionId, { state, ts: Date.now() });
    if (!prev || prev.state !== state) this.emit('changed', sessionId, state);
  }
}
