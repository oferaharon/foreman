import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * The reference bot in `helper/example/` — a bench kit, never a deployment (its README says
 * so). What can be held here without Docker: that the Dockerfile copies files that exist,
 * that `bot-run.sh` keeps the prompt out of `--allowedTools`' reach, and that the fake
 * Messages API answers what Claude Code actually sends with the SSE sequence the real API
 * uses. The container itself was run against a scratch panel; `docs/traps/bots.md` has what
 * that measured.
 */

const ROOT = path.join(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'helper', 'example');
const FAKE = path.join(EXAMPLE, 'fake-messages-api.mjs');

test('the Dockerfile copies files that exist in its build context, the helper unmodified', () => {
  const dockerfile = fs.readFileSync(path.join(EXAMPLE, 'Dockerfile'), 'utf8');
  const sources = dockerfile
    .split('\n')
    .filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
    .map((l) => l.trim().split(/\s+/).filter((w) => !w.startsWith('--'))[1]);
  assert.ok(sources.includes('foreman-helper.mjs'), 'the helper is copied in as it is in the repo');
  for (const src of sources) {
    assert.ok(fs.existsSync(path.join(ROOT, 'helper', src)), `COPY ${src}: not in the helper/ build context`);
  }
  assert.match(dockerfile, /^USER node$/m, 'Claude Code and the helper run as one user, the one that owns the 0600 transcripts');
});

test('bot-run.sh puts --allowedTools after the prompt, since the option takes every argument after it', () => {
  const script = fs.readFileSync(path.join(EXAMPLE, 'bot-run.sh'), 'utf8');
  const call = script.slice(script.indexOf('exec claude'));
  assert.ok(call.indexOf('"$@"') < call.indexOf('--allowedTools'), call);
  assert.match(call, /<\s*\/dev\/null/, '-p waits for stdin otherwise');
});

/* ------------------------------------------------------- the fake Messages API --- */

let child;
let base;

test.before(async () => {
  child = spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE_API_PORT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.setEncoding('utf8');
  base = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`the fake API never listened:\n${err}`)), 10_000);
    child.stderr.on('data', (d) => {
      err += d;
      const m = /listening on (127\.0\.0\.1:\d+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(`http://${m[1]}`);
      }
    });
  });
});

test.after(() => child?.kill('SIGTERM'));

/** The SSE body as `[{event, data}]`. */
function events(text) {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const event = /^event: (.+)$/m.exec(b)?.[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(b)[1]);
      return { event, data };
    });
}

const TOOLS = [{ name: 'Bash' }, { name: 'Read' }];
const prompt = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

async function post(body, url = '/v1/messages?beta=true') {
  const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { res, text: await res.text() };
}

test('a prompt is answered with the API\'s SSE sequence, asking for one Bash call, on the model it was sent', async () => {
  const { res, text } = await post({ model: 'claude-haiku-5-5', stream: true, tools: TOOLS, messages: [prompt('Run the tests and say whether they pass.')] });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const ev = events(text);
  assert.deepEqual(ev.map((e) => e.event), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.deepEqual(ev.map((e) => e.event), ev.map((e) => e.data.type), 'each event name is its data\'s type');
  assert.equal(ev[0].data.message.model, 'claude-haiku-5-5');
  assert.ok(ev[0].data.message.usage.input_tokens > 0, 'usage is there for the panel to compute a context from');
  assert.deepEqual(ev[1].data.content_block, { type: 'tool_use', id: ev[1].data.content_block.id, name: 'Bash', input: {} });
  assert.equal(JSON.parse(ev[2].data.delta.partial_json).command, 'npm test');
  assert.equal(ev[4].data.delta.stop_reason, 'tool_use');
});

test('`sleep N` in the prompt is the command, so a run can be held open to watch it grow', async () => {
  const ev = events((await post({ model: 'm', stream: true, tools: TOOLS, messages: [prompt('sleep 12, then the tests')] })).text);
  assert.equal(JSON.parse(ev[2].data.delta.partial_json).command, 'sleep 12');
});

test('a system-role message after the prompt does not hide it (Claude Code 2.1.296 sends one)', async () => {
  const messages = [prompt('Run the tests'), { role: 'system', content: [{ type: 'text', text: '# Environment' }] }];
  const ev = events((await post({ model: 'm', stream: true, tools: TOOLS, messages })).text);
  assert.equal(ev[1].data.content_block.type, 'tool_use');
});

test('a tool result is answered in text that quotes it, and ends the turn', async () => {
  const messages = [
    prompt('Run the tests'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok 1 - slugify\n# pass 1' }] },
  ];
  const ev = events((await post({ model: 'm', stream: true, tools: TOOLS, messages })).text);
  assert.equal(ev[1].data.content_block.type, 'text');
  assert.match(ev[2].data.delta.text, /ok 1 - slugify/);
  assert.match(ev[2].data.delta.text, /not from a model/);
  assert.equal(ev[4].data.delta.stop_reason, 'end_turn');
});

test('an unstreamed request gets the same message as one JSON body; anything else is a 404', async () => {
  const { res, text } = await post({ model: 'claude-sonnet-5-5', tools: [], messages: [prompt('a title, please')] });
  const msg = JSON.parse(text);
  assert.equal(res.status, 200);
  assert.equal(msg.type, 'message');
  assert.equal(msg.model, 'claude-sonnet-5-5');
  assert.equal(msg.content[0].type, 'text');
  assert.equal((await post({}, '/v1/models')).res.status, 404);
  const count = JSON.parse((await post({ messages: [prompt('x')] }, '/v1/messages/count_tokens')).text);
  assert.ok(count.input_tokens > 0);
});
