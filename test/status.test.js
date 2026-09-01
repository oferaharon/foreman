import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * `StatusEngine` reads `PANES_DIR` out of `config.js` at construction, so the state dir
 * has to be pointed somewhere disposable before the module is loaded — the real one holds
 * the running panel's hook receipts.
 */
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-status-'));
process.env.FOREMAN_STATE_DIR = STATE_DIR;
const { StatusEngine } = await import('../server/status.js');
const { PANES_DIR } = await import('../server/config.js');

/*
 * Bindings are persisted as receipts under `panes/` and restored at construction, so an
 * engine built in one test would otherwise arrive holding the last one's pane. Each test
 * gets a cold start.
 */
function engine() {
  fs.rmSync(PANES_DIR, { recursive: true, force: true });
  return new StatusEngine();
}

const HOOK = (sessionId) => ({ session_id: sessionId, cwd: '/tmp/x', transcript_path: '/tmp/x.jsonl' });

test('a working session reports working', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), '%7');
  assert.equal(st.stateOf('s1'), 'working');
});

/**
 * An interrupt fires no hook — `Escape` is not a natural stop, so `Stop` never runs. The
 * last receipt is `working` and it stands for the full `STATUS_STALE_MS`, which is ten
 * minutes of the roster insisting a session is busy while its pane shows a composer.
 */
test('an interrupt drops the stale receipt so the pane scrape decides', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), '%7');
  assert.equal(st.stateOf('s1'), 'working');

  assert.deepEqual(st.interrupted('%7', 's1'), ['s1']);
  assert.equal(
    st.stateOf('s1'),
    'unknown',
    '`unknown` is the one answer the precedence in sessions.js hands back to the scrape',
  );
});

test('an interrupt announces the change, so the roster re-reads now rather than at the next poll', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), '%7');

  const seen = [];
  st.on('changed', (id, state) => seen.push([id, state]));
  st.interrupted('%7', 's1');
  assert.deepEqual(seen, [['s1', 'unknown']]);
});

/**
 * The join that can silently do nothing. `states` is keyed by the Claude Code
 * `session_id` off the hook; the endpoint holds a pane id and the registry's id.
 */
test('the pane binding alone is enough to find the receipt', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), '%7');
  // The caller is a pane-only session, so it has no real session id to offer.
  assert.deepEqual(st.interrupted('%7', 'pane-7'), ['s1']);
  assert.equal(st.stateOf('s1'), 'unknown');
});

test('the registry id alone is enough when no hook has ever bound the pane', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), null); // a hook that arrived without a pane header
  assert.equal(st.paneBinding('%7'), null);
  assert.deepEqual(st.interrupted('%7', 's1'), ['s1']);
  assert.equal(st.stateOf('s1'), 'unknown');
});

/**
 * `/clear` mints a new session id, and the pane's binding names the old one until the
 * next hook lands. Whatever the pane is currently answering to, the receipt for it is the
 * one now known to be stale — so both are dropped.
 */
test('a rotation mid-flight clears both spellings of the pane', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('old'), '%7');
  st.states.set('new', { state: 'working', ts: Date.now() });

  assert.deepEqual(st.interrupted('%7', 'new').sort(), ['new', 'old']);
  assert.equal(st.stateOf('old'), 'unknown');
  assert.equal(st.stateOf('new'), 'unknown');
});

test('interrupting a session with no receipt changes nothing and says so', () => {
  const st = engine();
  const seen = [];
  st.on('changed', (...a) => seen.push(a));
  assert.deepEqual(st.interrupted('%7', 's1'), []);
  assert.deepEqual(seen, []);
});

test('an interrupt leaves the pane binding alone', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), '%7');
  st.interrupted('%7', 's1');
  assert.equal(st.paneBinding('%7'), 's1', 'the binding is how the pane is identified at all');
});

/** The ordinary path, unbroken: a natural stop still fires `Stop` and still wins. */
test('a natural stop after an interrupt reports idle again', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), '%7');
  st.interrupted('%7', 's1');
  st.ingest('Stop', HOOK('s1'), '%7');
  assert.equal(st.stateOf('s1'), 'idle');
});

test('a message sent after an interrupt puts the session back to working', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), '%7');
  st.interrupted('%7', 's1');
  st.ingest('UserPromptSubmit', HOOK('s1'), '%7');
  assert.equal(st.stateOf('s1'), 'working');
});

test('interrupting one session does not touch another', () => {
  const st = engine();
  st.ingest('PreToolUse', HOOK('s1'), '%7');
  st.ingest('PreToolUse', HOOK('s2'), '%9');
  st.interrupted('%7', 's1');
  assert.equal(st.stateOf('s2'), 'working');
});
