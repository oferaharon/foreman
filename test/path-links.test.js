import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findPaths, linkablePaths, parentOf, pathLinksIn, refuseReason, resolvePath } from '../web/path-links.js';
import { revealableFolder } from '../server/outputs.js';

/*
 * The path detector, and the bound that turns a candidate into a link.
 *
 * Two halves, tested apart because they answer to different authorities. `findPaths` is a
 * text scan with no idea what is on disk — every refusal below is one of the classes the
 * planner *measured* in 14,929 assistant text blocks, and each is named so that whoever
 * widens this later can see which measurement they are arguing with. `linkablePaths` is
 * the ruling: a path becomes a link only when it names one of the session's own outputs,
 * or the folder one of those sits in.
 *
 * Run in plain Node, the way `test/files-preview.test.js`, `test/trust-gate.test.js` and
 * `test/files-new.test.js` are — the module is DOM-free on purpose and the walk that uses
 * it is not what these hold.
 *
 * The folder resolver at the bottom is the server end of a folder link, and it is tested
 * against a **real** temporary transcript for `test/reveal.test.js`'s reason: the thing it
 * must get right is reading a record back off disk, and a stub proves nothing about that.
 *
 * Only sandbox project names appear anywhere here.
 */

const CWD = '/Users/someone/foreman-sandbox/alpha';

/* ------------------------------------------------------- shape: refusals --- */

/*
 * Six measured false-positive classes, plus the two the plan names separately. In the top
 * 70 path-shaped tokens found outside code there were exactly **two** real filesystem
 * paths; everything below is what the other 68 looked like.
 */
const REFUSED = [
  ['a date', '31/08', 'digits'],
  ['a European date with a leading zero', '05/06', 'digits'],
  ['a three-part date', '2026/09/11', 'digits'],
  ['a tally', '7/7', 'digits'],
  ['a ratio', '9/10', 'digits'],
  ['a three-way tally', '189/31/220', 'digits'],
  ['either-or prose', 'before/after', 'bare-relative'],
  ['either-or prose, short', 'yes/no', 'bare-relative'],
  ['either-or prose, a theme pair', 'light/dark', 'bare-relative'],
  ['either-or prose, initials', 'A/B', 'bare-relative'],
  ['a rate', 'GB/day', 'bare-relative'],
  ['two nouns over a slash', 'Tasks/Room', 'bare-relative'],
  ['a git ref', 'origin/main', 'git-ref'],
  ['a fully-spelled git ref', 'refs/heads/main', 'git-ref'],
  ['another remote', 'upstream/main', 'git-ref'],
  ['an IANA timezone', 'America/Los_Angeles', 'timezone'],
  ['a European timezone', 'Europe/London', 'timezone'],
  ['a Windows path', 'C:\\\\Users\\\\me\\\\notes.md', 'windows'],
  ['a file:line reference', 'server/index.js:412', 'colon'],
  ['a bare filename', 'package.json', 'bare-name'],
  ['a bare document name', 'notes.md', 'bare-name'],
  ['a lone slash', '/', 'too-short'],
  ['a slash run with nothing in it', '///', 'no-segments'],
];

for (const [what, token, why] of REFUSED) {
  test(`refused — ${what}: ${token}`, () => {
    assert.equal(refuseReason(token), why, `${token} should be refused as ${why}`);
    assert.deepEqual(findPaths(`it says ${token} here`), [], `${token} must not be a candidate`);
  });
}

test('refused — a URL, and every path-shaped span inside it', () => {
  const text = 'see https://example.com/alpha/docs/notes.md for the rest';
  assert.deepEqual(findPaths(text), []);
});

test('refused — a bare www. host, which marked would have autolinked', () => {
  assert.deepEqual(findPaths('see www.example.com/docs/notes.md'), []);
});

test('refused — a path with a space is never attempted, and the half before it is not linked', () => {
  // There is no way to know where a spaced path ends in prose. `docs/my` clears no bar of
  // its own (relative, no extension, no trailing slash), so nothing is drawn at all —
  // which is the documented answer rather than half a link.
  assert.deepEqual(findPaths('wrote docs/my notes.md just now'), []);
});

/* ------------------------------------------------------ shape: accepted --- */

test('a relative path with an extension is a candidate', () => {
  assert.deepEqual(findPaths('wrote docs/notes.md today'), [{ start: 6, end: 19, text: 'docs/notes.md' }]);
});

test('a folder-shaped token is a candidate — the trailing slash is the marker', () => {
  const [hit] = findPaths('everything went into docs/ in the end');
  assert.equal(hit.text, 'docs/');
});

test('an absolute path is a candidate with no extension needed', () => {
  const [hit] = findPaths('under /Users/someone/foreman-sandbox/alpha/docs there');
  assert.equal(hit.text, '/Users/someone/foreman-sandbox/alpha/docs');
});

test('a leading ./ and ../ are markers too', () => {
  assert.equal(findPaths('run ./build here')[0].text, './build');
  assert.equal(findPaths('it is in ../gamma there')[0].text, '../gamma');
});

test('a ~/ path is a candidate', () => {
  assert.equal(findPaths('kept in ~/Documents/report.md now')[0].text, '~/Documents/report.md');
});

test('a route fragment is a candidate — the scope check is what refuses it, not the shape', () => {
  // §5.4 rule 6: the detector only marks. `/api/version` resolving to nothing in the
  // output set is what keeps it plain, and the end-to-end case below proves it.
  assert.equal(findPaths('GET /api/version answers')[0].text, '/api/version');
});

test('trailing sentence punctuation is trimmed off the span', () => {
  for (const [text, want] of [
    ['it is docs/notes.md.', 'docs/notes.md'],
    ['(see docs/notes.md)', 'docs/notes.md'],
    ['is it docs/notes.md?', 'docs/notes.md'],
    ['"docs/notes.md",', 'docs/notes.md'],
    ['docs/notes.md…', 'docs/notes.md'],
    ['docs/notes.md...', 'docs/notes.md'],
  ]) {
    assert.equal(findPaths(text)[0].text, want, text);
  }
});

test('the span offsets address the original string, punctuation and all', () => {
  const text = 'wrote (docs/notes.md).';
  const [hit] = findPaths(text);
  assert.equal(text.slice(hit.start, hit.end), 'docs/notes.md');
});

test('several candidates in one line come back in order, non-overlapping', () => {
  const hits = findPaths('docs/notes.md and docs/ and web/app.js');
  assert.deepEqual(hits.map((h) => h.text), ['docs/notes.md', 'docs/', 'web/app.js']);
  for (let i = 1; i < hits.length; i += 1) assert.ok(hits[i].start >= hits[i - 1].end);
});

/* ---------------------------------------------------------- resolution --- */

test('a relative path resolves against the cwd', () => {
  assert.equal(resolvePath('docs/notes.md', CWD), `${CWD}/docs/notes.md`);
});

test('. and .. segments collapse, and a trailing slash comes off', () => {
  assert.equal(resolvePath('./docs/../docs/notes.md', CWD), `${CWD}/docs/notes.md`);
  assert.equal(resolvePath('docs/', CWD), `${CWD}/docs`);
});

test('a ~/ path takes its home from the cwd, and answers null when it cannot', () => {
  assert.equal(resolvePath('~/notes.md', '/Users/someone/foreman-sandbox/alpha'), '/Users/someone/notes.md');
  assert.equal(resolvePath('~/notes.md', '/opt/elsewhere'), null);
  assert.equal(resolvePath('~other/notes.md', CWD), null);
});

test('a relative path with no cwd resolves to nothing rather than to the root', () => {
  assert.equal(resolvePath('docs/notes.md', null), null);
});

test('parentOf answers the directory, and null at the root', () => {
  assert.equal(parentOf('/a/b/c.md'), '/a/b');
  assert.equal(parentOf('/a'), '/');
  assert.equal(parentOf('/'), null);
});

/* --------------------------------------------------------------- scope --- */

/** The shape `GET /api/sessions/:id/outputs` really answers with, file half. */
const out = (over = {}) => ({
  source: 'write',
  uuid: 'u-notes',
  index: 0,
  path: `${CWD}/docs/notes.md`,
  name: 'notes.md',
  kind: 'markdown',
  media: 'text/markdown; charset=utf-8',
  bytes: 42,
  ts: '2026-09-11T10:00:00.000Z',
  sidechain: false,
  note: null,
  onDisk: true,
  ...over,
});

const OUTPUTS = [out()];

test('a path naming one of this session\'s outputs is a file link', () => {
  const [hit] = pathLinksIn('I wrote docs/notes.md for you', OUTPUTS, CWD);
  assert.equal(hit.kind, 'file');
  assert.equal(hit.entry.uuid, 'u-notes');
  assert.equal(hit.text, 'docs/notes.md');
});

test('the parent directory of an output is a folder link, carrying that output', () => {
  const [hit] = pathLinksIn('everything is in docs/ now', OUTPUTS, CWD);
  assert.equal(hit.kind, 'folder');
  assert.equal(hit.entry.uuid, 'u-notes', 'the folder link is addressed by an output inside it');
});

test('a code file in the same paragraph is not linked', () => {
  const hits = pathLinksIn('I wrote docs/notes.md after reading web/app.js', OUTPUTS, CWD);
  assert.deepEqual(hits.map((h) => h.text), ['docs/notes.md']);
});

test('the six false-positive classes and a URL survive the whole pipeline unlinked', () => {
  const prose =
    'wrote docs/notes.md into docs/ after reading web/app.js on 31/08, ' +
    'merged origin/main, in America/Los_Angeles, see https://example.com/a/b.md';
  const hits = pathLinksIn(prose, OUTPUTS, CWD);
  assert.deepEqual(hits.map((h) => `${h.kind}:${h.text}`), ['file:docs/notes.md', 'folder:docs/']);
});

test('a route fragment reaches the scope check and is refused there', () => {
  assert.deepEqual(pathLinksIn('GET /api/version answers', OUTPUTS, CWD), []);
});

test('an absolute spelling of the same output links too', () => {
  const [hit] = pathLinksIn(`it is at ${CWD}/docs/notes.md`, OUTPUTS, CWD);
  assert.equal(hit.kind, 'file');
});

test('a file match wins over a folder match', () => {
  // A directory that is also an output's own path cannot happen through `scanOutputs`, but
  // the order is what decides it and the cheaper mistake is the overlay.
  const outs = [out(), out({ uuid: 'u-dir', path: `${CWD}/docs`, name: 'docs' })];
  const [hit] = pathLinksIn(`look in ${CWD}/docs`, outs, CWD);
  assert.equal(hit.kind, 'file');
  assert.equal(hit.entry.uuid, 'u-dir');
});

test('a folder prefers an output still on disk, so the reveal it addresses can succeed', () => {
  const outs = [
    out({ uuid: 'u-gone', path: `${CWD}/docs/old.md`, onDisk: false }),
    out({ uuid: 'u-live', path: `${CWD}/docs/notes.md`, onDisk: true }),
  ];
  const [hit] = pathLinksIn('in docs/ there', outs, CWD);
  assert.equal(hit.entry.uuid, 'u-live');
});

test('a pathless output — three images in four here — contributes neither a file nor a folder', () => {
  const images = [out({ uuid: 'u-img', source: 'image', path: null, name: null, kind: 'image', onDisk: null })];
  assert.deepEqual(pathLinksIn('docs/notes.md and docs/', images, CWD), []);
});

test('a link entry has no path and cannot be linked to', () => {
  const links = [{ kind: 'link', url: 'https://example.com/docs/notes.md', uuid: 'u-l', ts: null }];
  assert.deepEqual(pathLinksIn('see docs/notes.md', links, CWD), []);
});

test('an empty output set links nothing at all', () => {
  assert.deepEqual(pathLinksIn('wrote docs/notes.md', [], CWD), []);
  assert.deepEqual(pathLinksIn('wrote docs/notes.md', null, CWD), []);
});

/* ----------------------------------------- the walk, without a DOM --- */

/*
 * The walk's idempotency is a property of *where* it looks: `web/app.js` skips `a`, `code`
 * and `pre`, so text already inside a `path-link` anchor is invisible to the next pass and
 * a second walk finds nothing to do. There is no flag on the node, which is what lets a
 * re-walk after the output set has grown still pick up a path that was plain before.
 *
 * The half of that which can be held without a browser is this: the detector, run over the
 * text a linked bubble has *left outside* its anchors, returns nothing.
 */
test('a second pass over what remains outside the anchors finds nothing to link', () => {
  const prose = 'I wrote docs/notes.md into docs/ just now';
  const hits = pathLinksIn(prose, OUTPUTS, CWD);
  assert.equal(hits.length, 2);

  // What the DOM is left with: the spans are inside anchors, and only the gaps are still
  // walkable text nodes.
  const gaps = [];
  let at = 0;
  for (const h of hits) {
    gaps.push(prose.slice(at, h.start));
    at = h.end;
  }
  gaps.push(prose.slice(at));
  for (const gap of gaps) assert.deepEqual(pathLinksIn(gap, OUTPUTS, CWD), [], JSON.stringify(gap));
});

/* -------------------------------------------- the folder reveal, server --- */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-path-links-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const docs = path.join(scratch, 'docs');
fs.mkdirSync(docs);
const NOTES = path.join(docs, 'notes.md');
fs.writeFileSync(NOTES, '# notes\n');
const GONE = path.join(docs, 'gone.md');

/** A `Write` result record, as `server/outputs.js` reads one. */
const writeRec = (uuid, filePath) =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-09-11T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t_${uuid}`, content: 'ok' }] },
    toolUseResult: { type: 'create', filePath, content: '# notes\n', structuredPatch: [] },
  });

const transcript = path.join(scratch, 'session.jsonl');
fs.writeFileSync(
  transcript,
  [
    writeRec('u-notes', NOTES),
    writeRec('u-gone', GONE),
    // A create the human-facing list refuses: source, which the 2026-09-10 ruling excludes.
    writeRec('u-code', path.join(scratch, 'web', 'app.js')),
  ].join('\n') + '\n',
);

test('folder reveal: a real output uuid answers its parent directory', async () => {
  assert.equal(await revealableFolder(transcript, 'u-notes', 0), docs);
});

test('folder reveal: a gone file is refused, even though its folder is right there', async () => {
  assert.ok(fs.existsSync(docs), 'the directory exists — the refusal is about the file');
  assert.equal(await revealableFolder(transcript, 'u-gone', 0), null);
});

test('folder reveal: a create outside the human-facing set is refused', async () => {
  assert.equal(await revealableFolder(transcript, 'u-code', 0), null);
});

test('folder reveal: a fabricated uuid, and one from another session, both answer null', async () => {
  assert.equal(await revealableFolder(transcript, 'not-a-uuid', 0), null);
  assert.equal(await revealableFolder(transcript, 'u-from-gamma', 0), null);
});

test('folder reveal: an index past the end answers null', async () => {
  assert.equal(await revealableFolder(transcript, 'u-notes', 3), null);
});

test('folder reveal: a missing uuid or a negative index answers null without reading', async () => {
  assert.equal(await revealableFolder(transcript, '', 0), null);
  assert.equal(await revealableFolder(transcript, 'u-notes', -1), null);
});

/* ------------------------------------------------------- inline code --- */

/*
 * The 2026-09-11 ruling: a backticked path is exactly the one a reader wants to click, and
 * the output-set bound is what makes walking code safe. The detector itself has nothing to
 * say about backticks — by the time the walk reaches a text node the markdown is a `<code>`
 * element and the text inside it is a bare path — so what these hold is that the *bound*
 * still separates the two cases with no help from the formatting.
 */

test('a code span naming one of this session\'s outputs is linked', () => {
  // What `marked` leaves inside `<code>docs/notes.md</code>` — the walk sees this string.
  const [hit] = pathLinksIn('docs/notes.md', OUTPUTS, CWD);
  assert.equal(hit.kind, 'file');
  assert.equal(hit.entry.uuid, 'u-notes');
});

test('a code span naming a source file is not linked — the bound refuses it, not the markup', () => {
  assert.deepEqual(pathLinksIn('web/app.js', OUTPUTS, CWD), []);
  assert.deepEqual(pathLinksIn('server/index.js', OUTPUTS, CWD), []);
});

test('a code span that is a route, a git ref or a tally is refused exactly as in prose', () => {
  for (const token of ['/api/version', 'origin/main', '31/08', 'America/Los_Angeles']) {
    assert.deepEqual(pathLinksIn(token, OUTPUTS, CWD), [], token);
  }
});

test('the folder of an output links from a code span too', () => {
  const [hit] = pathLinksIn('docs/', OUTPUTS, CWD);
  assert.equal(hit.kind, 'folder');
});

/* ------------------------------------------- where it is wired, by source --- */

/*
 * Four rules that are about *placement* rather than about a value, and so can only be held
 * by reading the source — the shape `test/files-new.test.js` and `test/session-launch.test.js`
 * already use here. Each one is a thing that would go wrong silently.
 */

const appSrc = () => fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const serverSrc = () => fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

test('nothing about path links joins composerSig', () => {
  const src = appSrc();
  const sig = src.slice(src.indexOf('const composerSig = (s) =>'));
  const body = sig.slice(0, sig.indexOf('let lastComposerSig'));
  // A file landing must never rebuild the textarea under a reader's cursor — §7 rule 6,
  // and `renderMergeQueue`'s precedent.
  for (const word of ['outputs', 'pathLinksIn', 'linkPathsIn', 'refreshOutputs']) {
    assert.doesNotMatch(body, new RegExp(word), `composerSig must not mention ${word}`);
  }
});

test('the walk skips pre and anchors, and deliberately does not skip inline code', () => {
  const src = appSrc();
  const decl = src.slice(src.indexOf('const PATH_SKIP = new Set('));
  const set = decl.slice(0, decl.indexOf(');'));
  // `A` is the whole of the walk's idempotency: a drawn link is an anchor, so its own text
  // is invisible to the next pass. `PRE` is a fenced block, which is content being shown
  // rather than a path being mentioned.
  for (const tag of ['A', 'PRE']) assert.match(set, new RegExp(`'${tag}'`), `${tag} must be skipped`);
  // …and `CODE` is **walked**, by the 2026-09-11 ruling. The plan's §5.2 asked for it to be
  // skipped because that is where source paths live — but the output-set bound does that
  // job now, and does it wherever a path appears rather than only where it is formatted,
  // while the skip was costing the register a path is most often written in.
  assert.doesNotMatch(set, /'CODE'/, 'inline code is walked, by ruling');
});

test('the output set is fetched on pane open and off the dot signal, and never polled', () => {
  const src = appSrc();
  const at = src.indexOf('function createPane(slot, host) {');
  const pane = src.slice(at);
  assert.ok(pane.includes('async function refreshOutputs()'), 'the fetch lives in the pane factory');
  // Per pane, for split view's reason: two panes hold two sessions' output sets.
  assert.equal(src.slice(0, at).includes('view.outputs'), false, 'and nothing about it is in module scope');
  const fetchFn = pane.slice(pane.indexOf('async function refreshOutputs()'));
  assert.doesNotMatch(fetchFn.slice(0, fetchFn.indexOf('\n  }\n')), /setInterval|setTimeout/);
});

test('the folder route reveals a directory, takes no path, and is not the file reveal', () => {
  const src = serverSrc();
  const at = src.indexOf("app.post('/api/sessions/:id/output/reveal-folder'");
  assert.ok(at > 0, 'the route exists');
  const route = src.slice(at, src.indexOf('\n});', at));
  // The address space is the bound: `{uuid, index}` in, a directory derived server-side.
  assert.match(route, /revealableFolder\(session\.transcriptPath, req\.body\?\.uuid, index\)/);
  assert.match(route, /revealInFinder\(dir\)/, 'a directory reveal, which refuses a file');
  assert.doesNotMatch(route, /revealFile/, 'never the file reveal, which would open a handler');
  assert.doesNotMatch(route, /req\.body\?\.(?:path|folder|dir)/, 'no path parameter, here least of all');
});

test('the client posts a record and never a directory', () => {
  const src = appSrc();
  const at = src.indexOf('async function revealOutputFolder(');
  const fn = src.slice(at, src.indexOf('\n  }\n', at));
  assert.match(fn, /uuid: entry\.uuid/);
  assert.match(fn, /index: entry\.index/);
  assert.doesNotMatch(fn, /path:/, 'the body never carries a path');
});

test('.path-link is the transcript link colour with a dotted underline', () => {
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  const rule = css.slice(css.indexOf('.path-link {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /color: var\(--accent\);/);
  assert.match(body, /text-decoration: underline dotted;/);
  // A hard-coded colour is the one thing that cannot answer both themes.
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}/i);
});

test('a write becomes linkable when its result lands, not when the call goes out', () => {
  const src = appSrc();
  const append = src.slice(src.indexOf('function appendMessages(messages) {'));
  const body = append.slice(0, append.indexOf('function renderMessage(m) {'));
  // `anyNewOutput` answers on the tool *call* — right for the dot, which is a boolean, and
  // a beat early for the scan, which needs the `toolUseResult` record. Measured on the
  // bench: the set came back without the file and the sentence naming it a second later
  // was drawn against it. The chip's own resolved-but-unlinked path is the question asked
  // again at the only moment its answer can have changed.
  assert.match(body, /chip-summary\[data-path\]/);
  const at = body.indexOf("chip-summary[data-path]");
  assert.ok(body.slice(at).includes('refreshOutputs()'), 'the result path re-asks');
  assert.ok(
    body.indexOf("if (m.kind === 'tool_result' && chipNodes.has(m.toolUseId))") < at,
    'and it is asked where the chip is patched in place',
  );
});
