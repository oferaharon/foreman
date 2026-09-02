import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberFooter, openTaskFor, SessionRegistry } from '../server/sessions.js';

/*
 * Model and `ctx:` are scraped off the composer footer, which a question box, a permission
 * prompt or a picker covers completely — so a session that is *asking you something* is
 * exactly the session that reports no model. That is not a session without a model.
 *
 * The same shape as `bypass`, and it went wrong the same way: a session sat on an
 * `AskUserQuestion` box for three hours with `model: null`, the client threw on it, and the
 * composer never drew — no question card, no textarea, nothing to answer with.
 */

test('a footer that was drawn is remembered', () => {
  const store = new Map();
  const seen = rememberFooter(store, '%16', { model: 'Opus 5 (1M context)', contextPct: 12 });
  assert.deepEqual(seen, { model: 'Opus 5 (1M context)', contextPct: 12 });
});

test('a poll with no footer keeps the last real answer', () => {
  const store = new Map();
  rememberFooter(store, '%16', { model: 'Sonnet 5', contextPct: 5 });

  // What a pane holding a question box looks like: a parsed box, and no footer at all.
  const asking = rememberFooter(store, '%16', { model: null, contextPct: null, question: {} });
  assert.deepEqual(asking, { model: 'Sonnet 5', contextPct: 5 }, 'still Sonnet, still 5%');
});

/* `readPaneState` answers `undefined`-ish when the capture fails outright. */
test('nothing to read at all is not a new answer either', () => {
  const store = new Map();
  rememberFooter(store, '%16', { model: 'Fable 5', contextPct: 40 });
  assert.deepEqual(rememberFooter(store, '%16', null), { model: 'Fable 5', contextPct: 40 });
  assert.deepEqual(rememberFooter(store, '%16', undefined), { model: 'Fable 5', contextPct: 40 });
});

/*
 * The two travel together because they are one line. A footer *is* on screen and has no
 * `ctx:` on a session that has spent none — keeping the old number there would put a stale
 * percentage beside a live model, which is worse than showing neither.
 */
test('a footer with no percentage clears the percentage', () => {
  const store = new Map();
  rememberFooter(store, '%16', { model: 'Sonnet 5', contextPct: 43 });
  const fresh = rememberFooter(store, '%16', { model: 'Sonnet 5', contextPct: null });
  assert.equal(fresh.contextPct, null, 'the new footer is the whole answer');
});

test('a pane nobody has read yet reports nothing, not a stranger’s model', () => {
  const store = new Map();
  rememberFooter(store, '%16', { model: 'Opus 5', contextPct: 3 });
  assert.deepEqual(rememberFooter(store, '%19', { model: null, contextPct: null }), {
    model: null,
    contextPct: null,
  });
});

test('a later footer replaces the earlier one', () => {
  const store = new Map();
  rememberFooter(store, '%16', { model: 'Opus 5 (1M context)', contextPct: 4 });
  const after = rememberFooter(store, '%16', { model: 'Sonnet 5', contextPct: 4 });
  assert.equal(after.model, 'Sonnet 5', 'a switch is visible on the next poll that shows one');
});

/*
 * A worker is a worker because a *ticket* says so. The rail's third line names the task a
 * row belongs to, and the one way that goes wrong is a row still naming a ticket nobody is
 * waiting on — the branch merged and swept, the row pointing at nothing.
 */
const task = (id, state, extra = {}) => ({
  id,
  state,
  repo: '/repo',
  branch: `agent/${id}`,
  tmuxSession: `voice-repo-${id}`,
  ...extra,
});

test('the join is the tmux session the task was dispatched into', () => {
  const tasks = [task('setup-autodetect', 'working'), task('rail-team-line', 'working')];
  assert.equal(openTaskFor(tasks, 'voice-repo-rail-team-line')?.id, 'rail-team-line');
  assert.equal(openTaskFor(tasks, 'voice-repo-something-else'), null);
});

test('a task waiting on review still owns its worker', () => {
  // It has finished the work and kept the branch, the worktree and the session — the one
  // thing left is the lead reading it. A row that stopped saying so mid-review would drop
  // the task exactly when somebody was about to ask about it.
  assert.equal(openTaskFor([task('wave-e', 'review')], 'voice-repo-wave-e')?.state, 'review');
});

test('a closed task is not a task, whatever closed it', () => {
  for (const state of ['done', 'failed', 'abandoned']) {
    assert.equal(
      openTaskFor([task('merged', state)], 'voice-repo-merged'),
      null,
      `${state} is closed — the row is an ordinary session again`,
    );
  }
});

test('a pending task has no session to be joined to', () => {
  // It has no session, no branch and no worktree — nothing to join a row to. The record
  // still carries a `tmuxSession` key here on purpose: the guard that matters is the
  // state, and a pending task that somehow acquired a name must still match nothing.
  assert.equal(openTaskFor([task('search-index', 'pending')], 'voice-repo-search-index'), null);
});

test('a session with no tmux name matches nothing', () => {
  // Every roster row carries one, but a pane-only row can arrive without — and `undefined
  // === undefined` would otherwise marry it to a task that was never dispatched.
  const undispatched = [task('queued-one', 'queued', { tmuxSession: null })];
  assert.equal(openTaskFor(undispatched, null), null);
  assert.equal(openTaskFor(undispatched, undefined), null);
  assert.equal(openTaskFor(undispatched, ''), null);
});

test('no task store at all is not an error', () => {
  assert.equal(openTaskFor(null, 'voice-repo-x'), null);
  assert.equal(openTaskFor([], 'voice-repo-x'), null);
});

/*
 * `noteModel` is the other end of the same store, and it exists because the panel can set a
 * model faster than the terminal redraws the line the model is read off. Without it the
 * poll right after a switch scrapes a footer that has not caught up — or no footer at all,
 * because the picker is still coming down — and `rememberFooter` hands back the model the
 * session was on before the click. The label then sits a switch behind, which is what was
 * reported.
 *
 * It is a seed and not an assertion: the next poll that reads a real footer wins, so a
 * switch that silently failed corrects itself instead of being believed forever.
 */
const bareRegistry = () => new SessionRegistry(null, null, null, null);

test('a model the panel just set stands in until a footer is read', () => {
  const r = bareRegistry();
  rememberFooter(r.footers, '%16', { model: 'Fable 5.1', contextPct: 12 });

  r.noteModel('%16', 'Sonnet 5');

  // The picker is still on screen, so there is no footer to scrape.
  assert.deepEqual(rememberFooter(r.footers, '%16', { model: null, contextPct: null }), {
    model: 'Sonnet 5',
    contextPct: 12,
  });
});

test('the first real footer after a seed wins', () => {
  const r = bareRegistry();
  r.noteModel('%16', 'Sonnet 5');
  assert.deepEqual(rememberFooter(r.footers, '%16', { model: 'Haiku 4.5', contextPct: 7 }), {
    model: 'Haiku 4.5',
    contextPct: 7,
  });
});

test('a seed with nothing to seed changes nothing', () => {
  const r = bareRegistry();
  rememberFooter(r.footers, '%16', { model: 'Fable 5.1', contextPct: 12 });

  // `footerModelName` answers null for a row with no blurb to read, and null must not
  // erase a model that was actually on screen.
  r.noteModel('%16', null);
  r.noteModel(null, 'Sonnet 5');

  assert.deepEqual(rememberFooter(r.footers, '%16', null), { model: 'Fable 5.1', contextPct: 12 });
});
