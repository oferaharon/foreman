/*
 * Which brief the briefs modal is showing, and which repo it is showing it for.
 *
 * A pure module under `web/`, for the reason `trust-gate.js` set and the ones after it
 * kept: the two decisions worth pinning here are a *rule* (which kinds need a repo, and
 * which repo a freshly opened modal lands on) and the same rule inlined into a DOM builder
 * is not something a node test can hold. No DOM, no storage, no `window`.
 *
 * **The picker is only on three of the four tabs, and that is a fact about the briefs and
 * not a UI choice.** `lead`, `worker` and `planner` are functions of a repository — its
 * forge, its base branch, its `git config user.name`, its team's self-merge toggle — and
 * are regenerated per launch from those. The standalone brief is **one file for the whole
 * machine** (`server/session-launch.js` writes exactly one `session-brief.md` under the
 * state dir, and every ordinary session the panel launches is pointed at it), so a repo
 * picker on that tab would be a control that changes nothing: worse than absent, because
 * it implies the answer depends on it. `needsRepo` is the one spelling of that.
 *
 * **The default repo is the one you are already looking at.** Opening the modal from a
 * pane showing a session in a repo that has a team almost always means asking about *that*
 * team; landing on the alphabetically-first repo instead makes the first thing you do a
 * correction. It falls back to the first team rather than to nothing, because a modal that
 * opens on an empty picker has to be driven before it says anything at all.
 *
 * **The cache key is repo-and-kind and it is deliberately not repo alone.** One fetch
 * answers all four kinds for a repo (`GET /api/briefs?repo=…`), so switching tabs inside
 * one repo must not re-fetch — but the key still names the kind, because `standalone`'s
 * answer is repo-independent and keying it under whichever repo happened to be selected
 * when it was fetched would store four copies of one string and re-fetch on every repo
 * change to get it back. `cacheKey` returns the same key for `standalone` whatever repo is
 * passed, which is what makes that hold.
 *
 * Nothing here caches anything itself: it names keys, and the modal's own Map (which lives
 * for the life of the modal and not a second longer — a brief is generated at launch and a
 * stale one shown tomorrow would be a lie told confidently) does the holding.
 */

/**
 * The four tabs, in the order they are drawn: outward from the team.
 *
 * `lead` first because it is the one people come here to read — it is the longest, the
 * most consequential and the only one with toggles behind it. Then the two roles it
 * dispatches, then the brief that has nothing to do with a team at all.
 */
export const BRIEF_KINDS = [
  { kind: 'lead', label: 'lead', repo: true },
  { kind: 'worker', label: 'worker', repo: true },
  { kind: 'planner', label: 'planner', repo: true },
  { kind: 'standalone', label: 'standalone', repo: false },
];

/** Whether this kind's brief is a function of a repository. Unknown kinds answer `false`
 *  — an unknown kind has no repo to be about, and guessing `true` would draw a picker
 *  over something nothing can fill in. */
export function needsRepo(kind) {
  return BRIEF_KINDS.some((k) => k.kind === kind && k.repo);
}

/** Whether this is a kind the modal knows how to draw at all. */
export function isBriefKind(kind) {
  return BRIEF_KINDS.some((k) => k.kind === kind);
}

/**
 * The repo the modal opens on: the one the pane you are looking at is in, when that repo
 * has a team; otherwise the first team there is; otherwise nothing.
 *
 * `teams` is `GET /api/teams`'s list (objects carrying `repo`, or bare strings — both,
 * because the endpoint's row shape is not this module's business). `openRepo` is the
 * folder of the session in slot `a`, which may be null, may be a repo with no team, and
 * may be a worktree under a team's repo rather than the repo itself. Only an exact match
 * counts: a worker's worktree is a different folder from the repo it branched off, and
 * guessing a parent from a path prefix would file `…/foo-2` under `…/foo`.
 */
export function defaultRepo(teams, openRepo = null) {
  const list = (Array.isArray(teams) ? teams : [])
    .map((t) => (typeof t === 'string' ? t : t?.repo))
    .filter((r) => typeof r === 'string' && r);
  if (!list.length) return null;
  const want = typeof openRepo === 'string' ? openRepo.replace(/\/+$/, '') : null;
  if (want && list.some((r) => r.replace(/\/+$/, '') === want)) return want;
  return list[0];
}

/**
 * The key one brief is cached under for the life of the modal.
 *
 * `standalone` ignores the repo — see the header. Everything else is `<repo>|<kind>`, and
 * the separator is safe because the *kind* is the half that cannot contain one: it comes
 * from `BRIEF_KINDS`, four literals with no `|` in any of them, so no two (repo, kind)
 * pairs can spell one key however strange a path is. `mergeSig`'s trap in CLAUDE.md is the
 * same join from the other end — ordinary punctuation, never a control byte that *looks*
 * like an empty string in every editor. (This function had one, briefly, and looked fine.)
 */
export function cacheKey(repo, kind) {
  if (!needsRepo(kind)) return `|${kind}`;
  return `${repo || ''}|${kind}`;
}
