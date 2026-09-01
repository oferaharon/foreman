import path from 'node:path';

/**
 * The trigger allow-list, and the lead it resolves to.
 *
 * This is the narrowest, most security-critical module in the panel: everything it says
 * "yes" to ends up typed into a session that dispatches workers on the maintainer's behalf.
 * The whole feature exists because of one ruling in the frontend team's `decisions.md`
 * (2026-08-27) — a message whose first line is **exactly** `review feedback issue <N>` and
 * nothing else is standing permission for that lead to run its playbook without asking.
 * Nothing wider than that phrase is authorized by anyone, so every ambiguity here resolves
 * to **refuse**:
 *
 *   - no `triggers` on the team → every phrase refused. Adding a team must not add an
 *     attack surface, so `DEFAULTS.triggers` is `[]` and `[]` means no.
 *   - a pattern that is not anchored `^...$` → that team's triggers refused
 *     **wholesale**, loudly on stderr. Never silently run an unanchored regex: the
 *     anchors are what enforce "and nothing appended".
 *   - a pattern that does not compile, or an entry with no id → the same wholesale
 *     refusal. A config error should stop the feature working, not quietly narrow it.
 *   - text longer than the cap → refused before any regex runs.
 *   - more than one lead in a folder → null, never a pick.
 *
 * Pure functions. No HTTP, no tmux, no disk — the endpoint that calls this owns the
 * credential, the dedupe and the room line, and it is a separate item.
 *
 * Note what is deliberately *not* here: no case folding, no whitespace collapsing, no
 * punctuation tolerance, and no second pattern for the looser wording the frontend
 * repo's FEEDBACK-REVIEW-PLAYBOOK.md also mentions (`review issue XXX`). `decisions.md`
 * pre-authorizes one form, exactly. Being helpful here is the bug.
 */

/**
 * Longest text this will even look at. A trigger phrase is ~24 characters; the cap
 * exists so a hostile body cannot make regex cost matter.
 *
 * Over-length is a **refusal, not a truncation**. Cutting a long string down to 200 and
 * then testing it is a coercion — it hands a caller a way to have their input rewritten
 * into something that might match — and no reading of "exactly that phrase and nothing
 * else" survives a message that was 4KB long. Refusing runs no regex at all, which is
 * the point of the cap in the first place.
 */
export const MAX_TRIGGER_TEXT = 200;

/**
 * Is this pattern anchored at both ends, as written?
 *
 * `^` at position 0 cannot be escaped, so the start is a `startsWith`. The end is not:
 * `^foo\$` ends with a `$` character that is a *literal dollar sign*, not an anchor, and
 * a pattern like that would happily match `foo$ and also rm -rf`. So the trailing `$`
 * counts only when the run of backslashes before it is even (zero included) — `^foo\\$`
 * is an escaped backslash followed by a real anchor and is fine.
 *
 * Returns the fault as a sentence, or null when the pattern is anchored.
 */
function anchorFault(source) {
  if (!source.startsWith('^')) return 'it does not start with ^';
  if (!/(?:^|[^\\])(?:\\\\)*\$$/.test(source)) return 'it does not end with an unescaped $';
  return null;
}

/**
 * Validate the whole list, or refuse the whole list.
 *
 * Wholesale rather than skip-the-bad-one on purpose: a team whose triggers stop working
 * gets looked at, a team whose broken trigger was silently dropped does not — and the
 * one being dropped might be the safe one sitting beside a sloppy one.
 *
 * Returns compiled entries, or null after saying why on stderr.
 */
function compile(triggers) {
  const compiled = [];
  for (const [i, entry] of triggers.entries()) {
    const where = `triggers[${i}]`;
    const refuse = (why) => {
      console.error(`[trigger] refusing every trigger for this team: ${where} ${why}.`);
      return null;
    };
    if (!entry || typeof entry !== 'object') return refuse('is not an object');
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) return refuse('has no id');
    if (typeof entry.match !== 'string' || !entry.match) return refuse(`(${id}) has no match pattern`);

    const fault = anchorFault(entry.match);
    // The rule the maintainer wrote: nothing may be appended to the phrase. An unanchored
    // pattern is how that rule gets lost, so it is a config error rather than a pattern we
    // fix up.
    if (fault) return refuse(`(${id}) pattern ${JSON.stringify(entry.match)} is not anchored — ${fault}`);

    let re;
    try {
      // No flags, ever. `i` would fold case and `m` would let `^`/`$` meet a newline,
      // which is exactly the "and nothing appended" hole — and neither can be reached
      // from a pattern string when the flags argument is omitted.
      re = new RegExp(entry.match);
    } catch (err) {
      return refuse(`(${id}) pattern ${JSON.stringify(entry.match)} does not compile: ${err.message}`);
    }
    compiled.push({ id, re });
  }
  return compiled;
}

/**
 * Is this incoming sentence one the team pre-authorized? Returns the trigger's id, or
 * null.
 *
 * `triggers` is the team's own `team.json` field. `[]`, missing, or not an array all
 * mean the same thing: no.
 *
 * The match must span the **entire** trimmed text, checked here rather than trusted to
 * the pattern's anchors. That is not belt-and-braces for its own sake — it is what makes
 * the guarantee structural. `^a$|^b` passes the anchor check and leaves one branch
 * open-ended; an ES2025 modifier group (`(?m:^…$)`) re-opens `$` at a newline. Neither
 * can produce a partial match here, because a partial match is refused whatever the
 * pattern thought it was doing.
 */
export function matchTrigger(text, triggers) {
  if (!Array.isArray(triggers) || triggers.length === 0) return null;

  // Config first, so a misconfiguration is loud on the very first trigger rather than
  // waiting for a well-formed message to arrive.
  const compiled = compile(triggers);
  if (!compiled) return null;

  if (typeof text !== 'string' || text.length > MAX_TRIGGER_TEXT) return null;
  // `.trim()` and nothing else. The ruling says "exactly".
  const subject = text.trim();
  if (!subject) return null;

  for (const { id, re } of compiled) {
    const m = re.exec(subject);
    if (m && m.index === 0 && m[0].length === subject.length) return id;
  }
  return null;
}

/**
 * The one live lead for a repo, or null.
 *
 * `isLead` is read straight off the roster row and never re-derived: `sessions.js` gets
 * it from `isLeadName` (the naming contract in `launch.js`) and that is the single
 * source of truth for what a lead is. A second one is exactly what the snapshot bug cost
 * — a row the rail badged as the lead while the session behind it was an ordinary one.
 *
 * Folders are compared on `paneCwd`, the launch folder, because `cwd` is the
 * transcript's and Claude Code rewrites it when a session changes directory
 * mid-conversation — a lead that `cd`s once would stop matching. Both sides go through
 * `path.resolve` so a trailing slash or a `.` segment is not a silent no-match: that is
 * the shape of the bug where every team heading in the rail read `· 0` with its workers
 * three rows below it.
 *
 * More than one match is null, never a pick. Two leads in one folder is not supposed to
 * happen (`launchLead` refuses it), and if it has, the panel does not get to guess which
 * one speaks for the maintainer.
 */
export function findLead(sessions, folder) {
  if (typeof folder !== 'string' || !folder.trim()) return null;
  // Relative would resolve against this process's cwd, which is a different folder that
  // could happen to be right — an accident, not an answer.
  if (!path.isAbsolute(folder)) return null;
  if (!Array.isArray(sessions)) return null;

  const want = path.resolve(folder);
  const leads = sessions.filter(
    (s) =>
      s &&
      s.isLead &&
      s.paneId &&
      s.interactive &&
      typeof s.paneCwd === 'string' &&
      path.isAbsolute(s.paneCwd) &&
      path.resolve(s.paneCwd) === want,
  );
  return leads.length === 1 ? leads[0] : null;
}
