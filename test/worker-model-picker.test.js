import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WORKER_MODELS, DEFAULT_WORKER_MODEL, modelLabel } from '../server/worker-models.js';

/*
 * The team panel's `worker model` row — the control that decides what a worker launches on
 * when the lead names nothing.
 *
 * Note which picker this is *not*: `model.js` and `test/model.test.js` are about Claude
 * Code's own `/model` dialog, the one where a digit rewrites the global default. This one
 * is a `<select>` in the panel's own settings, and the two have nothing to do with each
 * other beyond the word.
 *
 * Two things are pinned, both of which would break silently. Nothing here is a rendered
 * check — whether the row reads well on a screen is a pair of eyes.
 *
 *  - **The rows are named, not spelled as ids.** `claude-opus-5-5` and `claude-opus-5` are
 *    one character apart in a dropdown answered by somebody who is not a developer, and a
 *    dropdown that offered both as raw ids would be a control they cannot answer correctly
 *    — which the 2026-08-26 ruling says should not be a control.
 *  - **The names come down with the config.** Mapping ids to names in the browser would be
 *    a second copy of the list, the exact shape `docs/traps/one-spelling.md` is about: it
 *    would agree the day it was written and go stale the first time a model is added, with
 *    nothing failing at the moment it parted.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

test('the picker draws the served name, and keeps the id as the value', () => {
  // The value is the launch flag and must stay the id; only the label is for reading.
  assert.match(app, /opt\.value = id;/);
  assert.match(app, /opt\.textContent = team\.modelNames\?\.\[id\] \|\| id;/);
  assert.match(app, /opt\.title = id;/, 'the id is still readable, on hover');
});

test('the browser holds no copy of the list or the names', () => {
  // `web/app.js` may say `defaultModel` and `models` — those are fields it is handed. What
  // it must never contain is a model id, which would mean the list had been retyped here.
  for (const id of WORKER_MODELS) {
    assert.ok(!app.includes(`'${id}'`), `${id} is spelled in web/app.js`);
    assert.ok(!app.includes(`"${id}"`), `${id} is spelled in web/app.js`);
  }
});

test('the config endpoints send the names, including one for a stored default', () => {
  // `workerModelNames(team.defaultModel)` rather than `workerModelNames()`: a stored `[1m]`
  // default is not on the list, still has to be drawn, and has to be drawn as what it is.
  const calls = index.match(/modelNames: workerModelNames\([^)]*\)/g) || [];
  assert.equal(calls.length, 2, 'the GET and the PATCH, which the panel treats as one shape');
  for (const call of calls) assert.match(call, /workerModelNames\((?:team|next)\.defaultModel\)/);
});

test('every id the picker can be handed has a name', () => {
  // The fallback to the raw id exists for a hand-edited team.json, never for a model the
  // panel ships. Duplicated from `test/dispatch.test.js` on purpose: that file asks whether
  // the names exist, this one asks whether the control that draws them can be answered.
  for (const id of [...WORKER_MODELS, `${DEFAULT_WORKER_MODEL}[1m]`]) {
    assert.notEqual(modelLabel(id), id, `${id} would render as its raw id`);
  }
});
