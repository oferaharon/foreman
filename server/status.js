import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PANES_DIR, STATUS_STALE_MS } from './config.js';
import { tmuxSocketPath } from './tmux.js';

/**
 * Turns Claude Code hook traffic into two things the panel needs and cannot get
 * anywhere else: which transcript a pane is writing, and what that session is
 * doing right now.
 */

/**
 * The socket path out of whatever a hook sent.
 *
 * Inside tmux, `$TMUX` is `<socket path>,<server pid>,<session id>` — the installer hands
 * us the first field already split (`${TMUX%%,*}`), but a sender that forwards the whole
 * variable is read the same way rather than being refused for a spelling. Empty is `null`:
 * a session that is not inside tmux at all expands the header to nothing, which is the
 * same "we were told nothing" as an older hook that never sent one.
 */
export function tmuxSocketField(raw) {
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0].trim();
  return first || null;
}

/**
 * Resolve a socket path for comparison.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, and `$TMUX` and `#{socket_path}` do not
 * always agree about which spelling they hand back — so two names for one server must not
 * read as two servers. The *directory* is what carries the symlink, and resolving it rather
 * than the socket file means this still works for a socket whose server has since gone
 * away (a dead scratch server's receipt arriving a moment late). A path that cannot be
 * resolved at all falls back to its normalised self, which can only ever make it compare
 * unequal — the safe direction, since the caller's default is to accept.
 */
function resolveSocket(p) {
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return path.normalize(p);
  }
}

/**
 * Is this receipt from a tmux server the panel is not polling?
 *
 * **Fail open on absence, closed on mismatch, and the asymmetry is deliberate rather than
 * an oversight.** A receipt carrying no socket is accepted exactly as it was before this
 * existed: every session already running was launched under the old hook, and Claude Code
 * only picks the new one up when it next re-reads its config — refusing those would trade
 * an intermittent wrong-transcript bug for a total loss of binding, which is strictly
 * worse. A socket that is present *and* different is the fix: that pane id was minted by
 * another server and means nothing here.
 *
 * The panel not knowing its *own* socket is the same "cannot judge" and answers the same
 * way. That window is the boot beat before any tmux server exists.
 */
export function foreignTmuxServer(receiptSocket, panelSocket) {
  const theirs = tmuxSocketField(receiptSocket);
  const ours = tmuxSocketField(panelSocket);
  if (!theirs || !ours) return false;
  return resolveSocket(theirs) !== resolveSocket(ours);
}

const WORKING = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop']);
const IDLE = new Set(['Stop', 'SessionStart', 'TaskCompleted', 'TeammateIdle']);
const DECISION = new Set(['PermissionRequest']);

export class StatusEngine extends EventEmitter {
  /** The panel's own tmux socket, once known, plus the sockets already complained about. */
  #panelSocket = null;
  #askingSocket = false;
  #refused = new Set();

  /**
   * @param {object} [opts]
   * @param {() => (string|null|Promise<string|null>)} [opts.socketSource]
   *   Where the panel's own tmux socket comes from. Injectable for one reason: the accept
   *   and refuse rules have to be provable without a live tmux server, and a test that
   *   started one would be a test that touched the machine every session on it shares.
   */
  constructor({ socketSource = tmuxSocketPath } = {}) {
    super();
    this.bindings = new Map(); // paneId -> { sessionId, cwd, transcriptPath, ts }
    this.states = new Map(); // sessionId -> { state, ts }
    this.socketSource = socketSource;
    this.#restore();
    // Ask now so the first hook has an answer to compare against. Fire-and-forget: see
    // `#panelSocketNow`, which fails open until it lands.
    this.#panelSocketNow();
  }

  /**
   * Resolve the panel's own tmux socket and remember it. The one place that happens, so a
   * caller that can wait — the boot, a test — gets a determinate answer, while `ingest`,
   * which cannot, reads the cache.
   */
  async primeSocket() {
    const v = await this.socketSource();
    if (v) this.#panelSocket = v;
    return this.#panelSocket;
  }

  /**
   * The panel's own socket, synchronously, or `null` while we do not yet know it.
   *
   * `ingest` is called from a route that has already answered 204 and must not grow an
   * `await` — a hook that waits on us adds latency to every tool call. So the resolution
   * is kicked off and its answer used from a later receipt; `tmuxSocketPath` memoises a
   * real answer and retries a miss, so this settles on its own once a tmux server exists.
   * Until it does, not knowing means accepting, which is the same rule `foreignTmuxServer`
   * applies to a receipt that carries no socket.
   */
  #panelSocketNow() {
    if (this.#panelSocket) return this.#panelSocket;
    if (!this.#askingSocket) {
      this.#askingSocket = true;
      this.primeSocket()
        .catch(() => {})
        .finally(() => {
          this.#askingSocket = false;
        });
    }
    return this.#panelSocket;
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
   * @param {string|null} socket  from the X-Tmux-Socket header — the tmux socket the
   *   sending session lives on, which is the only thing that makes its pane id mean
   *   anything. See `foreignTmuxServer` for why an absent one is still accepted.
   */
  ingest(event, payload, paneId, socket = null) {
    const sessionId = payload?.session_id || payload?.sessionId || null;
    if (!sessionId) return;

    /*
     * A receipt from another tmux server is refused whole — no binding, no state, no
     * receipt on disk. Its pane id was minted by a server this panel does not poll, where
     * numbering starts at `%0` again, so `%0` names one of *our* panes and binding it
     * hands that pane somebody else's transcript. It flip-flops with whichever server
     * last fired a hook for that number, which is what made it read as an intermittent
     * binding bug rather than a hook that should never have been accepted.
     *
     * Said once per foreign socket, because the alternative is a line per tool call of
     * every session on that server, and a silent refusal is the one shape this panel has
     * already been bitten by — the hook that posted JSON without saying so was dropped in
     * exactly this spot, in silence, for months.
     */
    if (foreignTmuxServer(socket, this.#panelSocketNow())) {
      const from = tmuxSocketField(socket);
      if (from && !this.#refused.has(from) && this.#refused.size < 16) {
        this.#refused.add(from);
        console.warn(
          `[status] ignoring hook receipts from another tmux server (${from}); ` +
            `this panel polls ${tmuxSocketField(this.#panelSocketNow())}`,
        );
      }
      return;
    }

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
