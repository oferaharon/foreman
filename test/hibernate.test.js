import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CronWitness,
  HIBERNATE_CHOICES,
  HibernateStore,
  IdleClock,
  RECURRING_EXPIRY_MS,
  WAKEUP_GRACE_MS,
  hibernateMs,
  idleSince,
  lockBlocks,
  readSchedulerLock,
  sleepRecord,
  sleepVerdict,
} from '../server/hibernate.js';
import * as leaf from '../web/hibernate-choices.js';
import { WORKTREES_DIR } from '../server/worktree.js';
import { SESSION_PREFIX } from '../server/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const P = SESSION_PREFIX;
const T = (iso) => Date.parse(iso);
const HOUR = 60 * 60_000;

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-hibernate-'));

/* ------------------------------------------------------------------------ the choices --- */

test('the choices are off, 30 min, 1 h, 4 h and 12 h, off first and by default', () => {
  assert.deepEqual([...HIBERNATE_CHOICES], ['off', '30m', '1h', '4h', '12h']);
  assert.equal(leaf.DEFAULT_HIBERNATE, 'off');
  assert.equal(hibernateMs('off'), null);
  assert.equal(hibernateMs('30m'), 30 * 60_000);
  assert.equal(hibernateMs('1h'), HOUR);
  assert.equal(hibernateMs('4h'), 4 * HOUR);
  assert.equal(hibernateMs('12h'), 12 * HOUR);
});

test('an absent or unknown setting reads as off, never as the shortest wait', () => {
  for (const v of [undefined, null, '', '30', '30M', '2h', 30, true, 'on']) assert.equal(hibernateMs(v), null, String(v));
});

test('the list has one spelling: the server re-exports the web leaf, and nothing else writes it', () => {
  assert.equal(HIBERNATE_CHOICES, leaf.HIBERNATE_CHOICES, 'the same object, not a copy');
  // A second literal is the drift one-spelling is about — a picker offering what the
  // validator refuses. Grep both trees for the list's most distinctive member.
  const hits = [];
  for (const dir of ['server', 'web', 'mcp']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(m?js|html)$/.test(e.name) && /['"]12h['"]/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    };
    walk(path.join(root, dir));
  }
  assert.deepEqual(hits, ['web/hibernate-choices.js']);
});

/* ------------------------------------------------------------------------ the verdict --- */

const ALPHA = '/Users/dev/Foreman/foreman-sandbox/alpha';
const NOW = T('2026-10-29T12:00:00Z');

/** A row that may sleep: every field the verdict reads, at its eligible value. */
const row = (over = {}) => ({
  id: '507be0d1-ab7e-4037-82f2-ddcf8d649f09',
  transcriptPath: '/p/507be0d1.jsonl',
  paneId: '%7',
  tmuxSession: `${P}alpha-main`,
  paneCwd: ALPHA,
  title: 'alpha-main',
  label: 'main',
  project: 'alpha',
  team: null,
  status: 'idle',
  prompt: null,
  plan: null,
  question: null,
  dialog: null,
  queued: [],
  background: { agents: 0, shells: 0, monitors: 0 },
  unread: 0,
  needsYou: false,
  bypass: false,
  attached: true,
  lastActivity: NOW - 2 * HOUR,
  model: 'Opus 5.5',
  ...over,
});

/** The context that lets `row()` sleep under a 1 h setting. */
const ctx = (over = {}) => ({
  now: NOW,
  afterMs: HOUR,
  sessions: [],
  live: { state: 'idle' },
  held: 0,
  idleSince: NOW - 2 * HOUR,
  cron: { blocked: false, why: null },
  lock: null,
  pids: [4242, 4243],
  composerEmpty: true,
  keepAwake: false,
  watched: false,
  ...over,
});

const refused = (r, c, rule) => {
  const out = sleepVerdict(r, c);
  assert.equal(out.ok, false, `expected a refusal by ${rule}`);
  assert.equal(out.rule, rule, out.why);
  assert.ok(typeof out.why === 'string' && out.why.length > 4, 'the reason is in words');
  return out.why;
};

test('an idle, ordinary, resumable session with nothing going on may sleep', () => {
  assert.deepEqual(sleepVerdict(row(), ctx()), { ok: true });
  // A lead too, when none of its workers is running.
  const lead = row({ tmuxSession: `${P}alpha-lead`, team: { role: 'lead', tasks: 1 } });
  assert.deepEqual(sleepVerdict(lead, ctx({ sessions: [lead] })), { ok: true });
});

test('off is off', () => {
  refused(row(), ctx({ afterMs: null }), 'off');
  refused(row(), ctx({ afterMs: hibernateMs('off') }), 'off');
});

test('(a) never a worker — by role and by the folder it sits in', () => {
  refused(row({ team: { role: 'worker', repo: ALPHA, task: 't1' } }), ctx(), 'worker');
  refused(row({ paneCwd: path.join(WORKTREES_DIR, 'alpha-fix'), team: null }), ctx(), 'worker');
  // The allow-list: a role nobody has invented yet is not a bench row either.
  refused(row({ team: { role: 'something-new' } }), ctx(), 'worker');
});

test('(b) never a lead with a live worker row — and a worker in another repo does not count', () => {
  const lead = row({ tmuxSession: `${P}alpha-lead`, team: { role: 'lead', tasks: 2 } });
  const mine = row({ tmuxSession: `${P}alpha-fix`, paneCwd: path.join(WORKTREES_DIR, 'alpha-fix'), team: { role: 'worker', repo: ALPHA } });
  const theirs = row({ tmuxSession: `${P}beta-fix`, paneCwd: path.join(WORKTREES_DIR, 'beta-fix'), team: { role: 'worker', repo: '/Users/dev/Foreman/foreman-sandbox/beta' } });
  assert.match(refused(lead, ctx({ sessions: [lead, mine, theirs] }), 'workers'), /1 worker running/);
  assert.deepEqual(sleepVerdict(lead, ctx({ sessions: [lead, theirs] })), { ok: true });
  // No roster to count against is a doubt, not a zero.
  refused(lead, ctx({ sessions: undefined }), 'unknown');
});

test('(d) nothing to resume — no transcript, or a synthetic pane id', () => {
  refused(row({ transcriptPath: null }), ctx(), 'history');
  refused(row({ id: 'pane-19' }), ctx(), 'history');
});

test('† a name the panel cannot give back never sleeps', () => {
  // No prefix: `slugFor` is null, so a wake would mint something else.
  refused(row({ tmuxSession: 'my-own-session' }), ctx(), 'name');
  refused(row({ paneId: null }), ctx(), 'name');
});

test('† keep-awake, and open in a browser', () => {
  refused(row(), ctx({ keepAwake: true }), 'keep-awake');
  refused(row(), ctx({ watched: true }), 'watched');
  // Not supplied is not "no".
  refused(row(), ctx({ keepAwake: undefined }), 'keep-awake');
  refused(row(), ctx({ watched: undefined }), 'watched');
});

test('(c) not idle', () => {
  assert.equal(refused(row({ status: 'working' }), ctx(), 'busy'), 'it is working');
  refused(row({ status: 'needs-decision' }), ctx(), 'busy');
  refused(row({ status: 'dialog' }), ctx(), 'busy');
});

test('(c) holding something, read off the pane just now even when the roster says idle', () => {
  const why = refused(row(), ctx({ live: { state: 'idle', question: { question: 'Which?' } } }), 'holding');
  assert.equal(why, 'it is asking you a question');
  refused(row({ plan: { options: [] } }), ctx(), 'holding');
});

test('(c) something queued, or held', () => {
  assert.match(refused(row({ queued: [{ id: 'q1', text: 'hi' }] }), ctx(), 'queued'), /1 message is queued/);
  refused(row({ queued: undefined }), ctx(), 'queued');
  assert.match(refused(row(), ctx({ held: 2 }), 'held'), /2 messages are waiting/);
  refused(row(), ctx({ held: undefined }), 'held');
});

test('(e) background work — and `null` is unknown, not zero', () => {
  assert.equal(refused(row({ background: { agents: 0, shells: 1, monitors: 0 } }), ctx(), 'background'), 'a background shell is running');
  refused(row({ background: { agents: 0, shells: 0, monitors: 2 } }), ctx(), 'background');
  refused(row({ background: { agents: 3, shells: 0, monitors: 0 } }), ctx(), 'background');
  refused(row({ background: null }), ctx(), 'background');
});

test('(e) a cron or a /loop, by either witness', () => {
  assert.equal(
    refused(row(), ctx({ cron: { blocked: true, why: 'a /loop or recurring cron is scheduled in it' } }), 'cron'),
    'a /loop or recurring cron is scheduled in it',
  );
  refused(row(), ctx({ cron: undefined }), 'cron');
  refused(row(), ctx({ lock: { pid: 4243, sessionId: 'x' } }), 'lock');
  // Another session's lock in the same folder is not this one's.
  assert.deepEqual(sleepVerdict(row(), ctx({ lock: { pid: 9999, sessionId: 'x' } })), { ok: true });
});

test('(f) a reply you have not read, or anything else waiting on you', () => {
  refused(row({ unread: 1 }), ctx(), 'unread');
  refused(row({ needsYou: true }), ctx(), 'unread');
});

test('† something typed in its terminal — or a composer that cannot be read', () => {
  assert.equal(refused(row(), ctx({ composerEmpty: false }), 'composer'), 'something is typed in its terminal');
  refused(row(), ctx({ composerEmpty: null }), 'composer');
});

test('not idle long enough, and an idle clock nobody supplied', () => {
  assert.equal(refused(row(), ctx({ idleSince: NOW - 12 * 60_000 }), 'idle'), 'it has been idle 12 min of 60 min');
  refused(row(), ctx({ idleSince: null }), 'idle');
});

/* --------------------------------------------------------------------- the idle clock --- */

test('idle since is the latest of the four times', () => {
  const r = { lastActivity: 100 };
  assert.equal(idleSince(r, {}), 100);
  assert.equal(idleSince(r, { lastBusy: 300, createdMs: 200, wokeAt: null }), 300);
  assert.equal(idleSince(r, { lastBusy: 50, createdMs: 200, wokeAt: 400 }), 400);
  assert.equal(idleSince({ lastActivity: null }, {}), null);
});

/* Measurement 5: `--resume` writes one untimestamped record, so the woken row's
   `lastActivity` is still the moment it was put to sleep. */
test('a woken session is not put straight back to sleep', () => {
  const sleptAt = NOW - 5 * HOUR;
  const wokeAt = NOW - 60_000;
  const woken = row({ lastActivity: sleptAt });
  const clock = new IdleClock(NOW - 24 * HOUR);
  clock.woke(woken.tmuxSession, wokeAt);

  // On the transcript alone it has been idle five hours — the bug this rule exists for.
  assert.equal(sleepVerdict(woken, ctx({ idleSince: idleSince(woken) })).ok, true);

  // With the pane's own creation time, the wake time, or both, it has been idle a minute.
  for (const times of [{ createdMs: wokeAt }, { wokeAt: clock.wokeAt(woken.tmuxSession) }, { createdMs: wokeAt, wokeAt }]) {
    const since = idleSince(woken, { lastBusy: clock.lastBusy(woken.tmuxSession), ...times });
    assert.equal(since, wokeAt);
    refused(woken, ctx({ idleSince: since }), 'idle');
  }
});

test('the clock starts every name at boot, and moves on any poll that is not idle', () => {
  const boot = NOW - HOUR;
  const clock = new IdleClock(boot);
  assert.equal(clock.lastBusy(`${P}alpha-main`), boot, 'a panel restart restarts every clock');
  clock.note([row({ status: 'working' }), row({ tmuxSession: `${P}beta-main`, status: 'idle' })], NOW);
  assert.equal(clock.lastBusy(`${P}alpha-main`), NOW);
  assert.equal(clock.lastBusy(`${P}beta-main`), boot);
  clock.prune([`${P}beta-main`]);
  assert.equal(clock.lastBusy(`${P}alpha-main`), boot);
});

/* -------------------------------------------------------------------- the cron witness --- */

/*
 * `cron-*.jsonl` are real transcripts from two scratch sessions in the sandbox's `alpha`
 * (Claude Code v2.1.296), cut down to the records a scan reads and the turns around them,
 * with the home directory rewritten — see docs/traps/launch.md, "A `/loop` outlives
 * `/clear`". Subsets below select whole real lines; nothing is written by hand.
 */
const fixtureLines = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8').split('\n').filter(Boolean);
const until = (lines, marker) => {
  const at = lines.findIndex((l) => l.includes(marker));
  assert.ok(at >= 0, `no line carries ${marker}`);
  return lines.slice(0, at);
};
const without = (lines, ...markers) => lines.filter((l) => !markers.some((m) => l.includes(m)));

function transcript(dir, name, lines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.length ? `${lines.join('\n')}\n` : '');
  return p;
}

const PANE = { key: '%7', since: T('2026-10-29T23:50:00Z') };
const AFTER = T('2026-10-30T01:00:00Z');

test('a recurring cron blocks, and is believed for seven days', () => {
  const dir = tmpDir();
  const p = transcript(dir, 'a.jsonl', fixtureLines('cron-recurring.jsonl'));
  const w = new CronWitness();
  assert.deepEqual(w.check({ ...PANE, path: p, now: AFTER }), { blocked: true, why: 'a /loop or recurring cron is scheduled in it' });
  const created = T('2026-10-29T23:51:57.335Z');
  assert.equal(w.check({ ...PANE, path: p, now: created + RECURRING_EXPIRY_MS - 1 }).blocked, true);
  assert.equal(w.check({ ...PANE, path: p, now: created + RECURRING_EXPIRY_MS }).blocked, false, 'it expired on its own');
});

test('create, then delete: nothing left', () => {
  const dir = tmpDir();
  const lines = until(fixtureLines('cron-delete-and-wakeup.jsonl'), 'For a test: call ScheduleWakeup now');
  const p = transcript(dir, 'b.jsonl', lines);
  assert.deepEqual(new CronWitness().check({ ...PANE, path: p, now: AFTER }), { blocked: false, why: null });
  // And before the delete, the same transcript blocks.
  const q = transcript(dir, 'b2.jsonl', until(lines, 'Use CronDelete to cancel job'));
  assert.equal(new CronWitness().check({ ...PANE, path: q, now: AFTER }).blocked, true);
});

test('a ScheduleWakeup blocks until its stop — and a refused call scheduled nothing', () => {
  const dir = tmpDir();
  const all = fixtureLines('cron-delete-and-wakeup.jsonl');
  const at = T('2026-10-29T23:57:00Z');
  // Up to the refused call's error only: `is_error`, nothing armed.
  const refusedOnly = until(all, 'toolu_01UgLxNQrbRBTLdxWRMZFTZP');
  assert.equal(new CronWitness().check({ ...PANE, path: transcript(dir, 'w0.jsonl', refusedOnly), now: at }).blocked, false);
  // Armed for 00:17Z.
  const armed = until(all, 'Now cancel that wakeup');
  assert.deepEqual(new CronWitness().check({ ...PANE, path: transcript(dir, 'w1.jsonl', armed), now: at }), {
    blocked: true,
    why: 'a /loop wake-up is pending in it',
  });
  // Stopped.
  const stopped = until(all, 'say the word woken');
  assert.equal(new CronWitness().check({ ...PANE, path: transcript(dir, 'w2.jsonl', stopped), now: at }).blocked, false);
});

test('an armed wake-up whose fire was never seen is believed only until a grace past scheduledFor', () => {
  const dir = tmpDir();
  // The whole file ends on an arm for 00:00:00Z.
  const p = transcript(dir, 'w.jsonl', fixtureLines('cron-delete-and-wakeup.jsonl'));
  const due = T('2026-10-30T00:00:00Z');
  assert.equal(new CronWitness().check({ ...PANE, path: p, now: due + WAKEUP_GRACE_MS }).blocked, true);
  assert.equal(new CronWitness().check({ ...PANE, path: p, now: due + WAKEUP_GRACE_MS + 1 }).blocked, false);
});

/* Measurement 1: a cron survives `/clear` into a transcript that never mentions it. */
test('a cron survives /clear: the witness follows the pane, not the path', () => {
  const dir = tmpDir();
  const before = transcript(dir, 'before.jsonl', fixtureLines('cron-recurring.jsonl'));
  const fresh = until(fixtureLines('cron-after-clear.jsonl'), 'Call the CronList tool');
  const after = transcript(dir, 'after.jsonl', fresh);

  const w = new CronWitness();
  assert.equal(w.check({ ...PANE, path: before, now: AFTER }).blocked, true);
  // The same pane, now showing its post-/clear transcript — still blocked.
  assert.equal(w.check({ ...PANE, path: after, now: AFTER }).blocked, true);
  // A witness that only ever saw the new path would have let it sleep — which is the point.
  assert.equal(new CronWitness().check({ ...PANE, path: after, now: AFTER }).blocked, false);
});

test('a CronList result is the exact list, and a fire of an unseen id is a live cron', () => {
  const dir = tmpDir();
  const lines = fixtureLines('cron-after-clear.jsonl');
  // The new transcript up to its first CronList answer: the surviving job is named there.
  const listed = until(lines, 'Run `date` first');
  assert.equal(new CronWitness().check({ ...PANE, path: transcript(dir, 'l.jsonl', listed), now: AFTER }).blocked, true);

  // The loop-wake fire in the other session's post-/clear transcript, with everything
  // after it cut: a `taskKind: 'loop'` fire clears a wake-up, it creates no cron.
  const fire = until(fixtureLines('cron-wakeup-fire.jsonl'), 'toolu_014pTn4HpYeF3yWVh4extgCb');
  assert.equal(new CronWitness().check({ ...PANE, path: transcript(dir, 'f.jsonl', fire), now: AFTER }).blocked, false);
  // …and the whole file, whose next turn armed `/loop 20m`, blocks.
  const whole = transcript(dir, 'f2.jsonl', fixtureLines('cron-wakeup-fire.jsonl'));
  assert.equal(new CronWitness().check({ ...PANE, path: whole, now: AFTER }).blocked, true);
});

test('prune forgets a pane that is gone, and with it the paths only it had shown', () => {
  const dir = tmpDir();
  const p = transcript(dir, 'a.jsonl', fixtureLines('cron-recurring.jsonl'));
  const w = new CronWitness();
  w.check({ ...PANE, path: p, now: AFTER });
  const fresh = transcript(dir, 'b.jsonl', until(fixtureLines('cron-after-clear.jsonl'), 'Call the CronList tool'));
  w.prune([]);
  // Gone: the same key seen again starts from what it shows now.
  assert.equal(w.check({ ...PANE, path: fresh, now: AFTER }).blocked, false);
});

/* Measurement 2: a one-shot fires, then is gone, with no CronDelete. */
test('a one-shot cron blocks until its own fire record', () => {
  const dir = tmpDir();
  // Only the one-shot: the two CronList calls (which name the recurring job) are removed.
  const lines = without(fixtureLines('cron-after-clear.jsonl'), 'toolu_01ADH8ghj8qPypxgFRrpsavL', 'toolu_01H9qDdxMorcjXPdZ5W8MQv4');
  const pending = until(lines, 'scheduled_task_fire');
  assert.deepEqual(new CronWitness().check({ ...PANE, path: transcript(dir, 'o1.jsonl', pending), now: AFTER }), {
    blocked: true,
    why: 'a one-off scheduled task is waiting to fire in it',
  });
  assert.equal(new CronWitness().check({ ...PANE, path: transcript(dir, 'o2.jsonl', lines), now: AFTER }).blocked, false);
});

test('a woken session does not count the loops its last life ran', () => {
  const dir = tmpDir();
  const p = transcript(dir, 'a.jsonl', fixtureLines('cron-recurring.jsonl'));
  // The same transcript, resumed in a pane created after every record in it.
  const woken = { key: '%0', since: T('2026-10-30T00:30:00Z') };
  assert.equal(new CronWitness().check({ ...woken, path: p, now: AFTER }).blocked, false);
  // And a pane id reused by a new process is a new pane, even under one witness.
  const w = new CronWitness();
  assert.equal(w.check({ ...PANE, path: p, now: AFTER }).blocked, true);
  assert.equal(w.check({ key: PANE.key, since: woken.since, path: p, now: AFTER }).blocked, false);
});

test('the scan is incremental: it reads what was appended, across a line cut in half', () => {
  const dir = tmpDir();
  const lines = fixtureLines('cron-delete-and-wakeup.jsonl');
  const create = lines.findIndex((l) => l.includes('Scheduled recurring job f358eaec'));
  const p = transcript(dir, 'i.jsonl', lines.slice(0, create));
  const w = new CronWitness();
  assert.equal(w.check({ ...PANE, path: p, now: AFTER }).blocked, false);

  // Half the result line, then the rest: nothing is read from a partial line.
  const half = Math.floor(lines[create].length / 2);
  fs.appendFileSync(p, lines[create].slice(0, half));
  assert.equal(w.check({ ...PANE, path: p, now: AFTER }).blocked, false);
  fs.appendFileSync(p, `${lines[create].slice(half)}\n`);
  assert.equal(w.check({ ...PANE, path: p, now: AFTER }).blocked, true);

  const rest = until(lines.slice(create + 1), 'For a test: call ScheduleWakeup now');
  fs.appendFileSync(p, `${rest.join('\n')}\n`);
  assert.equal(w.check({ ...PANE, path: p, now: AFTER }).blocked, false, 'the delete was read from the appended tail');
});

test('a file that shrinks under its path is read again from the start', () => {
  const dir = tmpDir();
  const p = transcript(dir, 's.jsonl', fixtureLines('cron-delete-and-wakeup.jsonl'));
  const w = new CronWitness();
  w.check({ ...PANE, path: p, now: AFTER });
  transcript(dir, 's.jsonl', fixtureLines('cron-recurring.jsonl'));
  assert.equal(w.check({ ...PANE, path: p, now: AFTER }).blocked, true);
});

test('an unreadable transcript blocks', () => {
  assert.deepEqual(new CronWitness().check({ ...PANE, path: '/nonexistent/x.jsonl', now: AFTER }), {
    blocked: true,
    why: 'its transcript cannot be read',
  });
});

/* ------------------------------------------------------------------------- the lock --- */

test('the scheduler lock: none, held by this pane, by another, or unreadable', () => {
  const folder = tmpDir();
  assert.equal(readSchedulerLock(folder), null);
  fs.mkdirSync(path.join(folder, '.claude'));
  const file = path.join(folder, '.claude', 'scheduled_tasks.lock');
  // The measured shape.
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'dcda540b-f561-45aa-b1c5-406a7d3bf1ca', pid: 4243, procStart: 'Thu Oct 29 23:51:32 2026', acquiredAt: 1793317917237 }));
  const lock = readSchedulerLock(folder);
  assert.equal(lock.pid, 4243);
  // Matched by pid: after /clear the lock still carries the old session id.
  assert.match(lockBlocks(lock, [4242, 4243]), /used the scheduler/);
  assert.equal(lockBlocks(lock, [5000]), null, 'another session in this folder holds it');
  assert.match(lockBlocks(lock, null), /cannot be told/);
  fs.writeFileSync(file, '{"pid":');
  assert.deepEqual(readSchedulerLock(folder), { unreadable: true });
  assert.match(lockBlocks(readSchedulerLock(folder), [4243]), /cannot be read/);
  assert.equal(lockBlocks(null, null), null, 'no lock needs no pids');
});

/* ------------------------------------------------------------------------- the store --- */

test('the sleep record keeps paneCwd as the folder, and the shape the wake needs', () => {
  const rec = sleepRecord(row({ cwd: '/somewhere/it/wandered' }), { now: NOW, idleSince: NOW - 2 * HOUR, pinned: true, pinAfter: `${P}beta-main` });
  assert.deepEqual(rec, {
    name: `${P}alpha-main`,
    folder: ALPHA,
    slug: 'main',
    lead: false,
    sessionId: '507be0d1-ab7e-4037-82f2-ddcf8d649f09',
    transcriptPath: '/p/507be0d1.jsonl',
    title: 'alpha-main',
    label: 'main',
    project: 'alpha',
    bypass: false,
    attached: true,
    pinned: true,
    pinAfter: `${P}beta-main`,
    sleptAt: NOW,
    idleSince: NOW - 2 * HOUR,
    lastActivity: NOW - 2 * HOUR,
    model: 'Opus 5.5',
  });
  assert.equal(sleepRecord(row({ tmuxSession: `${P}alpha-lead` })).lead, true);
});

const storeAt = (dir) => new HibernateStore(path.join(dir, 'hibernate.json'), { flushMs: 60_000 });

test('the store remembers sleepers, keep-awake and held messages across a reload', () => {
  const dir = tmpDir();
  const s = storeAt(dir);
  s.put(sleepRecord(row(), { now: NOW }));
  s.setKeepAwake(`${P}beta-main`, true);
  s.hold(`${P}alpha-main`, 'first', { now: NOW });
  s.hold(`${P}alpha-main`, 'second', { now: NOW + 1 });
  s.stop();

  const t = storeAt(dir);
  assert.equal(t.get(`${P}alpha-main`).sessionId, '507be0d1-ab7e-4037-82f2-ddcf8d649f09');
  assert.equal(t.bySessionId('507be0d1-ab7e-4037-82f2-ddcf8d649f09').name, `${P}alpha-main`);
  assert.deepEqual([...t.names()], [`${P}alpha-main`]);
  assert.equal(t.isKeepAwake(`${P}beta-main`), true);
  assert.deepEqual(t.held(`${P}alpha-main`).map((i) => i.text), ['first', 'second']);
  // The drain is in order, and empties the list.
  assert.deepEqual(t.takeHeld(`${P}alpha-main`).map((i) => i.text), ['first', 'second']);
  assert.equal(t.heldCount(`${P}alpha-main`), 0);
  t.stop();
  // The write went through a temp file in the same directory and left none behind.
  assert.deepEqual(fs.readdirSync(dir), ['hibernate.json']);
});

test('held messages: the queue’s cap, and never for a name that is not asleep', () => {
  const s = storeAt(tmpDir());
  assert.throws(() => s.hold(`${P}alpha-main`, 'hi'), /not asleep/);
  s.put(sleepRecord(row()));
  for (let i = 0; i < 20; i += 1) s.hold(`${P}alpha-main`, `m${i}`);
  assert.throws(() => s.hold(`${P}alpha-main`, 'one too many'), /20 messages waiting/);
  s.stop();
});

test('leadFor finds the one sleeping lead for a folder, and nothing else', () => {
  const s = storeAt(tmpDir());
  assert.equal(s.leadFor(ALPHA), null, 'nobody asleep');
  s.put(sleepRecord(row()));
  assert.equal(s.leadFor(ALPHA), null, 'an ordinary sleeper is not a lead');
  s.put({ ...sleepRecord(row({ tmuxSession: `${P}alpha-lead` })), lead: true });
  assert.equal(s.leadFor(ALPHA).name, `${P}alpha-lead`);
  assert.equal(s.leadFor(`${ALPHA}/`).name, `${P}alpha-lead`, 'the folder is compared resolved');
  assert.equal(s.leadFor('alpha'), null, 'a relative folder is never an answer');
  assert.equal(s.leadFor(path.join(path.dirname(ALPHA), 'beta')), null, 'another folder’s lead is not this one’s');
  s.put({ ...sleepRecord(row({ tmuxSession: `${P}alpha-lead-2` })), lead: true });
  assert.equal(s.leadFor(ALPHA), null, 'two are a choice, and a message is never sent on a guess');
  s.stop();
});

test('forget drops the record and what was held, and says how many', () => {
  const s = storeAt(tmpDir());
  s.put(sleepRecord(row()));
  s.hold(`${P}alpha-main`, 'a');
  s.hold(`${P}alpha-main`, 'b');
  const out = s.forget(`${P}alpha-main`);
  assert.equal(out.dropped, 2);
  assert.equal(out.record.name, `${P}alpha-main`);
  assert.equal(s.has(`${P}alpha-main`), false);
  assert.equal(s.forget(`${P}alpha-main`), null);
  s.stop();
});

test('unknown keys are carried through a rewrite, top-level and inside each record', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'hibernate.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 3,
      futureThing: { a: 1 },
      asleep: { [`${P}alpha-main`]: { ...sleepRecord(row()), wakeCount: 4 } },
      keepAwake: [],
      held: {},
    }),
  );
  const s = storeAt(dir);
  s.update(`${P}alpha-main`, { title: 'renamed' });
  s.setKeepAwake(`${P}beta-main`, true);
  s.stop();

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.version, 3);
  assert.deepEqual(doc.futureThing, { a: 1 });
  assert.equal(doc.asleep[`${P}alpha-main`].wakeCount, 4);
  assert.equal(doc.asleep[`${P}alpha-main`].title, 'renamed');
  assert.deepEqual(doc.keepAwake, [`${P}beta-main`]);
});

test('an unparseable file is never written over', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'hibernate.json');
  fs.writeFileSync(file, '{"asleep": {');
  const s = storeAt(dir);
  assert.equal(s.unreadable, true);
  s.setKeepAwake(`${P}alpha-main`, true);
  s.stop();
  assert.equal(fs.readFileSync(file, 'utf8'), '{"asleep": {');
});

test('every change is announced, for the roster broadcast', () => {
  const s = storeAt(tmpDir());
  let n = 0;
  s.on('changed', () => (n += 1));
  s.put(sleepRecord(row()));
  s.hold(`${P}alpha-main`, 'x');
  s.setKeepAwake(`${P}alpha-main`, true);
  s.setKeepAwake(`${P}alpha-main`, true); // no change, no event
  s.forget(`${P}alpha-main`);
  assert.equal(n, 4);
  s.stop();
});
