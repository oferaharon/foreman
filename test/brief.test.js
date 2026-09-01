import assert from 'node:assert/strict';
import test from 'node:test';
import { forgeSection, leadBrief } from '../server/lead-brief.js';
import { FALLBACK } from '../server/human-name.js';
import { workerBrief, plannerBrief } from '../server/worker-brief.js';

/*
 * The three briefs used to name the decisions file without ever telling anyone to read
 * it (`decisionsFile` was interpolated into "append it here" / "a ruling in here", never
 * into a "read this" instruction). These pin the fix: each brief must carry the real
 * path it was given, and an instruction to read it, not just mention it in passing.
 */

const REPO = '/Users/x/Code/Fake';
const DECISIONS = '/Users/x/State/teams/Users-x-Code-Fake/decisions.md';
// Not a name anyone has: these assertions are about the *substitution*, so a literal
// that could also be the machine's own git identity would pass for the wrong reason.
const NAME = 'zzq-testname';

test('lead brief instructs reading the decisions file, before first reply and after /clear', () => {
  const brief = leadBrief({ repo: REPO, teamDir: '/Users/x/State/teams/Users-x-Code-Fake', decisionsFile: DECISIONS });
  assert.ok(brief.includes(DECISIONS), 'the real path is in the brief');
  assert.match(brief, /[Rr]ead .*before your first reply/s, 'told to read before the first reply');
  assert.match(brief, /\/clear/, 'told the instruction survives /clear');
});

test('worker brief instructs reading the decisions file before starting, and the conflict rule', () => {
  const brief = workerBrief({ repo: REPO, taskId: 'my-task', decisionsFile: DECISIONS });
  assert.ok(brief.includes(DECISIONS), 'the real path is in the brief');
  assert.match(brief, new RegExp(`Read .*${FALLBACK}'s standing rulings`), 'told to read it');
  assert.match(brief, /room_post/, 'the conflict rule points at room_post, not guessing');
});

test('planner brief instructs reading the decisions file before starting, and the conflict rule', () => {
  const brief = plannerBrief({
    repo: REPO,
    taskId: 'my-plan',
    planFile: '/Users/x/State/teams/Users-x-Code-Fake/plans/my-plan.md',
    decisionsFile: DECISIONS,
  });
  assert.ok(brief.includes(DECISIONS), 'the real path is in the brief');
  assert.match(brief, new RegExp(`Read .*${FALLBACK}'s standing rulings`), 'told to read it');
  assert.match(brief, /open questions/, 'a conflict is recorded in the plan, not guessed at');
});

test('workerBrief and plannerBrief do not silently emit undefined when the path is missing', () => {
  const worker = workerBrief({ repo: REPO, taskId: 'no-decisions' });
  assert.ok(!worker.includes('undefined'), 'worker brief must not print undefined');

  const planner = plannerBrief({
    repo: REPO,
    taskId: 'no-decisions',
    planFile: '/Users/x/State/teams/Users-x-Code-Fake/plans/no-decisions.md',
  });
  assert.ok(!planner.includes('undefined'), 'planner brief must not print undefined');
});

/* --------------------------------------------- the forge section, per repo --- */

/*
 * The brief used to assert Gitea — one section headed "Gitea: issues in, PRs out" and a
 * worker "branched from main", on every repo. A lead on a GitHub repo was told to reach
 * for tools it had never been given; a lead on a repo with no remote was told to open a PR
 * against nothing. These pin the three variants and the cross-refusals between them.
 */

const briefFor = (forge, base = 'main') =>
  leadBrief({ repo: REPO, teamDir: '/Users/x/State/teams/Users-x-Code-Fake', decisionsFile: DECISIONS, forge, base });

test('a Gitea repo gets the gitea section and nothing about gh', () => {
  const brief = briefFor({ forge: 'gitea', via: 'mcp', reading: 'Gitea' });
  assert.match(brief, /## Gitea: issues in, PRs out/);
  assert.match(brief, /open a PR with the gitea tools/);
  assert.doesNotMatch(brief, /gh pr create/, 'a gitea lead has no gh instructions to misread');
  assert.doesNotMatch(brief, /## No PRs on this repo/);
});

test('a GitHub repo with gh gets shell commands, and never the gitea tools', () => {
  const brief = briefFor({ forge: 'github', via: 'gh', reading: 'GitHub' });
  assert.match(brief, /## GitHub: issues in, PRs out/);
  assert.match(brief, /gh issue view 14/);
  assert.match(brief, /gh pr create --base main/);
  assert.match(brief, /gh pr merge <N> --merge/);
  assert.match(brief, /never `--admin`, never a force anything/, 'and told which flags not to reach for');
  assert.doesNotMatch(brief, /gitea/i, 'the other forge is not mentioned at all');
});

test('a GitHub repo reached through an MCP server names that instead of gh', () => {
  const brief = briefFor({ forge: 'github', via: 'mcp', reading: 'GitHub' });
  assert.match(brief, /## GitHub: issues in, PRs out/);
  assert.match(brief, /`github` MCP tools/);
  assert.doesNotMatch(brief, /gh pr create/, 'no shell commands for a lead that has no gh');
});

test('no forge stops at the branch, and says so as the normal shape rather than a failure', () => {
  const brief = briefFor(null, 'master');
  assert.match(brief, /## No PRs on this repo: work stops at the branch/);
  assert.match(brief, new RegExp(`there is no PR to open — ${FALLBACK}\\s+merges locally and tells you`));
  assert.match(brief, /no remote at all/);
  assert.match(brief, /ordinary shape\s+for most repositories rather than a degraded mode/);
  assert.doesNotMatch(brief, /gitea/i);
  assert.doesNotMatch(brief, /gh pr/);
  // The merge-queue paragraph is about a button that is not drawn on this repo.
  assert.doesNotMatch(brief, /merge queue types the word/);
});

test('`push only` says the branch is pushed; `no remote` says it stays here', () => {
  const push = briefFor({ forge: null, via: null, reading: 'push only' });
  assert.match(push, /committed\s+and pushed\s+on/);
  assert.match(push, /no tools for it are installed/);
  const none = briefFor({ forge: null, via: null, reading: 'no remote' });
  assert.match(none, /committed\s+on/);
  assert.doesNotMatch(none, /and pushed/);
});

test('the detected base branch reaches the prose, not a hardcoded main', () => {
  const brief = briefFor({ forge: 'gitea', via: 'mcp', reading: 'Gitea' }, 'trunk');
  assert.match(brief, /branched from `trunk`/);
  assert.match(brief, /base `trunk`/);
  assert.doesNotMatch(brief, /branched from `main`/);
});

test('the detected base branch reaches the worker and planner briefs too, not a hardcoded main', () => {
  const worker = workerBrief({ repo: REPO, taskId: 'my-task', decisionsFile: DECISIONS, base: 'trunk' });
  assert.match(worker, /branch came from `trunk`/);
  assert.doesNotMatch(worker, /came from main/);

  const planner = plannerBrief({
    repo: REPO,
    taskId: 'my-plan',
    planFile: '/Users/x/State/teams/Users-x-Code-Fake/plans/my-plan.md',
    decisionsFile: DECISIONS,
    base: 'trunk',
  });
  assert.match(planner, /checked out from `trunk`/);
  assert.doesNotMatch(planner, /checked out from main/);
});

test('every variant carries the close gate, because every variant can force-delete a branch', () => {
  for (const forge of [
    { forge: 'gitea', via: 'mcp', reading: 'Gitea' },
    { forge: 'github', via: 'gh', reading: 'GitHub' },
    { forge: 'github', via: 'mcp', reading: 'GitHub' },
    null,
  ]) {
    const brief = briefFor(forge);
    assert.match(brief, /"Done" means merged, and the panel checks/, 'the gate is described');
    assert.match(brief, /outcome "abandon"/, 'and the deliberate way out is named');
  }
});

const forgeSectionOf = (forge, human) => forgeSection({ forge, base: 'main', human });

test('the brief is one template literal, and a bare backtick would break the module', async () => {
  // T19, the expensive way: sixteen bare backticks in `worker-brief.js` broke the module
  // outright and nothing in the suite noticed, because the tests that exercise briefs
  // import it — and an import that throws fails at collection rather than as a finding.
  // This is that check written down: load the file fresh and build every variant.
  const mod = await import('../server/lead-brief.js');
  for (const forge of [null, { forge: 'gitea', via: 'mcp' }, { forge: 'github', via: 'gh' }, { forge: 'github', via: 'mcp' }]) {
    const text = mod.forgeSection({ forge, base: 'main' });
    assert.ok(text.length > 200, 'every variant renders');
    assert.doesNotMatch(text, /undefined/, 'and nothing interpolated as undefined');
  }
});

/* ------------------------------------------------ whose repo is this, anyway --- */

/*
 * The name is detected (`human-name.js`, off `git config user.name`) and threaded in as a
 * parameter. These pin the substitution rather than any particular name — the whole point
 * of the item is that the prose no longer carries one person's, so an assertion on a
 * literal would be the bug in test form.
 */

const everyBrief = (human) => [
  ['lead', leadBrief({ repo: REPO, teamDir: '/Users/x/State/teams/Users-x-Code-Fake', decisionsFile: DECISIONS, human })],
  ['worker', workerBrief({ repo: REPO, taskId: 'my-task', decisionsFile: DECISIONS, human })],
  ['planner', plannerBrief({
    repo: REPO,
    taskId: 'my-plan',
    planFile: '/Users/x/State/teams/Users-x-Code-Fake/plans/my-plan.md',
    decisionsFile: DECISIONS,
    human,
  })],
];

const OTHER = 'qqx-othername';

test('a detected name reaches every brief, and it is the only thing that moves with it', () => {
  const mine = everyBrief(NAME);
  const theirs = everyBrief(OTHER);
  for (const [i, [which, brief]] of mine.entries()) {
    assert.ok(brief.includes(NAME), `${which} brief carries the detected name`);
    assert.ok(!brief.includes(OTHER), `${which} brief carries no other name`);
    // Render the same brief under a different name: every difference between the two
    // must be an interpolation of the name and nothing else, which is what proves the
    // substitution reaches every site rather than most of them.
    assert.equal(
      brief.split(NAME).join('§'),
      theirs[i][1].split(OTHER).join('§'),
      `${which} brief differs only where the name goes`,
    );
  }
});

test('with no name detected, every brief reads as the fallback and names nobody', () => {
  const missing = everyBrief(undefined);
  const explicit = everyBrief(FALLBACK);
  for (const [i, [which, brief]] of missing.entries()) {
    assert.ok(brief.includes(FALLBACK), `${which} brief falls back`);
    assert.ok(!brief.includes(NAME), `${which} brief invents nothing`);
    assert.ok(!brief.includes('undefined'), `${which} brief must not print undefined`);
    assert.equal(brief, explicit[i][1], `${which} brief's default is the fallback itself`);
  }
});

test('the forge section substitutes too, in all three variants', () => {
  for (const forge of [
    { forge: 'gitea', via: 'mcp', reading: 'Gitea' },
    { forge: 'github', via: 'gh', reading: 'GitHub' },
    null,
  ]) {
    const named = forgeSectionOf(forge, NAME);
    assert.ok(named.includes(NAME), 'the detected name reaches the forge section');
    assert.equal(
      named.split(NAME).join('§'),
      forgeSectionOf(forge, OTHER).split(OTHER).join('§'),
      'and every site it reaches is an interpolation',
    );
    assert.ok(forgeSectionOf(forge, undefined).includes(FALLBACK), 'and falls back when there is none');
  }
});

/*
 * The instruction to read the decisions file is the one line that makes the whole rulings
 * mechanism work, and it lives in prose that gets rewritten — this item rewrote it once
 * and the scrub will again. Nothing pinned it across all three briefs at once, so a
 * rewrite could quietly drop it from one and leave the other two passing.
 */
test('all three briefs still tell their session to read the decisions file', () => {
  for (const [which, brief] of everyBrief(NAME)) {
    assert.ok(brief.includes(DECISIONS), `${which} brief names the real path`);
    assert.match(brief, /[Rr]ead \S*\/decisions\.md/, `${which} brief says to read it`);
  }
});

test('the lead is told an empty decisions file is normal, not a missing one', () => {
  const brief = leadBrief({ repo: REPO, teamDir: '/Users/x/State/teams/Users-x-Code-Fake', decisionsFile: DECISIONS });
  assert.match(brief, /empty\s+decisions file is normal/i, 'the clause is there');
  assert.match(brief, /nothing has been decided yet/i, 'and says what empty means');
});

/*
 * The soak test after C5 found the maintainer's own name leaking into PR bodies and commit
 * messages — the worker brief's written-half rule covered projects only, and the lead
 * brief had no sandbox section at all, so nothing ever told it not to write the name into
 * a PR. Both briefs now carry the rule; these pin that neither can silently lose it again.
 */
test('the worker brief widens the written-half rule to the maintainer\'s name', () => {
  const brief = workerBrief({ repo: REPO, taskId: 'my-task', decisionsFile: DECISIONS });
  assert.match(brief, /never the\s+maintainer's name/, 'the rule names what not to write');
  assert.match(brief, /sandbox/i, 'and still points at the sandbox rule');
});

test('the lead brief gets its own sandbox section, addressed to what it writes to the forge', () => {
  const brief = leadBrief({ repo: REPO, teamDir: '/Users/x/State/teams/Users-x-Code-Fake', decisionsFile: DECISIONS });
  assert.match(brief, /sandbox/i, 'the lead brief mentions the sandbox rule at all');
  assert.match(brief, /never the\s+maintainer's name/, 'the rule names what not to write');
  assert.match(brief, /task_set_pr/, 'addressed to what the lead actually writes to the forge');
});

/*
 * The one place the name cannot simply be substituted. "The human (someuser) talks to
 * you" is the ruled shape, and with the fallback in it that sentence reads "The human
 * (the human) talks to you" — which is what a stranger's very first lead would have got,
 * because a repo with no `user.name` is exactly the case they hit first. Found on a
 * scratch panel, not in a test, which is why there is now a test.
 */
test('the briefs introduce the human without stuttering when nobody is named', () => {
  for (const [which, brief] of everyBrief(undefined)) {
    assert.ok(!brief.includes('the human (the human)'), `${which} brief does not stutter`);
    assert.ok(!brief.includes('The human (the human)'), `${which} brief does not stutter`);
  }
  const [[, lead], [, worker], [, planner]] = everyBrief(NAME);
  assert.match(lead, new RegExp(`The human \\(${NAME}\\) talks to you`), 'the ruled shape, named');
  assert.match(worker, new RegExp(`reports to the human \\(${NAME}\\)`));
  assert.match(planner, new RegExp(`bring your plan to the human \\(${NAME}\\)`));

  const [[, plainLead], [, plainWorker], [, plainPlanner]] = everyBrief(undefined);
  assert.match(plainLead, /The human talks to you/, 'and a plain noun when there is no name');
  assert.match(plainWorker, /reports to the human;/);
  assert.match(plainPlanner, /bring your plan to the human for approval/);
});
