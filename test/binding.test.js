import assert from 'node:assert/strict';
import test from 'node:test';
import { bindPanes, unboundReason } from '../server/binding.js';

const CWD = '/Code/Alpha';
const T = (h) => Date.UTC(2026, 7, 24, h); // hour -> ms, for readable fixtures

const pane = (paneId, label, createdHour) => ({
  paneId,
  cwd: CWD,
  label,
  createdMs: createdHour === undefined ? 0 : T(createdHour),
});

const meta = (sessionId, title, mtimeHour) => ({
  sessionId,
  cwd: CWD,
  title,
  mtime: T(mtimeHour),
});

const bind = (panes, metas, hook = () => null) =>
  bindPanes({ panes, metas, hookBindingFor: hook });

test('a hook binding beats everything else', () => {
  const { bound } = bind(
    [pane('%1', 'alpha-main', 1)],
    [meta('s-old', 'alpha-main', 5), meta('s-hooked', 'something-else', 6)],
    (p) => (p === '%1' ? 's-hooked' : null),
  );
  assert.equal(bound.get('s-hooked').confidence, 'hook');
  assert.equal(bound.has('s-old'), false);
});

test('the label matches its transcript exactly', () => {
  const { bound } = bind(
    [pane('%1', 'alpha-main', 1)],
    [meta('s1', 'alpha-main', 5), meta('s2', 'alpha-other', 6)],
  );
  assert.equal(bound.get('s1').confidence, 'label');
  assert.equal(bound.has('s2'), false);
});

test('label matching is case-insensitive, so legacy repo-branch titles still bind', () => {
  // Older sessions were named `<repo>-<branch>` — "Alpha-main" vs label "alpha-main".
  const { bound } = bind([pane('%1', 'alpha-main', 1)], [meta('s1', 'Alpha-main', 5)]);
  assert.equal(bound.get('s1').confidence, 'label');
});

test('a brand-new pane does not adopt yesterday history', () => {
  // The bug: a pane opened at 10:00 was handed a transcript last written at 06:00.
  const { bound, unbound } = bind([pane('%9', 'alpha-testlabel', 10)], [meta('old', 'Alpha-main', 6)]);
  assert.equal(bound.size, 0);
  assert.equal(unbound.length, 1);
});

test('a restarted session does not adopt its own previous run', () => {
  // Same label, but the file stopped changing before this pane existed.
  const { bound, unbound } = bind(
    [pane('%9', 'alpha-testlabel', 12)],
    [meta('prev-run', 'alpha-testlabel', 8)],
  );
  assert.equal(bound.size, 0, 'the previous run is a different session');
  assert.equal(unbound[0].paneId, '%9');
});

test('a sibling does not inherit an exited session transcript', () => {
  // testlabel exited leaving its transcript behind; quesitons shares the folder with
  // alpha-main, so the folder is ambiguous and only an exact label match binds.
  const { bound } = bind(
    [pane('%1', 'alpha-main', 1), pane('%2', 'alpha-quesitons', 1)],
    [meta('orphan', 'alpha-testlabel', 20)],
  );
  assert.equal(bound.size, 0);
});

test('a lone pane keeps its history even when the title predates the naming change', () => {
  // Sessions started before --name carried the label are titled `<repo>-<branch>`:
  // label `beta-main` against title `Beta`. One pane in the folder means
  // there is nothing it could be confused with.
  const { bound } = bind(
    [{ paneId: '%5', cwd: '/Code/Beta', label: 'beta-main', createdMs: T(1) }],
    [{ sessionId: 's1', cwd: '/Code/Beta', title: 'Beta', mtime: T(9) }],
  );
  assert.equal(bound.get('s1').confidence, 'inferred');
});

test('a shared folder refuses the same mismatched title', () => {
  // Identical data to the test above, except a sibling pane exists.
  const panes = [
    { paneId: '%5', cwd: '/Code/Beta', label: 'beta-main', createdMs: T(1) },
    { paneId: '%6', cwd: '/Code/Beta', label: 'beta-other', createdMs: T(1) },
  ];
  const { bound } = bind(panes, [
    { sessionId: 's1', cwd: '/Code/Beta', title: 'Beta', mtime: T(9) },
  ]);
  assert.equal(bound.size, 0, 'ambiguous folder: exact label match only');
});

test('a lone pane still refuses a file naming another live pane', () => {
  const panes = [
    { paneId: '%5', cwd: '/Code/A', label: 'a-main', createdMs: T(1) },
    { paneId: '%6', cwd: '/Code/B', label: 'b-main', createdMs: T(1) },
  ];
  const { bound } = bind(panes, [{ sessionId: 's1', cwd: '/Code/A', title: 'b-main', mtime: T(9) }]);
  assert.equal(bound.size, 0);
});

test('two panes in one directory never share a transcript', () => {
  const { bound } = bind(
    [pane('%1', 'alpha-main', 1), pane('%2', 'alpha-quesitons', 1)],
    [meta('s1', 'alpha-main', 10), meta('s2', 'alpha-quesitons', 11)],
  );
  assert.equal(bound.get('s1').pane.paneId, '%1');
  assert.equal(bound.get('s2').pane.paneId, '%2');
  assert.equal(bound.size, 2);
});

test('an unlabelled pane still gets the newest transcript', () => {
  // Hand-started sessions have no launcher-minted label; the old heuristic is fine there.
  const { bound } = bind(
    [{ paneId: '%1', cwd: CWD, label: null, createdMs: T(1) }],
    [meta('older', 'whatever', 5), meta('newest', 'whatever', 9)],
  );
  assert.equal(bound.get('newest').confidence, 'inferred');
  assert.equal(bound.has('older'), false);
});

test('a labelled pane binds an untitled transcript', () => {
  const { bound } = bind([pane('%1', 'alpha-main', 1)], [meta('s1', null, 9)]);
  assert.equal(bound.get('s1').confidence, 'inferred');
});

test('unboundReason separates "never spoke" from "cannot tell"', () => {
  const p = pane('%9', 'alpha-quesitons', 10);
  assert.equal(unboundReason(p, []), 'new');
  assert.equal(unboundReason(p, [meta('x', 'Alpha-main', 6)]), 'new', 'older than the pane');
  assert.equal(unboundReason(p, [meta('x', 'Alpha-main', 12)]), 'ambiguous');
});

test('a repo-branch title is not proof of ownership when siblings compete', () => {
  // The wrapper's default title is `<repo>-<branch>`. A pane labelled `main` on branch
  // `main` produces `Alpha-main` — and so does every other session in that folder, so
  // matching it proves nothing.
  const panes = [pane('%1', 'alpha-main', 1), pane('%2', 'alpha-quesitons', 1)];
  panes.forEach((p) => (p.defaultTitle = 'Alpha-main'));
  const metas = [{ sessionId: 's1', cwd: CWD, title: 'Alpha-main', mtime: T(9) }];
  const { bound } = bind(panes, metas);
  assert.equal(bound.size, 0, 'must not claim an exact match it cannot prove');
});

test('a label-derived title still binds when siblings compete', () => {
  // `alpha-testlabel` could not have come from repo-branch, so it identifies its owner.
  const panes = [pane('%1', 'alpha-main', 1), pane('%2', 'alpha-testlabel', 1)];
  panes.forEach((p) => (p.defaultTitle = 'Alpha-main'));
  const metas = [{ sessionId: 's1', cwd: CWD, title: 'alpha-testlabel', mtime: T(9) }];
  const { bound } = bind(panes, metas);
  assert.equal(bound.get('s1').confidence, 'label');
  assert.equal(bound.get('s1').pane.paneId, '%2');
});

test('a repo-branch title is fine when the pane is alone in its folder', () => {
  const panes = [
    { paneId: '%1', cwd: '/Code/Beta', label: 'beta-main', createdMs: T(1),
      defaultTitle: 'Beta-main' },
  ];
  const metas = [{ sessionId: 's1', cwd: '/Code/Beta', title: 'Beta-main', mtime: T(9) }];
  const { bound } = bind(panes, metas);
  assert.equal(bound.get('s1').confidence, 'label', 'no sibling, nothing to confuse it with');
});

test('a label that collides with the branch still binds when no sibling could be the impostor', () => {
  // The trap: a session labelled `main` on branch `main` produces the title
  // `Alpha-main` — identical to the old `<repo>-<branch>` default. Guarding against
  // that blocked the legitimate binding until both panes were known modern namers.
  const panes = [
    { paneId: '%1', cwd: CWD, label: 'alpha-main', createdMs: T(11), defaultTitle: 'Alpha-main', modernNamer: true },
    { paneId: '%2', cwd: CWD, label: 'alpha-secondary', createdMs: T(11), defaultTitle: 'Alpha-main', modernNamer: true },
  ];
  const { bound } = bind(panes, [meta('mine', 'alpha-main', 12)]);
  assert.equal(bound.get('mine').confidence, 'label');
  assert.equal(bound.get('mine').pane.paneId, '%1');
});

test('...but not while a sibling predates the naming change', () => {
  // quesitons launched before the wrapper stamped labels, so it still writes
  // `Alpha-main` too. Neither can be told apart, so neither binds.
  const panes = [
    { paneId: '%1', cwd: CWD, label: 'alpha-main', createdMs: T(11), defaultTitle: 'Alpha-main', modernNamer: true },
    { paneId: '%2', cwd: CWD, label: 'alpha-quesitons', createdMs: T(1), defaultTitle: 'Alpha-main', modernNamer: false },
  ];
  const { bound } = bind(panes, [meta('contested', 'Alpha-main', 12)]);
  assert.equal(bound.size, 0);
});

test('a distinct label binds regardless of sibling vintage', () => {
  const panes = [
    { paneId: '%1', cwd: CWD, label: 'alpha-secondary', createdMs: T(11), defaultTitle: 'Alpha-main', modernNamer: true },
    { paneId: '%2', cwd: CWD, label: 'alpha-quesitons', createdMs: T(1), defaultTitle: 'Alpha-main', modernNamer: false },
  ];
  const { bound } = bind(panes, [meta('mine', 'alpha-secondary', 12)]);
  assert.equal(bound.get('mine').confidence, 'label');
});

/* --------------------------------------------------- a binding, once made, sticks --- */

test('a sibling starting up does not unbind the session already reading', () => {
  const first = pane('%1', 'foreman-1', 1);
  const metas = [meta('s1', 'Foreman', 5)];

  // Alone in the folder, %1 is bound by inference even though the names differ.
  const before = bindPanes({ panes: [first], metas });
  assert.equal(before.bound.get('s1').confidence, 'inferred');

  // A second session opens in the same folder. Nothing about %1 changed.
  const second = pane('%2', 'foreman-2', 6);
  const after = bindPanes({
    panes: [first, second],
    metas,
    rememberedFor: (id) => (id === '%1' ? 's1' : null),
  });
  assert.equal(after.bound.get('s1').pane.paneId, '%1');
  assert.deepEqual(after.unbound.map((p) => p.paneId), ['%2']);
});

test('a remembered binding is dropped once it stops holding up', () => {
  // The transcript is older than the pane, so it cannot be that pane's — memory or not.
  const { bound } = bindPanes({
    panes: [pane('%1', 'alpha-main', 6)],
    metas: [meta('s1', 'Alpha-main', 2)],
    rememberedFor: () => 's1',
  });
  assert.equal(bound.has('s1'), false);
});

test('a hook still overrules what we remembered', () => {
  const { bound } = bindPanes({
    panes: [pane('%1', 'alpha-main', 1)],
    metas: [meta('s1', 'Alpha-main', 5), meta('s2', 'other', 6)],
    hookBindingFor: () => 's2',
    rememberedFor: () => 's1',
  });
  assert.equal(bound.get('s2').confidence, 'hook');
  assert.equal(bound.has('s1'), false);
});

test('the last pane and the last transcript in a folder find each other', () => {
  // Two panes, and the newer one names itself. What is left over is not a guess.
  const { bound } = bind(
    [pane('%1', 'foreman-1', 1), pane('%2', 'foreman-2', 6)],
    [meta('s-old', 'Foreman', 5), meta('s-new', 'foreman-2', 7)],
  );
  assert.equal(bound.get('s-new').confidence, 'label');
  assert.equal(bound.get('s-old').pane.paneId, '%1');
});

test('two unbound panes over one folder stay unbound', () => {
  const { bound, unbound } = bind(
    [pane('%1', 'a-1', 1), pane('%2', 'a-2', 1)],
    [meta('s1', 'Repo-main', 5), meta('s2', 'Repo-main', 6)],
  );
  assert.equal(bound.size, 0);
  assert.deepEqual(unbound.map((p) => p.paneId), ['%1', '%2']);
});

test('a /clear chain does not count as rivals for the pane that wrote it', () => {
  // One pane, all day, `/clear`ing twice: three transcripts, one live conversation.
  const chain = (id, fromHour, toHour) => ({
    sessionId: id,
    cwd: CWD,
    title: 'Alpha-main',
    firstTs: new Date(T(fromHour)).toISOString(),
    lastTs: new Date(T(toHour)).toISOString(),
    mtime: T(toHour),
  });
  const { bound } = bind(
    [pane('%1', 'alpha-1', 1), pane('%2', 'alpha-2', 9)],
    [
      chain('s-first', 2, 5),
      chain('s-middle', 5, 8),
      chain('s-live', 8, 11),
      { ...chain('s-two', 10, 12), title: 'alpha-2' },
    ],
  );
  assert.equal(bound.get('s-two').confidence, 'label');
  assert.equal(bound.get('s-live').pane.paneId, '%1');
  assert.equal(bound.has('s-first'), false);
});

test('a remembered label match is still a label match', () => {
  const { bound } = bindPanes({
    panes: [pane('%1', 'alpha-main', 1)],
    metas: [meta('s1', 'alpha-main', 5)],
    rememberedFor: () => ({ sessionId: 's1', confidence: 'label' }),
  });
  assert.equal(bound.get('s1').confidence, 'label');
});

/* ------------------------------------------- a session that changed directory --- */

/*
 * Claude Code stamps `cwd` on every record and rewrites it when the session moves — so a
 * conversation that started in `Alpha` and is now working in `Alpha/alpha-dev/backend`
 * records a directory its pane will never match. What doesn't move is the folder Claude
 * Code filed the transcript under, which is named after the directory it launched in.
 *
 * Found live: a session with a unique label, a pane, and a perfectly good transcript read
 * "can't tell which history is this one's" for as long as it stayed in the subfolder.
 */
const moved = (sessionId, title, mtimeHour, into) => ({
  sessionId,
  cwd: `${CWD}/${into}`, // where it is now
  projectDir: CWD.replace(/\//g, '-'), // where it started, and where the file lives
  title,
  mtime: T(mtimeHour),
});

test('a session that moved into a subfolder still binds to its pane', () => {
  const { bound } = bind(
    [pane('%1', 'alpha-main', 1), pane('%2', 'alpha-secondary', 1)],
    [meta('s1', 'alpha-main', 5), moved('s2', 'alpha-secondary', 6, 'alpha-dev/backend')],
  );
  assert.equal(bound.get('s2').confidence, 'label');
  assert.equal(bound.get('s2').pane.paneId, '%2');
});

test('the launch folder decides, not the recorded cwd', () => {
  // The mirror image: a transcript that started somewhere else and wandered *into* this
  // pane's directory. Its cwd now matches, and it is still not this pane's.
  const stranger = {
    sessionId: 's-stranger',
    cwd: CWD,
    projectDir: '-Code-SomewhereElse',
    title: 'alpha-main',
    mtime: T(6),
  };
  const { bound, unbound } = bind([pane('%1', 'alpha-main', 1)], [stranger]);
  assert.equal(bound.has('s-stranger'), false);
  assert.equal(unbound.length, 1);
});

test('a moved session counts as a candidate when saying why a pane is unbound', () => {
  const p = pane('%1', 'alpha-secondary', 1);
  assert.equal(unboundReason(p, [moved('s2', 'someone-else', 6, 'alpha-dev/backend')]), 'ambiguous');
  assert.equal(unboundReason(p, []), 'new');
});
