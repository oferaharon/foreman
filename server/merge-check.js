import { shaOf } from './deployed.js';
import { mergePaths } from './merge-queue.js';
import { normalizeReviewPaths } from './team.js';

/**
 * May the lead merge this PR on its own judgment? — the verdict behind
 * `POST /api/team/tasks/:id/merge-check` and the `leadDecidesMerges` toggle.
 *
 * **The panel cannot read a forge, and this file must never start.** It holds no
 * credential, makes no network call, and does not shell out to `gh` — the maintainer's
 * ruling of 2026-08-30, and the same one that makes the merge button type a sentence
 * instead of calling Gitea. Every instinct while reading this file says "just ask the forge
 * whether the checks are green"; that is the one thing it may not do.
 *
 * So the conditions split in two, and the split is the whole design:
 *
 *   **A wall.** Everything computed from the panel's own disk, where nothing the lead says
 *   can change the answer: the toggle, the path list, the forge reading, the task's shape,
 *   the head sha matching the branch tip this checkout diffed, and whether any changed file
 *   is under `humanReviewPaths`. A lead cannot talk its way past any of these.
 *
 *   **Discipline.** The forge's own facts — is the PR mergeable, are its checks green —
 *   arrive *from the lead*, are validated against an enum and nothing more, and are written
 *   into the room where the maintainer reads them. This is the same trade
 *   `worker_answer_question` already makes with its `grounds`: it does not prevent a lead
 *   from being wrong, it makes being wrong impossible to do quietly.
 *
 * Every refusal **fails closed**: a thing that could not be checked refuses, never passes.
 * The order below is the plan's, and it is deliberately not cheapest-first — a refusal
 * should name the most fundamental thing that is wrong, so a team whose toggle is off hears
 * about the toggle rather than about a missing quote.
 *
 * Pure except for two git reads (`mergePaths`, `shaOf`), both injected, so the decision
 * table is testable without a repo and the git half is testable against a real throwaway
 * one — the shape `collectQueue` already uses.
 */

/**
 * The words the lead may use for the forge's mergeability, and only `clean` passes.
 *
 * They map onto GitHub's `mergeStateStatus` (`CLEAN` and `HAS_HOOKS` are `clean`; `DIRTY`,
 * `BEHIND`, `DRAFT`, `BLOCKED`, `UNSTABLE`, `UNKNOWN` keep their own words) and onto
 * Gitea's own answer. An unrecognised word is refused rather than guessed at — `UNKNOWN` is
 * never a pass, and neither is a word this list has not met.
 */
export const MERGEABLE = ['clean', 'dirty', 'behind', 'draft', 'blocked', 'unstable', 'unknown'];

/**
 * The words for the checks. `green` passes; `none` passes **only with a `suiteQuote`** —
 * "this repo configures no checks" is the live case here rather than the exotic one, and
 * the thing standing in for CI is then the worker's own report that the suite passed, which
 * has to be quoted rather than asserted.
 */
export const CHECKS = ['green', 'none', 'red', 'pending', 'unknown'];

/**
 * Which changed files are under one of the review paths.
 *
 * The match is `p === e || p.startsWith(e + '/')` — an entry names a file or a folder, and
 * **the `/` boundary is the whole of it**: `server` must hit `server/index.js` and must not
 * hit `serverless.js`. A naive `p.startsWith(e)` passes every other example anyone writes
 * down and fails exactly that one, which is why it has a test of its own.
 *
 * Both arguments are exact repo-relative paths — git's `-z` output on one side
 * (`mergePaths`) and `normalizeReviewPaths`' cleaned entries on the other — so there is no
 * quoting, no escaping and no glob to reconcile. Pure, and order-preserving: the hits come
 * back in the order git listed them, so the room line reads like the diff.
 */
export function reviewPathHits(changed, reviewPaths) {
  const entries = Array.isArray(reviewPaths) ? reviewPaths : [];
  if (!entries.length) return [];
  const files = Array.isArray(changed) ? changed : [];
  return files.filter((p) => entries.some((e) => p === e || String(p).startsWith(`${e}/`)));
}

/** `a`, `a and b`, `a, b and c` — with a cap, because a refusal is read on one line. */
function list(items, max = 5) {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const joined =
    shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${joined} and ${rest} more` : joined;
}

const short = (sha) => String(sha || '').slice(0, 12);
const blank = (s) => !String(s ?? '').trim();

/** A refusal: one reason, and whatever facts were established before it. */
const no = (reason, extra = {}) => ({ allowed: false, reasons: [reason], paths: null, head: null, forge: null, ...extra });

/**
 * The whole decision.
 *
 * @param {object} o
 * @param {object} o.team        the team config, as `readTeam` returns it
 * @param {object} o.task        the task record
 * @param {string} o.repo        the repo the *caller* named — refusal 4 compares it to the task's
 * @param {object} o.forge       `resolveForge`'s answer for that repo
 * @param {string} [o.base]      the repo's detected base, for a record written before `base` was stored
 * @param {string} o.head        the head sha the lead read off the forge
 * @param {string} o.mergeable   one of MERGEABLE, from the lead
 * @param {string} o.checks      one of CHECKS, from the lead
 * @param {string} o.evidence    what the lead read, in its own words
 * @param {string} o.reason      why this PR is one it may merge
 * @param {string} [o.suiteQuote] the worker's own words about the suite — required when checks is `none`
 * @param {{paths?: Function, sha?: Function}} [deps]
 * @returns {Promise<{allowed: boolean, reasons: string[], paths: string[]|null, head: string|null, forge: string|null}>}
 */
export async function mergeVerdict(
  { team, task, repo, forge, base = null, head, mergeable, checks, evidence, reason, suiteQuote } = {},
  deps = {},
) {
  const { paths: readPaths = mergePaths, sha = shaOf } = deps;
  const reading = forge?.reading || null;

  /* 1 — the toggle. First, because it is the maintainer's own answer to "may it at all",
   * and a team that has not opted in should hear that rather than a critique of its PR. */
  if (!team?.toggles?.leadDecidesMerges) {
    return no(
      'the team\'s "leadDecidesMerges" toggle is off — this PR waits for the maintainer\'s word, however good it looks',
    );
  }

  /* 2 — the path list. Unparseable refuses; it never falls back to "empty", because empty
   * means *nothing is reserved* and a typo must not be read as consent. */
  let reviewPaths;
  try {
    reviewPaths = normalizeReviewPaths(team.humanReviewPaths);
  } catch (err) {
    return no(`this team's humanReviewPaths could not be read, so nothing can be cleared against it — ${err.message}`);
  }

  /* 3 — the forge. `push only` and `no remote` mean there is no PR in the first place. */
  if (!forge?.forge) {
    return no(`the forge reading here is "${reading || 'unknown'}" — there is no PR to merge`, { forge: reading });
  }

  /* 4 — the task's shape. Every clause is a fact on disk; none of it is the lead's word. */
  if (!task) return no('there is no such task', { forge: reading });
  if (String(task.repo || '') !== String(repo || '')) {
    return no(`${task.id} is not a task in this folder`, { forge: reading });
  }
  if (task.kind === 'plan') {
    return no(`${task.id} is a plan — it is read and approved, not merged`, { forge: reading });
  }
  if (task.state !== 'review') {
    return no(`${task.id} is ${task.state}, not in review`, { forge: reading });
  }
  if (!task.pr) return no(`${task.id} has no PR recorded — there is nothing to merge`, { forge: reading });
  if (!task.branch) return no(`${task.id} has no branch recorded`, { forge: reading });

  /* 5 — the sha. This is what stops "checked yesterday, merged today", and it is the
   * `expect` pattern `POST /api/team/merge` already uses one endpoint over: the lead passes
   * the head it read from the forge, and everything below is computed against *that*
   * commit or not at all. */
  if (blank(head)) {
    return no('no head sha was given — a verdict is bound to the commit it was taken on', { forge: reading });
  }
  const [given, tip] = await Promise.all([sha(repo, String(head).trim()), sha(repo, task.branch)]);
  if (!given) {
    return no(`the head ${short(head)} does not resolve in this checkout — pull, or check the sha`, { forge: reading });
  }
  if (!tip) return no(`${task.branch} does not resolve in this checkout`, { forge: reading, head: given });
  if (given !== tip) {
    return no(
      `the head you read (${short(given)}) is not the tip of ${task.branch} here (${short(tip)}) — the panel would be vouching for a different commit`,
      { forge: reading, head: given },
    );
  }

  /* 6 — the changed files. `null` from `mergePaths` means *could not be read*, which its own
   * header insists is not the same as *touches nothing*: an unreadable branch refuses. */
  const changed = await readPaths(repo, { branch: task.branch, base: task.base || base });
  if (!changed) {
    return no(`the files ${task.branch} changes could not be read, so nothing can be cleared against the review paths`, {
      forge: reading, head: given,
    });
  }

  /* 7 — the path list, matched. The one wall that is about *this* PR's content. */
  const hits = reviewPathHits(changed, reviewPaths);
  if (hits.length) {
    return no(
      `${list(hits)} ${hits.length === 1 ? 'is' : 'are'} under humanReviewPaths (${list(reviewPaths)}) — the maintainer looks at these themselves`,
      { forge: reading, head: given, paths: changed },
    );
  }

  /* 8–10 — the forge's own facts, which arrive from the lead. Validated against an enum
   * and nothing more: the panel cannot check them, and pretending otherwise would be worse
   * than saying so. An unrecognised word refuses — never a pass by accident. */
  const facts = { forge: reading, head: given, paths: changed };
  if (!MERGEABLE.includes(mergeable)) {
    return no(`"${mergeable}" is not something this accepts for mergeable — one of: ${MERGEABLE.join(', ')}`, facts);
  }
  if (mergeable !== 'clean') {
    return no(`you reported the PR as "${mergeable}" rather than clean`, facts);
  }
  if (!CHECKS.includes(checks)) {
    return no(`"${checks}" is not something this accepts for checks — one of: ${CHECKS.join(', ')}`, facts);
  }
  if (checks !== 'green' && checks !== 'none') {
    return no(`you reported the checks as "${checks}" rather than green`, facts);
  }
  if (checks === 'none' && blank(suiteQuote)) {
    return no(
      'you reported no checks on this repo, so the suite passing is the worker\'s own claim — quote it in suiteQuote',
      facts,
    );
  }

  /* 11 — the grounds. The `requireGrounds` shape: a claim nobody can verify still has to
   * be *made*, in the room, where the maintainer reads it back. */
  if (blank(evidence)) return no('no evidence given — say what you read on the forge, and where', facts);
  if (blank(reason)) return no('no reason given — say why this is a PR you may merge without asking', facts);

  /* Allowed. `reasons` says what was checked rather than repeating that it passed: it is
   * what the room line prints and what the maintainer reads back a week later. */
  return {
    allowed: true,
    forge: reading,
    head: given,
    paths: changed,
    reasons: [
      'the team\'s "leadDecidesMerges" toggle is on',
      `forge: ${reading}`,
      `${task.id} is in review with ${task.pr}`,
      `${short(given)} is the tip of ${task.branch} in this checkout`,
      reviewPaths.length
        ? `none of its ${changed.length} changed ${changed.length === 1 ? 'file' : 'files'} is under humanReviewPaths (${list(reviewPaths)})`
        : `its ${changed.length} changed ${changed.length === 1 ? 'file' : 'files'} cleared an empty humanReviewPaths — nothing is reserved for the maintainer on this team`,
      `you report the PR mergeable: clean, checks: ${checks}`,
      ...(checks === 'none' ? [`no checks on this repo; the suite is the worker's own claim: ${String(suiteQuote).trim()}`] : []),
    ],
  };
}
