import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * TEAMS_DIR is derived from STATE_DIR at import time, so the env var has to be set
 * before the module loads — same reason the store tests use dynamic import.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-team-'));
const {
  decisionsPreamble, ensureTeam, readTeam, teamKey, teamDir, leadSettings, mergeRule,
  normalizeReviewPaths, pathRule, plannerStance, plansDir, planPath,
  MAX_REVIEW_PATHS, MAX_REVIEW_PATH_LENGTH,
} = await import('../server/team.js');
const { FALLBACK, humanName } = await import('../server/human-name.js');

test.after(() => {
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

test('the key is the full path, not the basename', () => {
  assert.equal(teamKey('/Users/x/Code/Api'), 'Users-x-Code-Api');
  assert.equal(teamKey('/Users/x/Other/Api/'), 'Users-x-Other-Api', 'trailing slash');
  // Two repos called Api must not share a team — the whole reason for the convention.
  assert.notEqual(teamKey('/Users/x/Code/Api'), teamKey('/Users/x/Other/Api'));
});

test('ensure seeds the layout once and is idempotent', () => {
  const repo = '/Users/x/Code/Fake';
  const { dir, config, decisionsFile } = ensureTeam(repo);
  assert.equal(dir, teamDir(repo));
  assert.equal(config.maxWorkers, 3);
  assert.equal(config.toggles.answerPermissionPrompts, false, 'answering starts off');
  assert.equal(config.toggles.mergePRs, false, 'visibly no, not unspecified');
  assert.ok(fs.existsSync(decisionsFile));
  const seeded = fs.readFileSync(decisionsFile, 'utf8');

  // Second ensure: config re-written, decisions NOT re-seeded.
  fs.appendFileSync(decisionsFile, '\n- a ruling\n');
  ensureTeam(repo);
  assert.ok(fs.readFileSync(decisionsFile, 'utf8').includes('a ruling'), 'rulings survive');
  assert.notEqual(fs.readFileSync(decisionsFile, 'utf8'), seeded);
});

test('stored config wins, new defaults fill gaps', () => {
  const repo = '/Users/x/Code/Tuned';
  const { configFile } = ensureTeam(repo);
  // Hand-tune, drop a key, add nothing else — the shape an old team.json has after a
  // new toggle ships.
  fs.writeFileSync(configFile, JSON.stringify({ maxWorkers: 5, toggles: { openPRs: false } }));
  const team = readTeam(repo);
  assert.equal(team.maxWorkers, 5, 'tuned value kept');
  assert.equal(team.toggles.openPRs, false, 'tuned toggle kept');
  assert.equal(team.toggles.flagConflicts, true, 'missing toggle takes its default');

  // The self-merge pair, in the same shape: a `team.json` written before this shipped
  // carries neither key, and reads them at their defaults rather than at `undefined`.
  // This is what "a maintainer on an older team.json sees nothing change" means in code.
  assert.equal(team.toggles.leadDecidesMerges, false, 'off, and off is what nothing means');
  assert.deepEqual(team.humanReviewPaths, [], 'and no paths are reserved, because the toggle is off');
});

test('the panel fold is remembered per team, and stays out of the dials', () => {
  const repo = '/Users/x/Code/Folded';
  const { config, configFile } = ensureTeam(repo);
  assert.equal(config.ui.settingsOpen, false, 'closed is the default, visibly');
  assert.equal(config.toggles.settingsOpen, undefined, 'chrome never joins the autonomy dials');

  // A team.json written before this existed still answers, at the default.
  fs.writeFileSync(configFile, JSON.stringify({ maxWorkers: 2 }));
  assert.equal(readTeam(repo).ui.settingsOpen, false, 'missing ui takes its default');

  // And an opened one is still open on the next read — the point of storing it here
  // rather than in one browser's localStorage.
  fs.writeFileSync(configFile, JSON.stringify({ ui: { settingsOpen: true } }));
  assert.equal(readTeam(repo).ui.settingsOpen, true);
  assert.equal(ensureTeam(repo).config.ui.settingsOpen, true, 'and ensure does not reset it');
});

test('a repo with no team reads as null', () => {
  assert.equal(readTeam('/Users/x/Code/Nowhere'), null);
});

test('the dispatch defaults: Opus workers, leadMerges off', () => {
  const { config } = ensureTeam('/Users/x/Code/Defaults');
  assert.equal(config.defaultModel, 'claude-opus-5', 'the ruled default is Opus');
  assert.equal(config.toggles.leadMerges, false, 'trust is handed over explicitly, never seeded');
});

test('a fresh team decides no merges of its own, and reserves nothing', () => {
  const { config, configFile } = ensureTeam('/Users/x/Code/SelfMerge');
  assert.equal(config.toggles.leadDecidesMerges, false, 'the maintainer turns this on, nothing seeds it');
  assert.deepEqual(config.humanReviewPaths, []);

  // Top level, not in `toggles` — `toggles` is the autonomy dials, booleans and one
  // number, and a path list in there reads as a permission. Same reason `triggers` is
  // top-level.
  assert.equal(config.toggles.humanReviewPaths, undefined);
  const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(onDisk.humanReviewPaths, [], 'written, so it is visibly empty rather than absent');
  assert.equal(onDisk.toggles.leadDecidesMerges, false);
});

/* --------------------------------------------- humanReviewPaths, the shape --- */

/*
 * One function decides what an entry is, so the PATCH validator and the matcher cannot
 * disagree — and it refuses the whole list rather than dropping the bad entry. That is
 * `trigger.js`'s `compile()` rule with a sharper reason: a dropped entry makes the safety
 * list *shorter*, which fails towards merging something the maintainer wanted to see.
 */

test('a review path is tidied to one spelling, de-duplicated and sorted', () => {
  assert.deepEqual(normalizeReviewPaths([]), []);
  assert.deepEqual(normalizeReviewPaths(undefined), [], 'an absent key is the empty list');

  // Four spellings of one folder, and a file beside it.
  assert.deepEqual(
    normalizeReviewPaths(['./server/', '/server', 'server//', 'server', 'SECURITY.md']),
    ['SECURITY.md', 'server'],
  );
  assert.deepEqual(normalizeReviewPaths(['  web/m  ']), ['web/m'], 'trimmed — a trailing space matches nothing');
  assert.deepEqual(normalizeReviewPaths(['a//b///c']), ['a/b/c'], 'repeated slashes collapse');
  assert.deepEqual(normalizeReviewPaths(['b', 'a']), ['a', 'b'], 'sorted, so the panel shows it back stably');
});

test('a bad entry refuses the whole list, and the message names it', () => {
  const refused = (list) => {
    let message = null;
    assert.throws(() => normalizeReviewPaths(list), (err) => ((message = err.message), true));
    return message;
  };

  // Globs: the repo carries no glob matcher, and a `*` matched literally against git's
  // output would match nothing — a hole in a safety list, silently.
  assert.match(refused(['server', 'web/**']), /"web\/\*\*"/);
  assert.match(refused(['web/**']), /prefixes, not globs/);
  // Out of the repo, and inert-in-the-match, both by name.
  assert.match(refused(['../etc']), /"\.\.\/etc"/);
  assert.match(refused(['.']), /"\."/);
  assert.match(refused(['a\0b']), /null byte/);
  assert.match(refused(['']), /empty/);
  assert.match(refused([42]), /"?42"?/);
  assert.match(refused([null]), /not a path/);

  // A list is a list. `null` and a bare string are somebody's typo, and reading either as
  // "nothing is reserved" is the fail-open this function exists to prevent.
  assert.match(refused(null), /must be a list/);
  assert.match(refused('server'), /must be a list/);

  // Caps, both of them, and the count is in the message.
  assert.match(refused([`${'a'.repeat(MAX_REVIEW_PATH_LENGTH + 1)}`]), new RegExp(`${MAX_REVIEW_PATH_LENGTH}`));
  const many = Array.from({ length: MAX_REVIEW_PATHS + 1 }, (_, i) => `d${i}`);
  assert.match(refused(many), new RegExp(`${MAX_REVIEW_PATHS + 1} entries`));
  assert.equal(normalizeReviewPaths(many.slice(0, MAX_REVIEW_PATHS)).length, MAX_REVIEW_PATHS, 'the cap itself is fine');

  // And the whole list goes: the good entry beside the bad one is not quietly kept.
  assert.throws(() => normalizeReviewPaths(['server', 'web/**']));
});

test('the merge rule is the forge\'s own, and there is no general one', () => {
  const repo = '/Users/x/Code/Api';
  const dir = '/Users/x/state/teams/key';
  const allowFor = (forge) => leadSettings({ repo, dir, leadMerges: true, forge }).permissions.allow;

  // Gitea: one tool that both opens and merges — the reason the toggle is dangerous, and
  // a fact about Gitea rather than about forges.
  assert.ok(allowFor({ forge: 'gitea', via: 'mcp' }).includes('mcp__gitea__pull_request_write'));

  // GitHub through `gh`: a Bash prefix, and genuinely narrow — `gh pr merge` cannot open
  // a PR, so this rule does not carry Gitea's trade at all.
  assert.deepEqual(allowFor({ forge: 'github', via: 'gh' }).filter((r) => r.startsWith('Bash')), ['Bash(gh pr merge:*)']);

  // GitHub through an MCP server: nothing. Nobody here has run that server, so its tool
  // name is unverified — and an unverified name in an allow rule is a rule that silently
  // does nothing, which is worse than a prompt the lead can answer. The panel's copy says
  // so rather than the settings pretending.
  assert.equal(allowFor({ forge: 'github', via: 'mcp' }).length, 1, 'the team dir write, and nothing else');

  // No forge: the toggle can be on and grants nothing, because there is nothing to merge.
  assert.equal(allowFor(null).length, 1);
  assert.equal(mergeRule(null), null);
  assert.equal(mergeRule({ forge: null, via: null }), null);
});

test('pathRule double-slashes the absolute path', () => {
  // A plain absolute path in an Edit rule silently matches nothing — measured, Wave B.0.
  assert.equal(pathRule('Edit', '/Users/x/Code/Api'), 'Edit(//Users/x/Code/Api/**)');
});

test('leadMerges gains and loses the gitea allow rule', () => {
  const repo = '/Users/x/Code/Api';
  const dir = '/Users/x/state/teams/key';
  const gitea = { forge: 'gitea', via: 'mcp' };
  const off = leadSettings({ repo, dir, leadMerges: false, forge: gitea });
  const on = leadSettings({ repo, dir, leadMerges: true, forge: gitea });

  assert.ok(!off.permissions.allow.includes('mcp__gitea__pull_request_write'), 'off: the rule is absent');
  assert.ok(on.permissions.allow.includes('mcp__gitea__pull_request_write'), 'on: the rule is present');
  assert.ok(!leadSettings({ repo, dir, forge: gitea }).permissions.allow.includes('mcp__gitea__pull_request_write'), 'unspecified means off');

  // The stance the toggle must never loosen: the checkout stays denied, the team dir
  // stays the only writable place, and git commit/push stay refused.
  for (const settings of [off, on]) {
    assert.ok(settings.permissions.deny.includes(pathRule('Edit', repo)), 'the lead never writes code');
    assert.ok(settings.permissions.deny.includes('Bash(git commit:*)'));
    assert.ok(settings.permissions.deny.includes('Bash(git push:*)'));
    assert.ok(settings.permissions.allow.includes(pathRule('Edit', dir)));
    assert.ok(!settings.permissions.deny.some((r) => r.startsWith('Write(')), 'Write rules are dead — Edit only');
  }
});

test('ensure seeds the plans folder, so the planner\'s allow rule points at something real', () => {
  const repo = '/Users/x/Code/Planned';
  const { dir } = ensureTeam(repo);
  assert.equal(plansDir(repo), path.join(dir, 'plans'));
  assert.ok(fs.existsSync(plansDir(repo)), 'made at ensure, not at dispatch');
  assert.equal(planPath(repo, 'big-thing'), path.join(dir, 'plans', 'big-thing.md'));
});

test('the planner stance: writes nowhere but plans, and never a branch', () => {
  const repo = '/Users/x/Code/Api';
  const worktree = '/Users/x/state/worktrees/Api-plan-it';
  const plans = plansDir(repo);
  const s = plannerStance({ repo, worktree, plans, worktreesRoot: '/Users/x/state/worktrees' });

  assert.deepEqual(s.allow, [pathRule('Edit', plans)], 'exactly one writable place');
  assert.ok(s.deny.includes(pathRule('Edit', repo)), 'the real checkout, same as the lead');
  assert.ok(s.deny.includes(pathRule('Edit', worktree)), 'its own worktree — a planner writes no code anywhere');
  assert.ok(s.deny.includes(pathRule('Edit', '/Users/x/state/worktrees')), 'nor into a build worker\'s');
  assert.ok(s.deny.includes('Bash(git commit:*)') && s.deny.includes('Bash(git push:*)'));

  // The load-bearing shape: deny beats allow, so the allowed path must be *below* the
  // team dir rather than the team dir with carve-outs — decisions.md is the human's memory
  // and lead-settings.json is the lead's own stance, both one level up.
  assert.ok(s.allow[0].startsWith(`Edit(//${teamDir(repo).replace(/^\//, '')}/plans/`));
  assert.ok(!s.allow.includes(pathRule('Edit', teamDir(repo))), 'never the team dir itself');
});

/* ------------------------------------------------ the decisions preamble --- */

/*
 * A header, never seeded rules. A lead reads this file as authority, so anything in it
 * that parses as a ruling is obeyed as though a human had decided it — which is exactly
 * the thing the file exists to guarantee did happen. The test a human applies is "could
 * this be mistaken for a ruling if it were read aloud"; what a test can check is the
 * shape that makes that possible: no dated entries, no imperative rules, and prose that
 * says outright it is not one.
 */

test('a new team gets an explanation of its decisions file, and no rulings in it', () => {
  const text = decisionsPreamble('/Users/x/Code/Alpha');

  assert.match(text, /^# Decisions — Alpha\n/, 'headed by the repo it belongs to');
  assert.match(text, /## About this file/, 'and the seeded part says what it is');

  // What it has to teach someone who has never run this.
  assert.match(text, /re-reads it before its first reply in every session/, 'when the lead reads it');
  assert.match(text, /the team lead appends it here/, 'who writes it');
  assert.match(text, /[Ww]orkers read it too/, 'and who else obeys it');
  assert.match(text, /binding/, 'a worker treats a relevant ruling as binding');
  assert.match(text, /cleared|clear/, 'and why it lives outside the conversation');
  assert.match(text, /no rulings yet/i, 'it says plainly that it holds none');

  // Not a ruling, in the two shapes a lead would read as one.
  assert.doesNotMatch(text, /^## \d{4}-\d{2}-\d{2}/m, 'no dated entry');
  assert.doesNotMatch(text, /^\s*[-*] /m, 'no bulleted list of rules');
  // The guard that matters once this is published: not the absence of one former name,
  // but that the seed can never pick up whoever happens to own the machine it runs on.
  const me = humanName(process.cwd());
  if (me !== FALLBACK) assert.ok(!text.includes(me), 'and it names nobody, this machine included');
});

test('the seed writes once and never touches an existing decisions file', () => {
  const repo = '/Users/x/Code/Preamble';
  const { decisionsFile } = ensureTeam(repo);
  assert.equal(fs.readFileSync(decisionsFile, 'utf8'), decisionsPreamble(repo), 'seeded verbatim');

  // The real risk this guards: somebody rewording the preamble and it landing on top of
  // a file that already holds a year of somebody's rulings.
  fs.writeFileSync(decisionsFile, '# Decisions — mine\n\n## 2026-01-01 — a real ruling\n');
  ensureTeam(repo);
  assert.equal(
    fs.readFileSync(decisionsFile, 'utf8'),
    '# Decisions — mine\n\n## 2026-01-01 — a real ruling\n',
    'an existing file is never re-headed, reformatted or re-seeded',
  );
});
