import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FALLBACK, humanName } from '../server/human-name.js';

/*
 * The real process, the real protocol, both roles. A stub panel answers the HTTP side,
 * so what's under test is exactly what a Claude Code session sees: JSON-RPC lines over
 * stdio — and the role split, which is a security boundary, not a convenience.
 */

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'foreman.js');
const REPO = '/Users/x/Code/Fake';

// 25 room entries, seq 1..25 — enough to exercise the tail cap (20) and prove a real
// cursor still gets everything after it, unbounded by the tail.
const ROOM_ENTRIES = Array.from({ length: 25 }, (_, i) => ({
  seq: i + 1, ts: i + 1, from: 'lead', to: 'all', kind: 'status', text: `entry ${i + 1}`,
}));

const PEER = '/Users/x/Code/Beta';

/*
 * Three links, and each one is a case. `lnk-1` is this repo's open link; `lnk-2` joins two
 * *other* projects, which is what proves `link_read`'s scoping is a scoping and not a
 * formality; `lnk-3` is this repo's *closed* one, which `link_list` must leave out and
 * `link_read` must still answer — a link that closed an hour ago still has a history this
 * lead was half of.
 */
const LINKS = [
  { id: 'lnk-1', a: REPO, b: PEER, label: 'shared auth schema', closedAt: null, lastAt: 25, unseen: 2 },
  { id: 'lnk-2', a: '/Users/x/Code/Gamma', b: '/Users/x/Code/Alpha', label: '', closedAt: null },
  { id: 'lnk-3', a: REPO, b: PEER, label: 'an old one', closedAt: 9 },
];

// 25 thread entries, ts 1..25 — the same shape as ROOM_ENTRIES, and for the same reason:
// enough to exercise the tail cap (20) against a real cursor that is not bounded by it.
const THREAD_ENTRIES = Array.from({ length: 25 }, (_, i) => ({
  ts: i + 1, seq: i + 1, kind: 'link', link: 'lnk-1', speaker: 'lead',
  sender: i % 2 ? PEER : REPO, text: `link entry ${i + 1}`,
}));

let stub;
let port;
const stubState = {
  toggles: { answerDesignQuestions: false, answerPermissionPrompts: false, approvePlans: false },
  roomPosts: [],
  questionAnswers: [],
  dispatches: [],
  added: [],
  linkMessages: [],
};

function makeChild(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FOREMAN_PORT: String(port), FOREMAN_REPO: REPO, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lineQueue = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const w = waiters.shift();
      if (w) w(line);
      else lineQueue.push(line);
    }
  });
  const nextLine = () =>
    lineQueue.length ? Promise.resolve(lineQueue.shift()) : new Promise((r) => waiters.push(r));
  const rpc = async (msg) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    return JSON.parse(await nextLine());
  };
  return { child, rpc };
}

let lead;
let worker;

test.before(async () => {
  stub = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === '/api/team/tasks' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            tasks: [
              {
                id: 'one', repo: REPO, state: 'working', kind: 'build', branch: 'agent/one',
                // Every brief in this repo opens with a `## Why` heading — this is the
                // real shape of the bug, not a contrived one.
                body: `## Why\n\n${'A'.repeat(140)}\nMore detail nobody will ever read here.`,
                worktree: '/somewhere/deep', createdAt: 1, updatedAt: 2, source: 'lead',
                live: { sessionId: 'sess-1', status: 'needs-decision' },
              },
              { id: 'other-repo', repo: '/elsewhere', state: 'working', live: null },
            ],
          }),
        );
      } else if (req.url.startsWith('/api/team/room') && req.method === 'GET') {
        const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
        const after = since > 0 ? ROOM_ENTRIES.filter((e) => e.seq > since) : ROOM_ENTRIES;
        const LIMIT = 200; // mirrors room.js's own default — the stub is the real contract
        res.end(
          JSON.stringify({
            entries: after.slice(-LIMIT),
            cursor: ROOM_ENTRIES.at(-1).seq,
            truncated: after.length > LIMIT,
          }),
        );
      } else if (req.url === '/api/sessions' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            sessions: [
              {
                id: 'sess-1',
                question: {
                  kind: 'question',
                  multiSelect: false,
                  options: [
                    { index: 1, label: 'Use tabs' },
                    { index: 2, label: 'Use spaces' },
                  ],
                },
              },
            ],
          }),
        );
      } else if (req.url.startsWith('/api/sessions/sess-1/tail')) {
        res.end(JSON.stringify({ messages: [{ role: 'assistant', text: 'tail!' }], truncated: false }));
      } else if (req.url.startsWith('/api/team/config')) {
        res.end(JSON.stringify({ repo: REPO, toggles: stubState.toggles }));
      } else if (req.url === '/api/team/room' && req.method === 'POST') {
        stubState.roomPosts.push(parsed);
        res.end(JSON.stringify({ ok: true, entry: parsed }));
      } else if (req.url === '/api/sessions/sess-1/question' && req.method === 'POST') {
        stubState.questionAnswers.push(parsed);
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url === '/api/team/dispatch' && req.method === 'POST') {
        stubState.dispatches.push(parsed);
        // A promotion carries `id` and no `label` — the record's own id is the name.
        res.end(JSON.stringify({ ok: true, task: { id: parsed.id || parsed.label, kind: parsed.kind || 'build' } }));
      } else if (req.url === '/api/team/tasks' && req.method === 'POST') {
        stubState.added.push(parsed);
        res.end(JSON.stringify({ ok: true, id: parsed.label, task: { id: parsed.label, state: 'pending' } }));
      } else if (req.url.startsWith('/api/team/links/') && req.url.includes('/message') && req.method === 'POST') {
        stubState.linkMessages.push({ url: req.url, body: parsed });
        res.end(JSON.stringify({ ok: true, link: 'lnk-1', peer: PEER, sessionId: 'lead-b', delivered: true, queued: false }));
      } else if (req.url.startsWith('/api/team/links/') && req.url.includes('/thread') && req.method === 'GET') {
        const id = req.url.slice('/api/team/links/'.length).split('/')[0];
        const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
        const all = THREAD_ENTRIES.filter((e) => e.link === id || id === 'lnk-3');
        const after = since > 0 ? all.filter((e) => e.ts > since) : all;
        const LIMIT = 200; // the endpoint's own cap, mirrored — the stub is the contract
        res.end(
          JSON.stringify({
            link: LINKS.find((l) => l.id === id) || null,
            entries: after.slice(-LIMIT),
            cursor: all.length ? all.at(-1).ts : 0,
            truncated: after.length > LIMIT,
          }),
        );
      } else if (req.url.startsWith('/api/team/links') && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const folder = q.get('folder') || '';
        const open = q.get('open') === '1';
        const rows = LINKS.filter((l) => (!folder || l.a === folder || l.b === folder) && (!open || !l.closedAt)).map(
          (l) => (folder ? { ...l, peer: l.a === folder ? l.b : l.a, peerName: 'Beta' } : l),
        );
        res.end(JSON.stringify({ links: rows }));
      } else if (req.url === '/api/team/plans/one' && req.method === 'GET') {
        res.end(JSON.stringify({ ok: true, id: 'one', state: 'review', path: '/t/plans/one.md', text: '# Plan\n\nDo the thing.' }));
      } else if (req.url === '/api/team/tasks/w-task' && req.method === 'PATCH') {
        res.end(JSON.stringify({ ok: true, task: { id: 'w-task', state: parsed.state } }));
      } else if (req.url === '/api/team/tasks/one' && req.method === 'PATCH') {
        res.end(JSON.stringify({ ok: true, task: { id: 'one', pr: parsed.pr } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `stub has no ${req.method} ${req.url}` }));
      }
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  port = stub.address().port;

  lead = makeChild({ FOREMAN_ROLE: 'lead' });
  worker = makeChild({ FOREMAN_ROLE: 'worker', FOREMAN_TASK: 'w-task' });
});

test.after(() => {
  lead?.child.kill();
  worker?.child.kill();
  stub?.close();
});

test('the lead surface: dispatch, status, read, send, close, the room, and the gated answers', async () => {
  const res = await lead.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(
    res.result.tools.map((t) => t.name).sort(),
    [
      'link_list', 'link_read', 'link_send',
      'plan_read', 'room_post', 'room_read', 'task_add', 'task_close', 'task_dispatch',
      'task_merge_check', 'task_set_pr', 'task_start', 'team_status',
      'worker_answer_permission', 'worker_answer_question', 'worker_approve_plan',
      'worker_read', 'worker_send',
    ],
  );
});

test('the worker surface is exactly two tools', async () => {
  const res = await worker.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(res.result.tools.map((t) => t.name).sort(), ['room_post', 'task_report']);
});

test('a worker cannot call a lead tool', async () => {
  const res = await worker.rpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'task_dispatch', arguments: { label: 'x', body: 'y' } },
  });
  assert.ok(res.error, 'refused at the protocol layer — the tool does not exist for this role');
});

test('team_status is scoped to FOREMAN_REPO', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'team_status', arguments: {} },
  });
  const bodyOut = JSON.parse(res.result.content[0].text);
  assert.deepEqual(bodyOut.tasks.map((t) => t.id), ['one'], 'the other repo is invisible');
});

test('team_status strips full briefs and dispatch plumbing, keeping what a lead decides on', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 45, method: 'tools/call',
    params: { name: 'team_status', arguments: {} },
  });
  const [row] = JSON.parse(res.result.content[0].text).tasks;
  assert.equal(row.body, undefined, 'the full brief never rides along');
  assert.equal(row.brief, `${'A'.repeat(119)}…`, 'first line only, capped around 120 chars');
  assert.ok(!row.brief.includes('More detail'), 'the second line is dropped, not just the overflow');
  assert.equal(row.repo, undefined, 'already at the top level of the response');
  assert.equal(row.worktree, undefined, 'dispatch plumbing, not a lead decision');
  assert.equal(row.createdAt, undefined);
  assert.equal(row.source, undefined);
  // What a lead actually decides on survives.
  assert.equal(row.id, 'one');
  assert.equal(row.kind, 'build');
  assert.equal(row.state, 'working');
  assert.equal(row.branch, 'agent/one');
  assert.deepEqual(row.live, { sessionId: 'sess-1', status: 'needs-decision' });
});

test('team_status brief skips a leading heading instead of previewing it verbatim', async () => {
  // The measured bug: every brief here opens `## Why`, so an un-skipped preview reads as
  // that heading literally, for every task, forever.
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 49, method: 'tools/call',
    params: { name: 'team_status', arguments: {} },
  });
  const [row] = JSON.parse(res.result.content[0].text).tasks;
  assert.notEqual(row.brief, '## Why', 'a body opening with a heading must not preview as the heading');
  assert.ok(!row.brief.startsWith('#'), 'the heading marker is gone too, not just skipped past');
});

test('room_read with no cursor returns a tail, not the whole room', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 50, method: 'tools/call',
    params: { name: 'room_read', arguments: {} },
  });
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.entries.length, 20, 'the tail, not all 25');
  assert.equal(out.entries[0].text, 'entry 6', 'the newest 20, not the oldest 20');
  assert.equal(out.entries.at(-1).text, 'entry 25');
  assert.equal(out.cursor, 25, 'the cursor is still the room\'s newest seq');
  assert.equal(out.truncated, true, 'entries were left out');
});

test('room_read with a cursor returns everything after it, unbounded by the tail', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 51, method: 'tools/call',
    params: { name: 'room_read', arguments: { since: 10 } },
  });
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.entries.length, 15, 'all 15 entries after seq 10, not clipped to 20 or fewer');
  assert.equal(out.entries[0].text, 'entry 11');
  assert.equal(out.entries.at(-1).text, 'entry 25');
  assert.equal(out.cursor, 25);
  assert.equal(out.truncated, false);
});

test('room_read with an explicit since:0 is a real cursor, not "no cursor"', async () => {
  // Deliberate choice: since:0 means "everything from the start" (subject to the
  // endpoint's own 200 cap), the same as any other explicit cursor — it does not fall
  // back to the ~20-entry tail the way an omitted `since` does.
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 52, method: 'tools/call',
    params: { name: 'room_read', arguments: { since: 0 } },
  });
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.entries.length, 25, 'the whole room, not trimmed to the tail');
  assert.equal(out.cursor, 25);
  assert.equal(out.truncated, false);
});

test('worker_read resolves a task id to its session', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'worker_read', arguments: { id: 'one' } },
  });
  assert.match(res.result.content[0].text, /tail!/);
});

test('answering a question is gated on the toggle', async () => {
  stubState.toggles.answerDesignQuestions = false;
  const refused = await lead.rpc({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: {
      name: 'worker_answer_question',
      arguments: { id: 'one', options: ['Use spaces'], grounds: 'CLAUDE.md says spaces' },
    },
  });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /toggle is off/);

  stubState.toggles.answerDesignQuestions = true;
  const ok = await lead.rpc({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: {
      name: 'worker_answer_question',
      arguments: { id: 'one', options: ['Use spaces'], grounds: 'CLAUDE.md says spaces' },
    },
  });
  assert.notEqual(ok.result.isError, true, ok.result.content?.[0]?.text);
  const answered = stubState.questionAnswers.at(-1);
  assert.deepEqual(answered.options, [2], 'label resolved to the on-screen index');
  assert.deepEqual(answered.expect, [{ index: 2, label: 'Use spaces' }], 'guard payload built');
  const audit = stubState.roomPosts.at(-1);
  assert.equal(audit.kind, 'answer');
  assert.match(audit.grounds, /CLAUDE.md/);
});

test('answering without grounds is refused even with the toggle on', async () => {
  stubState.toggles.answerDesignQuestions = true;
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'worker_answer_question', arguments: { id: 'one', options: [2], grounds: '  ' } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /No grounds/);
});

test('a worker posts as itself, addressed to the lead', async () => {
  const res = await worker.rpc({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'room_post', arguments: { kind: 'status', text: 'halfway there' } },
  });
  assert.notEqual(res.result.isError, true);
  const post = stubState.roomPosts.at(-1);
  assert.equal(post.from, 'w-task');
  assert.equal(post.to, 'lead');
});

test('task_report reaches the task PATCH', async () => {
  const res = await worker.rpc({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'task_report', arguments: { state: 'review', summary: 'done, committed' } },
  });
  assert.match(res.result.content[0].text, /review/);
});

test('a failing tool is a result the model sees, not a protocol error', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'worker_read', arguments: { id: 'no-such-task' } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /No such task/);
  assert.equal(res.error, undefined);
});

test('task_set_pr records the URL through the PATCH path', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: 'task_set_pr', arguments: { id: 'one', url: 'http://192.0.2.10:3002/x/y/pulls/7' } },
  });
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
});

test('task_close carries the outcome', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 13, method: 'tools/call',
    params: { name: 'task_close', arguments: { id: 'one', outcome: 'done' } },
  });
  // The stub 404s this route — what matters here is the tool sent the outcome and
  // surfaced the failure as a result, not that the stub implements closing.
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /stub has no POST \/api\/team\/tasks\/one\/close/);
});

test('kind rides the dispatch through to the panel, and defaults to nothing at all', async () => {
  // Absent rather than 'build': the endpoint owns the default, so a lead that says
  // nothing and a lead that says "build" reach the same place by the same route.
  await lead.rpc({
    jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: { name: 'task_dispatch', arguments: { label: 'ordinary', body: 'fix it' } },
  });
  assert.equal(stubState.dispatches.at(-1).kind, undefined);

  await lead.rpc({
    jsonrpc: '2.0', id: 21, method: 'tools/call',
    params: { name: 'task_dispatch', arguments: { label: 'shape-it', body: 'plan it', kind: 'plan' } },
  });
  const sent = stubState.dispatches.at(-1);
  assert.equal(sent.kind, 'plan');
  assert.equal(sent.source, 'lead');
  assert.equal(sent.folder, REPO, 'still pinned to this lead\'s repo');
});

test('task_add records a task and starts nothing — a different route from task_dispatch', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 30, method: 'tools/call',
    params: { name: 'task_add', arguments: { label: 'Search Index!', body: 'index the transcripts' } },
  });
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);

  const sent = stubState.added.at(-1);
  assert.equal(sent.label, 'Search Index!', 'the tool sends what the lead typed — the endpoint tidies it');
  assert.equal(sent.body, 'index the transcripts');
  assert.equal(sent.source, 'lead');
  assert.equal(sent.folder, REPO, 'pinned to this lead\'s repo, like everything else');
  assert.equal(sent.kind, undefined, 'the endpoint owns the default kind, here as in dispatch');

  // The whole point of the tool: recording is not starting. Nothing reached the dispatch
  // route, which is the one that cuts a worktree and spends money.
  assert.ok(
    !stubState.dispatches.some((d) => /search/i.test(d.label || '')),
    'task_add must never reach /api/team/dispatch',
  );
});

test('a planner can be recorded pending too, and the model rides along', async () => {
  await lead.rpc({
    jsonrpc: '2.0', id: 31, method: 'tools/call',
    params: {
      name: 'task_add',
      arguments: {
        label: 'shape-search', body: 'plan the index', kind: 'plan',
        model: 'claude-sonnet-5', modelReason: 'mechanical survey',
      },
    },
  });
  const sent = stubState.added.at(-1);
  assert.equal(sent.kind, 'plan');
  assert.equal(sent.model, 'claude-sonnet-5');
  assert.equal(sent.modelReason, 'mechanical survey');
});

test('task_start promotes by id, and the confirmation reaches both the record and the room', async () => {
  const before = stubState.dispatches.length;
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 40, method: 'tools/call',
    params: {
      name: 'task_start',
      arguments: { id: 'search-index', confirmation: 'zzq-testname: "yes, start search-index now"' },
    },
  });
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);

  // The whole dispatch path, addressed by id. No `label`: re-tidying a stored id is a
  // rename waiting to happen, so the endpoint takes the name off the record.
  const sent = stubState.dispatches.at(-1);
  assert.equal(stubState.dispatches.length, before + 1);
  assert.equal(sent.id, 'search-index');
  assert.equal(sent.label, undefined);
  assert.equal(sent.folder, REPO, 'still pinned to this lead\'s repo');
  assert.equal(sent.body, undefined, 'omitted means "start it on the brief it was recorded with"');
  assert.equal(sent.startedBy, 'zzq-testname: "yes, start search-index now"', 'stamped on the record');

  // The audit line: the claim about that second yes, in front of the person who gave it.
  const audit = stubState.roomPosts.at(-1);
  assert.equal(audit.from, 'lead');
  assert.equal(audit.to, 'search-index');
  assert.equal(audit.kind, 'status');
  assert.equal(audit.text, 'Started search-index — zzq-testname: "yes, start search-index now"');
});

test('starting without a confirmation fails at the protocol layer, and dispatches nothing', async () => {
  const before = stubState.dispatches.length;
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 41, method: 'tools/call',
    params: { name: 'task_start', arguments: { id: 'search-index' } },
  });
  // Not an `isError` result the model can shrug at: a required argument is a promise
  // about the call, and here the required argument *is* the guard.
  assert.ok(res.error, 'refused at the protocol layer');
  assert.match(res.error.message, /confirmation/);
  assert.equal(stubState.dispatches.length, before, 'nothing started');

  // And the whitespace string that satisfies `required` is refused a layer down, the
  // way `grounds` already is.
  const blank = await lead.rpc({
    jsonrpc: '2.0', id: 42, method: 'tools/call',
    params: { name: 'task_start', arguments: { id: 'search-index', confirmation: '   ' } },
  });
  assert.equal(blank.result.isError, true);
  assert.match(blank.result.content[0].text, /fresh, per-task yes/);
  assert.equal(stubState.dispatches.length, before, 'still nothing started');
});

test('a replacement brief rides along, because the last moment to change it is now', async () => {
  await lead.rpc({
    jsonrpc: '2.0', id: 43, method: 'tools/call',
    params: {
      name: 'task_start',
      arguments: { id: 'brief-modal', body: 'narrower than recorded: modal only', confirmation: 'go' },
    },
  });
  const sent = stubState.dispatches.at(-1);
  assert.equal(sent.id, 'brief-modal');
  assert.equal(sent.body, 'narrower than recorded: modal only');
});

test('a worker cannot start tasks — task_start is the lead\'s alone', async () => {
  const before = stubState.dispatches.length;
  const res = await worker.rpc({
    jsonrpc: '2.0', id: 44, method: 'tools/call',
    params: { name: 'task_start', arguments: { id: 'search-index', confirmation: 'I said so' } },
  });
  assert.ok(res.error, 'refused at the protocol layer — a worker starts nothing');
  assert.equal(stubState.dispatches.length, before, 'and nothing reached the panel');
});

test('a worker cannot record tasks — task_add is the lead\'s alone', async () => {
  const res = await worker.rpc({
    jsonrpc: '2.0', id: 32, method: 'tools/call',
    params: { name: 'task_add', arguments: { label: 'sneaky', body: 'nope' } },
  });
  assert.ok(res.error, 'refused at the protocol layer — a worker records nothing');
  assert.equal(stubState.added.at(-1)?.label, 'shape-search', 'and nothing reached the panel');
});

test('the lead reads a plan as a document, not as a room post', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 22, method: 'tools/call',
    params: { name: 'plan_read', arguments: { id: 'one' } },
  });
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
  const plan = JSON.parse(res.result.content[0].text);
  assert.match(plan.text, /Do the thing/);
  assert.equal(plan.path, '/t/plans/one.md');
  // Reading a plan is not posting one — the room is a log a human scans, a plan is a page.
  assert.ok(!stubState.roomPosts.some((p) => /Do the thing/.test(p.text || '')), 'never dumped into the room');
});

test('plan_read is repo-scoped like everything else', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 23, method: 'tools/call',
    params: { name: 'plan_read', arguments: { id: 'other-repo' } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /No such task/);
});

test('a worker still cannot read plans — the surface is two tools', async () => {
  const res = await worker.rpc({
    jsonrpc: '2.0', id: 24, method: 'tools/call',
    params: { name: 'plan_read', arguments: { id: 'one' } },
  });
  assert.ok(res.error, 'refused at the protocol layer');
});

// The fail-closed guard: an absent or unrecognised FOREMAN_ROLE must refuse to serve, never
// fall back to the more powerful surface. Both spawn the real process with no stub
// interaction — the refusal happens before the server would ever read a request.
function spawnWithEnv(role) {
  return new Promise((resolve) => {
    const env = { ...process.env, FOREMAN_PORT: String(port), FOREMAN_REPO: REPO };
    if (role === undefined) delete env.FOREMAN_ROLE;
    else env.FOREMAN_ROLE = role;
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('no FOREMAN_ROLE at all refuses to start, rather than defaulting to lead', async () => {
  const { code, stderr } = await spawnWithEnv(undefined);
  assert.notEqual(code, 0, 'must not exit clean — it did not start serving');
  assert.match(stderr, /FOREMAN_ROLE is not set/);
  assert.match(stderr, /lead, worker/);
});

test('an unrecognised FOREMAN_ROLE refuses to start, naming the value and the valid ones', async () => {
  const { code, stderr } = await spawnWithEnv('banana');
  assert.notEqual(code, 0, 'must not exit clean');
  assert.match(stderr, /"banana"/);
  assert.match(stderr, /lead, worker/);
});

/* ------------------------------------------ whose team is this, in the tools --- */

/* ------------------------------------------------------------------ links --- */

/*
 * The three link tools. What they are is one channel between two *projects*, and what
 * makes them safe is what they deliberately do not offer: no way to open or close a link,
 * no repo argument, and no `speaker`.
 */

test('the link tools are repo-pinned: no repo argument on any of them', async () => {
  const res = await lead.rpc({ jsonrpc: '2.0', id: 60, method: 'tools/list' });
  for (const name of ['link_list', 'link_send', 'link_read']) {
    const tool = res.result.tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is on the lead surface`);
    const props = Object.keys(tool.inputSchema.properties || {});
    for (const forbidden of ['repo', 'folder', 'a', 'b', 'speaker']) {
      assert.ok(!props.includes(forbidden), `${name} must not take \`${forbidden}\``);
    }
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} takes nothing else either`);
  }
});

test('there is no tool to open or close a link, and the descriptions say to ask instead', async () => {
  const res = await lead.rpc({ jsonrpc: '2.0', id: 61, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  for (const absent of ['link_open', 'link_close', 'link_create', 'link_new']) {
    assert.ok(!names.includes(absent), `${absent} must not exist — a lead granting itself a channel is the rule`);
  }
  const list = res.result.tools.find((t) => t.name === 'link_list');
  assert.match(list.description, /cannot open or close a link/i, 'and the lead is told so');
  assert.match(list.description, /ask them in conversation/i, 'with what to do instead');
});

test('a worker has no link tools at all', async () => {
  const res = await worker.rpc({
    jsonrpc: '2.0', id: 62, method: 'tools/call',
    params: { name: 'link_send', arguments: { id: 'lnk-1', text: 'hello' } },
  });
  assert.ok(res.error, 'refused at the protocol layer — a worker has no channel off its own task');
});

test('link_list asks for this repo’s open links only', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 63, method: 'tools/call',
    params: { name: 'link_list', arguments: {} },
  });
  const out = JSON.parse(res.result.content[0].text);
  assert.deepEqual(out.links.map((l) => l.id), ['lnk-1'], 'the other pair’s link and the closed one are both out');
  assert.equal(out.links[0].peer, PEER, 'and the far end is named for it');
});

test('link_send posts this session’s own repo as the folder, and drops anything else', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 64, method: 'tools/call',
    params: {
      name: 'link_send',
      // A caller trying the two arguments that would matter: which project is speaking,
      // and which of the two shapes the message takes. Neither is plumbed.
      arguments: { id: 'lnk-1', text: 'can you hold #40?', folder: '/Users/x/Code/Gamma', speaker: 'human' },
    },
  });
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
  const sent = stubState.linkMessages.at(-1);
  assert.equal(sent.url, '/api/team/links/lnk-1/message');
  assert.deepEqual(Object.keys(sent.body).sort(), ['folder', 'text'], 'exactly two fields reach the panel');
  assert.equal(sent.body.folder, REPO, 'this repo, never one the caller named');
  assert.equal(sent.body.text, 'can you hold #40?');
  assert.equal(sent.body.speaker, undefined, 'the shape is decided by which endpoint composed it');
});

test('link_read refuses a link this project is not an endpoint of', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 65, method: 'tools/call',
    params: { name: 'link_read', arguments: { id: 'lnk-2' } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /No such link on this project/);
});

test('link_read still answers on a closed link — the history is half this lead’s', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 66, method: 'tools/call',
    params: { name: 'link_read', arguments: { id: 'lnk-3' } },
  });
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
  assert.equal(JSON.parse(res.result.content[0].text).entries.length, 20);
});

/*
 * `room_read`'s hard-won rule, one channel over: an omitted `since` is a tail and an
 * explicit one — including a literal `0` — is a real cursor. `args.since || 0` collapses
 * them, which is how an omitted cursor once read a whole log into a lead's context.
 */
test('link_read with no cursor returns a tail, not the whole thread', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 67, method: 'tools/call',
    params: { name: 'link_read', arguments: { id: 'lnk-1' } },
  });
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.entries.length, 20, 'the tail, not all 25');
  assert.equal(out.entries[0].text, 'link entry 6', 'the newest 20, not the oldest 20');
  assert.equal(out.entries.at(-1).text, 'link entry 25');
  assert.equal(out.cursor, 25, 'the cursor is still the thread’s newest timestamp');
  assert.equal(out.truncated, true, 'entries were left out');
  assert.ok(out.link, 'and the record rides along, so the lead knows which link it read');
});

test('link_read with a cursor returns everything after it, unbounded by the tail', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 68, method: 'tools/call',
    params: { name: 'link_read', arguments: { id: 'lnk-1', since: 10 } },
  });
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.entries.length, 15, 'all 15 after ts 10, not clipped to 20 or fewer');
  assert.equal(out.entries[0].text, 'link entry 11');
  assert.equal(out.cursor, 25);
  assert.equal(out.truncated, false);
});

test('link_read with an explicit since:0 is a real cursor, not "no cursor"', async () => {
  const res = await lead.rpc({
    jsonrpc: '2.0', id: 69, method: 'tools/call',
    params: { name: 'link_read', arguments: { id: 'lnk-1', since: 0 } },
  });
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.entries.length, 25, 'the whole thread, not trimmed to the tail');
  assert.equal(out.cursor, 25);
  assert.equal(out.truncated, false);
});

test('link_read says its cursor is a timestamp, since a room seq could never order two rooms', async () => {
  const res = await lead.rpc({ jsonrpc: '2.0', id: 70, method: 'tools/list' });
  const tool = res.result.tools.find((t) => t.name === 'link_read');
  assert.match(tool.description, /timestamp/i);
  assert.match(tool.description, /per project/i, 'and why a seq cannot do it');
});

/*
 * The tool descriptions are prose a lead reads on every call, and they used to name one
 * person 13 times. The name is detected once at startup from the repo this process is
 * pinned to (`FOREMAN_REPO` → `human-name.js`), so what is pinned here is the substitution:
 * a repo with a `user.name` puts it in the descriptions, and one without reads
 * "the human". `REPO` above is a path that does not exist, which is the no-name case.
 */

const descriptions = async (child) => {
  const res = await child.rpc({ jsonrpc: '2.0', id: 900 + Math.floor(Math.random() * 90), method: 'tools/list' });
  return res.result.tools.map((t) => `${t.description} ${JSON.stringify(t.inputSchema)}`).join('\n');
};

test('with no name on the repo, no tool description names anybody', async () => {
  for (const child of [lead, worker]) {
    const text = await descriptions(child);
    assert.match(text, /the human/, 'the fallback is what stands in');
    // The regression this guards is precise: `REPO` does not exist, and reading the
    // *global* `user.name` from wherever this process happens to be sitting would put
    // whoever owns the machine into the descriptions instead.
    const me = humanName(process.cwd());
    if (me !== FALLBACK) assert.ok(!text.includes(me), 'and nobody real is named');
  }
});

test('a repo with a user.name puts that name in the descriptions instead', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-mcp-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'zzq-testname'], { cwd: dir });
  const named = makeChild({ FOREMAN_ROLE: 'lead', FOREMAN_REPO: dir });
  try {
    const text = await descriptions(named);
    assert.match(text, /zzq-testname has confirmed the task in conversation/, 'task_dispatch reads with it');
    assert.match(text, /bring it to zzq-testname for approval/, 'and so does plan_read');
    assert.doesNotMatch(text, /the human/, 'the fallback is gone, not sitting beside it');
  } finally {
    named.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
