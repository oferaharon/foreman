import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A scratch state dir before `config.js` is ever imported: the store writes
// `shared-room.jsonl` under it, and `SESSION_PREFIX` resolves from its `config.json` —
// which does not exist here, so it takes the documented default and this file's
// name-fallback test does not depend on whatever the real machine has configured.
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-observe-'));

const { SharedRoomStore } = await import('../server/shared-room.js');
const { SESSION_PREFIX } = await import('../server/config.js');
const { Observer, participant, resolveSender, isPeerPrompt, MAX_AGE_MS } = await import('../server/observe.js');

const DIR = process.env.FOREMAN_STATE_DIR;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * `test/fixtures/peer-inbox-beta.jsonl` is a **real** recipient transcript captured off a
 * scratch pair in the sandbox — two genuine `origin.kind: 'peer'` records with Claude
 * Code's own peer-safety boilerplate intact in `message.content`, wrapped in ordinary
 * user/assistant noise. Only the identities were rewritten to sandbox names and the paths
 * to sandbox paths; the record shape is untouched, which is the whole point of it being a
 * capture rather than a reconstruction.
 */
const INBOX = fs.readFileSync(path.join(FIXTURES, 'peer-inbox-beta.jsonl'), 'utf8');
const RECORDS = INBOX.trim().split('\n').map((l) => JSON.parse(l));
const FROM_ALPHA = RECORDS.find((r) => r.origin?.name === 'alpha');
const FROM_GAMMA = RECORDS.find((r) => r.origin?.name === 'gamma');

const NOW = Date.parse('2026-09-05T06:10:00.000Z');

let n = 0;
const scratch = (name) => {
  const dir = path.join(DIR, `case-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return name ? path.join(dir, name) : dir;
};

test.after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the roster and registry

/** A roster row of the shape `sessions.js` broadcasts, trimmed to what the observer reads. */
function row(label, { pane, pid, team = null, transcriptPath = null, id = `sid-${label}` }) {
  return {
    id,
    label,
    title: label,
    cwd: `/sandbox/${label}`,
    transcriptPath,
    paneId: pane,
    tmuxSession: `${SESSION_PREFIX}${label}`,
    team,
    pid,
  };
}

/** One `~/.claude/sessions/<pid>.json`, the file Claude Code writes per live session. */
function registry(dir, pid, { name, pane, cwd = `/sandbox/${name}`, sessionId = `sid-${name}` }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, name, nameSource: 'user', tmux: `${SESSION_PREFIX}${name}:@1.${pane}` }),
  );
}

/** A whole bench: a registry dir, a store, an observer and a roster, wired together. */
function bench({ rows, records = [], file = 'inbox.jsonl' } = {}) {
  const dir = scratch();
  const peersDir = path.join(dir, 'sessions');
  fs.mkdirSync(peersDir, { recursive: true });
  const transcript = path.join(dir, file);
  fs.writeFileSync(transcript, records.map((r) => `${JSON.stringify(r)}\n`).join(''));

  const roster = rows.map((r) => (r.transcriptPath === '@' ? { ...r, transcriptPath: transcript } : r));
  const store = new SharedRoomStore(path.join(dir, 'shared-room.jsonl'));
  const observer = new Observer({
    store,
    roster: () => roster,
    peersDir,
    retryMs: 1,
    now: () => NOW,
  });
  return { dir, peersDir, transcript, roster, store, observer };
}

// ------------------------------------------------------------------ the participant rule

test('participant is an allow-list on role, not "not a worker"', () => {
  assert.equal(participant({ team: null }), true, 'an ordinary session is in');
  assert.equal(participant({}), true, 'no team field at all is in');
  assert.equal(participant({ team: { role: 'lead' } }), true);
  assert.equal(participant({ team: { role: 'worker' } }), false);
  // The reason it is written as an allow-list: a role nobody has thought of yet must be
  // out until somebody names it here, not in by default. `benchEntries`' lesson.
  assert.equal(participant({ team: { role: 'planner' } }), false);
  assert.equal(participant(null), false);
});

test('the hook witness matches the envelope and nothing else', () => {
  assert.equal(isPeerPrompt('<cross-session-message from="uds:/tmp/cc-socks/1.sock">hi</cross-session-message>'), true);
  assert.equal(isPeerPrompt('please read <cross-session-message ...'), false, 'anchored, so a quote is not a message');
  assert.equal(isPeerPrompt('<cross-session-messages-are-fun>'), false, '\\b, so a longer tag is not a match');
  assert.equal(isPeerPrompt(undefined), false);
});

// ------------------------------------------------------------------------- the happy path

test('a peer message between two participants is ingested, both ends resolved', () => {
  const b = bench({
    records: RECORDS,
    rows: [
      row('beta', { pane: '%19', transcriptPath: '@' }),
      row('alpha', { pane: '%12' }),
    ],
  });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });

  const written = b.observer.ingest(FROM_ALPHA, b.roster[0], NOW);

  assert.ok(written, 'the entry was written');
  assert.deepEqual(
    { ...written, seq: undefined },
    {
      seq: undefined,
      ts: Date.parse('2026-09-05T06:07:59.521Z'),
      kind: 'peer',
      msgId: '900440c3-3294-45e0-8f0a-7a27f7914d71',
      text: 'PEER-LINE-4417 hello from alpha',
      from: {
        name: 'alpha',
        tmuxSession: `${SESSION_PREFIX}alpha`,
        paneId: '%12',
        cwd: '/sandbox/alpha',
        sessionId: 'sid-alpha',
        pid: 50048,
      },
      to: {
        name: 'beta',
        tmuxSession: `${SESSION_PREFIX}beta`,
        paneId: '%19',
        cwd: '/sandbox/beta',
        sessionId: 'sid-beta',
      },
      fromRole: null,
      toRole: null,
      fromSource: 'registry',
      reply: false,
    },
  );
});

test('the entry is stamped when the message landed, not when the panel noticed it', () => {
  // The boot sweep can meet a message hours after it arrived. A log that stamped it `now`
  // would sort it above traffic that genuinely came later.
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  const e = b.observer.ingest(FROM_ALPHA, b.roster[0], NOW);
  assert.notEqual(e.ts, NOW);
  assert.equal(e.ts, Date.parse(FROM_ALPHA.timestamp));
});

test('text is origin.body, and no entry ever carries the peer-safety boilerplate', async () => {
  const b = bench({
    records: RECORDS,
    rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' }), row('gamma', { pane: '%7' })],
  });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  registry(b.peersDir, 50123, { name: 'gamma', pane: '%7' });

  await b.observer.sweep(undefined, { now: NOW });

  const entries = b.store.readAll();
  assert.deepEqual(entries.map((e) => e.text), [
    'PEER-LINE-4417 hello from alpha',
    'PROBE-TWO-8821 hook test',
  ]);
  // The boilerplate is in the fixture — if it were not, this test would prove nothing.
  assert.ok(INBOX.includes('permission laundering'), 'the capture carries the boilerplate');
  const written = fs.readFileSync(path.join(path.dirname(b.transcript), 'shared-room.jsonl'), 'utf8');
  assert.ok(!written.includes('permission laundering'), 'and none of it reached the room');
  assert.ok(!written.includes('cross-session-message'), 'nor did the envelope');
});

// ------------------------------------------------------------------------------- dedupe

test('the same record ingested twice writes once', () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });

  const first = b.observer.ingest(FROM_ALPHA, b.roster[0], NOW);
  const second = b.observer.ingest(FROM_ALPHA, b.roster[0], NOW);

  assert.ok(first);
  assert.equal(second, null, 'the msgId was already known');
  assert.equal(b.store.readAll().length, 1);
});

test('the hook and the sweep can both see one message and it is logged once', async () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  registry(b.peersDir, 50123, { name: 'gamma', pane: '%7' });

  await b.observer.onHookPrompt({ transcriptPath: b.transcript, sessionId: 'sid-beta' }, { now: NOW });
  await b.observer.sweep(undefined, { now: NOW });

  // gamma is not on the roster here, so only alpha's message is admitted — and it is
  // admitted exactly once even though two channels saw the same bytes.
  assert.equal(b.store.readAll().filter((e) => e.msgId === FROM_ALPHA.origin.msg_id).length, 1);
});

// ------------------------------------------------------------------ the two ends' roles

test('a worker→lead message IS ingested, tagged fromRole worker', () => {
  // The maintainer's 2026-09-04 ruling: workers are out of `@` addressing, but a worker's
  // message to its lead is shown. It is the one real non-scratch peer message on this
  // machine and a symmetrical rule would hide exactly that.
  const b = bench({
    records: RECORDS,
    rows: [
      row('beta', { pane: '%19', transcriptPath: '@', team: { role: 'lead', tasks: 2, review: 0 } }),
      row('alpha', { pane: '%12', team: { role: 'worker', repo: '/sandbox/beta', task: 'some-task' } }),
    ],
  });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });

  const e = b.observer.ingest(FROM_ALPHA, b.roster[0], NOW);

  assert.ok(e, 'a worker sender is admitted');
  assert.equal(e.fromRole, 'worker');
  assert.equal(e.toRole, 'lead');
  assert.equal(e.fromSource, 'registry');
});

test('a message TO a worker is refused, and the sweep never reads a worker inbox', async () => {
  // The other half of the split: the recipient must be a participant, with no exception.
  // A lead talking to its worker is that pair's business, and the room is not a second
  // inbox for it. Both channels agree — the sweep skips the row, and the hook refuses it.
  const b = bench({
    records: RECORDS,
    rows: [
      row('beta', { pane: '%19', transcriptPath: '@', team: { role: 'worker', repo: '/sandbox/alpha', task: 't' } }),
      row('alpha', { pane: '%12', team: { role: 'lead', tasks: 1, review: 0 } }),
    ],
  });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });

  assert.equal(b.observer.ingest(FROM_ALPHA, b.roster[0], NOW), null);
  assert.equal(await b.observer.sweep(undefined, { now: NOW }), 0);
  assert.equal(await b.observer.onHookPrompt({ transcriptPath: b.transcript, sessionId: 'sid-beta' }, { now: NOW }), 0);
  assert.equal(b.store.readAll().length, 0);
});

// ------------------------------------------------------------------- resolving the sender

test('a sender whose registry file is gone falls back to the name, marked as a guess', () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  // No registry file written at all — the sender has exited, which happens within seconds.

  const e = b.observer.ingest(FROM_ALPHA, b.roster[0], NOW);

  assert.ok(e);
  assert.equal(e.fromSource, 'name', 'labelled as the guess it is');
  assert.equal(e.from.name, 'alpha');
  assert.equal(e.from.paneId, '%12', 'the row it guessed its way to still resolves the rest');
});

test('a sender that joins to no roster row at all is refused', () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' })] });
  // Nothing named `alpha` in the roster and no registry file: a Remote Control sender, or
  // a session outside tmux. It joins to no participant row, so it is out — structurally,
  // not by filtering a list of names.

  assert.equal(b.observer.ingest(FROM_ALPHA, b.roster[0], NOW), null);
  assert.deepEqual(resolveSender({ fromPid: 50048, from: 'alpha' }, b.roster, { peersDir: b.peersDir }), {
    row: null,
    fromSource: 'unknown',
  });
  assert.equal(b.store.readAll().length, 0);
});

test('a registry entry joins by pane, or by tmux session when the pane has moved', () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  // tmux pane ids restart at %0 when the server goes down, so a registry entry can name a
  // pane the roster no longer has while naming a session it plainly does. Session names
  // are the contract that survives; the pane id is not.
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%999' });
  assert.equal(resolveSender({ fromPid: 50048, from: 'alpha' }, b.roster, { peersDir: b.peersDir }).fromSource, 'registry');
});

test('a registry entry that joins to nothing still falls through to the name rung', () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  // The registry read succeeds but names a session and a pane the roster has never heard
  // of — a stale file, or a pid reused. Reading it must not consume the attempt: the name
  // rung still has to be tried, or a resolvable sender is thrown away by a bad file.
  fs.writeFileSync(
    path.join(b.peersDir, '50048.json'),
    JSON.stringify({ pid: 50048, sessionId: 'sid-ghost', name: 'ghost', tmux: 'somebody-else:@1.%999' }),
  );
  const { row: found, fromSource } = resolveSender({ fromPid: 50048, from: 'alpha' }, b.roster, { peersDir: b.peersDir });
  assert.equal(fromSource, 'name');
  assert.equal(found.label, 'alpha');
});

test('a record that is not a peer message is ignored', () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  const plain = RECORDS.find((r) => !r.origin);
  assert.equal(b.observer.ingest(plain, b.roster[0], NOW), null);
});

// --------------------------------------------------------------------- reading the files

test('the sweep reads only the new bytes after the first pass', async () => {
  const b = bench({ records: [RECORDS[0]], rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });

  assert.equal(await b.observer.sweep(undefined, { now: NOW }), 0, 'no peer records yet');
  const firstOffset = b.observer.offsets.get(b.transcript);
  assert.equal(firstOffset, fs.statSync(b.transcript).size);

  fs.appendFileSync(b.transcript, `${JSON.stringify(FROM_ALPHA)}\n`);
  assert.equal(await b.observer.sweep(undefined, { now: NOW }), 1);
  assert.ok(b.observer.offsets.get(b.transcript) > firstOffset);
});

test('a half-written last line is held back and picked up once it is whole', async () => {
  const b = bench({ records: [RECORDS[0]], rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  await b.observer.sweep(undefined, { now: NOW });

  const line = JSON.stringify(FROM_ALPHA);
  fs.appendFileSync(b.transcript, line.slice(0, 200));
  assert.equal(await b.observer.sweep(undefined, { now: NOW }), 0, 'a torn tail is not a record');

  fs.appendFileSync(b.transcript, `${line.slice(200)}\n`);
  assert.equal(await b.observer.sweep(undefined, { now: NOW }), 1);
});

test('the first pass is bounded to recent records; later passes are not aged', async () => {
  const stale = { ...FROM_ALPHA, timestamp: new Date(NOW - MAX_AGE_MS - 60_000).toISOString() };
  const b = bench({ records: [RECORDS[0], stale], rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });

  assert.equal(await b.observer.sweep(undefined, { now: NOW }), 0, 'older than the window, so the room does not open on it');

  // The same message arriving *live* is not aged — it is new by construction.
  const fresh = { ...FROM_ALPHA, origin: { ...FROM_ALPHA.origin, msg_id: 'live-1' }, timestamp: new Date(NOW - MAX_AGE_MS - 60_000).toISOString() };
  fs.appendFileSync(b.transcript, `${JSON.stringify(fresh)}\n`);
  assert.equal(await b.observer.sweep(undefined, { now: NOW }), 1);
});

test('a transcript that is not there is not an error', async () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' })] });
  fs.rmSync(b.transcript);
  assert.equal(await b.observer.sweep(undefined, { now: NOW }), 0);
  assert.equal(await b.observer.onHookPrompt({ transcriptPath: b.transcript, sessionId: 'sid-beta' }, { now: NOW }), 0);
});

test('offsets are forgotten when a transcript leaves the roster', async () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  await b.observer.sweep(undefined, { now: NOW });
  assert.equal(b.observer.offsets.size, 1);
  await b.observer.sweep([], { now: NOW });
  assert.equal(b.observer.offsets.size, 0, 'the map does not grow for the life of the process');
});

// ------------------------------------------------------------------------- the hook path

test('the hook path reads the tail and ingests what it finds', async () => {
  const b = bench({
    records: RECORDS,
    rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' }), row('gamma', { pane: '%7' })],
  });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  registry(b.peersDir, 50123, { name: 'gamma', pane: '%7' });

  const written = await b.observer.onHookPrompt(
    { transcriptPath: b.transcript, sessionId: 'sid-beta', paneId: '%19' },
    { now: NOW },
  );
  assert.equal(written, 2);
});

test('the hook path retries once when the record has not landed yet', async () => {
  // The measured gap is a few milliseconds, but a busy recipient cannot be bounded, so a
  // read that finds nothing waits and reads once more. One retry, not a loop.
  const b = bench({ records: [RECORDS[0]], rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });

  const late = setTimeout(() => fs.appendFileSync(b.transcript, `${JSON.stringify(FROM_ALPHA)}\n`), 0);
  const written = await b.observer.onHookPrompt({ transcriptPath: b.transcript, sessionId: 'sid-beta' }, { now: NOW });
  clearTimeout(late);

  assert.equal(written, 1, 'the retry caught the record the first read missed');
});

test('the hook path refuses a transcript it cannot join to a roster row', async () => {
  const b = bench({ records: RECORDS, rows: [row('alpha', { pane: '%12' })] });
  assert.equal(await b.observer.onHookPrompt({ transcriptPath: b.transcript, sessionId: 'nobody' }, { now: NOW }), 0);
});

test('the recipient is found by pane, and by file, when the session id does not match', async () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  registry(b.peersDir, 50123, { name: 'gamma', pane: '%7' });

  assert.equal(await b.observer.onHookPrompt({ transcriptPath: b.transcript, paneId: '%19' }, { now: NOW }), 1);

  const b2 = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b2.peersDir, 50048, { name: 'alpha', pane: '%12' });
  assert.equal(await b2.observer.onHookPrompt({ transcriptPath: b2.transcript }, { now: NOW }), 1);
});

test('a task notification is never mistaken for a peer message', () => {
  // Both carry `promptSource: 'system'` (measured, 13/13), so the two parsers are kept
  // apart only by their second witness. This is the one case where they can collide.
  const notice = {
    type: 'user',
    isMeta: true,
    promptSource: 'system',
    uuid: '33333333-3333-4333-8333-333333333333',
    timestamp: '2026-09-05T06:08:00.000Z',
    message: { role: 'user', content: '<task-notification><summary>agent finished</summary></task-notification>' },
  };
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('alpha', { pane: '%12' })] });
  registry(b.peersDir, 50048, { name: 'alpha', pane: '%12' });
  assert.equal(b.observer.ingest(notice, b.roster[0], NOW), null);
});

test('the second fixture record resolves independently of the first', () => {
  const b = bench({ records: RECORDS, rows: [row('beta', { pane: '%19', transcriptPath: '@' }), row('gamma', { pane: '%7' })] });
  registry(b.peersDir, 50123, { name: 'gamma', pane: '%7' });
  const e = b.observer.ingest(FROM_GAMMA, b.roster[0], NOW);
  assert.equal(e.text, 'PROBE-TWO-8821 hook test');
  assert.equal(e.from.name, 'gamma');
  assert.equal(e.fromSource, 'registry');
});
