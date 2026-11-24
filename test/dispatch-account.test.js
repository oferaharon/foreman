import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * A worker runs on its lead's Claude account — the maintainer's ruling Q3 of the
 * multi-account plan: read live off the lead's roster row at dispatch, not a team setting and
 * not a per-task choice.
 *
 * `resolveWorkerAccount` is pure apart from the one thing it is handed — `hookOf` — which these
 * tests build from a **real scratch config dir** and the real installer, because "does this
 * dir's settings file hold the panel's hook" is a question about a file and a stub would prove
 * nothing. The rest of the dispatch (`POST /api/team/dispatch`) sits behind a worktree and a
 * real Claude Code launch, so what lives there is pinned the `worker-effort.test.js` way: read
 * off the source. The end-to-end half was demonstrated in the sandbox, not here.
 *
 * Every dir and name below is a scratch one. No email, no uuid, anywhere.
 */

process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-dispatch-account-'));
const { resolveWorkerAccount, leadRowsFor } = await import('../server/dispatch.js');
const { installAccount, installStatus, installTarget } = await import('../server/account-install.js');
const { DEFAULT_CONFIG_DIR } = await import('../server/account.js');
const { TaskStore } = await import('../server/tasks.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const PORT = 48999;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-acct-'));
const stateDir = path.join(scratch, 'state');
test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

/** A scratch second-account config dir; `hooked` runs the real installer into it. */
function configDir(name, { hooked = false } = {}) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  if (hooked) {
    const out = installAccount(installTarget(dir, { stateDir }), { port: PORT });
    assert.equal(out.ok, true, out.message);
  }
  return dir;
}
const hookOf = (dir) => installStatus(installTarget(dir, { stateDir }), PORT).hook;

const REPO = '/work/alpha';
const lead = (account, extra = {}) => ({
  isLead: true,
  paneId: '%1',
  interactive: true,
  paneCwd: REPO,
  transcriptPath: null,
  account,
  ...extra,
});
const onDefault = () => lead({ explicit: false, dir: DEFAULT_CONFIG_DIR, nickname: null });
const onOther = (dir, nickname = null) => lead({ explicit: true, dir, nickname });

/* ------------------------------------------------------- a default lead, unchanged --- */

test('a default lead gives the default account — no dir, no name, no note', () => {
  const r = resolveWorkerAccount({ leads: [onDefault()], knownDirs: [DEFAULT_CONFIG_DIR], hookOf });
  assert.deepEqual(r, { configDir: null });
});

test('a default lead is unchanged even when another account is known and unhooked', () => {
  // The hook check is for the account the worker will run on. Another account sitting
  // unhooked in the settings box must not stand in front of a default dispatch.
  const other = configDir('c-unhooked');
  const r = resolveWorkerAccount({ leads: [onDefault()], knownDirs: [DEFAULT_CONFIG_DIR, other], hookOf });
  assert.deepEqual(r, { configDir: null });
});

/* ------------------------------------------------- a second-account lead, allowed --- */

test('a second-account lead: the worker gets that dir, named by nickname', () => {
  const dir = configDir('c-hooked', { hooked: true });
  const r = resolveWorkerAccount({
    leads: [onOther(dir, 'Studio')],
    knownDirs: [DEFAULT_CONFIG_DIR, dir],
    hookOf,
  });
  assert.equal(r.configDir, dir);
  assert.equal(r.name, 'Studio');
  assert.ok(path.isAbsolute(r.configDir), 'absolute — never the ~-shortened display form');
});

test('with no nickname the account is named by its folder, never an email or id', () => {
  const dir = configDir('c-folder-name', { hooked: true });
  const row = onOther(dir);
  // Fields a roster account row really carries, none of which may reach a name.
  row.account.email = 'someone@example.invalid';
  row.account.uuid = '00000000-0000-4000-8000-000000000000';
  const r = resolveWorkerAccount({ leads: [row], knownDirs: [DEFAULT_CONFIG_DIR, dir], hookOf });
  assert.equal(r.name, 'c-folder-name');
  assert.ok(!JSON.stringify(r).includes('example.invalid'));
  assert.ok(!JSON.stringify(r).includes('00000000-0000'));
});

test('a lead whose process could not be read still answers by its transcript\'s root', () => {
  // `rowConfigDir`'s fallback: `account: null`, transcript filed under another account's
  // projects folder. The worker follows it rather than defaulting.
  const dir = configDir('c-by-transcript', { hooked: true });
  const row = lead(null, { transcriptPath: path.join(dir, 'projects', '-work-alpha', 'abc.jsonl') });
  const r = resolveWorkerAccount({ leads: [row], knownDirs: [DEFAULT_CONFIG_DIR, dir], hookOf });
  assert.equal(r.configDir, dir);
});

/* ------------------------------------------------------------------- the refusals --- */

test('refused when the lead\'s account has no panel status hook, and the message names the button', () => {
  const dir = configDir('c-no-hook');
  const r = resolveWorkerAccount({ leads: [onOther(dir, 'Studio')], knownDirs: [DEFAULT_CONFIG_DIR, dir], hookOf });
  assert.equal(r.status, 409);
  assert.equal(r.configDir, undefined, 'nothing to launch with');
  assert.match(r.error, /Studio/);
  assert.match(r.error, /settings → Account tags/);
  assert.match(r.error, /Install/);
  assert.match(r.error, /Nothing was created/);
});

test('refused when the hook is out of date, with the words that say so', () => {
  // `hookState` answers `outdated` for an entry of ours that a reinstall would rewrite; the
  // wording is the only thing this pins (the state's own tests are `hook-settings`'s).
  const dir = configDir('c-stale-hook', { hooked: true });
  const r = resolveWorkerAccount({ leads: [onOther(dir)], knownDirs: [DEFAULT_CONFIG_DIR, dir], hookOf: () => 'outdated' });
  assert.equal(r.status, 409);
  assert.match(r.error, /out-of-date/);
  assert.match(r.error, /Install/);
});

test('refused when the hook state is unreadable — a file the panel cannot parse is not a hook', () => {
  const dir = configDir('c-garbage');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
  const r = resolveWorkerAccount({ leads: [onOther(dir)], knownDirs: [DEFAULT_CONFIG_DIR, dir], hookOf });
  assert.equal(r.status, 409);
});

test('an unreadable lead row — positively another account, which one unknown — is refused, not defaulted', () => {
  // `explicit` with no readable dir and no transcript root: `rowConfigDir` answers undefined.
  const row = lead({ explicit: true, dir: null, nickname: null });
  const r = resolveWorkerAccount({ leads: [row], knownDirs: [DEFAULT_CONFIG_DIR], hookOf });
  assert.equal(r.status, 409);
  assert.match(r.error, /can’t be read/);
  assert.match(r.error, /Nothing was created/);
});

test('a dir the panel never saw a live pane on is refused (the launch list is the detected list)', () => {
  const dir = configDir('c-unknown', { hooked: true });
  const r = resolveWorkerAccount({ leads: [onOther(dir)], knownDirs: [DEFAULT_CONFIG_DIR], hookOf });
  assert.equal(r.status, 409);
  assert.match(r.error, /Not an account this panel has seen/);
});

test('two lead rows that disagree about the account are refused', () => {
  const dir = configDir('c-two', { hooked: true });
  const r = resolveWorkerAccount({
    leads: [onOther(dir), onDefault()],
    knownDirs: [DEFAULT_CONFIG_DIR, dir],
    hookOf,
  });
  assert.equal(r.status, 409);
  assert.match(r.error, /not on the same Claude account/);
});

test('two lead rows that agree are one answer', () => {
  const dir = configDir('c-agree', { hooked: true });
  const r = resolveWorkerAccount({
    leads: [onOther(dir, 'Studio'), onOther(dir)],
    knownDirs: [DEFAULT_CONFIG_DIR, dir],
    hookOf,
  });
  assert.equal(r.configDir, dir);
});

/* ------------------------------------------------------ no lead row at all — default --- */

test('no lead row means the default, and says so only once another account is known', () => {
  const quiet = resolveWorkerAccount({ leads: [], knownDirs: [DEFAULT_CONFIG_DIR], hookOf });
  assert.deepEqual(quiet, { configDir: null, note: null }, 'one account on this Mac: nothing to be wrong about');

  const dir = configDir('c-known-only');
  const said = resolveWorkerAccount({ leads: [], knownDirs: [DEFAULT_CONFIG_DIR, dir], hookOf });
  assert.equal(said.configDir, null);
  assert.match(said.note, /No lead row was found/);
  assert.match(said.note, /default Claude account/);
});

/* ------------------------------------------------------------ finding the lead rows --- */

test('leadRowsFor takes every lead in the folder and nothing else', () => {
  const other = { ...onDefault(), paneCwd: '/work/beta' };
  const worker = { ...onDefault(), isLead: false };
  const second = { ...onDefault(), paneId: '%2' };
  const rows = [onDefault(), other, worker, second];
  assert.equal(leadRowsFor(rows, REPO).length, 2);
  assert.deepEqual(leadRowsFor(rows, 'relative/path'), [], 'a relative folder resolves against nothing useful');
  assert.deepEqual(leadRowsFor(null, REPO), []);
});

/* ----------------------------------------------------------------- the task record --- */

test('the task record keeps the dir it launched on, and a default one reads null', () => {
  const file = path.join(scratch, 'tasks.json');
  const store = new TaskStore(file);
  clearInterval(store.timer);
  store.create({ id: 'on-other', repo: REPO, body: 'x', configDir: '/abs/.claude-other' });
  store.create({ id: 'on-default', repo: REPO, body: 'x' });
  assert.equal(store.get('on-other').configDir, '/abs/.claude-other');
  assert.equal(store.get('on-default').configDir, null, 'absent means the default account');
  store.flush();

  const again = new TaskStore(file);
  clearInterval(again.timer);
  assert.equal(again.get('on-other').configDir, '/abs/.claude-other');
  assert.equal(again.get('on-default').configDir, null);
});

test('a record written before the field reads as the default account', () => {
  const file = path.join(scratch, 'tasks-old.json');
  fs.writeFileSync(file, JSON.stringify({ old: { id: 'old', repo: REPO, body: 'x', state: 'done' } }));
  const store = new TaskStore(file);
  clearInterval(store.timer);
  assert.equal(store.get('old').configDir, null);
});

test('a promotion carries the account onto the pending record by update', () => {
  const store = new TaskStore(path.join(scratch, 'tasks-promo.json'));
  clearInterval(store.timer);
  store.create({ id: 'later', repo: REPO, body: 'x', state: 'pending' });
  assert.equal(store.get('later').configDir, null, 'recorded with nothing: the account is decided at start');
  store.update('later', { state: 'queued', configDir: '/abs/.claude-other' });
  assert.equal(store.get('later').configDir, '/abs/.claude-other');
});

/* --------------------------------------------- the dispatch's wiring, read off source --- */

const index = read('server', 'index.js');

test('the account is resolved before any worktree exists, so a refusal leaves nothing behind', () => {
  const at = index.indexOf('resolveWorkerAccount({');
  const worktree = index.indexOf('wt = await createWorktree({ repo, label });');
  const refuse = index.indexOf('if (account.error) return res.status(account.status || 409)');
  assert.ok(at > 0 && worktree > at, 'resolved first');
  assert.ok(refuse > at && refuse < worktree, 'refused before createWorktree');
});

test('the hook check is the installer\'s own reading, on the panel\'s own port', () => {
  assert.match(index, /hookOf: \(dir\) => installStatus\(installTarget\(dir\), PORT\)\.hook,/);
});

test('the worker launches on the resolved dir, validated against the known list, never a request field', () => {
  const launch = index.match(/'--model', model\.model,[\s\S]*?\n\s+\}\);/)[0];
  assert.match(launch, /configDir: account\.configDir,/);
  assert.match(launch, /knownDirs: registry\.configDirs\.list\(\),/);
  assert.ok(!/req\.body\?\.configDir/.test(index.slice(index.indexOf("app.post('/api/team/dispatch'"), index.indexOf("app.post('/api/team/tasks'"))));
  assert.match(index, /effortReason: effortReason \|\| null,\n\s+\/\/[^\n]*\n\s+\/\/[^\n]*\n\s+configDir: account\.configDir,/);
});

test('a non-default account is a room line stamped `event: \'account\'`, naming no email or id', () => {
  const block = index.match(/if \(account\.configDir\) \{\n\s+room\.post[\s\S]*?\n {4}\}/)[0];
  assert.match(block, /event: 'account'/);
  assert.match(block, /kind: 'system'/);
  assert.match(block, /\$\{account\.name\} account, its lead's/);
  assert.ok(!/email|uuid/.test(block));
});

test('the room gives the account line no colour of its own — deliberately, like model and effort', () => {
  // A hue in this room means *look at this*; which account a worker runs on is a fact to
  // read beside the dispatch line. It falls through to `is-plain` and gets its keyword.
  const app = read('web', 'app.js');
  assert.ok(!/e\.event === 'account'/.test(app));
});
