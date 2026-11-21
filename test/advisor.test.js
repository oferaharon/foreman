import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The model advisor's pure half (`server/advisor.js`): the call it builds, the input it is
 * handed and the rules its answer is checked against. The spawning is the replay script's
 * (test/advisor-eval.test.js) and, later, the lead's MCP process's.
 */

import {
  ADVISABLE_MODELS,
  ADVISOR_ONLY_MODELS,
  ADVISOR_EFFORT,
  ADVISOR_MODEL,
  ADVISOR_VERSION,
  SCRUBBED_ENV,
  adviceArgv,
  adviceEnv,
  adviceInput,
  adviceSchema,
  adviceUsage,
  advisorPrompt,
  briefSha,
  readAdvice,
} from '../server/advisor.js';
import { WORKER_EFFORTS, WORKER_MODELS, DEFAULT_WORKER_MODEL } from '../server/worker-models.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const answer = (structured, extra = {}) => JSON.stringify({ type: 'result', is_error: false, structured_output: structured, ...extra });

test('the advisor runs on Sonnet 5.5 at low, by ruling, and has a version', () => {
  assert.equal(ADVISOR_MODEL, 'claude-sonnet-5-5');
  assert.equal(ADVISOR_EFFORT, 'low');
  assert.ok(Number.isInteger(ADVISOR_VERSION) && ADVISOR_VERSION >= 1);
});

test('the schema never offers Haiku, never a [1m] id, and only ids on the launch list', () => {
  const s = adviceSchema();
  const models = s.properties.model.enum;
  assert.ok(models.length > 0);
  for (const id of models) {
    assert.ok(!/haiku/i.test(id), `${id} must not be advisable`);
    assert.ok(!id.endsWith('[1m]'));
    assert.ok(WORKER_MODELS.includes(id));
  }
  assert.ok(models.includes(DEFAULT_WORKER_MODEL), 'the default must be advisable');
  assert.deepEqual(s.properties.effort.enum, WORKER_EFFORTS);
  assert.deepEqual(s.required, ['model', 'effort', 'reason']);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual([...ADVISABLE_MODELS], models);
});

test('the argv carries every measured flag, no --bare, and no input', () => {
  const argv = adviceArgv();
  const has = (flag, value) => {
    const i = argv.indexOf(flag);
    assert.ok(i >= 0, `missing ${flag}`);
    if (value !== undefined) assert.equal(argv[i + 1], value, `${flag} value`);
  };
  has('-p');
  has('--no-session-persistence');
  has('--tools', '');
  has('--strict-mcp-config');
  has('--setting-sources', '');
  has('--disable-slash-commands');
  has('--settings', '{"disableAllHooks":true}');
  has('--system-prompt', advisorPrompt());
  has('--json-schema', JSON.stringify(adviceSchema()));
  has('--output-format', 'json');
  has('--model', ADVISOR_MODEL);
  has('--effort', ADVISOR_EFFORT);
  assert.ok(!argv.includes('--bare'), '--bare skips the keychain and fails here');
  // The input goes on stdin: nothing after the last flag value, and no brief marker anywhere.
  assert.ok(!argv.some((a) => a.includes('--- brief ---')));
  assert.equal(argv.at(-2), '--effort');
});

test('Haiku 5.5 may run the advisor, at an effort, and is still never a worker model or advice', () => {
  assert.deepEqual([...ADVISOR_ONLY_MODELS], ['claude-haiku-5-5']);
  assert.ok(!WORKER_MODELS.includes('claude-haiku-5-5'), 'display-only by the 2026-10-13 ruling');
  const argv = adviceArgv({ model: 'claude-haiku-5-5' });
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'low');
  assert.ok(!adviceSchema().properties.model.enum.includes('claude-haiku-5-5'));
  assert.equal(readAdvice(answer({ model: 'claude-haiku-5-5', effort: 'low', reason: 'r' })).ok, false);
});

test('a Haiku 4.5 advisor is launched without --effort, and an unknown model or effort is refused', () => {
  const argv = adviceArgv({ model: 'claude-haiku-4-5-20251001' });
  assert.ok(!argv.includes('--effort'));
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
  assert.throws(() => adviceArgv({ model: 'claude-opus-5' }), /Not a model/);
  assert.throws(() => adviceArgv({ model: 'gpt' }), /Not a model/);
  assert.throws(() => adviceArgv({ effort: 'bogus' }), /Not an effort/);
});

test('the prompt names no team default and only sandbox repos', () => {
  const p = advisorPrompt();
  assert.ok(!/default model|team default|defaultModel/i.test(p), 'told the rule, never the dial');
  // Every repo-shaped mention is one of the three sandbox names.
  const repos = [...p.matchAll(/\bIn (\w+),/g)].map((m) => m[1]);
  assert.ok(repos.length >= 2);
  for (const r of repos) assert.ok(['alpha', 'beta', 'gamma'].includes(r), r);
  for (const id of ADVISABLE_MODELS) assert.ok(p.includes(id), `${id} described`);
  assert.ok(!/haiku/i.test(p));
});

test('briefSha is the exact bytes: whitespace and line endings count', () => {
  assert.equal(briefSha('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(briefSha('abc'), briefSha('abc\n'));
  assert.notEqual(briefSha('abc'), briefSha(' abc'));
  assert.notEqual(briefSha('a\nb'), briefSha('a\r\nb'));
  assert.equal(briefSha('é'), briefSha('é'));
});

test('adviceInput carries kind, tag and the body verbatim, and nothing else', () => {
  const body = '  In alpha, rename x.\n\n';
  const s = adviceInput({ body, kind: 'build', tag: 'chore' });
  assert.ok(s.startsWith('Kind: build\nTag: chore\n'));
  assert.ok(s.endsWith(`--- brief ---\n${body}`));
  assert.ok(adviceInput({ body: 'x', kind: 'plan' }).includes('Kind: plan\nTag: none\n'));
  assert.ok(adviceInput({ body: 'x', kind: 'weird', tag: '' }).includes('Kind: build\nTag: none\n'));
});

test('adviceEnv drops TMUX, TMUX_PANE and the session linkage, keeps the rest, mutates nothing', () => {
  const env = { PATH: '/bin', HOME: '/h', TMUX: '/tmp/x,1,0', TMUX_PANE: '%3', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_SOCKET: '/s', CLAUDECODE: '1' };
  const out = adviceEnv(env);
  assert.deepEqual(out, { PATH: '/bin', HOME: '/h' });
  assert.equal(env.TMUX_PANE, '%3');
  assert.ok(SCRUBBED_ENV.includes('TMUX') && SCRUBBED_ENV.includes('TMUX_PANE'));
});

test('readAdvice reads a good answer and tidies the reason', () => {
  const r = readAdvice(answer({ model: 'claude-sonnet-5-5', effort: 'low', reason: '  A rename,\n one file. ' }));
  assert.deepEqual(r, { ok: true, model: 'claude-sonnet-5-5', effort: 'low', reason: 'A rename, one file.' });
  const parsed = readAdvice({ structured_output: { model: 'claude-opus-5-5', effort: 'high', reason: 'x'.repeat(1000) } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reason.length, 400);
});

test('readAdvice refuses an unknown id, Haiku, a retired id, a [1m] id, a bad effort and a missing reason', () => {
  const bad = [
    { model: 'claude-gpt', effort: 'high', reason: 'r' },
    { model: 'claude-haiku-4-5-20251001', effort: 'low', reason: 'r' },
    { model: 'claude-opus-5', effort: 'high', reason: 'r' },
    { model: 'claude-opus-5-5[1m]', effort: 'high', reason: 'r' },
    { model: 'claude-opus-5-5', effort: 'ultracode', reason: 'r' },
    { model: 'claude-opus-5-5', effort: 'high' },
    { model: 'claude-opus-5-5', effort: 'high', reason: '   ' },
    { model: 'claude-opus-5-5', effort: 'high', reason: 7 },
  ];
  for (const s of bad) assert.equal(readAdvice(answer(s)).ok, false, JSON.stringify(s));
});

test('readAdvice refuses empty, malformed, failed and structure-less output', () => {
  for (const raw of ['', '   ', 'not json', '[1,2]', 'null', '"x"', JSON.stringify({ result: 'hi' }), JSON.stringify({ structured_output: 'x' })]) {
    const r = readAdvice(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(typeof r.error, 'string');
  }
  const failed = readAdvice(answer({ model: 'claude-opus-5-5', effort: 'high', reason: 'r' }, { is_error: true, terminal_reason: 'api_error' }));
  assert.deepEqual(failed, { ok: false, error: 'call failed: api_error' });
});

test('adviceUsage reads the token counts and never a dollar figure', () => {
  const u = adviceUsage(JSON.stringify({ usage: { input_tokens: 2, output_tokens: 150, cache_read_input_tokens: 558, cache_creation_input_tokens: 640 }, total_cost_usd: 0.1 }));
  assert.deepEqual(u, { input: 2, output: 150, cacheRead: 558, cacheWrite: 640 });
  assert.ok(!Object.keys(u).some((k) => /cost|usd/i.test(k)));
  assert.equal(adviceUsage('junk'), null);
  assert.equal(adviceUsage({}), null);
});

test('advisor.js imports only worker-models.js and node:crypto; worker-models.js imports nothing', () => {
  const src = fs.readFileSync(path.join(here, '..', 'server', 'advisor.js'), 'utf8');
  const froms = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]).sort();
  assert.deepEqual(froms, ['./worker-models.js', 'node:crypto']);
  assert.ok(!/\bimport\s*\(/.test(src), 'no dynamic imports');
  const leaf = fs.readFileSync(path.join(here, '..', 'server', 'worker-models.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(leaf));
});
