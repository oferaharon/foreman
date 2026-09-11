import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { anyNewOutput, isNewOutput } from '../web/files-new.js';
import { CREATE_EXTS, extOf, isHumanFacingPath } from '../web/output-exts.js';

/*
 * The `files` button's dot, run in plain Node — `web/files-new.js` is DOM-free for exactly
 * this reason, the way `web/files-kinds.js` and `web/trust-gate.js` are.
 *
 * The fixtures are the shapes `server/normalize.js` really emits, in its field spellings: a
 * `tool_use` carries `{kind, toolUseId, name, summary, input}`, an `assistant` carries
 * `{kind, text, model}`, a `tool_result` carries `{kind, toolUseId, isError, output}` and
 * anything holding images carries `images: [{uuid, index, media}]`.
 *
 * Only sandbox project names appear in them (`alpha`, `beta`, `gamma`), which is the rule
 * for anything written down here.
 */

const toolUse = (name, input) => ({
  kind: 'tool_use',
  toolUseId: 'tu_1',
  name,
  summary: '',
  input,
  ts: '2026-09-11T12:00:00.000Z',
  uuid: 'rec-1',
});

/* ------------------------------------------------------- the six witnesses --- */

test('a Write to a human-facing extension lights the dot', () => {
  assert.equal(isNewOutput(toolUse('Write', { file_path: '/alpha/notes.md' })), true);
  assert.equal(isNewOutput(toolUse('Write', { file_path: '/alpha/out/report.txt' })), true);
  assert.equal(isNewOutput(toolUse('Write', { file_path: '/beta/t/table.csv' })), true);
  // The extension is read case-insensitively, because a path is whatever was typed.
  assert.equal(isNewOutput(toolUse('Write', { file_path: '/gamma/README.MD' })), true);
});

test('a Write of source does not — the one thing precision is spent on', () => {
  for (const p of [
    '/alpha/server/index.js',
    '/alpha/package.json',
    '/beta/t/run.sh',
    '/gamma/web/app.tsx',
    '/alpha/tool.py',
    // No extension at all, and a dotfile, which has none by `path.extname`'s reading.
    '/alpha/Makefile',
    '/alpha/.bashrc',
  ]) {
    assert.equal(isNewOutput(toolUse('Write', { file_path: p })), false, p);
  }
});

test('a Write with no path at all is refused rather than guessed at', () => {
  assert.equal(isNewOutput(toolUse('Write', {})), false);
  assert.equal(isNewOutput(toolUse('Write', { file_path: null })), false);
  assert.equal(isNewOutput({ kind: 'tool_use', name: 'Write' }), false);
});

test('a SendUserFile lights it whatever it is handing over', () => {
  // Never extension-filtered, on either side: the tool's own purpose is the witness, which
  // is why a `.wav` lists in the modal too.
  assert.equal(isNewOutput(toolUse('SendUserFile', { files: ['/tmp/alpha-bench.wav'] })), true);
  assert.equal(isNewOutput(toolUse('SendUserFile', { files: ['/tmp/shot.png'], caption: 'the dot' })), true);
});

test('a message carrying images lights it, whichever record it rode in on', () => {
  // A tool's screenshot, inside a result…
  assert.equal(
    isNewOutput({
      kind: 'tool_result',
      toolUseId: 'tu_1',
      isError: false,
      output: 'ok',
      images: [{ uuid: 'rec-2', index: 0, media: 'image/png' }],
    }),
    true,
  );
  // …and one the maintainer pasted, on a `user` record. The scan lists both, so counting
  // one and not the other would make the dot a subset of the modal.
  assert.equal(
    isNewOutput({
      kind: 'user',
      text: 'here is the rail',
      images: [{ uuid: 'rec-3', index: 0, media: 'image/jpeg' }],
    }),
    true,
  );
  // An empty array is not an image.
  assert.equal(isNewOutput({ kind: 'user', text: 'nothing', images: [] }), false);
});

test('a WebFetch lights it, and only with a URL on it', () => {
  assert.equal(isNewOutput(toolUse('WebFetch', { url: 'https://example.com/docs' })), true);
  assert.equal(isNewOutput(toolUse('WebFetch', { prompt: 'what does it say' })), false);
  assert.equal(isNewOutput(toolUse('WebFetch', { url: '' })), false);
});

test('assistant prose with a link lights it; prose without does not', () => {
  assert.equal(
    isNewOutput({ kind: 'assistant', text: 'The spec is at https://example.com/spec — read §3.' }),
    true,
  );
  assert.equal(
    isNewOutput({ kind: 'assistant', text: 'See [the spec](https://example.com/spec) for the rule.' }),
    true,
  );
  assert.equal(
    isNewOutput({ kind: 'assistant', text: 'I changed web/app.js and the suite is green at 1784.' }),
    false,
  );
  // A path is not a URL, and neither is a bare host: the scan wants a scheme.
  assert.equal(isNewOutput({ kind: 'assistant', text: 'run it at 127.0.0.1:48771' }), false);
  assert.equal(isNewOutput({ kind: 'assistant', text: '' }), false);
});

test("a URL the maintainer typed is not something the session produced", () => {
  // `user` and not `assistant`, exactly as `server/outputs.js` has it — it mines prose for
  // `cited` links off assistant records alone.
  assert.equal(isNewOutput({ kind: 'user', text: 'look at https://example.com/issues/12' }), false);
  assert.equal(isNewOutput({ kind: 'command', name: 'model', args: '' }), false);
  assert.equal(isNewOutput({ kind: 'thinking', text: 'https://example.com/maybe' }), false);
});

test('an issue or PR URL in a tool result lights it; other result output does not', () => {
  const result = (output) => ({ kind: 'tool_result', toolUseId: 'tu_1', isError: false, output });
  assert.equal(isNewOutput(result('https://example.com/alpha/repo/pulls/3')), true);
  assert.equal(isNewOutput(result('opened https://github.example/alpha/repo/pull/42 for review')), true);
  // A URL that is not issue/PR-shaped contributes nothing — the 9× multiplier the scan
  // refuses outright.
  assert.equal(isNewOutput(result('fetched https://example.com/a/long/page and 30 more')), false);
  // And the path shape on its own is not a link: this repo's own prose says `/pulls/3`.
  assert.equal(isNewOutput(result('the route is /pulls/3/files')), false);
  assert.equal(isNewOutput(result('')), false);
});

test('anything that is not a message at all is refused', () => {
  for (const junk of [null, undefined, 'a string', 42, [], [{ kind: 'tool_use' }]]) {
    assert.equal(isNewOutput(junk), false);
  }
});

test('a batch lights it if any message in it does', () => {
  const plain = [{ kind: 'assistant', text: 'done' }, { kind: 'user', text: 'thanks' }];
  assert.equal(anyNewOutput(plain), false);
  assert.equal(anyNewOutput([...plain, toolUse('Write', { file_path: '/alpha/report.md' })]), true);
  assert.equal(anyNewOutput([]), false);
  assert.equal(anyNewOutput(null), false);
});

/* --------------------------------------- the list is one list, not two --- */

/*
 * The whole point of `web/output-exts.js` is that there is no second copy of the extension
 * set, so these two hold that rather than the values: one that `server/outputs.js` imports
 * it, and one that the browser-side `extOf` answers what `node:path.extname` does.
 *
 * A source scan for the import, because the alternative is importing the server module into
 * a browser-shaped test and asserting a private const it does not export — and the thing
 * worth proving is the *absence* of a second declaration, which only the source shows.
 */
test('server/outputs.js imports the extension list rather than declaring one', () => {
  const src = readFileSync(new URL('../server/outputs.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ CREATE_EXTS \} from '\.\.\/web\/output-exts\.js';/);
  assert.doesNotMatch(src, /const CREATE_EXTS\s*=/);
  // …and it is still what decides a `Write`, so the import is not merely present.
  assert.match(src, /CREATE_EXTS\.has\(extOf\(entry\.filePath\)\)/);
});

test('the browser-side extOf answers what node:path.extname answers', () => {
  for (const p of [
    '/alpha/notes.md',
    '/alpha/out/REPORT.TXT',
    '/alpha/Makefile',
    '/alpha/.bashrc',
    '/alpha/archive.tar.gz',
    '/alpha/v1.2/run',
    '/alpha/trailing.',
    'notes.md',
    '.md',
    '',
  ]) {
    assert.equal(extOf(p), path.extname(p).toLowerCase(), p);
  }
});

test('the list holds documents and images and no source', () => {
  for (const e of ['.md', '.txt', '.csv', '.pdf', '.png', '.svg']) assert.ok(CREATE_EXTS.has(e), e);
  for (const e of ['.js', '.json', '.py', '.sh', '.tsx', '.html']) assert.ok(!CREATE_EXTS.has(e), e);
  assert.equal(isHumanFacingPath('/gamma/plan.markdown'), true);
  assert.equal(isHumanFacingPath('/gamma/plan.rs'), false);
});

/* ------------------------------- where the dot is painted, and where it is not --- */

/*
 * Three source facts about `web/app.js`, pinned because each is a rule rather than a
 * detail and the cheapest way to undo any of them is a one-line edit that looks tidy.
 *
 * A DOM test is not available here — `web/app.js` is a browser module that reaches for
 * `document` at import time — so these are scans, the shape `test/session-launch.test.js`
 * and `test/aside-fold.test.js` already use for exactly this reason.
 */
const appSrc = () => readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('the dot is nowhere near composerSig', () => {
  const src = appSrc();
  const sig = src.slice(src.indexOf('const composerSig = (s) =>'));
  const body = sig.slice(0, sig.indexOf('let lastComposerSig'));
  // A file landing must never tear the textarea down under a reader's cursor — the
  // `renderMergeQueue` precedent, and §7 rule 6 of the plan.
  assert.doesNotMatch(body, /filesNew/);
  assert.doesNotMatch(body, /paintFilesBtn/);
});

test('the dot rides the head render beat and the message-arrival path, and nothing else', () => {
  const src = appSrc();
  // The roster beat, beside the other two controls that repaint in place there.
  const beat = src.slice(src.indexOf('function renderHead() {'));
  const head = beat.slice(0, beat.indexOf('const sig = composerSig(s);'));
  assert.ok(head.includes("paintFilesBtn(head.querySelector('.head-files'));"), 'painted on the roster beat');
  // …and live arrival, which is the only thing that ever sets the flag.
  const append = src.slice(src.indexOf('function appendMessages(messages) {'));
  const body = append.slice(0, append.indexOf('function renderMessage(m) {'));
  assert.ok(body.includes('if (!view.filesNew && anyNewOutput(messages)) {'), 'set on arrival');
  assert.ok(
    body.indexOf('anyNewOutput(messages)') < body.indexOf('if (!streamEl) return;'),
    'counted before anything about drawing is decided',
  );
  // Per pane, in the factory. Module scope is where a second pane gets caught.
  const at = src.indexOf('function createPane(slot, host) {');
  assert.ok(src.slice(at).includes('filesNew: false,'), "the flag is on the pane's own view");
  assert.equal(src.slice(0, at).includes('filesNew'), false, 'and nowhere in module scope');
});

test('the dot is drawn from the accent token and carries no animation', () => {
  const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  const rule = css.slice(css.indexOf('.head-files-dot {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /background: var\(--accent\);/);
  assert.doesNotMatch(body, /animation/);
  // A hard-coded colour here would be the one thing that cannot answer both themes.
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,6}/);
});
