import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAgents, scanAgents, agentList } from '../server/agents.js';
import { normalizeRecord } from '../server/normalize.js';
import { parsePane } from '../server/tmux.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (name) => path.join(here, 'fixtures', name);
const fixture = (name) => fs.readFileSync(fixturePath(name), 'utf8');

/*
 * `agents-v322.jsonl` is the Agent records of one real sandbox session in `alpha`, Claude Code
 * v2.1.322: two subagents launched in the background ("Sleep agent one", "Sleep agent two")
 * and one asked to run in the *foreground* ("List alpha files", Explore) — which v2.1.322
 * launched async all the same. Cut down to the records about agents, bulky fields dropped,
 * the home folder rewritten to `/Users/dev`; ids and timestamps are as recorded.
 */
const records = () =>
  fixture('agents-v322.jsonl')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const normalized = () => records().flatMap((r) => normalizeRecord(r));

test('every Agent call is one run, with the description, type and start it was given', async () => {
  const { runs } = await scanAgents(fixturePath('agents-v322.jsonl'));
  assert.deepEqual(
    runs.map((r) => [r.name, r.type, r.startedAt]),
    [
      ['Sleep agent one', 'general-purpose', '2026-11-11T08:04:51.538Z'],
      ['Sleep agent two', 'general-purpose', '2026-11-11T08:04:52.172Z'],
      ['List alpha files', 'Explore', '2026-11-11T08:11:50.816Z'],
    ],
  );
  assert.deepEqual(runs, collectAgents(normalized()), 'the streaming pass and the pure fold agree');
});

test('"foreground" is async on v2.1.322, so a launch result is not the end of a run', () => {
  const all = normalized();
  const launch = all.filter((m) => m.kind === 'tool_result');
  assert.equal(launch.length, 3);
  for (const m of launch) assert.equal(m.agent.status, 'async_launched');
  // Up to the launch results alone, nothing has finished.
  const cut = all.findIndex((m) => m.kind === 'task_notification');
  for (const r of collectAgents(all.slice(0, cut))) assert.equal(r.done, false, r.name);
});

test('a notice finishes its run by tool-use id, or by agent id when it carries none', () => {
  const all = normalized();
  const notices = all.filter((m) => m.kind === 'task_notification');
  assert.ok(notices.some((n) => !n.toolUseId && n.taskId), 'the measurement holds a notice with no <tool-use-id>');
  const runs = collectAgents(all);
  for (const r of runs) assert.equal(r.done, true, r.name);
  // Last active is the newest record about the run — Sleep agent one notified three times.
  const one = runs.find((r) => r.name === 'Sleep agent one');
  assert.equal(one.agentId, 'a985bd19674e14fe6');
  assert.equal(one.lastActiveAt, '2026-11-11T08:08:26.952Z');
  const two = runs.find((r) => r.name === 'Sleep agent two');
  assert.equal(two.lastActiveAt, '2026-11-11T08:06:33.904Z');
});

test('a synchronous answer (older Claude Code) ends the run, and an error is a failure', () => {
  const ts = (n) => `2026-01-01T00:00:0${n}.000Z`;
  const runs = collectAgents([
    { kind: 'tool_use', name: 'Task', toolUseId: 't1', input: { description: 'Find it', subagent_type: 'Explore' }, ts: ts(1) },
    { kind: 'tool_result', toolUseId: 't1', agent: { id: 'a1', status: 'completed' }, ts: ts(2) },
    { kind: 'tool_use', name: 'Agent', toolUseId: 't2', input: { description: 'Break it' }, ts: ts(3) },
    { kind: 'tool_result', toolUseId: 't2', isError: true, ts: ts(4) },
    { kind: 'tool_use', name: 'Bash', toolUseId: 't3', input: { command: 'ls' }, ts: ts(5) },
  ]);
  assert.deepEqual(
    runs.map((r) => [r.name, r.type, r.done, r.status, r.lastActiveAt]),
    [
      ['Find it', 'Explore', true, 'completed', ts(2)],
      ['Break it', null, true, 'failed', ts(4)],
    ],
  );
});

test('a subagent\'s own nested Agent call is not one of the session\'s', () => {
  const runs = collectAgents([
    { kind: 'tool_use', name: 'Agent', toolUseId: 'n1', input: { description: 'nested' }, sidechain: true, ts: 'x' },
  ]);
  assert.deepEqual(runs, []);
});

test('rows join to their calls; a finished call nothing is running is earlier', () => {
  const runs = collectAgents(normalized());
  // The 80×23 capture of this same session: both sleep agents still listed under the composer
  // although their first notices had arrived ("waiting on its own background work").
  const panel = parsePane(fixture('pane-agents-2-v322-narrow.txt')).agentRows;
  const list = agentList(runs, panel);
  assert.deepEqual(
    list.running.map((r) => [r.name, r.type, r.elapsed, r.tokens, r.toolUseId]),
    [
      ['Sleep agent one', 'general-purpose', '8s', '33.9k', 'toolu_01PvnaQXdTpF8APdc6WcTJju'],
      ['Sleep agent two', 'general-purpose', '12s', '37.3k', 'toolu_01JiC66kHwXJnW3mUx7pb8CP'],
    ],
  );
  assert.deepEqual(
    list.earlier.map((r) => r.name),
    ['List alpha files'],
    'the panel wins over a notice: a listed agent is running, not earlier',
  );

  // Nothing on screen: everything finished is earlier, newest first.
  assert.deepEqual(
    agentList(runs, null).earlier.map((r) => r.name),
    ['List alpha files', 'Sleep agent two', 'Sleep agent one'],
  );
});

test('a truncated title matches as a prefix; an unmatched row is kept with nothing to jump to', () => {
  const runs = collectAgents([
    { kind: 'tool_use', name: 'Agent', toolUseId: 'a', input: { description: 'Waiting for background sleep command', subagent_type: 'general-purpose' }, ts: '1' },
    { kind: 'tool_use', name: 'Agent', toolUseId: 'b', input: { description: 'Sleep agent 1', subagent_type: 'general-purpose' }, ts: '2' },
  ]);
  const { running, more, earlier } = agentList(runs, {
    rows: [
      { type: 'general-purpose', name: 'Waiting for background sleep com…', elapsed: '1m 12s', tokens: '45.0k' },
      { type: 'general-purpose', name: 'Running sleep 280 command', elapsed: '4m', tokens: '36.7k' },
      { type: 'general-purpose', name: null, elapsed: '9s', tokens: '1k' },
    ],
    more: 2,
  });
  assert.equal(running[0].toolUseId, 'a');
  assert.equal(running[0].name, 'Waiting for background sleep command', 'the whole description, not the cut title');
  assert.equal(running[1].toolUseId, null);
  assert.equal(running[1].name, 'Running sleep 280 command');
  assert.equal(running[2].toolUseId, null);
  assert.equal(more, 2);
  assert.deepEqual(earlier, [], 'an unfinished call off screen is neither running nor earlier');
});

test('two calls with one title: the row claims the unfinished, newer one', () => {
  const runs = collectAgents([
    { kind: 'tool_use', name: 'Agent', toolUseId: 'old', input: { description: 'Sleep', subagent_type: 'gp' }, ts: '1' },
    { kind: 'task_notification', toolUseId: 'old', status: 'completed', ts: '2' },
    { kind: 'tool_use', name: 'Agent', toolUseId: 'new', input: { description: 'Sleep', subagent_type: 'gp' }, ts: '3' },
  ]);
  const list = agentList(runs, { rows: [{ type: 'gp', name: 'Sleep', elapsed: '1s', tokens: '1k' }], more: 0 });
  assert.equal(list.running[0].toolUseId, 'new');
  assert.deepEqual(list.earlier.map((r) => r.toolUseId), ['old']);
  // …and a row of another type never claims it.
  assert.equal(agentList(runs, { rows: [{ type: 'Explore', name: 'Sleep' }], more: 0 }).running[0].toolUseId, null);
});
