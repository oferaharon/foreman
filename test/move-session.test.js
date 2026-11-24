import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BYPASS_CONFIRM_WHY } from '../server/account.js';
import { SESSION_PREFIX } from '../server/config.js';
import { STILL_UP } from '../server/exit-session.js';
import { WORKTREES_DIR } from '../server/worktree.js';
import {
  CopyError,
  accountLabel,
  conversationFiles,
  copyConversation,
  moveSession,
  moveTargets,
  planMove,
  verifyCopy,
} from '../server/move-session.js';

/*
 * Moving a session to another account (the multi-account plan's item 8), on a temp tree.
 * Every config dir here is a folder under the OS temp dir standing in for an account; the
 * uuid and the folder names are made up, and no real account's folder is read or written.
 * tmux, the panes and the room are fakes — what Claude Code does with the copy (M10) was
 * measured on the bench and is in `server/move-session.js`'s header.
 */
const P = SESSION_PREFIX;
const SID = '507be0d1-ab7e-4037-82f2-ddcf8d649f09';
const FOLDER = '-Users-x-Code-alpha';
const ALPHA = '/Users/x/Code/alpha';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Two accounts under a fake home: its default `.claude` and a second dir beside it. */
function tree({ sibling = true } = {}) {
  const home = tmp('foreman-move-home-');
  const main = path.join(home, '.claude');
  const one = path.join(home, '.claude-one');
  const two = path.join(home, '.claude-two');
  for (const d of [main, one, two]) fs.mkdirSync(path.join(d, 'projects'), { recursive: true });
  const src = path.join(one, 'projects', FOLDER);
  fs.mkdirSync(src, { recursive: true });
  const transcript = path.join(src, `${SID}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: SID, message: { content: 'codeword: tangerine' } })}\n`);
  if (sibling) {
    fs.mkdirSync(path.join(src, SID, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(src, SID, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(src, SID, 'subagents', 'agent-a1.jsonl'), '{"type":"assistant"}\n');
    fs.writeFileSync(path.join(src, SID, 'tool-results', 'r1.txt'), 'x'.repeat(5000));
  }
  // Per-project memory is the folder's, not the conversation's: it never travels.
  fs.mkdirSync(path.join(src, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(src, 'memory', 'MEMORY.md'), '- a memory\n');
  // The account a move goes *to* on a bypass row must have accepted bypass mode.
  return { home, main, one, two, src, transcript };
}

const account = (dir, over = {}) => ({
  dir,
  configDir: dir,
  folder: path.basename(dir),
  explicit: true,
  uuid: '00000000-0000-4000-8000-000000000001',
  signedIn: true,
  nickname: null,
  ...over,
});

const row = (t, over = {}) => ({
  id: SID,
  transcriptPath: t.transcript,
  paneId: '%7',
  tmuxSession: `${P}alpha-main`,
  paneCwd: ALPHA,
  title: 'alpha-main',
  team: null,
  status: 'idle',
  bypass: false,
  pinned: true,
  account: account(t.one, { nickname: 'Work' }),
  ...over,
});

/* ------------------------------------------------------------ refusals --- */

test('the plan: entry on the target account, resuming the copy, same name and pin', () => {
  const t = tree();
  const plan = planMove(row(t), { targetDir: t.two, targetLabel: 'Side', home: t.home });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.entry.configDir, t.two);
  assert.equal(plan.entry.resume, SID);
  assert.equal(plan.entry.transcriptPath, path.join(t.two, 'projects', FOLDER, `${SID}.jsonl`));
  assert.equal(plan.entry.tmuxSession, `${P}alpha-main`);
  assert.equal(plan.entry.folder, ALPHA);
  assert.equal(plan.entry.pinned, true);
  assert.equal(plan.sourceLabel, 'Work');
  assert.equal(plan.targetLabel, 'Side');
  assert.equal(plan.lead, false);
});

test('moving to the default account launches with no configDir at all', () => {
  const t = tree();
  const plan = planMove(row(t), { targetDir: t.main, home: t.home });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.entry.configDir, null);
  assert.equal(plan.targetLabel, 'default');
  assert.equal(plan.entry.transcriptPath, path.join(t.main, 'projects', FOLDER, `${SID}.jsonl`));
});

test('refused: a worker — by its task role and by sitting in a worktree', () => {
  const t = tree();
  const out = planMove(row(t, { team: { role: 'worker', task: 'x' } }), { targetDir: t.two, home: t.home });
  assert.equal(out.why, 'worker');
  assert.match(out.error, /lead’s account/);
  // A row whose task closed under it, still in a worktree: `isBenchRow`'s folder half.
  const stray = planMove(row(t, { paneCwd: path.join(WORKTREES_DIR, 'alpha-x'), tmuxSession: `${P}alpha-x-main` }), {
    targetDir: t.two,
    home: t.home,
  });
  assert.equal(stray.why, 'worker');
  assert.match(stray.error, /lead’s account/);
});

test('refused: a sleeper', () => {
  const out = planMove(null, { asleep: true });
  assert.equal(out.why, 'asleep');
  assert.match(out.error, /asleep/);
});

test('refused: a pane holding something — every way heldBy reads it', () => {
  const t = tree();
  for (const live of [
    { state: 'needs-decision', prompt: { question: 'Do you want to proceed?', options: [] } },
    { state: 'dialog', question: { title: 'Pick one' } },
    { state: 'dialog', plan: { body: 'x' } },
    { state: 'dialog', dialog: 'Select model' },
  ]) {
    const out = planMove(row(t), { targetDir: t.two, live, home: t.home });
    assert.equal(out.why, 'holding', JSON.stringify(live));
    assert.match(out.error, /^Not moved: /);
  }
  assert.ok(!planMove(row(t), { targetDir: t.two, live: { state: 'idle' }, home: t.home }).error);
});

test('refused: no transcript — unbound, a synthetic pane id, or a file not named after it', () => {
  const t = tree();
  assert.equal(planMove(row(t, { transcriptPath: null }), { targetDir: t.two, home: t.home }).why, 'no-transcript');
  assert.equal(planMove(row(t, { id: 'pane-7' }), { targetDir: t.two, home: t.home }).why, 'no-transcript');
  const odd = path.join(t.src, 'other.jsonl');
  assert.equal(planMove(row(t, { transcriptPath: odd }), { targetDir: t.two, home: t.home }).why, 'no-transcript');
});

test('refused: the account it already runs on', () => {
  const t = tree();
  const out = planMove(row(t), { targetDir: t.one, home: t.home });
  assert.equal(out.why, 'same');
  assert.match(out.error, /already runs on Work/);
});

test('refused: an account that cannot be read', () => {
  const t = tree();
  const out = planMove(row(t, { account: { explicit: true, dir: null }, transcriptPath: '/nowhere/x.jsonl' }), {
    targetDir: t.two,
    home: t.home,
  });
  assert.equal(out.why, 'account');
});

test('refused: a target that already holds the conversation — the file, or its folder — never overwritten', () => {
  const t = tree();
  const dest = path.join(t.two, 'projects', FOLDER);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, `${SID}.jsonl`), 'older\n');
  const out = planMove(row(t), { targetDir: t.two, targetLabel: 'Side', home: t.home });
  assert.equal(out.why, 'exists');
  assert.match(out.error, /Side already has a copy/);
  assert.match(out.error, /never overwrites/);
  assert.equal(fs.readFileSync(path.join(dest, `${SID}.jsonl`), 'utf8'), 'older\n');

  fs.rmSync(path.join(dest, `${SID}.jsonl`));
  fs.mkdirSync(path.join(dest, SID));
  assert.equal(planMove(row(t), { targetDir: t.two, home: t.home }).why, 'exists');
});

test('refused: a bypass row onto an account that never accepted bypass mode — allowed once it has', () => {
  const t = tree();
  const out = planMove(row(t, { bypass: true }), { targetDir: t.two, home: t.home });
  assert.equal(out.why, 'bypass');
  assert.ok(out.error.includes(BYPASS_CONFIRM_WHY));

  fs.writeFileSync(path.join(t.two, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  const ok = planMove(row(t, { bypass: true }), { targetDir: t.two, home: t.home });
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.entry.skipPermissions, true);
  // …and the account it is leaving is not asked: it ran bypass there already.
});

test('refused: a name the panel could not give back', () => {
  const t = tree();
  const out = planMove(row(t, { tmuxSession: 'my-own-name' }), { targetDir: t.two, home: t.home });
  assert.equal(out.why, 'name');
});

test('a lead may be moved, and is marked as one', () => {
  const t = tree();
  const plan = planMove(row(t, { tmuxSession: `${P}alpha-lead`, team: { role: 'lead' } }), { targetDir: t.two, home: t.home });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.lead, true);
});

test('the choices: every signed-in account but its own, by key', () => {
  const t = tree();
  const dirs = [t.main, t.one, t.two];
  const choices = [
    { key: 0, nickname: 'Personal', folder: 'default' },
    { key: 1, nickname: 'Work', folder: '.claude-one' },
    { key: 2, nickname: null, folder: '.claude-two' },
  ];
  assert.deepEqual(
    moveTargets(row(t), choices, dirs, t.home).map((c) => [c.key, c.label]),
    [
      [0, 'Personal'],
      [2, '.claude-two'],
    ],
  );
  assert.deepEqual(moveTargets(row(t, { account: { explicit: true, dir: null }, transcriptPath: null }), choices, dirs, t.home), []);
  assert.equal(accountLabel(null, t.main, t.home), 'default');
  assert.equal(accountLabel({ folder: '.claude-two' }, t.two, t.home), '.claude-two');
});

/* ------------------------------------------------------------ the copy --- */

test('the copy: the transcript and its sibling folder, byte-equal, fresh mtime, original untouched, memory left behind', async () => {
  const t = tree();
  const past = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(t.transcript, past, past);
  const before = hash(t.transcript);
  const files = conversationFiles(t.transcript, SID, t.two);

  const out = await copyConversation(files);
  assert.equal(out.files, 3);
  assert.equal(hash(files.file.to), before);
  assert.equal(hash(path.join(files.sibling.to, 'subagents', 'agent-a1.jsonl')), hash(path.join(files.sibling.from, 'subagents', 'agent-a1.jsonl')));
  assert.equal(fs.readFileSync(path.join(files.sibling.to, 'tool-results', 'r1.txt'), 'utf8').length, 5000);
  // Newer than the original from the first poll, so the scan prefers the copy.
  assert.ok(fs.statSync(files.file.to).mtimeMs > past.getTime() + 1000);
  // The original: same bytes, same mtime, still there.
  assert.equal(hash(t.transcript), before);
  assert.equal(fs.statSync(t.transcript).mtimeMs, past.getTime());
  assert.ok(fs.existsSync(path.join(t.src, SID, 'subagents', 'agent-a1.jsonl')));
  // Per-project memory is not the conversation's.
  assert.ok(!fs.existsSync(path.join(t.two, 'projects', FOLDER, 'memory')));
});

test('the copy: no sibling folder is fine', async () => {
  const t = tree({ sibling: false });
  const files = conversationFiles(t.transcript, SID, t.two);
  const out = await copyConversation(files);
  assert.equal(out.files, 1);
  assert.ok(!fs.existsSync(files.sibling.to));
});

test('the copy: a target that appeared after the check is a failure, not a clobber — and the partial copy is reported', async () => {
  const t = tree();
  const files = conversationFiles(t.transcript, SID, t.two);
  fs.mkdirSync(files.toDir, { recursive: true });
  fs.writeFileSync(files.file.to, 'someone else\n');
  await assert.rejects(copyConversation(files), (err) => {
    assert.ok(err instanceof CopyError);
    assert.match(err.message, /EEXIST/);
    // The sibling folder went first and is named, so it can be reported rather than deleted.
    assert.ok(err.written.includes(files.sibling.to));
    assert.ok(!err.written.includes(files.file.to));
    return true;
  });
  assert.equal(fs.readFileSync(files.file.to, 'utf8'), 'someone else\n');
});

test('the check: a copy that differs by one byte is refused by name', async () => {
  const d = tmp('foreman-move-verify-');
  const a = path.join(d, 'a.jsonl');
  const b = path.join(d, 'b.jsonl');
  fs.writeFileSync(a, 'abc\n');
  fs.writeFileSync(b, 'abd\n');
  await assert.rejects(verifyCopy([[a, b]]), /b\.jsonl is not byte-for-byte/);
  fs.writeFileSync(b, 'abc\n');
  assert.equal(await verifyCopy([[a, b]]), 4);
});

/* ------------------------------------------------------------ the sequence --- */

function deps(over = {}) {
  const calls = [];
  const d = {
    calls,
    pinnedNames: async () => {
      calls.push('pins');
      return [`${P}alpha-main`];
    },
    exit: async (target) => {
      calls.push(['exit', target.name, target.paneId]);
      return { gone: true, stopped: [] };
    },
    startEntries: async (entries, opts) => {
      calls.push(['start', entries, opts]);
      return [{ state: 'started', name: entries[0].tmuxSession, paneId: '%9' }];
    },
    reserved: () => new Set(['sleeper']),
    post: (line) => calls.push(['post', line]),
    ...over,
  };
  return d;
}

test('the sequence: pins, /exit, copy, start on the target with the copy, then the line', async () => {
  const t = tree();
  const plan = planMove(row(t), { targetDir: t.two, targetLabel: 'Side', home: t.home });
  const d = deps({ home: t.home });
  const out = await moveSession(plan, row(t), d, { terminal: false });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.from, 'Work');
  assert.equal(out.to, 'Side');
  assert.deepEqual(d.calls[0], 'pins');
  assert.deepEqual(d.calls[1], ['exit', `${P}alpha-main`, '%7']);
  const [, entries, opts] = d.calls[2];
  assert.equal(entries[0].configDir, t.two);
  assert.equal(entries[0].resume, SID);
  assert.ok(fs.existsSync(entries[0].transcriptPath), 'the copy is on disk before the start');
  assert.deepEqual(opts.pinOrder, [`${P}alpha-main`]);
  assert.deepEqual([...opts.reserved], ['sleeper']);
  const [, line] = d.calls[3];
  assert.match(line.text, /moved from Work to Side/);
  assert.match(line.text, /left as it was/);
  assert.equal(line.lead, false);
});

test('stops at the /exit: not gone, or refused — nothing copied', async () => {
  const t = tree();
  const plan = planMove(row(t), { targetDir: t.two, home: t.home });
  const up = await moveSession(plan, row(t), deps({ home: t.home, exit: async () => ({ gone: false, why: STILL_UP }) }));
  assert.equal(up.ok, false);
  assert.equal(up.stage, 'exit');
  assert.match(up.error, /Nothing was copied/);
  assert.ok(!fs.existsSync(plan.files.file.to));

  const refused = await moveSession(plan, row(t), deps({ home: t.home, exit: async () => { throw new Error('busy'); } }));
  assert.equal(refused.stage, 'exit');
  assert.match(refused.error, /left as it is/);
});

test('stops at the copy and says where: partial copy reported, not deleted, original untouched', async () => {
  const t = tree();
  const before = hash(t.transcript);
  const plan = planMove(row(t), { targetDir: t.two, targetLabel: 'Side', home: t.home });
  // The target appears between the plan and the copy.
  fs.mkdirSync(plan.files.toDir, { recursive: true });
  fs.writeFileSync(plan.files.file.to, 'raced\n');
  const d = deps({ home: t.home });
  const out = await moveSession(plan, row(t), d);
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'copy');
  assert.equal(out.status, 500);
  assert.match(out.error, /closed, but copying its conversation to Side failed/);
  assert.match(out.error, /partial copy was left on Side and not deleted/);
  assert.match(out.error, new RegExp(`claude --resume ${SID}`));
  assert.match(out.error, /CLAUDE_CONFIG_DIR=~\/\.claude-one/);
  assert.ok(fs.existsSync(plan.files.sibling.to), 'the partial copy is still there');
  assert.equal(hash(t.transcript), before);
  assert.ok(!d.calls.some((c) => c[0] === 'start'), 'nothing started');
});

test('stops at the start and says where: copied and checked, not started, original untouched', async () => {
  const t = tree();
  const before = hash(t.transcript);
  const plan = planMove(row(t), { targetDir: t.main, home: t.home });
  const out = await moveSession(
    plan,
    row(t),
    deps({ home: t.home, startEntries: async () => [{ state: 'failed', error: 'tmux said no' }] }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'start');
  assert.match(out.error, /was copied to default \(checked byte for byte\), but it did not start there: tmux said no/);
  assert.match(out.error, /untouched on Work/);
  assert.equal(hash(t.transcript), before);
  assert.ok(fs.existsSync(plan.files.file.to));
});

test('a lead posts its line as the lead', async () => {
  const t = tree();
  const lead = row(t, { tmuxSession: `${P}alpha-lead`, team: { role: 'lead' } });
  const plan = planMove(lead, { targetDir: t.two, home: t.home });
  const d = deps({ home: t.home });
  const out = await moveSession(plan, lead, d);
  assert.equal(out.ok, true, out.error);
  const [, line] = d.calls.find((c) => c[0] === 'post');
  assert.equal(line.lead, true);
  assert.equal(line.folder, ALPHA);
  assert.match(line.text, /^The lead was moved/);
});
