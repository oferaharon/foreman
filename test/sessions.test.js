import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { forgeSummary, resetForgeCache } from '../server/forge.js';
import { forgesFor, rememberFooter, openTaskFor, workerTeam, SessionRegistry } from '../server/sessions.js';

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
 * `workerTeam` shapes that record into the row the rail draws. The join above is still the
 * only thing that decides *which* task a session owns — this only says what the row says
 * about it — and the one field worth pinning is `since`, because a whole ordering rule
 * rests on it never moving.
 */

test('a worker row carries the task it is working, plus the watcher’s verdict', () => {
  const t = task('add-a-search-index', 'working', { createdAt: 100, dispatchedAt: 200 });
  assert.deepEqual(workerTeam(t, false), {
    role: 'worker',
    repo: '/repo',
    task: 'add-a-search-index',
    branch: 'agent/add-a-search-index',
    state: 'working',
    stuck: false,
    since: 200,
  });
  assert.equal(workerTeam(t, true).stuck, true, 'stuck is the watcher’s, passed in');
  assert.equal(workerTeam(t).stuck, false, 'and a row nobody has judged yet is quiet');
});

/*
 * The rail sorts a lead's nested workers on `since` and then leaves them alone, which only
 * works because the stamp is written once — `dispatchedAt` at the transition to
 * `dispatched`, never again. Reading anything that moves here (`updatedAt` is the obvious
 * one, and it is next to it on the record) would put recency back under a field named for
 * the dispatch.
 */
test('`since` is the dispatch stamp, not anything that moves', () => {
  const t = task('static-order', 'working', {
    createdAt: 100,
    dispatchedAt: 200,
    updatedAt: 999_999,
  });
  assert.equal(workerTeam(t).since, 200);
});

test('a record that reached a session without a dispatch stamp falls back to when it was made', () => {
  const t = task('promoted', 'working', { createdAt: 100, dispatchedAt: null });
  assert.equal(workerTeam(t).since, 100, 'still orderable, and still in the right place');

  const neither = task('ancient', 'working');
  assert.equal(workerTeam(neither).since, null, 'and null rather than a guess');
});

test('a stamp of 0 is a stamp', () => {
  // `??` and not `||`: the epoch is a real millisecond, and `0 || createdAt` would quietly
  // take the wrong field for it.
  assert.equal(workerTeam(task('epoch', 'working', { dispatchedAt: 0, createdAt: 5 })).since, 0);
});

test('a worker with no branch yet says so rather than inventing one', () => {
  const t = task('queued-one', 'queued', { branch: null, dispatchedAt: 7 });
  assert.equal(workerTeam(t).branch, null);
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

/*
 * The forge on a roster row — the mark in a pane's header, and now on every session
 * rather than on a lead alone.
 *
 * Two things it must not do, and both are about the poll rather than about forges: it
 * runs on every tick over every Claude pane on this machine, so a folder held by three
 * panes must cost one resolution and not three; and nothing about a header decoration may
 * stop the roster being built.
 */

test('a folder held by several panes is resolved once, not once per pane', async () => {
  const asked = [];
  const forges = await forgesFor(
    ['/repo/alpha', '/repo/alpha', '/repo/gamma', '/repo/alpha'],
    async (dir) => {
      asked.push(dir);
      return { reading: 'GitHub', webUrl: `https://github.com/o${dir}` };
    },
  );

  assert.deepEqual(asked.sort(), ['/repo/alpha', '/repo/gamma'], 'one call per distinct folder');
  assert.equal(forges.size, 2);
  assert.equal(forges.get('/repo/alpha').reading, 'GitHub');
});

test('a pane with no folder asks nothing and answers nothing', async () => {
  const asked = [];
  const forges = await forgesFor([null, undefined, '', '/repo/beta'], async (dir) => {
    asked.push(dir);
    return { reading: 'no remote', webUrl: null };
  });

  assert.deepEqual(asked, ['/repo/beta'], 'a pane tmux reports no cwd for is skipped');
  // The row reads this with `?? null`, so a folder that is not in the map draws nothing.
  assert.equal(forges.get(null), undefined);
});

test('a resolver that throws costs that folder its mark and nothing else', async () => {
  const forges = await forgesFor(['/repo/alpha', '/repo/gamma'], async (dir) => {
    if (dir === '/repo/alpha') throw new Error('git is having a day');
    return { reading: 'Gitea', webUrl: 'https://forge.example/o/gamma' };
  });

  assert.equal(forges.get('/repo/alpha'), null, 'quiet, not thrown');
  assert.equal(forges.get('/repo/gamma').reading, 'Gitea');
});

/*
 * The ordinary case on this machine is a folder that is not a git repo at all — a home
 * directory, a scratch folder, anywhere somebody opened a session. `git remote get-url`
 * fails there, and the whole of what that must produce is a quiet row.
 */
test('a folder that is not a git repo is `no remote` with no link, not an error', async () => {
  resetForgeCache();
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'forge-not-a-repo-'));
  try {
    // The real remote read — that is the half under test. The other two reads are stubbed
    // so the answer does not depend on what this Mac happens to have installed.
    const forges = await forgesFor([dir], (d) => forgeSummary(d, { mcp: async () => ({}), hasGh: () => false }));
    assert.deepEqual(forges.get(dir), { reading: 'no remote', webUrl: null });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    resetForgeCache();
  }
});

/*
 * The trap this field is one `meta.cwd` away from: Claude Code rewrites a transcript's
 * `cwd` when a session changes directory mid-conversation, and the repository has not
 * moved. Nothing here can drive `refresh()` — it needs tmux — so the pin is on the source
 * of the two row assignments, which is the thing that would silently go wrong.
 */
test('a row takes its forge from the pane it runs in, never from the transcript', async () => {
  const src = await fsp.readFile(new URL('../server/sessions.js', import.meta.url), 'utf8');
  const lookups = [...src.matchAll(/forge:\s*forges\.get\(([^)]*)\)/g)].map((m) => m[1].trim());

  assert.equal(lookups.length, 2, 'both row shapes carry one — bound, and pane-only');
  for (const arg of lookups) {
    assert.match(arg, /pane\.cwd$/, 'the pane’s launch folder');
    assert.doesNotMatch(arg, /meta\./, 'never the transcript’s, which moves');
  }

  // …and the roster is broadcast on a diff, so a forge that appeared under a running
  // session reaches a browser only if `#diff` is asked about it.
  assert.match(src, /JSON\.stringify\(prev\.forge\) !== JSON\.stringify\(s\.forge\)/);
});
