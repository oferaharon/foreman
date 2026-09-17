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
const { StatusEngine, foreignTmuxServer, tmuxSocketField } = await import('../server/status.js');
const { PANES_DIR } = await import('../server/config.js');

/** The socket this fake panel is polling. Injected, never read off the machine: a test
 *  that started a tmux server would be a test touching the one server every session on
 *  this Mac shares. */
const OURS = '/private/tmp/tmux-501/default';
const THEIRS = '/private/tmp/tmux-501-scratch/default';

/*
 * Bindings are persisted as receipts under `panes/` and restored at construction, so an
 * engine built in one test would otherwise arrive holding the last one's pane. Each test
 * gets a cold start.
 */
function engine(socketSource = () => OURS) {
  fs.rmSync(PANES_DIR, { recursive: true, force: true });
  return new StatusEngine({ socketSource });
}

/** The panel's own socket resolves a microtask after construction — `ingest` cannot
 *  await, so anything asserting the guard has to let that land first. */
async function armed(socketSource) {
  const st = engine(socketSource);
  await st.primeSocket();
  return st;
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

/* ------------------------------------------------- which tmux server sent it --- */

/*
 * A pane id is only meaningful relative to one tmux server, and every server numbers its
 * panes from `%0`. A bench's scratch server therefore posts receipts for `%0` and `%1`
 * while the real server's `%0` and `%1` belong to somebody else — measured on 2026-09-16,
 * where a scratch session's transcript was drawn under a real session's name because the
 * hook is the authoritative binding rule and had no way to say which server it came from.
 */

test('a receipt from another tmux server is refused whole', async () => {
  const st = await armed();
  st.ingest('PreToolUse', HOOK('scratch'), '%0', THEIRS);

  assert.equal(st.paneBinding('%0'), null, 'no binding — that %0 is not this server\'s %0');
  assert.equal(st.stateOf('scratch'), 'unknown', 'and no status either');
  assert.deepEqual(fs.readdirSync(PANES_DIR), [], 'and nothing written to panes/');
});

test('a receipt from the panel\'s own tmux server binds as it always did', async () => {
  const st = await armed();
  st.ingest('PreToolUse', HOOK('s1'), '%0', OURS);

  assert.equal(st.paneBinding('%0'), 's1');
  assert.equal(st.stateOf('s1'), 'working');
  assert.deepEqual(fs.readdirSync(PANES_DIR), ['_0.json']);
});

/*
 * Fail **open** on absence, and it is deliberate rather than an oversight: every session
 * already running was launched under a hook entry that sends no socket, and Claude Code
 * only picks the new one up when it next re-reads its config. Refusing those would trade
 * an intermittent wrong-transcript bug for a total loss of binding.
 */
test('a receipt carrying no socket is accepted exactly as before', async () => {
  const st = await armed();
  st.ingest('PreToolUse', HOOK('s1'), '%0', null);
  assert.equal(st.paneBinding('%0'), 's1');
  assert.equal(st.stateOf('s1'), 'working');
});

test('an empty socket header is "not told", not a mismatch', async () => {
  const st = await armed();
  // A session outside tmux expands `${TMUX%%,*}` to nothing, so the header arrives blank.
  st.ingest('PreToolUse', HOOK('s1'), '%0', '');
  assert.equal(st.paneBinding('%0'), 's1');
});

test('the panel not yet knowing its own socket also fails open', async () => {
  const st = await armed(() => null); // no tmux server to ask — the boot beat
  st.ingest('PreToolUse', HOOK('s1'), '%0', THEIRS);
  assert.equal(st.paneBinding('%0'), 's1', 'cannot judge means accept, the same rule');
});

/*
 * The whole `$TMUX` variable is `<socket>,<pid>,<session id>`. The installer splits it in
 * the shell, but a sender that forwards the lot must not be refused for a spelling.
 */
test('the socket is read out of a whole $TMUX value too', async () => {
  const st = await armed();
  st.ingest('PreToolUse', HOOK('s1'), '%0', `${OURS},21056,33`);
  assert.equal(st.paneBinding('%0'), 's1');

  const other = engine();
  await other.primeSocket();
  other.ingest('PreToolUse', HOOK('scratch'), '%0', `${THEIRS},999,1`);
  assert.equal(other.paneBinding('%0'), null);
});

test('tmuxSocketField takes the first comma field and reads empty as nothing', () => {
  assert.equal(tmuxSocketField('/tmp/s/default,1,2'), '/tmp/s/default');
  assert.equal(tmuxSocketField('/tmp/s/default'), '/tmp/s/default');
  assert.equal(tmuxSocketField(''), null);
  assert.equal(tmuxSocketField('  '), null);
  assert.equal(tmuxSocketField(null), null);
  assert.equal(tmuxSocketField(undefined), null);
});

/*
 * `/tmp` is a symlink to `/private/tmp` on this platform, and `$TMUX` and
 * `#{socket_path}` do not always agree about which spelling they hand back. Two names for
 * one server must not read as two servers, or the guard refuses every receipt the panel
 * depends on. Resolved against the real filesystem — `/tmp` is a real symlink here, so
 * this is the actual behaviour and not a stub of it.
 */
test('two spellings of one socket are one server', () => {
  assert.equal(fs.realpathSync('/tmp'), '/private/tmp', 'this test needs /tmp to be a symlink');
  assert.equal(foreignTmuxServer('/tmp/tmux-501/default', '/private/tmp/tmux-501/default'), false);
  assert.equal(foreignTmuxServer('/private/tmp/tmux-501/default', '/tmp/tmux-501/default'), false);
});

test('a socket whose server has gone away still compares unequal rather than throwing', () => {
  // Nothing at this path to realpath, which is the common case for a dead scratch server.
  assert.equal(foreignTmuxServer('/tmp/tmux-501-gone/default', '/private/tmp/tmux-501/default'), true);
});

test('a SessionEnd from a foreign server does not unbind one of ours', async () => {
  const st = await armed();
  st.ingest('PreToolUse', HOOK('s1'), '%0', OURS);
  st.ingest('SessionEnd', HOOK('scratch'), '%0', THEIRS);
  assert.equal(st.paneBinding('%0'), 's1', 'the refusal is of the whole receipt, every event');
  assert.equal(st.stateOf('s1'), 'working');
});
