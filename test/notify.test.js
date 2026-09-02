import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePane } from '../server/tmux.js';
import { needsKind, isReview, step, alertText } from '../web/notify.js';

/*
 * What the panel will interrupt somebody for.
 *
 * The module is pure on purpose — no DOM, no `Notification`, no storage — so the rule can
 * be pinned here rather than only in a browser. The wiring in `web/app.js` decides whether
 * to *show*; everything below decides what happened, and those are the two halves that
 * must not be confused: a bug in the wiring is a notification that doesn't appear, a bug
 * here is one that appears for the wrong reason, at the wrong time, or never.
 *
 * Every field these rows carry is a field the roster already broadcasts — `status`,
 * `prompt`, `plan`, `question`, `team` — which is the whole reason this feature needed no
 * server change and no restart.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** A roster row with nothing wrong with it, which every case below varies from. */
const idle = (over = {}) => ({
  id: 's1',
  title: 'alpha-main',
  project: 'alpha',
  status: 'idle',
  prompt: null,
  plan: null,
  question: null,
  team: null,
  ...over,
});

/* ─────────────────────────────────────────────────────────── what counts ─── */

test('an idle session, and a working one, want nothing', () => {
  assert.equal(needsKind(idle()), null);
  assert.equal(needsKind(idle({ status: 'working' })), null);
});

test('the three screens the issue named, each read as itself', () => {
  assert.equal(needsKind(idle({ status: 'needs-decision', prompt: { options: [] } })), 'permission');
  assert.equal(needsKind(idle({ status: 'dialog', question: { options: [] } })), 'question');
  assert.equal(needsKind(idle({ status: 'needs-decision', plan: { options: [] } })), 'plan');
});

test('a question box is recognised by its own field, not by its status', () => {
  // The trap this pins: a question box reports `dialog`, not `needs-decision` — a rule
  // written on `status` alone would notify for every other box and stay silent for this one.
  assert.equal(needsKind(idle({ status: 'dialog', question: { options: [] } })), 'question');
  assert.equal(needsKind(idle({ status: 'dialog' })), null, 'a picker somebody opened is not a summons');
});

test('needs-decision with nothing readable behind it still counts', () => {
  // The `Switch model?` confirmation carries no key-hint footer, so nothing parses and the
  // row arrives with a bare status. A session sitting on it is as stuck as one on a box we
  // can read, and it is the shape that cost a debugging session once already.
  assert.equal(needsKind(idle({ status: 'needs-decision' })), 'blocked');
});

test('the trust gate outranks the permission prompt it is made of', () => {
  // Measured, not constructed: this is the real capture, through the real parser. The gate
  // *is* a fully-populated permission box, so asking the general question first would
  // announce it as one — and send whoever read it to a card that deliberately has no
  // button on it.
  for (const file of ['pane-trust-gate.txt', 'pane-trust-gate-narrow.txt']) {
    const { prompt } = parsePane(fixture(file));
    assert.ok(prompt, 'the premise: the gate parses as an ordinary prompt');
    assert.equal(needsKind(idle({ status: 'needs-decision', prompt })), 'trust', file);
  }
});

test('a plan box outranks the needs-decision it also reports', () => {
  const s = idle({ status: 'needs-decision', plan: { options: [] }, prompt: null });
  assert.equal(needsKind(s), 'plan');
});

/* ──────────────────────────────────────────────────────────── the workers ─── */

test('a worker’s own prompt stays quiet until it goes stuck', () => {
  // The quieting is the maintainer's own call: a worker's permission prompt is its lead's
  // to answer, and it does not reach the inbox until the stuck timer fires. A notification
  // that ignored that would undo the decision from a different direction.
  const blocked = { status: 'needs-decision', prompt: { options: [] } };
  const quiet = idle({ ...blocked, team: { role: 'worker', state: 'working', stuck: false } });
  const stuck = idle({ ...blocked, team: { role: 'worker', state: 'working', stuck: true } });
  assert.equal(needsKind(quiet), null);
  assert.equal(needsKind(stuck), 'permission');
});

test('a lead is never quieted', () => {
  const s = idle({
    status: 'needs-decision',
    prompt: { options: [] },
    team: { role: 'lead', tasks: 2, review: 0 },
  });
  assert.equal(needsKind(s), 'permission');
});

test('review is a worker’s task state, and is not quieted', () => {
  assert.equal(isReview(idle({ team: { role: 'worker', state: 'working', stuck: false } })), false);
  assert.equal(isReview(idle({ team: { role: 'worker', state: 'review', stuck: false } })), true);
  assert.equal(isReview(idle({ team: { role: 'lead', review: 3 } })), false, 'a count is not a report');
  assert.equal(isReview(idle()), false);
});

/* ─────────────────────────────────────────────────────────── transitions ─── */

test('the first frame is a baseline and fires nothing', () => {
  // Half the sessions on this Mac are sitting at a prompt at any given moment. Opening the
  // panel is not the moment to be told about all of them at once.
  const rows = [
    idle({ id: 'a', status: 'needs-decision', prompt: { options: [] } }),
    idle({ id: 'b', question: { options: [] }, status: 'dialog' }),
  ];
  const { alerts, marks } = step(null, rows);
  assert.deepEqual(alerts, []);
  assert.equal(marks.size, 2);
});

test('a session entering a box fires exactly once, and not again while it sits there', () => {
  let marks = step(null, [idle()]).marks;

  const blocked = [idle({ status: 'needs-decision', prompt: { options: [] } })];
  let out = step(marks, blocked);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].kind, 'permission');
  marks = out.marks;

  for (let i = 0; i < 5; i++) {
    out = step(marks, blocked);
    assert.deepEqual(out.alerts, [], 'the same box, still open, is not news');
    marks = out.marks;
  }
});

test('answering one box straight into another fires for the second', () => {
  // Otherwise the second sits there silently for as long as the first's notification
  // happens to have been the last thing said about that session.
  let marks = step(null, [idle()]).marks;
  marks = step(marks, [idle({ status: 'needs-decision', prompt: { options: [] } })]).marks;
  const out = step(marks, [idle({ status: 'dialog', question: { options: [] } })]);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].kind, 'question');
});

test('a box answered and reopened fires again', () => {
  let marks = step(null, [idle()]).marks;
  const blocked = [idle({ status: 'needs-decision', prompt: { options: [] } })];
  marks = step(marks, blocked).marks;
  marks = step(marks, [idle()]).marks;
  const out = step(marks, blocked);
  assert.equal(out.alerts.length, 1);
});

test('a session nobody has seen before, already blocked, is news', () => {
  // Not another baseline: a pane opened into a new folder lands straight on the trust gate,
  // and that is the ordinary case rather than an edge one.
  const marks = step(null, [idle({ id: 'a' })]).marks;
  const out = step(marks, [idle({ id: 'a' }), idle({ id: 'b', status: 'needs-decision', prompt: { options: [] } })]);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].id, 'b');
});

test('a worker reaching review fires once, alongside nothing else', () => {
  const working = [idle({ id: 'w', title: 'issue-8', team: { role: 'worker', state: 'working', stuck: false, branch: 'agent/issue-8', task: 'issue-8' } })];
  const done = [idle({ id: 'w', title: 'issue-8', team: { role: 'worker', state: 'review', stuck: false, branch: 'agent/issue-8', task: 'issue-8' } })];
  let marks = step(null, working).marks;
  const out = step(marks, done);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].kind, 'review');
  assert.equal(out.alerts[0].branch, 'agent/issue-8');
  marks = out.marks;
  assert.deepEqual(step(marks, done).alerts, [], 'still in review is not a second report');
});

test('a stuck worker that also reports gets both, and they are different notifications', () => {
  const before = [idle({ id: 'w', team: { role: 'worker', state: 'working', stuck: false } })];
  const after = [
    idle({
      id: 'w',
      status: 'needs-decision',
      prompt: { options: [] },
      team: { role: 'worker', state: 'review', stuck: true },
    }),
  ];
  const marks = step(null, before).marks;
  const out = step(marks, after);
  assert.deepEqual(out.alerts.map((a) => a.kind).sort(), ['permission', 'review']);
});

test('a row with no id is skipped rather than throwing', () => {
  const { alerts, marks } = step(new Map(), [null, {}, idle()]);
  assert.equal(marks.size, 1);
  assert.deepEqual(alerts, []);
});

test('a session that disappears takes its mark with it', () => {
  // Otherwise the map grows for the life of the tab, and a `/clear` — which mints a new id
  // every time — would make it grow steadily.
  const marks = step(null, [idle({ id: 'a' }), idle({ id: 'b' })]).marks;
  const out = step(marks, [idle({ id: 'a' })]);
  assert.deepEqual([...out.marks.keys()], ['a']);
});

/* ───────────────────────────────────────────────────────────────── words ─── */

test('every kind has words of its own, and the tag is the session', () => {
  const kinds = ['permission', 'question', 'plan', 'blocked', 'trust'];
  const bodies = new Set();
  for (const kind of kinds) {
    const { title, body, tag } = alertText({ id: 's1', kind, title: 'alpha-main' });
    assert.equal(title, 'alpha-main');
    assert.equal(tag, 'foreman:s1', 'one live notification per session, replaced not stacked');
    assert.ok(body.length > 10, kind);
    assert.ok(!body.includes('alpha-main'), 'the name is the title; the body must not spend a line repeating it');
    bodies.add(body);
  }
  assert.equal(bodies.size, kinds.length, 'each screen says which one it is');
});

test('the trust gate’s words send the reader to the terminal, not to the panel', () => {
  // The panel reads that screen perfectly and refuses to draw a button on it. A
  // notification saying only "needs a decision" would send somebody to a card whose whole
  // content is "go to the Mac".
  const { body } = alertText({ id: 's1', kind: 'trust', title: 'alpha-main' });
  assert.match(body, /terminal/i);
});

test('a review names its branch when it has one and does not invent one when it does not', () => {
  const withBranch = alertText({ id: 'w', kind: 'review', title: 'issue-8', branch: 'agent/issue-8', task: 'issue-8' });
  assert.match(withBranch.title, /ready for review/);
  assert.match(withBranch.body, /agent\/issue-8/);

  const without = alertText({ id: 'w', kind: 'review', title: 'issue-8', branch: null, task: null });
  assert.match(without.body, /review/i);
  assert.ok(!without.body.includes('null'));
  assert.ok(!without.body.includes('undefined'));
});

test('an unknown kind still says something rather than "undefined"', () => {
  const { body } = alertText({ id: 's1', kind: 'something-new', title: 'alpha-main' });
  assert.ok(body && !body.includes('undefined'));
});
