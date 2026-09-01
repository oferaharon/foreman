/**
 * Deciding which transcript belongs to which tmux pane.
 *
 * This is the part of the panel most able to lie to you: bind wrongly and you read one
 * session's conversation while typing into another's terminal. It has three rules, in
 * descending confidence, and it would rather return nothing than guess.
 *
 *   hook      a SessionStart/PreToolUse hook told us outright. Authoritative.
 *   label     the transcript's own name matches the pane's launcher-minted label. Exact,
 *             because the `claude()` wrapper stamps the label in via --name.
 *   inferred  newest transcript in the same directory. A guess, and heavily fenced.
 *
 * An inference, once made, is also *kept*: `rememberedFor` replays the previous poll's
 * binding for a pane. Without it a pane bound while it was alone in its folder came
 * unbound the moment a second session started there — the folder became ambiguous and
 * the panel blanked a transcript it had been reading happily for an hour. The new pane
 * cannot own that transcript anyway (it is older than the pane), so nothing was learned
 * that should change the answer.
 *
 * Two guards do the real work, both learned from bugs:
 *
 *   Freshness — a transcript last written *before* a pane existed cannot belong to it.
 *   Without this a brand-new session adopts whatever ran in that folder yesterday, and
 *   a restarted session adopts its own previous run.
 *
 *   Ownership — a titled transcript already declares whose it is. If the pane has a
 *   label and the names differ, that file belongs to another session, running or not.
 *   An exited session leaves its transcript behind; a sibling must not inherit it.
 */

const lower = (s) => (s ? String(s).toLowerCase() : null);

/**
 * `~/.claude/projects/<cwd>` with every separator as a dash — Claude Code's own rule for
 * naming a transcript's folder. Dots are folded too, so the comparison holds whichever
 * convention wrote the directory; both sides go through this, so it can only agree with
 * itself.
 */
const encodeCwd = (cwd) => String(cwd || '').replace(/[/.]/g, '-');

/**
 * Could this transcript have been started by this pane?
 *
 * Not "is it working in the same directory as this pane" — those are different questions,
 * and the difference blanked a live session. Claude Code stamps `cwd` on every record and
 * updates it when the session changes directory, so a conversation that started in
 * `Alpha` and moved to `Alpha/alpha-dev/backend` writes a cwd its pane will never
 * match. What doesn't move is the folder the file was filed under, which is named after
 * the directory the session *launched* in — the pane's own.
 *
 * The recorded cwd is still the fallback, for a probe from before this was carried.
 */
function sameWorkspace(pane, meta) {
  if (meta.projectDir) return encodeCwd(meta.projectDir) === encodeCwd(pane.cwd);
  return meta.cwd === pane.cwd;
}

/**
 * Could this title have been produced by the wrapper's `<repo>-<branch>` default
 * rather than by a session label?
 *
 * It matters because the two can collide. A pane labelled `main` in the Alpha repo on
 * branch `main` produces the title `Alpha-main` — identical to what every *other*
 * Alpha session on that branch produces. Matching a label against such a title looks
 * exact and proves nothing: 13 transcripts in that folder carry it.
 *
 * A title that differs from the repo-branch default can only have come from a label,
 * and is therefore real evidence of ownership.
 */
function looksBranchDerived(meta, pane) {
  if (!meta.title || !pane.defaultTitle) return false;
  return lower(meta.title) === lower(pane.defaultTitle);
}

/**
 * @param {object}   args
 * @param {Array}    args.panes             {paneId, cwd, label, createdMs}
 * @param {Array}    args.metas             {sessionId, cwd, title, mtime}
 * @param {Function} args.hookBindingFor    paneId -> sessionId | null
 * @param {Function} args.rememberedFor      paneId -> sessionId | {sessionId, confidence} | null
 * @returns {{bound: Map<string, {pane: object, confidence: string}>, unbound: Array}}
 */
export function bindPanes({ panes, metas, hookBindingFor = () => null, rememberedFor = () => null }) {
  const bound = new Map(); // sessionId -> { pane, confidence }
  const claimed = new Set();
  const takenPanes = new Set();
  const bySession = new Map(metas.map((m) => [m.sessionId, m]));

  const claim = (sessionId, pane, confidence) => {
    bound.set(sessionId, { pane, confidence });
    claimed.add(sessionId);
    takenPanes.add(pane.paneId);
  };

  const remaining = () =>
    panes.filter((p) => !takenPanes.has(p.paneId)).sort((a, b) => a.paneId.localeCompare(b.paneId));

  // 1. Hooks are authoritative.
  for (const pane of remaining()) {
    const sid = hookBindingFor(pane.paneId);
    if (sid && bySession.has(sid) && !claimed.has(sid)) claim(sid, pane, 'hook');
  }

  // 1b. Whatever this pane was bound to a moment ago, provided it still holds up: same
  // directory, and still fresh enough to be this pane's. A binding that was safe to make
  // does not become unsafe because a *sibling* appeared afterwards.
  for (const pane of remaining()) {
    const prev = rememberedFor(pane.paneId);
    const sid = typeof prev === 'string' ? prev : prev?.sessionId;
    const meta = sid && !claimed.has(sid) ? bySession.get(sid) : null;
    if (!meta) continue;
    if (!sameWorkspace(pane, meta)) continue;
    if (pane.createdMs && meta.mtime < pane.createdMs) continue;
    // Keep the confidence it was earned with — a label match does not decay to a guess
    // just because it is being remembered rather than recomputed.
    claim(sid, pane, (typeof prev === 'object' && prev?.confidence) || 'inferred');
  }

  const paneCount = new Map();
  for (const p of panes) paneCount.set(p.cwd, (paneCount.get(p.cwd) || 0) + 1);

  // 2. The transcript names itself after the pane's label.
  //
  // The branch-default guard below only earns its keep while a *sibling* might still be
  // writing that default name. A pane launched after the shell wrapper started stamping
  // the label always writes its own label, so it can never be the impostor — and if no
  // sibling could be, a title matching this pane's label is simply this pane's, even
  // when the label happens to equal the branch (`main` in the `main` branch).
  const suspectSibling = (pane) =>
    panes.some((p) => p.paneId !== pane.paneId && p.cwd === pane.cwd && !p.modernNamer);

  for (const pane of remaining()) {
    if (!pane.label) continue;
    const shared = (paneCount.get(pane.cwd) || 0) > 1 && suspectSibling(pane);
    const candidate = metas
      .filter(
        (m) =>
          sameWorkspace(pane, m) &&
          !claimed.has(m.sessionId) &&
          lower(m.title) === lower(pane.label) &&
          (!pane.createdMs || m.mtime >= pane.createdMs) &&
          // Where siblings compete, a title that is merely the repo-branch default
          // proves nothing — every session in that folder carries it.
          !(shared && looksBranchDerived(m, pane)),
      )
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (candidate) claim(candidate.sessionId, pane, 'label');
  }

  // 3. Newest in the directory — but only where there is nothing to confuse it with.
  //
  // Ambiguity is created by *siblings*, not by names. A folder running one pane has
  // exactly one live conversation, so the newest fresh transcript is that pane's even
  // when the names differ (sessions predating the --name change are titled
  // `<repo>-<branch>`, e.g. label `beta-main` against title `Beta`).
  //
  // A folder running several panes has no such luxury: there, only an exact label
  // match is safe, and anything else stays unbound rather than showing you a sibling's
  // conversation.
  const otherLabels = new Set(panes.map((p) => lower(p.label)).filter(Boolean));

  for (const pane of remaining()) {
    const alone = (paneCount.get(pane.cwd) || 0) === 1;
    const rivals = remaining().filter((p) => p.cwd === pane.cwd).length;
    if (!alone && rivals > 1) continue;

    const candidates = metas
      .filter((m) => {
        if (!sameWorkspace(pane, m) || claimed.has(m.sessionId)) return false;
        if (pane.createdMs && m.mtime < pane.createdMs) return false;
        // Still never take a file that names a different live pane.
        const t = lower(m.title);
        if (t && t !== lower(pane.label) && otherLabels.has(t)) return false;
        return true;
      })
      .sort((a, b) => b.mtime - a.mtime);

    // In a crowded folder, "newest" is a guess and stays refused. But once every sibling
    // has been bound, one pane left over with exactly one *live* transcript left over is
    // not a guess at all — there is nothing else either of them could be.
    //
    // "Live" is what makes that arithmetic work in a folder you have been working in all
    // day: `/clear` mints a new transcript, so one pane leaves a trail of them. A file
    // whose last word was written before another file's first is a rotation predecessor,
    // not a conversation anyone is still having, and counting it as a rival is what kept
    // a perfectly identifiable session reading "can't tell which history is this one's".
    const live = alone ? candidates : liveOnly(candidates);
    if (!alone && live.length !== 1) continue;
    if (live[0]) claim(live[0].sessionId, pane, 'inferred');
  }

  return { bound, unbound: remaining() };
}

/** When a transcript was first and last written, in ms. */
const spanOf = (m) => ({
  start: Date.parse(m.firstTs || '') || 0,
  end: Date.parse(m.lastTs || '') || m.mtime,
});

/**
 * Drop transcripts that another one in the set has already succeeded — `/clear` leaves a
 * chain of them behind, and only the tip of the chain is a live conversation.
 */
function liveOnly(metas) {
  const spans = metas.map(spanOf);
  return metas.filter((m, i) => !spans.some((o, j) => j !== i && o.start >= spans[i].end));
}

/**
 * Why a pane ended up with no transcript — the UI says something different for each.
 * "new" means it hasn't spoken yet; "ambiguous" means we found candidates and refused
 * to pick between them.
 */
export function unboundReason(pane, metas) {
  // Deliberately only two answers. A finer split would mean predicting whether this
  // pane will name itself on its next reply, which depends on whether it launched
  // before or after the shell wrapper started stamping the label — and a running pane
  // gives no way to tell. Better to say what's true than to promise a fix that won't
  // arrive.
  const hasCandidate = metas.some(
    (m) => sameWorkspace(pane, m) && (!pane.createdMs || m.mtime >= pane.createdMs),
  );
  return hasCandidate ? 'ambiguous' : 'new';
}
