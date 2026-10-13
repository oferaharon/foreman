import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * One spelling, held by a test (`docs/traps/one-spelling.md`). The helper ships alone — one
 * file copied into a deployment — so it cannot import `server/`, and the panel never loads
 * `helper/`. The four path components and the two limits are therefore spelled twice, and
 * this file is what keeps the two spellings one contract: the helper's exports are
 * IMPORTED here, never copied, and asserted equal to `server/bots.js`'s on a shared table
 * of inputs — and then against the store's own answers, since a regex both sides agree on
 * means nothing if the store does not use it.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bot-components-state-'));

const helper = await import('../helper/foreman-helper.mjs');
const server = await import('../server/bots.js');

test.after(() => fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true }));

const S = randomUUID();

/** Every input is tried against every component, so a regex that is too wide anywhere shows. */
const TABLE = [
  // plausible
  'main', 'group-one', 'ag-2f0c', 'Main', 'a', 'a.b', 'a_b', 'v1.2.3', '-workspace-agent', '-srv-alpha', '-Users-x-alpha',
  S, S.toUpperCase(), S.replace(/-/g, ''), `${S}.jsonl`, `${S}x`,
  'agent-a1b2', 'agent-A1', 'agent-', 'agent-a.b', 'agent-a_b', `agent-${'a'.repeat(64)}`, `agent-${'a'.repeat(65)}`,
  // traversal, absolute, and separators
  '.', '..', '...', '../x', '..\\x', 'a/b', '/etc', '/', '\\', 'a\\b', './a', 'a/..', '~', '~/x',
  // whitespace, control, and other bytes a path must never carry
  '', ' ', 'a b', ' a', 'a\n', '\n', 'a\0b', 'a\tb', 'é', 'a:b', 'a*b', '*', 'a?b', '%2e%2e', 'a%2fb',
  // lengths
  'x'.repeat(64), 'x'.repeat(65), '-'.repeat(255), '-'.repeat(256), `a${'.'.repeat(63)}`, `.${'a'.repeat(63)}`,
];

test('the four component regexes are the helper\'s own, source and flags', () => {
  assert.deepEqual(Object.keys(server.COMPONENT_RES), Object.keys(helper.COMPONENT_RES));
  for (const [name, re] of Object.entries(helper.COMPONENT_RES)) {
    assert.equal(server.COMPONENT_RES[name].source, re.source, name);
    assert.equal(server.COMPONENT_RES[name].flags, re.flags, name);
  }
  for (const name of ['ROOT_RE', 'PROJECT_RE', 'SESSION_RE', 'AGENT_RE']) {
    assert.equal(server[name].source, helper[name].source, name);
    assert.equal(server[name].flags, helper[name].flags, name);
  }
});

test('on a shared table of inputs, every component regex answers as the helper\'s does', () => {
  for (const [name, re] of Object.entries(helper.COMPONENT_RES)) {
    for (const input of TABLE) assert.equal(server.COMPONENT_RES[name].test(input), re.test(input), `${name}: ${JSON.stringify(input)}`);
  }
  for (const input of TABLE) assert.equal(server.isRoot(input), helper.isRoot(input), `isRoot ${JSON.stringify(input)}`);
});

test('validComponents agrees with the helper\'s on every combination the table makes, agent absent included', () => {
  const roots = ['main', '.', '..', 'a/b', 'Main', ''];
  const projects = ['-workspace-alpha', '..', '/etc', 'a.b', ''];
  const sessions = [S, S.toUpperCase(), '..', ''];
  const agents = [undefined, null, '', 'agent-a1', 'agent-../x', '..', 'agent-'];
  let n = 0;
  for (const root of roots) for (const project of projects) for (const session of sessions) for (const agent of agents) {
    const c = { root, project, session, agent };
    assert.equal(server.validComponents(c), helper.validComponents(c), JSON.stringify(c));
    n++;
  }
  assert.ok(n > 500);
  assert.equal(server.validComponents(), helper.validComponents());
});

test('the limits and the protocol are the helper\'s', () => {
  assert.equal(server.CHUNK_MAX, helper.CHUNK_MAX);
  assert.equal(server.HEAD_MAX, helper.HEAD_MAX);
  assert.equal(server.PROTOCOL_VERSION, helper.PROTOCOL_VERSION);
  assert.ok(server.SUPPORTED_PROTOCOLS.includes(helper.PROTOCOL_VERSION));
});

test('the store refuses a component exactly when the helper would never send it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bot-components-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new server.BotStore({ dir, timers: false, log: () => {} });
  store.register('alpha-bot');
  const body = Buffer.from(`${JSON.stringify({ type: 'user', message: { content: 'x' } })}\n`);
  const roots = TABLE.filter((s) => s.toLowerCase() !== 'index.json'); // the store's own file name, refused apart
  let accepted = 0;
  for (const [name, inputs] of [['root', roots], ['project', TABLE], ['session', TABLE], ['agent', TABLE]]) {
    for (const input of inputs) {
      // A fresh session each time, so no refusal is about a conversation already held.
      const c = { root: 'main', project: '-workspace-alpha', session: randomUUID(), agent: null, [name]: input };
      const r = store.append('alpha-bot', c, 0, body);
      const valid = helper.validComponents(c);
      if (!valid) assert.deepEqual(r, { status: 400, body: { error: 'bad component' } }, `${name}: ${JSON.stringify(input)}`);
      else {
        // Accepted by the regexes; the only other refusal is a spelling that folds onto one held.
        assert.ok(r.status === 200 || (r.status === 409 && /only in case/.test(r.body.error)), `${name}: ${JSON.stringify(input)} → ${JSON.stringify(r)}`);
        accepted += r.status === 200;
      }
    }
  }
  assert.ok(accepted > 10);
});
