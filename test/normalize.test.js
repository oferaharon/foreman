import assert from 'node:assert/strict';
import test from 'node:test';
import { imageBlocks, normalizeRecord, servableImage, stitch } from '../server/normalize.js';
import { linkLine } from '../server/links.js';
import { mergeLine } from '../server/merge-queue.js';

/*
 * Images in a transcript, and the two paths that used to throw them away.
 *
 * Every record shape here is copied from a real one. The tool_result shape is the
 * `mcp__claude-in-chrome__computer` screenshot from
 * a transcript in another project (`5b232be6…jsonl`) — two text blocks then the
 * image, at `message.content[0].content[2]`, with `toolUseResult` an *array* that
 * duplicates those same blocks and carries no file path. The pasted shape is the maintainer's own,
 * from `Foreman/36699c8f…jsonl` — text and image side by side at the top of a `user`
 * record, with `imagePasteIds` beside them.
 *
 * Measured across the 429 transcripts on this Mac: 1027 image blocks, every one
 * `source.type === 'base64'`, only `image/jpeg` and `image/png`, and not one of them on a
 * sidechain record.
 */

const DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = (data = DATA) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const txt = (text) => ({ type: 'text', text });

const shot = (uuid, blocks) => ({
  type: 'user',
  uuid,
  timestamp: '2026-08-29T05:08:48.736Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: blocks }] },
  toolUseResult: blocks,
});

test('imageBlocks numbers every image in a record, nesting and all', () => {
  const rec = {
    type: 'user',
    uuid: 'r1',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: [txt('captured'), png()] },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [png(), png()] },
      ],
    },
  };
  const found = imageBlocks(rec);
  assert.deepEqual(
    found.map((f) => [f.index, f.toolUseId]),
    [
      [0, 'toolu_a'],
      [1, 'toolu_b'],
      [2, 'toolu_b'],
    ],
    'ordinals are record-wide and in walk order, not per tool_result',
  );
});

test('an ordinal survives a block we decline to serve', () => {
  const url = { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } };
  const rec = {
    type: 'user',
    uuid: 'r2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [url, png()] }] },
  };
  const found = imageBlocks(rec);
  assert.equal(found.length, 2, 'both are walked');
  assert.equal(servableImage(found[0].block), false);
  assert.equal(servableImage(found[1].block), true);

  const [msg] = normalizeRecord(rec);
  // The one we can serve keeps the number the walk gave it. Renumber the survivors and
  // the endpoint hands back the wrong picture — silently, and only in records with a
  // block we refused.
  assert.deepEqual(msg.images, [{ uuid: 'r2', index: 1, media: 'image/png' }]);
});

test('a captured screenshot is named on the tool_result, not stringified to [image]', () => {
  const rec = shot('u1', [txt('Successfully captured screenshot (1274x952, jpeg)'), txt('Tab Context:'), png()]);
  const [msg] = normalizeRecord(rec);

  assert.equal(msg.kind, 'tool_result');
  assert.deepEqual(msg.images, [{ uuid: 'u1', index: 0, media: 'image/png' }]);
  assert.doesNotMatch(msg.output, /\[image\]/, 'the placeholder is gone');
  assert.match(msg.output, /Successfully captured/, 'the text blocks are untouched');
  assert.equal(JSON.stringify(msg).includes(DATA), false, 'no base64 goes anywhere near the wire');
});

test('images land on the tool_result they came from, when a record carries several', () => {
  const rec = {
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-08-29T05:08:48.736Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: [txt('no picture here')] },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [png()] },
      ],
    },
  };
  const [a, b] = normalizeRecord(rec);
  assert.equal(a.images, undefined, 'a result with no image says nothing about images');
  assert.deepEqual(b.images, [{ uuid: 'u2', index: 0, media: 'image/png' }]);
});

test('a pasted screenshot rides on the user message', () => {
  const rec = {
    type: 'user',
    uuid: 'p1',
    timestamp: '2026-08-24T16:00:32.307Z',
    imagePasteIds: [1],
    message: { role: 'user', content: [txt('[Image #1] - 3 are live, correct?'), png()] },
  };
  const [msg] = normalizeRecord(rec);
  assert.equal(msg.kind, 'user');
  assert.equal(msg.text, '[Image #1] - 3 are live, correct?');
  assert.deepEqual(msg.images, [{ uuid: 'p1', index: 0, media: 'image/png' }]);
});

test('a message that is only an image no longer vanishes', () => {
  const rec = {
    type: 'user',
    uuid: 'p2',
    timestamp: '2026-08-24T16:00:32.307Z',
    message: { role: 'user', content: [png()] },
  };
  const out = normalizeRecord(rec);
  // `textOf` filters to text blocks, and the empty-text check below it returned []. A
  // pasted screenshot with nothing typed beside it was invisible in the panel entirely.
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'user');
  assert.equal(out[0].text, '');
  assert.equal(out[0].images.length, 1);
});

test('a message with neither text nor images is still nothing', () => {
  assert.deepEqual(
    normalizeRecord({ type: 'user', uuid: 'p3', message: { role: 'user', content: [txt('   ')] } }),
    [],
  );
});

test('stitch carries the images onto the chip that asked for them', () => {
  const call = {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-08-29T05:08:40.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } }],
    },
  };
  const result = shot('u3', [txt('Successfully captured screenshot'), png()]);
  const [chip] = stitch([...normalizeRecord(call), ...normalizeRecord(result)]);
  assert.equal(chip.kind, 'tool_use');
  assert.deepEqual(chip.result.images, [{ uuid: 'u3', index: 0, media: 'image/png' }]);
});

test('an image on a sidechain record is kept and flagged, not dropped', () => {
  const rec = { ...shot('s1', [txt('captured'), png()]), isSidechain: true };
  const [msg] = normalizeRecord(rec);
  assert.equal(msg.sidechain, true);
  assert.equal(msg.images.length, 1, 'a subagent’s screenshots are part of what the session produced');
});

/*
 * Task notifications — a finished subagent, background command or monitor, handed back to
 * the session as a synthetic user turn that the terminal never draws.
 *
 * All three envelopes below are copied from one scratch session in the sandbox's `alpha`
 * repo on Claude Code v2.1.257 — one agent whose report is markdown, one whose result is a
 * bare number, one background command with no result at all. Only the home directory in
 * the paths is rewritten; every tag, and the order of them, is as Claude Code wrote it.
 *
 * Measured across this Mac's transcripts: 472 of these, `<summary>` on all 472,
 * `<result>` on 92, `<event>` on 94, and one lone `human`/`typed` message whose text
 * mentions the words — which is the last test here.
 */

const notice = (uuid, content) => ({
  type: 'user',
  uuid,
  timestamp: '2026-09-03T00:59:00.988Z',
  message: { role: 'user', content },
  origin: { kind: 'task-notification' },
  promptSource: 'system',
  queueSkipAttachments: true,
  userType: 'external',
});

const AGENT_MARKDOWN = `<task-notification>
<task-id>ab25f30c58bf94f03</task-id>
<tool-use-id>toolu_01DRNbBLkyf3iPd8k3nmGW7d</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-dev-Foreman-foreman-sandbox-alpha/433f353b/tasks/ab25f30c58bf94f03.output</output-file>
<status>completed</status>
<summary>Agent "Describe repo in markdown" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>
<result># alpha

- A ~75-line ES-module string library with \`node --test\` coverage.
- It's a **sandbox**: nothing here is real.</result>
<usage><subagent_tokens>29054</subagent_tokens><tool_uses>2</tool_uses><duration_ms>10433</duration_ms></usage>
</task-notification>`;

const BACKGROUND_NO_RESULT = `<task-notification>
<task-id>b1hehjy97</task-id>
<tool-use-id>toolu_01RcDwUmmWibzt1fmzwhciQL</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-dev-Foreman-foreman-sandbox-alpha/433f353b/tasks/b1hehjy97.output</output-file>
<status>completed</status>
<summary>Background command "Sleep 2 seconds then echo done" completed (exit code 0)</summary>
</task-notification>`;

test('a finished agent is a chip, not a user bubble', () => {
  const [msg] = normalizeRecord(notice('n1', AGENT_MARKDOWN));
  assert.equal(msg.kind, 'task_notification', 'never `user` — nobody typed this');
  assert.equal(msg.summary, 'Agent "Describe repo in markdown" finished');
  assert.match(msg.text, /^# alpha/, 'the body is the report, with the envelope gone');
  assert.match(msg.text, /nothing here is real\.$/, 'and it ends where `</result>` did');
  assert.ok(!/task-id|output-file|<usage>/.test(msg.text), 'no bookkeeping leaks into it');
});

test('a notification with no result opens onto nothing', () => {
  const [msg] = normalizeRecord(notice('n2', BACKGROUND_NO_RESULT));
  assert.equal(msg.kind, 'task_notification');
  assert.equal(msg.summary, 'Background command "Sleep 2 seconds then echo done" completed (exit code 0)');
  // ~290 of the 472 are a status and a pointer to an output file. An empty body is what
  // makes the chip refuse to open, rather than opening on a blank panel.
  assert.equal(msg.text, '');
});

test('a monitor event is a notification too, and `<event>` is its body', () => {
  const [msg] = normalizeRecord(
    notice(
      'n3',
      '<task-notification>\n<task-id>bh2tndyto</task-id>\n<summary>Monitor event: "alpha test run"</summary>\n<event>the suite went green on the third try</event>\n</task-notification>',
    ),
  );
  assert.equal(msg.kind, 'task_notification');
  assert.equal(msg.text, 'the suite went green on the third try');
});

test('the task id stands in when there is no summary', () => {
  const [msg] = normalizeRecord(
    notice('n4', '<task-notification>\n<task-id>b1hehjy97</task-id>\n</task-notification>'),
  );
  assert.equal(msg.summary, 'b1hehjy97');
  assert.equal(msg.text, '');
});

test('a record with no `origin` is still read off `promptSource`', () => {
  const rec = notice('n5', BACKGROUND_NO_RESULT);
  delete rec.origin;
  assert.equal(normalizeRecord(rec)[0].kind, 'task_notification');
});

test('a message merely mentioning a task-notification stays the user\'s words', () => {
  // There is exactly one of these on this Mac — `origin.kind: 'human'`,
  // `promptSource: 'typed'` — and it is why detection is on the record's own fields and
  // never on the sentence inside. Same reasoning as `parseCommandOutput`'s anchoring.
  const rec = {
    type: 'user',
    uuid: 'h1',
    timestamp: '2026-09-03T00:59:00.988Z',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: `look at this: ${AGENT_MARKDOWN}` },
  };
  const [msg] = normalizeRecord(rec);
  assert.equal(msg.kind, 'user');
  assert.match(msg.text, /^look at this: <task-notification>/);
});

test('a typed message that is nothing but the envelope is still the user\'s words', () => {
  const rec = {
    type: 'user',
    uuid: 'h2',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: AGENT_MARKDOWN },
  };
  // The envelope alone is not the witness — pasting one must not turn it into machinery.
  assert.equal(normalizeRecord(rec)[0].kind, 'user');
});

test('a system-sourced record of some other shape falls straight through', () => {
  const rec = {
    type: 'user',
    uuid: 'h3',
    promptSource: 'system',
    message: { role: 'user', content: '<some-future-thing>hello</some-future-thing>' },
  };
  // `promptSource: 'system'` may grow to carry things nobody here has read. A bubble is
  // the right default for a shape we do not recognise.
  assert.equal(normalizeRecord(rec)[0].kind, 'user');
});

/*
 * The `[link]` register — another project's lead, delivered by the panel into a lead's
 * composer. Same family as the nudge and the task-notification above: without the
 * prefix, a delivered message draws as a two-screen user bubble in the maintainer's own
 * voice, which is the exact failure the feature exists to prevent (see the plan's Traps).
 *
 * The envelope is composed by `linkLine` (`server/links.js`), never hand-typed here, so
 * these tests cannot drift from what the panel actually sends.
 */

const typed = (uuid, content) => ({
  type: 'user',
  uuid,
  timestamp: '2026-09-03T00:59:00.988Z',
  message: { role: 'user', content },
});

test('a link message from another lead is a chip, not a user bubble', () => {
  const text = linkLine({ speaker: 'lead', body: 'the schema moved.', id: 'lnk-1', peer: '/repos/beta' });
  const [msg] = normalizeRecord(typed('l1', text));
  assert.equal(msg.kind, 'link_message', 'never `user` — nobody typed this');
  assert.equal(msg.text, text);
});

test('a link message from the maintainer is the same kind as one from a lead', () => {
  const text = linkLine({
    speaker: 'human',
    body: 'go ahead and merge that.',
    id: 'lnk-1',
    peer: '/repos/beta',
    human: 'the maintainer',
  });
  const [msg] = normalizeRecord(typed('l2', text));
  // Detection is by the shared `[link] ` prefix, never by which envelope shape follows —
  // the whole point is that a lead cannot tell the two apart by reading the transcript.
  assert.equal(msg.kind, 'link_message');
});

test('a message merely mentioning [link] stays the user\'s words', () => {
  const [msg] = normalizeRecord(typed('l3', 'did you see the [link] feature land yet?'));
  assert.equal(msg.kind, 'user');
});

test('a message starting with [link] but no trailing space stays the user\'s words', () => {
  // `[link]` with no space is not the mark — see the parseCommandOutput lesson, learned a
  // third time here. Anchoring loosely would eat ordinary prose shaped like the prefix.
  const [msg] = normalizeRecord(typed('l4', '[link]: see the docs section on this'));
  assert.equal(msg.kind, 'user');
});

test('the merge sentence still normalizes as a user message', () => {
  // The contrast that makes the [link] prefix load-bearing: the merge line carries no
  // prefix and must keep drawing as a user bubble, because it is the maintainer's own
  // word — getting this backwards is the failure the whole feature is built around.
  const text = mergeLine([{ id: 'task-1', prNumber: 40 }], 'the maintainer');
  const [msg] = normalizeRecord(typed('l5', text));
  assert.equal(msg.kind, 'user');
  assert.equal(msg.text, text);
});
