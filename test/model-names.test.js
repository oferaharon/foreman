import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * Display names for models the panel shows and never launches — and the wall that keeps
 * "has a name" from turning into "may be started".
 *
 * A bot's transcript names whatever model its deployment ran on, and four of those had no
 * name here, so the bots band drew `claude-haiku-5-5` beside rows reading `Sonnet 5.5`. The
 * fix is a display-only map read by the one `modelLabel`. The maintainer's constraint (lead,
 * 2026-10-13): **display names only** — none of these ids may join `WORKER_MODELS`, the
 * worker dispatch list or the launch-model picker, and dispatch and launch validation must
 * still refuse them. Both halves are pinned here, because the half that would break is the
 * silent one: an id added to the list "to get its name" would validate everywhere and
 * nothing on screen would say a ruling had been undone.
 */

// `dispatch.js` derives a directory from STATE_DIR at import time — a scratch one first,
// `test/dispatch.test.js`'s reason. ESM hoists static imports, hence the dynamic ones.
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-model-names-'));
const { DISPLAY_MODEL_NAMES, WORKER_MODELS, WORKER_MODEL_NAMES, isKnownModel, modelLabel, workerModelNames } =
  await import('../server/worker-models.js');
const { resolveWorkerModel } = await import('../server/dispatch.js');
const { resolveLaunchModel, validateConfigPatch } = await import('../server/settings-file.js');
const { modelName } = await import('../server/context-window.js');

test.after(() => {
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SHOWN_ONLY = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
};

/* ------------------------------------------------------------ the names --- */

test('the four display-only ids have proper names, through the one `modelLabel`', () => {
  assert.deepEqual({ ...DISPLAY_MODEL_NAMES }, SHOWN_ONLY);
  for (const [id, name] of Object.entries(SHOWN_ONLY)) {
    assert.equal(modelLabel(id), name, id);
    assert.equal(modelLabel(`${id}[1m]`), `${name} (1M context)`, `${id}[1m]`);
  }
  // The launchable names are untouched and still win.
  assert.equal(modelLabel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  // An id nobody named is still drawn as itself, and an inherited key is not a name.
  assert.equal(modelLabel('claude-nonsense'), 'claude-nonsense');
  assert.equal(modelLabel('constructor'), 'constructor');
});

test('a bot’s `modelName` — what the band and the pane draw — comes off the same path', () => {
  // `server/context-window.js`'s `modelName` is what `server/bots.js` stores and ships, and
  // the store recomputes it on load, so a name added here reaches existing copies at boot.
  for (const [id, name] of Object.entries(SHOWN_ONLY)) assert.equal(modelName(id, id), name, id);
  assert.equal(modelName('claude-haiku-5-5', 'claude-haiku-5-5[1m]'), 'Haiku 5.5 (1M context)');
  assert.equal(modelName(null, null), null, 'null in, null out — no client formats a null');
  assert.match(text('server/context-window.js'), /import \{ modelLabel \} from '\.\/worker-models\.js';/);
  assert.match(text('server/bots.js'), /c\.modelName = nameOfModel\(c\.model, c\.parse\.requestedModel\);/);
});

test('names are spelled once: no display-only id is named anywhere else', () => {
  for (const id of Object.keys(SHOWN_ONLY)) {
    assert.ok(!Object.hasOwn(WORKER_MODEL_NAMES, id), `${id} is not a worker model's name`);
    for (const file of ['server/context-window.js', 'server/bots.js', 'web/app.js', 'web/bots-band.js']) {
      assert.ok(!text(file).includes(`'${SHOWN_ONLY[id]}'`), `${file} spells "${SHOWN_ONLY[id]}" itself`);
    }
  }
});

/* ------------------------------------------------------------- the wall --- */

test('none of them is launchable: not on `WORKER_MODELS`, and `isKnownModel` refuses each', () => {
  for (const id of Object.keys(SHOWN_ONLY)) {
    assert.ok(!WORKER_MODELS.includes(id), `${id} must not join WORKER_MODELS`);
    assert.equal(isKnownModel(id), false, id);
    assert.equal(isKnownModel(`${id}[1m]`), false, `${id}[1m]`);
  }
});

test('a worker cannot be dispatched on one, named or as a team default', () => {
  for (const id of Object.keys(SHOWN_ONLY)) {
    assert.throws(() => resolveWorkerModel(id, null), /Unknown model/, id);
    assert.throws(() => resolveWorkerModel(`${id}[1m]`, null), /Unknown model/, `${id}[1m]`);
    assert.throws(() => resolveWorkerModel(null, id), /not a model this panel knows/, `team default ${id}`);
  }
  // The lead's tool description lists what dispatch accepts, and none of these.
  const mcp = text('mcp/foreman.js');
  for (const id of Object.keys(SHOWN_ONLY)) assert.ok(!mcp.includes(id), `mcp/foreman.js names ${id}`);
});

test('the launch model cannot be set to one, from the settings box or from the file', () => {
  for (const id of Object.keys(SHOWN_ONLY)) {
    const patch = validateConfigPatch({ launchModel: id });
    assert.equal(patch.ok, false, `PATCH /api/config refuses ${id}`);
    assert.equal(patch.status, 400);
    const read = resolveLaunchModel({ config: { launchModel: id }, file: 'config.json' });
    assert.ok(read.error, `a config.json naming ${id} is refused at launch`);
  }
});

test('neither picker offers one: the served name maps walk `WORKER_MODELS` alone', () => {
  const offered = Object.keys(workerModelNames());
  assert.deepEqual(offered, [...WORKER_MODELS]);
  for (const id of Object.keys(SHOWN_ONLY)) assert.ok(!offered.includes(id), `${id} is offered`);
  // The launch picker's rows are `WORKER_MODELS`, and the team panel's the same list.
  const index = text('server/index.js');
  assert.match(index, /launchModels: WORKER_MODELS,/);
  assert.doesNotMatch(index, /DISPLAY_MODEL_NAMES/);
  assert.doesNotMatch(text('server/dispatch.js'), /DISPLAY_MODEL_NAMES/);
  assert.doesNotMatch(text('server/settings-file.js'), /DISPLAY_MODEL_NAMES/);
});
