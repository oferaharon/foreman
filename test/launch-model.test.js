import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOT_READ_KEYS,
  EXPOSURE_KEYS,
  LAUNCH_MODEL_RULE,
  WRITABLE_KEYS,
  resolveLaunchModel,
  touchesExposure,
  validateConfigPatch,
} from '../server/settings-file.js';
import { DEFAULT_LAUNCH_MODEL, WORKER_MODELS, isKnownModel } from '../server/worker-models.js';
import { claudeCommand } from '../server/launch.js';
import { normalizeOrigin } from '../server/origin.js';

/*
 * `launchModel` — the model every session the panel launches starts on, except a worker.
 *
 * Three subjects. The resolution (what a launch would use for a given `config.json`), the
 * validation (what `PATCH /api/config` writes and what it refuses), and the command the
 * flag ends up in. The call sites — that every launch in `server/index.js` actually carries
 * the flag, once — are pinned in `test/session-launch.test.js`, beside the standalone-args
 * test they extend; and the response shape against a running panel in `test/team-api.test.js`.
 */

/* ───────────────────────────────────────────────────────────── the resolution ─── */

test('absent means Opus 5.5, by the 2026-10-08 ruling, and that id is on the one list', () => {
  assert.equal(DEFAULT_LAUNCH_MODEL, 'claude-opus-5-5');
  assert.ok(WORKER_MODELS.includes(DEFAULT_LAUNCH_MODEL), 'the default must be a model the picker can show');
  assert.deepEqual(resolveLaunchModel({ config: {} }), { model: 'claude-opus-5-5', source: 'default', error: null });
  assert.deepEqual(resolveLaunchModel(), { model: 'claude-opus-5-5', source: 'default', error: null });
});

test('a listed id is used as written, the 1M variant included', () => {
  for (const id of [...WORKER_MODELS, 'claude-opus-5-5[1m]']) {
    assert.deepEqual(resolveLaunchModel({ config: { launchModel: id } }), {
      model: id,
      source: 'config.json',
      error: null,
    });
  }
});

test('an alias is refused, not resolved — what "opus" means is exactly what moved under the panel', () => {
  const out = resolveLaunchModel({ config: { launchModel: 'opus' }, file: '/x/config.json' });
  assert.equal(out.model, null, 'a refused id must never fall back to a model nobody chose');
  assert.match(out.error, /\/x\/config\.json/, 'the reason names the file to open');
  assert.match(out.error, /"opus"/, 'the reason names the value it refused');
  assert.ok(out.error.includes(LAUNCH_MODEL_RULE));
});

test('a value that is not a string is refused and named by its type', () => {
  for (const bad of [null, 5, true, ['claude-opus-5-5'], { id: 'claude-opus-5-5' }, '']) {
    const out = resolveLaunchModel({ config: { launchModel: bad } });
    assert.equal(out.model, null, `accepted ${JSON.stringify(bad)}`);
    assert.ok(out.error, `no reason for ${JSON.stringify(bad)}`);
  }
});

test('isKnownModel is the dispatch\'s own rule: the list, plus [1m], and nothing looser', () => {
  assert.ok(isKnownModel('claude-sonnet-5-5'));
  assert.ok(isKnownModel('claude-sonnet-5-5[1m]'));
  assert.ok(!isKnownModel('claude-sonnet-5-5[2m]'));
  assert.ok(!isKnownModel(' claude-sonnet-5-5'));
  assert.ok(!isKnownModel('sonnet'));
  assert.ok(!isKnownModel('claude-opus-9'), 'an id shaped like a real one is still refused');
  assert.ok(!isKnownModel(undefined));
});

/* ─────────────────────────────────────────────────────────────── the validation ─── */

test('PATCH writes a listed launchModel, trimmed', () => {
  assert.ok(WRITABLE_KEYS.includes('launchModel'));
  assert.deepEqual(validateConfigPatch({ launchModel: ' claude-sonnet-5-5 ' }, { normalizeOrigin }), {
    ok: true,
    patch: { launchModel: 'claude-sonnet-5-5' },
  });
});

test('PATCH refuses an unknown launchModel and names it — an alias, a typo, a non-string', () => {
  for (const bad of ['opus', 'claude-opus-55', 42, null, '']) {
    const out = validateConfigPatch({ launchModel: bad }, { normalizeOrigin });
    assert.equal(out.ok, false, `wrote ${JSON.stringify(bad)}`);
    assert.equal(out.status, 400);
    assert.match(out.error, /launchModel/);
    assert.ok(out.error.includes(LAUNCH_MODEL_RULE));
  }
  // And it refuses the whole patch, not just its own key: nothing half-writes.
  const mixed = validateConfigPatch({ bindHost: '127.0.0.1', launchModel: 'opus' }, { normalizeOrigin });
  assert.equal(mixed.ok, false);
});

test('launchModel is not exposure: a LAN peer is not gated on it, and the exposure list did not grow', () => {
  assert.deepEqual(EXPOSURE_KEYS, ['bindHost', 'allowedOrigins']);
  assert.equal(touchesExposure({ launchModel: 'claude-opus-5-5' }), false);
  // …and adding it to a patch does not smuggle the exposure keys past the gate either.
  assert.equal(touchesExposure({ launchModel: 'claude-opus-5-5', bindHost: '0.0.0.0' }), true);
});

test('launchModel asks for no restart — it is read at each launch, not at boot', () => {
  assert.deepEqual(BOOT_READ_KEYS, ['bindHost', 'allowedOrigins']);
  assert.ok(!BOOT_READ_KEYS.includes('launchModel'));
  for (const key of BOOT_READ_KEYS) assert.ok(WRITABLE_KEYS.includes(key));
});

test('the prefix refusal is untouched by the new key', () => {
  const out = validateConfigPatch({ sessionPrefix: 'x-', launchModel: 'claude-opus-5-5' }, { normalizeOrigin });
  assert.equal(out.ok, false);
  assert.match(out.error, /sessionPrefix/);
});

/* ───────────────────────────────────────────────────────────────── the command ─── */

test('the model flag rides after --resume, shell-escaped, and the command is still the bare word', () => {
  const cmd = claudeCommand({ resume: 'abc-123', extraArgs: ['--settings', '/s.json', '--model', 'claude-opus-5-5'] });
  assert.equal(cmd, "claude --resume 'abc-123' '--settings' '/s.json' '--model' 'claude-opus-5-5'");
  assert.ok(cmd.startsWith('claude '), 'never an exec of a resolved path — the wrapper must apply');
});

test('a fresh launch carries the model once, after bypass when there is one', () => {
  const cmd = claudeCommand({ skipPermissions: true, extraArgs: ['--model', 'claude-opus-5-5[1m]'] });
  assert.equal(cmd, "claude --dangerously-skip-permissions '--model' 'claude-opus-5-5[1m]'");
  assert.equal(cmd.split('--model').length - 1, 1);
});

test('a value with a quote in it cannot break out of the -ilc body', () => {
  const cmd = claudeCommand({ extraArgs: ['--model', "x'; rm -rf ~; '"] });
  assert.equal(cmd, `claude '--model' 'x'\\''; rm -rf ~; '\\'''`);
});
