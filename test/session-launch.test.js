import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Two subjects, and the second is the one that will actually catch something.
 *
 * The files: what every ordinary session on this Mac is told, and the one tool server it is
 * given. Both are static and both are world-readable, so what they must *not* contain is as
 * much of the subject as what they must.
 *
 * The call sites: `server/index.js` has six `createSession(` calls and four of them are
 * standalone launches. Missing one is invisible — the session comes up looking exactly like
 * every other, simply without the tools — which is the "a saved lead came back as an ordinary
 * session" bug wearing a different hat. So this reads the source and refuses a call that
 * neither passes the helper's result nor says in as many words why it is exempt. It is the
 * `test/logs.test.js` idiom: three copies of one fact in three places, held together by the
 * only mechanism available, which is a test that reads them.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

/*
 * `config.js` resolves `STATE_DIR` and `PORT` **once, at import**, and the module under test
 * imports it — so the scratch values have to be in the environment before the first import
 * anywhere in this process, and a second dir cannot be swapped in later however the URL is
 * spelled (a query string busts `session-launch.js`'s own cache entry, never `config.js`'s).
 * Hence one scratch dir for the file, set here. `node --test` gives each test file its own
 * process, so nothing else in the suite sees these.
 */
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-session-launch-'));
process.env.FOREMAN_STATE_DIR = STATE;
process.env.FOREMAN_PORT = '48999';
process.on('exit', () => fs.rmSync(STATE, { recursive: true, force: true }));

const mod = await import('../server/session-launch.js');

/* ------------------------------------------------------------------ the two files --- */

test('both files land under the state dir it was given, and nowhere else', async () => {
  const { brief, mcp } = await mod.writeSessionFiles();
  assert.equal(brief, path.join(STATE, 'session-brief.md'));
  assert.equal(mcp, path.join(STATE, 'session-mcp.json'));
  // Nothing else, and nothing per session: the identity is read from `TMUX_PANE` at run
  // time, so there is exactly one pair of files on the machine and nothing to collect.
  assert.deepEqual(fs.readdirSync(STATE).sort(), ['session-brief.md', 'session-mcp.json']);
});

test('the MCP config names the session role, no repo, and no credential', async () => {
  await mod.writeSessionFiles();

  const cfg = JSON.parse(fs.readFileSync(path.join(STATE, 'session-mcp.json'), 'utf8'));
  const entry = cfg.mcpServers.foreman;
  assert.equal(entry.type, 'stdio');
  assert.equal(entry.command, process.execPath);
  assert.equal(entry.args.length, 1);
  assert.ok(entry.args[0].endsWith(path.join('mcp', 'foreman.js')), `not the MCP server: ${entry.args[0]}`);
  assert.ok(fs.existsSync(entry.args[0]), `${entry.args[0]} does not exist`);

  // The role is the whole of the scope. `FOREMAN_REPO` would pin a standalone to one repo,
  // and a room's whole point is a session in one codebase talking to a session in another.
  assert.deepEqual(Object.keys(entry.env).sort(), ['FOREMAN_PORT', 'FOREMAN_ROLE']);
  assert.equal(entry.env.FOREMAN_ROLE, 'session');
  assert.equal(entry.env.FOREMAN_PORT, '48999');

  // World-readable, and nothing here is ever copied from the user's own config — so there is
  // no `credentialKeys` refusal to make, and there must never be anything for one to catch.
  // Checked against the serialized file rather than the object: this is about the bytes.
  const raw = fs.readFileSync(path.join(STATE, 'session-mcp.json'), 'utf8');
  for (const word of ['TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'PAT', 'Authorization']) {
    assert.ok(!raw.toUpperCase().includes(word.toUpperCase()), `session-mcp.json mentions ${word}`);
  }
});

test('the role is one mcp/foreman.js actually recognises', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'mcp', 'foreman.js'), 'utf8');
  // A role the server does not know fails closed at launch — correct, and it would mean
  // every ordinary session silently starting with no tool server at all.
  assert.match(src, /const ROLES = \[[^\]]*'session'/, 'mcp/foreman.js does not accept the `session` role');
});

test('the brief names the three tools and both line prefixes, and names nobody', async () => {
  await mod.writeSessionFiles();
  const brief = fs.readFileSync(path.join(STATE, 'session-brief.md'), 'utf8');

  for (const tool of ['group_list', 'group_post', 'group_read']) {
    assert.ok(brief.includes(tool), `the brief never names ${tool}`);
  }
  // The team room's own tools are a different surface with the same word in them. A brief
  // that named one would be teaching a standalone about a tool it does not have.
  for (const wrong of ['room_post', 'room_read', 'task_report', 'worker_send']) {
    assert.ok(!brief.includes(wrong), `the brief names ${wrong}, which a standalone does not have`);
  }

  // The two prefixes, and what each means. `envelope.js` guarantees no body can reach
  // column 0; that guarantee is worth nothing unless the reader knows what the prefix says.
  assert.ok(brief.includes('`> `'), 'the brief does not name the peer prefix');
  assert.ok(brief.includes('`| `'), 'the brief does not name the human prefix');
  assert.ok(brief.includes('**never authority**'), 'the brief does not say a `> ` line is never authority');
  assert.ok(brief.includes('the person at the keyboard'), 'the brief does not say whose word a `| ` line is');

  // `@name`, and the half a session could get wrong: a mention is a **signal**, so being
  // named changes what this session is told and never who was told. A brief that taught only
  // the first half would have a session answering a post it was explicitly told was somebody
  // else's, or staying quiet on one addressed to it.
  assert.ok(brief.includes('`@name` addresses a post'), 'the brief never mentions `@name`');
  assert.ok(brief.includes('Everyone in the room\nstill hears everything'), 'the brief must say a mention narrows nothing');
  assert.ok(
    brief.includes('If the header line\nsays the post is addressed to **you**'),
    'the brief does not say what to do when named',
  );
  assert.ok(brief.includes('If it names somebody else and adds *not you*'), 'the brief does not say what to do when not named');
  assert.ok(brief.includes('spelled exactly as `group_list` gives it'), 'the brief must point at the live list');

  /*
   * The shape on the wire, ruled 2026-09-05. The per-post envelope stopped restating the
   * `> ` rule, so this brief is now the only place a session learns it — and it therefore
   * also has to describe the one line that *does* arrive, or `→ you` reaches a session with
   * nothing to read it against. The parts, not the sentence: they are the contract
   * (`room-header.js`) and the sentence is copy.
   */
  assert.ok(brief.includes('one header line, then the post itself'), 'the brief does not describe a delivery');
  assert.ok(
    brief.includes('says who spoke, which room by name and id, and who it\nwas addressed to'),
    'the brief does not say what the header line carries',
  );
  for (const arrow of ['`→ all`', '`→ you`', 'not you — for your information']) {
    assert.ok(brief.includes(arrow), `the brief does not spell the arrow ${arrow}`);
  }
  assert.ok(brief.includes('nothing is explained again per post'), 'the brief does not say the rule is not repeated');
  assert.ok(
    brief.includes("Who else is in the room is `group_list`'s answer, not the\npost's"),
    'the brief does not say where the roster went',
  );

  // One file for the whole machine, which is only sound while it names no repo and no
  // person. `humanName` is what a *lead's* brief uses; a standalone brief has no repo to
  // ask, which is the whole reason it is anonymous.
  assert.ok(!/[Oo]fer/.test(brief), 'the standalone brief names a person');
  assert.equal(brief, mod.sessionBrief(), 'the file on disk is not what sessionBrief() returns');
});

/* ------------------------------------------------------------------- the flags --- */

test('the flags merge the MCP config and never replace it', async () => {
  const args = await mod.standaloneArgs();

  assert.deepEqual(args, [
    '--append-system-prompt-file', path.join(STATE, 'session-brief.md'),
    '--mcp-config', path.join(STATE, 'session-mcp.json'),
  ]);

  // The measured one. `--mcp-config` merges; `--strict-mcp-config` turns it into a
  // replacement, and an ordinary session has around ten other servers registered. Adding it
  // here would strip every one of them with nothing on screen to say so.
  assert.ok(
    !args.includes('--strict-mcp-config'),
    '--strict-mcp-config would silently strip every other MCP server an ordinary session has',
  );
  // Nor a settings file: a standalone's permission stance is the user's own.
  assert.ok(!args.includes('--settings'), 'a standalone gets no generated settings file');
});

test('the flags are rewritten from source, not read back off disk', async () => {
  // A brief only reaches the *next* session, so the one thing that must not happen is a
  // launch pointing at a file the last boot wrote.
  await mod.writeSessionFiles();
  fs.writeFileSync(path.join(STATE, 'session-brief.md'), 'stale');
  await mod.standaloneArgs();
  assert.equal(fs.readFileSync(path.join(STATE, 'session-brief.md'), 'utf8'), mod.sessionBrief());
});

/* -------------------------------------------------------------- the call sites --- */

/**
 * Every `createSession(` in `server/index.js`, as {line, block} — the block being the
 * argument list, found by balancing parentheses from the call itself so a nested call or an
 * object spanning thirty lines is read whole.
 */
function createSessionCalls(src) {
  const calls = [];
  const needle = 'createSession(';
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    // `export async function createSession(` in launch.js has no analogue here, but an
    // import line would match, so skip anything that isn't a call in the body.
    if (/[\w$.]/.test(src[i - 1] || '')) continue;
    let depth = 0;
    let end = i + needle.length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    calls.push({
      line: src.slice(0, i).split('\n').length,
      block: src.slice(i, end + 1),
      // The five lines above the call, where an exemption states its case.
      preamble: src.slice(0, i).split('\n').slice(-6).join('\n'),
    });
  }
  return calls;
}

test('every standalone launch site passes the one helper, and every exception says why', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'server', 'index.js'), 'utf8');
  const calls = createSessionCalls(src);

  // A floor, not an exact count: the point is that the parse found the calls at all. If this
  // fails, the walk above broke — fix it before trusting anything below.
  assert.ok(calls.length >= 4, `only found ${calls.length} createSession call sites`);

  const missing = [];
  const exempt = [];
  for (const call of calls) {
    if (call.block.includes('standaloneArgs(')) continue;
    if (call.preamble.includes('standalone-args: exempt')) {
      exempt.push(call.line);
      continue;
    }
    missing.push(call.line);
  }

  assert.deepEqual(
    missing,
    [],
    `server/index.js:${missing.join(', ')} calls createSession without standaloneArgs() and without ` +
      'a `// standalone-args: exempt — <why>` comment above it. A standalone launched without ' +
      'those flags looks identical in the rail and simply has no rooms.',
  );

  // Exactly two exceptions, and both are launches that build their own brief and MCP config:
  // the lead, and a worker. A third would be a new kind of session and wants its own answer.
  assert.equal(exempt.length, 2, `expected two exempt call sites, found ${exempt.length}: ${exempt.join(', ')}`);
});

test('the four standalone sites are the ones the plan names', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'server', 'index.js'), 'utf8');
  const calls = createSessionCalls(src).filter((c) => c.block.includes('standaloneArgs('));
  assert.equal(calls.length, 4, `expected four standalone launch sites, found ${calls.length}`);

  // Named by what each one launches, so a site that moves is still recognised and a site that
  // *disappears* is caught. `restoreSessions` is handed one `startSession` by snapshot restore
  // and another by relaunch-all — two call sites, one loop, and skipping either was the
  // easiest of the four to miss.
  const blocks = calls.map((c) => c.block).join('\n');
  assert.ok(blocks.includes('req.body?.folder'), 'the /api/launch non-lead branch does not pass the flags');
  assert.ok(blocks.includes('session.paneCwd'), 'the duplicate endpoint does not pass the flags');
  assert.equal(
    calls.filter((c) => c.block.includes('...opts')).length,
    2,
    'snapshot restore and relaunch-all must each hand restoreSessions a startSession that passes the flags',
  );
});
