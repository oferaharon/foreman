import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * WORKER_SETTINGS_DIR is derived from STATE_DIR at import time — scratch dir before the
 * module loads, same as the other store tests. The model resolver is pure; the settings
 * writer is not, and the settings-file tests below read what actually landed on disk,
 * because that file is what enforces a planner's "cannot write code".
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-dispatch-'));
const { resolveWorkerModel, WORKER_MODELS, DEFAULT_WORKER_MODEL, writeWorkerSettings, WORKER_SETTINGS_DIR, GIT_DENY } =
  await import('../server/dispatch.js');
const { plannerStance, pathRule } = await import('../server/team.js');

test.after(() => {
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

test('no choice anywhere → Opus, marked as the default', () => {
  const r = resolveWorkerModel(undefined, undefined);
  assert.equal(r.model, 'claude-opus-5');
  assert.equal(r.model, DEFAULT_WORKER_MODEL);
  assert.equal(r.isDefault, true, 'the room hears nothing about a default launch');
});

test('the team default fills in when the lead names nothing', () => {
  const r = resolveWorkerModel('', 'claude-sonnet-5');
  assert.equal(r.model, 'claude-sonnet-5');
  assert.equal(r.isDefault, true);
});

test('an explicit model wins, and is not the default', () => {
  const r = resolveWorkerModel('claude-fable-5', 'claude-opus-5');
  assert.equal(r.model, 'claude-fable-5');
  assert.equal(r.defaultModel, 'claude-opus-5');
  assert.equal(r.isDefault, false, 'a departure — the room gets a line');
});

test('naming the default explicitly is not a departure', () => {
  // The room line exists so the maintainer sees the lead's judgment calls; a lead that spelled
  // out the default made no call worth a line.
  const r = resolveWorkerModel('claude-opus-5', 'claude-opus-5');
  assert.equal(r.isDefault, true);
});

test('the [1m] suffix rides on any known id', () => {
  assert.equal(resolveWorkerModel('claude-fable-5[1m]', null).model, 'claude-fable-5[1m]');
  assert.equal(resolveWorkerModel(null, 'claude-sonnet-5[1m]').model, 'claude-sonnet-5[1m]');
});

test('an unknown model fails the dispatch, naming the list', () => {
  // The value becomes a --model launch flag — this refusal is the wall between "the
  // lead picks a model" and "the lead picks launch flags".
  assert.throws(() => resolveWorkerModel('gpt-5', null), /Unknown model "gpt-5"/);
  assert.throws(() => resolveWorkerModel('gpt-5', null), new RegExp(WORKER_MODELS[0]));
  assert.throws(() => resolveWorkerModel('claude-opus-5 --dangerously-skip-permissions', null), /Unknown model/);
  assert.throws(() => resolveWorkerModel('[1m]', null), /Unknown model/, 'a bare suffix is not a model');
});

test('a corrupted stored default fails loudly, even under an explicit choice', () => {
  // Only a hand-edit can store one (the PATCH endpoint validates) — surface it on the
  // next dispatch, whichever dispatch that is, not on the one unlucky enough to omit
  // `model`.
  assert.throws(() => resolveWorkerModel(null, 'claude-nonsense'), /defaultModel "claude-nonsense"/);
  assert.throws(() => resolveWorkerModel('claude-opus-5', 'claude-nonsense'), /defaultModel/);
});

test('every id on the list resolves, plain and [1m]', () => {
  for (const id of WORKER_MODELS) {
    assert.equal(resolveWorkerModel(id, null).model, id);
    assert.equal(resolveWorkerModel(`${id}[1m]`, null).model, `${id}[1m]`);
  }
});

/* ------------------------------------------------- the settings file itself --- */

const readSettings = async (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a build worker\'s settings are the floor and the repo\'s own commands', async () => {
  const file = await writeWorkerSettings({ repo: '/Users/x/Code/Api', label: 'build-one', allow: ['Bash(npm test:*)'] });
  const s = await readSettings(file);
  assert.equal(s.agentPushNotifEnabled, false, 'the lead is the single notifying entity');
  assert.deepEqual(s.permissions.allow, ['Bash(npm test:*)']);
  assert.deepEqual(s.permissions.deny, GIT_DENY, 'nothing extra — a builder writes code');
  assert.ok(!s.permissions.deny.some((r) => r.startsWith('Edit(')), 'a builder may edit its worktree');
});

test('a planner is denied the checkout and every worktree, and allowed exactly the plans dir', async () => {
  // This file is the enforcement. The brief tells the planner it cannot write code; this
  // is what makes that true, so it is checked against the file on disk, not the object.
  const repo = '/Users/x/Code/Api';
  const worktree = '/Users/x/state/worktrees/Api-plan-it';
  const plans = '/Users/x/state/teams/Users-x-Code-Api/plans';
  const stance = plannerStance({ repo, worktree, plans, worktreesRoot: '/Users/x/state/worktrees' });
  const file = await writeWorkerSettings({
    repo, label: 'plan-it', allow: ['Bash(npm test:*)', ...stance.allow], deny: stance.deny,
  });
  const s = await readSettings(file);

  for (const rule of [pathRule('Edit', repo), pathRule('Edit', worktree), pathRule('Edit', '/Users/x/state/worktrees')]) {
    assert.ok(s.permissions.deny.includes(rule), `denied: ${rule}`);
  }
  assert.ok(s.permissions.deny.includes('Bash(git commit:*)'), 'a planner produces a document, not a branch');
  assert.ok(s.permissions.deny.includes('Bash(git push:*)'));
  for (const floor of GIT_DENY) {
    assert.ok(s.permissions.deny.includes(floor), `the destructive-git floor survives: ${floor}`);
  }
  assert.ok(s.permissions.allow.includes(pathRule('Edit', plans)), 'the one place it may write');
  assert.ok(s.permissions.allow.includes('Bash(npm test:*)'), 'reading a repo means running its tests');

  // Deny beats allow, so the allow has to be narrower than the team dir — a planner that
  // could reach one level up could rewrite decisions.md, which is the maintainer's own memory.
  assert.ok(
    !s.permissions.allow.some((r) => r === pathRule('Edit', '/Users/x/state/teams/Users-x-Code-Api')),
    'never the team dir itself',
  );
  assert.ok(!s.permissions.deny.some((r) => r.startsWith('Write(')), 'Write rules are dead — Edit only');
  assert.ok(
    s.permissions.deny.concat(s.permissions.allow).every((r) => !/\((?!\/\/)\//.test(r)),
    'every path rule double-slashes — a single slash silently matches nothing',
  );
});

test('the settings file lands under the worker-settings dir, named for repo and label', async () => {
  const file = await writeWorkerSettings({ repo: '/Users/x/Code/Api', label: 'named' });
  assert.equal(file, path.join(WORKER_SETTINGS_DIR, 'Api-named.json'));
});
