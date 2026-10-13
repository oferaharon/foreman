import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  AGENT_RE, CHUNK_MAX, COMPONENT_RES, HEAD_MAX, HELPER_VERSION, Helper, PROJECT_RE, PROTOCOL_VERSION,
  ROOT_RE, SESSION_RE, backoffDelay, isRoot, parseWatch, readConfig, shippableLength, validComponents,
} from '../helper/foreman-helper.mjs';
import { FAKE, fileKey, startFakePanel } from './fake-bot-panel.js';

/*
 * The helper, against a fake panel that speaks the plan's §2c wire (`fake-bot-panel.js`) and
 * a real tree of synthetic transcripts in a temp dir. Nothing here is a real conversation:
 * every record is made up below, and none is an `attachment` — the real ones carry a whole
 * system prompt.
 *
 * The helper runs in-process with its timings shrunk (`FAST`), so a test can stop it,
 * restart it, and take the panel away under it in well under a second. `--check` and the
 * import guard run it as a child process instead, because what they promise is about the
 * process.
 */

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, '..');
const HELPER = path.join(REPO, 'helper', 'foreman-helper.mjs');

const FAST = { pollMs: 15, fullScanMs: 150, helloMs: 150, backoffMinMs: 10, backoffMaxMs: 40, requestTimeoutMs: 3000 };
const PROJECT = '-workspace-alpha';

const sha = buf => createHash('sha256').update(buf).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-helper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** `n` synthetic transcript records, one per line. */
function records(n, tag = 'alpha', from = 0) {
  let out = '';
  for (let i = from; i < from + n; i++) {
    out += `${JSON.stringify({
      type: i % 2 ? 'assistant' : 'user',
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      timestamp: new Date(Date.UTC(2026, 9, 12, 10, 0, i)).toISOString(),
      message: { role: i % 2 ? 'assistant' : 'user', content: `${tag} record ${i}` },
    })}\n`;
  }
  return out;
}

function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function session(root, sid = randomUUID(), project = PROJECT) {
  return path.join(root, project, `${sid}.jsonl`);
}

function start(t, fake, watch, { token, timing } = {}) {
  const logs = [];
  const helper = new Helper(
    { url: fake.url, bot: fake.bot, token: token ?? fake.token, watch: parseWatch(watch) },
    { timing: { ...FAST, ...timing }, log: line => logs.push(line) },
  );
  const done = helper.run();
  const stop = async () => { helper.stop(); await done; };
  t.after(stop);
  return { helper, logs, stop };
}

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function synced(fake, key, file) {
  const copy = fake.copy(key);
  return !!copy && sha(copy) === sha(fs.readFileSync(file));
}

async function panel(t, opts) {
  const fake = await startFakePanel(opts);
  t.after(() => fake.close());
  return fake;
}

// ------------------------------------------------------------------------------ exports ---

test('importing the helper starts nothing: no output, no timers, a clean exit', async () => {
  const env = { PATH: process.env.PATH, HELPER_URL: pathToFileURL(HELPER).href };
  const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', 'await import(process.env.HELPER_URL)'], { env, timeout: 5000 });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('the limits are the wire\'s: 4 MiB chunks, a 4096-byte head, protocol v1', () => {
  assert.equal(CHUNK_MAX, 4 * 1024 * 1024);
  assert.equal(HEAD_MAX, 4096);
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(CHUNK_MAX, FAKE.CHUNK_MAX);
  assert.equal(HEAD_MAX, FAKE.HEAD_MAX);
});

/*
 * A shared table, run through the helper's regexes and the fake's transcription of §2c.
 * The panel's own copy (`server/bots.js`) gets the same treatment in its own test; this one
 * only proves the helper says what the plan says.
 */
const COMPONENT_TABLE = {
  root: {
    ok: ['main', 'g1', 'a.b_c-d', 'A'.repeat(64), '0'],
    bad: ['', '.', '..', '.hidden', '-x', '_x', 'a/b', 'a b', 'A'.repeat(65), '../x', 'a\\b', 'ä'],
  },
  project: {
    ok: ['-workspace-agent', '-workspace-alpha', 'x', '-'.repeat(255)],
    bad: ['', '.', '..', 'a/b', 'a.b', 'a_b', 'a b', '-'.repeat(256), '/abs'],
  },
  session: {
    ok: ['0f8fad5b-d9cb-469f-a165-70867728950e', '00000000-0000-0000-0000-000000000000'],
    bad: ['', '0F8FAD5B-D9CB-469F-A165-70867728950E', '0f8fad5b-d9cb-469f-a165-70867728950e.jsonl', '../0f8fad5b-d9cb-469f-a165-70867728950e', 'not-a-uuid', '0f8fad5bd9cb469fa16570867728950e'],
  },
  agent: {
    ok: ['agent-a1b2c3', 'agent-' + 'a'.repeat(64), 'agent-ABC123'],
    bad: ['', 'agent-', 'agent-a-b', 'agent-../x', 'agent-' + 'a'.repeat(65), 'a1b2c3', 'agent-a.b', 'Agent-a1'],
  },
};

test('the four component regexes accept and refuse what §2c says, and match the fake panel\'s', () => {
  const fake = { root: FAKE.ROOT_RE, project: FAKE.PROJECT_RE, session: FAKE.SESSION_RE, agent: FAKE.AGENT_RE };
  assert.deepEqual(COMPONENT_RES, { root: ROOT_RE, project: PROJECT_RE, session: SESSION_RE, agent: AGENT_RE });
  for (const [kind, { ok, bad }] of Object.entries(COMPONENT_TABLE)) {
    const test = kind === 'root' ? isRoot : s => COMPONENT_RES[kind].test(s);
    for (const s of ok) {
      assert.ok(test(s), `${kind} should accept ${JSON.stringify(s)}`);
      assert.ok(fake[kind].test(s), `the fake's ${kind} should accept ${JSON.stringify(s)}`);
    }
    for (const s of bad) {
      assert.ok(!test(s), `${kind} should refuse ${JSON.stringify(s)}`);
      assert.ok(!(fake[kind].test(s) && s !== '.' && s !== '..'), `the fake's ${kind} should refuse ${JSON.stringify(s)}`);
    }
  }
  const good = { root: 'main', project: PROJECT, session: '0f8fad5b-d9cb-469f-a165-70867728950e' };
  assert.ok(validComponents(good));
  assert.ok(validComponents({ ...good, agent: null }));
  assert.ok(validComponents({ ...good, agent: 'agent-a1' }));
  assert.ok(!validComponents({ ...good, root: '..' }));
  assert.ok(!validComponents({ ...good, agent: 'agent-' }));
});

test('a chunk ends on its last newline; a partial line is held; a full piece of one long line goes', () => {
  assert.equal(shippableLength(Buffer.from('a\nb\n')), 4);
  assert.equal(shippableLength(Buffer.from('a\nb')), 2);
  assert.equal(shippableLength(Buffer.from('abc')), 0);
  assert.equal(shippableLength(Buffer.from('')), 0);
  assert.equal(shippableLength(Buffer.from('abcd'), 4), 4, 'a full piece with no newline in it is one long line');
  assert.equal(shippableLength(Buffer.from('ab\nd'), 4), 3, 'a full piece with a newline in it still ends there');
});

test('backoff runs 1 s → 30 s with jitter, and never past the cap', () => {
  assert.equal(backoffDelay(0, 1000, 30000, () => 0), 1000);
  assert.equal(backoffDelay(0, 1000, 30000, () => 1), 2000);
  assert.equal(backoffDelay(3, 1000, 30000, () => 0), 8000);
  assert.equal(backoffDelay(99, 1000, 30000, () => 0), 15000);
  assert.equal(backoffDelay(99, 1000, 30000, () => 1), 30000);
});

test('FOREMAN_WATCH: labels, one * per path paired with one in its label, absolute paths only', () => {
  assert.deepEqual(parseWatch('main=/srv/claude/projects'), [{ label: 'main', path: '/srv/claude/projects', glob: null }]);
  const [a, b] = parseWatch(' main=/srv/a/projects ; *=/srv/groups/*/.claude/projects ;');
  assert.equal(a.label, 'main');
  assert.deepEqual(b.glob, { parent: '/srv/groups', pre: '', post: '', rest: ['.claude', 'projects'] });
  assert.deepEqual(parseWatch('grp-*=/srv/g-*-x/p')[0].glob, { parent: '/srv', pre: 'g-', post: '-x', rest: ['p'] });
  assert.throws(() => parseWatch(''), /empty/);
  assert.throws(() => parseWatch('main'), /label=path/);
  assert.throws(() => parseWatch('main=relative/projects'), /absolute/);
  assert.throws(() => parseWatch('*=/srv/*/x/*'), /more than one/);
  assert.throws(() => parseWatch('main=/srv/*/projects'), /must hold one \*/);
  assert.throws(() => parseWatch('*=/srv/projects'), /path has none/);
  assert.throws(() => parseWatch('../x=/srv/projects'), /must match/);
  assert.throws(() => parseWatch('main=/a;main=/b'), /twice/);
});

test('readConfig wants all four variables and keeps credentials out of the URL', () => {
  const env = { FOREMAN_URL: 'http://127.0.0.1:1/', FOREMAN_BOT: 'alpha-bot', FOREMAN_BOT_TOKEN: 't', FOREMAN_WATCH: 'main=/srv/p' };
  const cfg = readConfig(env);
  assert.equal(cfg.url, 'http://127.0.0.1:1');
  assert.equal(cfg.bot, 'alpha-bot');
  assert.throws(() => readConfig({ ...env, FOREMAN_BOT_TOKEN: '' }), /missing FOREMAN_BOT_TOKEN/);
  assert.throws(() => readConfig({ ...env, FOREMAN_URL: 'ftp://x' }), /http/);
  assert.throws(() => readConfig({ ...env, FOREMAN_URL: 'http://u:p@127.0.0.1:1' }), /credentials/);
});

test('HELPER_VERSION is the release it ships in', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(HELPER_VERSION, pkg.version, 'bump helper/foreman-helper.mjs HELPER_VERSION with package.json');
});

// ------------------------------------------------------------------------- the shipping ---

test('a first backfill: hello, manifest, then every file — oldest first, subagents included', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const old = put(session(root), records(5, 'old'));
  const mid = put(session(root, randomUUID(), '-workspace-beta'), records(3, 'mid'));
  const sid = randomUUID();
  const fresh = put(session(root, sid), records(4, 'fresh'));
  const sub = put(path.join(root, PROJECT, sid, 'subagents', 'agent-a1b2c3.jsonl'), records(2, 'sub'));
  put(path.join(root, PROJECT, sid, 'subagents', 'agent-a1b2c3.meta.json'), '{}');
  put(path.join(root, PROJECT, sid, 'tool-results', 'x.txt'), 'not a transcript');
  put(path.join(root, PROJECT, 'memory', 'notes.md'), 'not a transcript');
  put(path.join(root, PROJECT, 'not-a-session.jsonl'), records(1));
  const now = Date.now() / 1000;
  fs.utimesSync(old, now, now - 3 * 86400);
  fs.utimesSync(mid, now, now - 2 * 86400);
  fs.utimesSync(fresh, now, now - 60);
  fs.utimesSync(sub, now, now - 30);

  const { logs } = start(t, fake, `main=${root}`);
  const keys = {
    old: fileKey({ root: 'main', project: PROJECT, session: path.basename(old, '.jsonl') }),
    mid: fileKey({ root: 'main', project: '-workspace-beta', session: path.basename(mid, '.jsonl') }),
    fresh: fileKey({ root: 'main', project: PROJECT, session: sid }),
    sub: fileKey({ root: 'main', project: PROJECT, session: sid, agent: 'agent-a1b2c3' }),
  };
  await waitFor(() => synced(fake, keys.old, old) && synced(fake, keys.mid, mid) && synced(fake, keys.fresh, fresh) && synced(fake, keys.sub, sub), 'the backfill');

  assert.equal(fake.copies.size, 4, 'nothing but the two transcript shapes is shipped');
  assert.deepEqual(fake.appends.map(a => a.key), [keys.old, keys.mid, keys.fresh, keys.sub], 'oldest first');
  assert.ok(fake.appends.every(a => a.offset === 0 && a.endsOnNewline && !a.reset));
  assert.deepEqual(fake.violations, []);

  const hello = fake.hellos[0];
  assert.equal(hello.v, 1);
  assert.equal(hello.contentType, 'application/json');
  assert.match(hello.instance, /^[0-9a-f-]{36}$/);
  assert.equal(hello.helperVersion, HELPER_VERSION);
  assert.equal(typeof hello.host, 'string');
  assert.deepEqual(hello.roots, [{ label: 'main', path: root }]);
  assert.equal(hello.files, 4);
  const order = fake.log.map(e => e.route);
  assert.deepEqual(order.slice(0, 3), ['hello', 'manifest', 'append'], 'hello, then manifest, then shipping');
  for (const e of fake.log) assert.equal(e.headers.authorization, `Bearer ${fake.token}`);
  for (const e of fake.log.filter(x => x.route === 'append')) {
    assert.equal(e.headers['content-type'], 'application/octet-stream');
    assert.ok(!('agent' in e.query) || e.query.agent === 'agent-a1b2c3', 'agent is absent for a conversation');
    assert.ok(!('reset' in e.query), 'reset is sent only to reset');
    for (const v of Object.values(e.query)) assert.ok(!v.includes('/'), 'components only, never a path');
  }

  // Quiet once caught up: several polls and a heartbeat or two, and not one more line.
  const settled = logs.length;
  const hellos = fake.hellos.length;
  await waitFor(() => fake.hellos.length > hellos + 1, 'hello repeated as a heartbeat');
  await sleep(200);
  assert.equal(logs.length, settled, `no line per poll: ${logs.slice(settled).join(' | ')}`);
  assert.ok(logs.some(l => l.startsWith('online:')));
});

test('growth mid-file is appended at the panel\'s offset, and only the new bytes travel', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const file = put(session(root, sid), records(3));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the first lines');
  const first = fs.statSync(file).size;

  fs.appendFileSync(file, records(2, 'alpha', 3));
  await waitFor(() => synced(fake, key, file), 'the growth');
  fs.appendFileSync(file, records(4, 'alpha', 5));
  await waitFor(() => synced(fake, key, file), 'more growth');

  const mine = fake.appends.filter(a => a.key === key);
  assert.equal(mine[0].offset, 0);
  assert.equal(mine[1].offset, first);
  let at = 0;
  for (const a of mine) { assert.equal(a.offset, at); at += a.bytes; }
  assert.equal(at, fs.statSync(file).size, 'every byte sent exactly once');
});

test('a partial last line is held back until its newline lands', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const whole = records(1);
  const tail = records(1, 'alpha', 1);
  const file = put(session(root, sid), whole + tail.slice(0, 20));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  start(t, fake, `main=${root}`);

  await waitFor(() => fake.copy(key)?.toString() === whole, 'the complete line');
  await sleep(200);
  assert.equal(fake.copy(key).toString(), whole, 'the half-written line stays home');
  assert.equal(fake.appends.length, 1, 'and nothing is re-sent while it waits');

  fs.appendFileSync(file, tail.slice(20));
  await waitFor(() => synced(fake, key, file), 'the line once finished');
  assert.deepEqual(fake.violations, []);
});

test('a line longer than 4 MiB goes in 4 MiB pieces, and the copy is identical', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const big = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(CHUNK_MAX * 2 + 1000) } })}\n`;
  const file = put(session(root, sid), big + records(2));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the long line');
  const sizes = fake.appends.map(a => a.bytes);
  assert.deepEqual(sizes.slice(0, 2), [CHUNK_MAX, CHUNK_MAX]);
  assert.equal(sizes.reduce((a, b) => a + b, 0), fs.statSync(file).size);
  assert.ok(fake.appends.at(-1).endsOnNewline);
  assert.deepEqual(fake.violations, []);
});

test('a restart resumes from the manifest: no byte sent twice, none missed', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const file = put(session(root, sid), records(6));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  const first = start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the first run');
  await first.stop();
  const before = fs.statSync(file).size;

  fs.appendFileSync(file, records(5, 'alpha', 6));
  fake.forgetInstance(); // the old instance's last hello has aged out
  const second = start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the second run');

  assert.notEqual(fake.hellos.at(-1).instance, fake.hellos[0].instance, 'a restart is a new instance');
  const resumed = fake.appends.filter(a => a.key === key);
  assert.equal(resumed.reduce((n, a) => n + a.bytes, 0), fs.statSync(file).size, 'no duplicate bytes');
  assert.equal(resumed.at(-1).offset, before, 'the second run started where the panel was');
  assert.equal(sha(fake.copy(key)), sha(fs.readFileSync(file)));
  assert.ok(second.logs.some(l => /1 of 1 local file to ship/.test(l)), second.logs.join(' | '));
});

test('panel down → retries quietly → resumes, with one line for the outage and one for the return', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const file = put(session(root, sid), records(3));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  const { logs } = start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the first lines');

  await fake.down();
  fs.appendFileSync(file, records(3, 'alpha', 3));
  await waitFor(() => logs.some(l => l.startsWith('down:')), 'the outage');
  await sleep(400); // a dozen backoffs at FAST timings
  assert.equal(logs.filter(l => l.startsWith('down:')).length, 1, `one line per outage: ${logs.join(' | ')}`);
  assert.match(logs.find(l => l.startsWith('down:')), /unreachable/);

  await fake.up();
  await waitFor(() => synced(fake, key, file), 'the catch-up');
  assert.equal(logs.filter(l => l.startsWith('online:')).length, 2);
  assert.ok(logs.findIndex(l => l.startsWith('down:')) < logs.findLastIndex(l => l.startsWith('online:')));
  let at = 0;
  for (const a of fake.appends.filter(x => x.key === key)) { assert.equal(a.offset, at); at += a.bytes; }
});

test('a 409 on append refetches the manifest and resumes from the panel\'s size', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const first = records(2);
  const file = put(session(root, sid), first + records(3, 'alpha', 2));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  const { logs } = start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the first lines');

  // The panel's copy loses its tail behind the helper's back — a restore from an older backup.
  fake.setCopy(key, first);
  const manifests = fake.log.filter(e => e.route === 'manifest').length;
  fs.appendFileSync(file, records(2, 'alpha', 5));
  await waitFor(() => synced(fake, key, file), 'the resync');

  assert.ok(fake.log.filter(e => e.route === 'manifest').length > manifests, 'the manifest was fetched again');
  assert.ok(logs.some(l => /409/.test(l) && /manifest again/.test(l)), logs.join(' | '));
  assert.ok(!logs.some(l => l.startsWith('down:')), 'a 409 is not an outage');
  assert.equal(fake.appends.at(-1).offset, Buffer.byteLength(first));
  assert.equal(fake.generations.size, 0, 'resuming is not a reset');
});

test('a file that shrank is sent again from 0 with reset=1; the panel keeps the old copy', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const original = records(8);
  const file = put(session(root, sid), original);
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  const { logs } = start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the original');

  fs.writeFileSync(file, records(2, 'rewritten'));
  await waitFor(() => synced(fake, key, file), 'the reset');
  const reset = fake.appends.find(a => a.reset);
  assert.ok(reset, 'a reset append was sent');
  assert.equal(reset.offset, 0);
  assert.equal(fake.generations.get(key)[0].toString(), original);
  assert.equal(logs.filter(l => /smaller/.test(l)).length, 1);
});

test('a head mismatch on restart resets the panel\'s copy', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const file = put(session(root, sid), records(4));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  const first = start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the first run');
  await first.stop();

  const tampered = Buffer.from(fake.copy(key));
  tampered[30] = tampered[30] === 0x41 ? 0x42 : 0x41; // same size, different head
  fake.setCopy(key, tampered);
  fake.forgetInstance();
  const second = start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the reset');
  assert.ok(fake.appends.some(a => a.reset && a.offset === 0));
  assert.deepEqual(fake.generations.get(key)[0], tampered);
  assert.ok(second.logs.some(l => /head differs/.test(l)));
});

test('a file replaced by a same-size file of other bytes is caught by its new inode and reset', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const file = put(session(root, sid), records(4, 'one'));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the first file');

  const other = records(4, 'two'); // same length: 'one' and 'two' are both three letters
  assert.equal(Buffer.byteLength(other), fs.statSync(file).size);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, other);
  fs.renameSync(tmp, file);
  await waitFor(() => synced(fake, key, file), 'the replacement');
  assert.ok(fake.appends.some(a => a.reset));
});

test('glob roots: each match is its own label, and two roots may share a project name (trap 13)', async t => {
  const fake = await panel(t);
  const base = tree(t);
  const groups = path.join(base, 'groups');
  const shared = '-workspace-agent';
  const one = put(session(path.join(groups, 'g1', '.claude-shared', 'projects'), randomUUID(), shared), records(2, 'g1'));
  const two = put(session(path.join(groups, 'g2', '.claude-shared', 'projects'), randomUUID(), shared), records(3, 'g2'));
  put(session(path.join(groups, '.hidden', '.claude-shared', 'projects'), randomUUID(), shared), records(1));
  put(session(path.join(groups, 'bad name', '.claude-shared', 'projects'), randomUUID(), shared), records(1));
  fs.mkdirSync(path.join(groups, 'g3')); // matches the *, but has no projects dir yet
  const { logs } = start(t, fake, `*=${groups}/*/.claude-shared/projects`);

  const k1 = fileKey({ root: 'g1', project: shared, session: path.basename(one, '.jsonl') });
  const k2 = fileKey({ root: 'g2', project: shared, session: path.basename(two, '.jsonl') });
  await waitFor(() => synced(fake, k1, one) && synced(fake, k2, two), 'both groups');
  assert.equal(fake.copies.size, 2);
  assert.deepEqual(fake.hellos.at(-1).roots.map(r => r.label), ['g1', 'g2']);
  assert.ok(logs.some(l => /bad name/.test(l) && /not a valid root label/.test(l)));

  // A group that appears later is picked up without a restart.
  const late = put(session(path.join(groups, 'g3', '.claude-shared', 'projects'), randomUUID(), shared), records(1, 'g3'));
  const k3 = fileKey({ root: 'g3', project: shared, session: path.basename(late, '.jsonl') });
  await waitFor(() => synced(fake, k3, late), 'the late group');
});

test('a label template prefixes each match, and a conversation the panel refuses is skipped, once', async t => {
  const fake = await panel(t);
  const base = tree(t);
  const sid = randomUUID();
  const one = put(session(path.join(base, 'u-a', 'projects'), sid), records(2, 'a'));
  const two = put(session(path.join(base, 'u-b', 'projects'), sid), records(2, 'b')); // the same id under a second root
  const other = put(session(path.join(base, 'u-b', 'projects')), records(2, 'c'));
  const { logs } = start(t, fake, `grp-*=${base}/u-*/projects`);

  const ka = fileKey({ root: 'grp-a', project: PROJECT, session: sid });
  const kb = fileKey({ root: 'grp-b', project: PROJECT, session: sid });
  const kc = fileKey({ root: 'grp-b', project: PROJECT, session: path.basename(other, '.jsonl') });
  await waitFor(() => synced(fake, kc, other) && (synced(fake, ka, one) || synced(fake, kb, two)), 'the shippable ones');
  await sleep(200);
  assert.equal(fake.copies.size, 2, 'the duplicate id was refused, not merged');
  const refused = logs.filter(l => /refused by the panel/.test(l));
  assert.equal(refused.length, 1, logs.join(' | '));
  assert.ok(!logs.some(l => l.startsWith('down:')), 'one refused file is not an outage');
  assert.equal(fake.log.filter(e => e.route === 'append' && e.query.session === sid).length, 2, 'the refused file was not retried');
});

test('symlinks are refused wherever the walk meets one, and never followed', async t => {
  const fake = await panel(t);
  const base = tree(t);
  const root = path.join(base, 'projects');
  const outside = path.join(base, 'outside');
  const secret = put(path.join(outside, 'secret.jsonl'), records(1, 'secret'));
  put(path.join(outside, 'proj', `${randomUUID()}.jsonl`), records(1, 'secret'));
  put(path.join(outside, 'subs', 'agent-abc.jsonl'), records(1, 'secret'));

  const real = put(session(root), records(2));
  fs.mkdirSync(path.join(root, PROJECT), { recursive: true });
  fs.symlinkSync(secret, session(root)); // a session file
  fs.symlinkSync(path.join(outside, 'proj'), path.join(root, '-linked-project')); // a project dir
  const s2 = path.join(root, PROJECT, randomUUID());
  fs.mkdirSync(s2);
  fs.symlinkSync(path.join(outside, 'subs'), path.join(s2, 'subagents')); // a subagents dir
  const s3 = path.join(root, PROJECT, randomUUID(), 'subagents');
  fs.mkdirSync(s3, { recursive: true });
  fs.symlinkSync(secret, path.join(s3, 'agent-def.jsonl')); // a subagent file
  const s4 = randomUUID();
  fs.mkdirSync(path.join(outside, 'sessiondir', 'subagents'), { recursive: true });
  put(path.join(outside, 'sessiondir', 'subagents', 'agent-ghi.jsonl'), records(1, 'secret'));
  fs.symlinkSync(path.join(outside, 'sessiondir'), path.join(root, PROJECT, s4)); // a session dir
  const groups = path.join(base, 'groups');
  fs.mkdirSync(groups);
  put(session(path.join(outside, 'group', 'projects')), records(1, 'secret'));
  fs.symlinkSync(path.join(outside, 'group'), path.join(groups, 'linked')); // a glob match

  const { logs } = start(t, fake, `main=${root};*=${groups}/*/projects`);
  const key = fileKey({ root: 'main', project: PROJECT, session: path.basename(real, '.jsonl') });
  await waitFor(() => synced(fake, key, real), 'the real file');
  await sleep(300); // a full scan or two
  assert.deepEqual([...fake.copies.keys()], [key]);
  for (const copy of fake.copies.values()) assert.ok(!copy.data.toString().includes('secret'));
  const refusals = logs.filter(l => l.startsWith('refusing symlink'));
  assert.equal(refusals.length, 6, refusals.join('\n'));
  assert.equal(new Set(refusals).size, refusals.length, 'each refusal is said once');
});

test('a wrong token is one line, retried quietly, and writes nothing', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  put(session(root), records(2));
  const { logs } = start(t, fake, `main=${root}`, { token: 'not-the-token' });
  await waitFor(() => logs.some(l => l.startsWith('down:')), 'the refusal');
  await waitFor(() => fake.log.filter(e => e.route === 'hello').length > 3, 'it keeps trying');
  assert.equal(logs.filter(l => l.startsWith('down:')).length, 1);
  assert.match(logs.find(l => l.startsWith('down:')), /token refused \(401\)/);
  assert.equal(fake.copies.size, 0);
});

test('a second instance for the same bot is refused at hello and ships nothing', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  const sid = randomUUID();
  const file = put(session(root, sid), records(2));
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  start(t, fake, `main=${root}`);
  await waitFor(() => synced(fake, key, file), 'the first instance');
  const appends = fake.appends.length;
  const second = start(t, fake, `main=${root}`);
  await waitFor(() => second.logs.some(l => l.startsWith('down:')), 'the second instance\'s refusal');
  await sleep(200);
  assert.match(second.logs.find(l => l.startsWith('down:')), /another helper instance .*409, since /);
  assert.equal(second.logs.filter(l => l.startsWith('down:')).length, 1);
  assert.equal(fake.appends.length, appends);
});

test('a panel that speaks another protocol is refused loudly (426), once', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  put(session(root), records(1));
  for (let i = 0; i < 50; i++) fake.inject.push({ route: 'hello', status: 426, body: { supported: [2] } });
  const { logs } = start(t, fake, `main=${root}`);
  await waitFor(() => logs.some(l => l.startsWith('down:')), 'the refusal');
  await sleep(150);
  assert.equal(logs.filter(l => l.startsWith('down:')).length, 1);
  assert.match(logs.find(l => l.startsWith('down:')), /426; the panel supports \[2\]/);
});

// ------------------------------------------------------------------------------ --check ---

async function check(env) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [HELPER, '--check'], { env: { PATH: process.env.PATH, ...env }, timeout: 15000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('--check says reachable, token accepted, which roots matched and how many files the panel lacks', async t => {
  const fake = await panel(t);
  const base = tree(t);
  const root = path.join(base, 'projects');
  const sid = randomUUID();
  const sent = put(session(root, sid), records(3));
  put(session(root), records(2));
  put(path.join(root, PROJECT, sid, 'subagents', 'agent-a1.jsonl'), records(1));
  const g1 = put(session(path.join(base, 'groups', 'g1', 'projects')), records(1));
  fs.mkdirSync(path.join(base, 'empty'));

  // Ship one file through a running helper, then stop it, so the panel has some and lacks some.
  const key = fileKey({ root: 'main', project: PROJECT, session: sid });
  const h = start(t, fake, `main=${root}`);
  await waitFor(() => fake.copies.size === 3, 'a partial panel');
  await h.stop();
  fake.forgetInstance();
  fs.appendFileSync(sent, records(1, 'alpha', 3)); // now behind
  assert.ok(fake.copy(key));
  const hellos = fake.hellos.length;
  put(session(root), records(1)); // never sent

  const env = {
    FOREMAN_URL: fake.url,
    FOREMAN_BOT: fake.bot,
    FOREMAN_BOT_TOKEN: fake.token,
    FOREMAN_WATCH: `main=${root};*=${base}/groups/*/projects;none-*=${base}/empty/*/projects;gone=${base}/missing`,
  };
  const { code, stdout } = await check(env);
  assert.equal(code, 0, stdout);
  assert.match(stdout, new RegExp(`^panel\\s+${fake.url.replace(/\./g, '\\.')}\\s+reachable$`, 'm'));
  assert.match(stdout, /^token\s+accepted for bot alpha-bot$/m);
  assert.match(stdout, new RegExp(`^roots\\s+main\\s+${root.replace(/[.]/g, '\\.')}\\s+4 files$`, 'm'));
  assert.match(stdout, new RegExp(`^\\s+g1\\s+${path.dirname(path.dirname(g1)).replace(/[.]/g, '\\.')}\\s+1 file$`, 'm'));
  assert.match(stdout, /^\s+none-\*\s+\S+\s+matches nothing$/m);
  assert.match(stdout, /^\s+gone\s+\S+\s+not found$/m);
  assert.match(stdout, /^panel lacks\s+3 of 5 files \(2 never sent, 1 behind or different\)$/m);
  assert.match(stdout, /^result\s+ok$/m);
  assert.equal(fake.hellos.length, hellos, '--check never says hello, so it cannot fight a running helper');
  assert.equal(fake.appends.filter(a => a.offset > 0).length, 0, 'and it ships nothing');
});

test('--check with a wrong token, and with no panel at all', async t => {
  const fake = await panel(t);
  const root = path.join(tree(t), 'projects');
  put(session(root), records(1));
  const env = { FOREMAN_URL: fake.url, FOREMAN_BOT: fake.bot, FOREMAN_BOT_TOKEN: 'wrong', FOREMAN_WATCH: `main=${root}` };

  const refused = await check(env);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /^panel\s+\S+\s+reachable$/m);
  assert.match(refused.stdout, /^token\s+refused for bot alpha-bot/m);
  assert.match(refused.stdout, /^roots\s+main\s+\S+\s+1 file$/m);
  assert.match(refused.stdout, /^panel lacks\s+unknown/m);
  assert.match(refused.stdout, /^result\s+NOT ok$/m);
  assert.ok(!refused.stdout.includes('wrong'), 'the token is never printed');

  await fake.close();
  const gone = await check({ ...env, FOREMAN_BOT_TOKEN: fake.token });
  assert.equal(gone.code, 1);
  assert.match(gone.stdout, /^panel\s+\S+\s+unreachable \(ECONNREFUSED\)$/m);
  assert.match(gone.stdout, /^token\s+not checked$/m);
});

test('the helper refuses to start without its four variables, and says which', async () => {
  const r = await check({});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /missing FOREMAN_URL, FOREMAN_BOT, FOREMAN_BOT_TOKEN, FOREMAN_WATCH/);
});
