import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTEXT_WINDOWS, contextOf, modelName, windowFor } from '../server/context-window.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name) =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// An assistant record shaped like the fixtures', for the cases a real run cannot be made to
// produce on demand (a synthetic record, a two-entry iterations, an unknown model).
const asst = (over = {}, usage = {}, model = 'claude-sonnet-5-5') => ({
  type: 'assistant',
  requestedModel: model,
  effort: 'medium',
  message: { model, usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage } },
  ...over,
});

test('real Sonnet 5.5 run: input + cache creation + cache read, output excluded', () => {
  const c = contextOf(load('bot-sonnet-5-5.jsonl'));
  assert.equal(c.tokens, 2 + 14199 + 10987);
  assert.equal(c.window, 1_000_000);
  assert.equal(c.pct, 3);
  assert.equal(c.model, 'claude-sonnet-5-5');
  assert.equal(c.modelName, 'Sonnet 5.5');
  assert.equal(c.effort, 'medium');
});

test('40,564 tokens against a 1M window is 4 (matches the status-line payload)', () => {
  const c = contextOf([asst({}, { input_tokens: 2, cache_creation_input_tokens: 14_000, cache_read_input_tokens: 26_562 })]);
  assert.equal(c.tokens, 40_564);
  assert.equal(c.pct, 4);
});

test('real Haiku 4.5 run: 200k window, and two records sharing one usage are not summed', () => {
  const records = load('bot-haiku-4-5.jsonl');
  assert.equal(records.filter((r) => r.type === 'assistant').length, 2);
  const c = contextOf(records);
  assert.equal(c.tokens, 10 + 11087 + 13986);
  assert.equal(c.window, 200_000);
  assert.equal(c.pct, 13);
  assert.equal(c.modelName, 'Haiku 4.5');
});

test('no effort on Haiku 4.5 is null, never undefined or a guess', () => {
  assert.equal(contextOf(load('bot-haiku-4-5.jsonl')).effort, null);
});

test('[1m] lives only in requestedModel and widens the window', () => {
  const records = load('bot-sonnet-5-5-1m.jsonl');
  const a = records.find((r) => r.type === 'assistant');
  assert.equal(a.message.model, 'claude-sonnet-5-5');
  assert.equal(a.requestedModel, 'claude-sonnet-5-5[1m]');
  const c = contextOf(records);
  assert.equal(c.window, 1_000_000);
  assert.equal(c.requestedModel, 'claude-sonnet-5-5[1m]');
  assert.equal(c.modelName, 'Sonnet 5.5 (1M context)');
});

test('windowFor: a [1m] request beats a 200k table entry; unknown is null', () => {
  assert.equal(windowFor('claude-haiku-4-5-20251001', null), 200_000);
  assert.equal(windowFor('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001[1m]'), 1_000_000);
  assert.equal(windowFor('claude-mystery-9', null), null);
  assert.equal(windowFor(null, null), null);
  assert.equal(windowFor('toString', null), null);
  for (const w of Object.values(CONTEXT_WINDOWS)) assert.ok(w === 200_000 || w === 1_000_000);
});

test('the 4.6 models are 200k (measured), and [1m] still widens them', () => {
  for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
    assert.equal(windowFor(m, null), 200_000);
    assert.equal(windowFor(m, `${m}[1m]`), 1_000_000);
  }
  assert.equal(contextOf([asst({}, { input_tokens: 100_000 }, 'claude-opus-4-6')]).pct, 50);
});

test('a <synthetic>, error or unmetered record is skipped for the one before it', () => {
  const good = asst({}, { input_tokens: 1000 });
  for (const skip of [
    asst({ message: { model: '<synthetic>', usage: { input_tokens: 5 } } }),
    asst({ isApiErrorMessage: true }, { input_tokens: 5 }),
    asst({ isUnmetered: true }, { input_tokens: 5 }),
  ]) {
    assert.equal(contextOf([good, skip]).tokens, 1000);
  }
});

test('a two-entry iterations takes the last entry, not the top level or the sum', () => {
  const r = asst({}, {
    input_tokens: 50_000,
    iterations: [
      { input_tokens: 10_000, cache_read_input_tokens: 0, type: 'message' },
      { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, type: 'message' },
    ],
  });
  assert.equal(contextOf([r]).tokens, 600);
});

test('an empty iterations falls back to the top-level fields', () => {
  assert.equal(contextOf([asst({}, { input_tokens: 700, iterations: [] })]).tokens, 700);
});

test('an unknown model: pct null, tokens still returned, name falls back to the id', () => {
  const c = contextOf([asst({}, { input_tokens: 41_000 }, 'claude-mystery-9')]);
  assert.equal(c.pct, null);
  assert.equal(c.window, null);
  assert.equal(c.tokens, 41_000);
  assert.equal(c.modelName, 'claude-mystery-9');
});

test('pct is clamped to 0..100', () => {
  assert.equal(contextOf([asst({}, { input_tokens: 5_000_000 })]).pct, 100);
});

test('model, effort and context come from one record', () => {
  const older = asst({ effort: 'high' }, { input_tokens: 9 }, 'claude-opus-5-5');
  const newer = asst({ effort: undefined }, { input_tokens: 500 }, 'claude-haiku-4-5-20251001');
  const c = contextOf([older, newer]);
  assert.equal(c.model, 'claude-haiku-4-5-20251001');
  assert.equal(c.effort, null);
  assert.equal(c.tokens, 500);
});

test('no qualifying record answers a same-shaped object of nulls, never null itself', () => {
  for (const input of [[], null, [{ type: 'user' }, { type: 'cost-state' }]]) {
    const c = contextOf(input);
    assert.deepEqual(c, { tokens: null, window: null, pct: null, model: null, modelName: null, requestedModel: null, effort: null });
  }
  assert.equal(modelName(null, null), null);
});
