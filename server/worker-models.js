/*
 * worker-models.js — the models a worker may be launched on, spelled once.
 *
 * A leaf module with no imports, deliberately. The list lived in `dispatch.js` and was
 * typed out a second time in `mcp/foreman.js`'s `task_dispatch` description, which is the
 * shape `docs/traps/one-spelling.md` is about: two spellings of one contract agree the day
 * they are written and diverge silently afterwards — here, a lead told about a model the
 * dispatch would refuse, or never told about one it would accept. The import could not be
 * `dispatch.js` itself: that pulls in `tmux.js` and the whole pane-parser stack, which a
 * stdio MCP child has no business loading. So the list moved down here and `dispatch.js`
 * re-exports it, leaving every existing importer untouched.
 *
 * **It is also the list every other session the panel launches is started on.** Since the
 * maintainer's ruling of 2026-10-08 every launch the panel owns passes `--model` — `+ new`,
 * `⧉`, snapshot restore, relaunch all, restart one and a team lead — and the id comes from
 * `launchModel` in the panel's `config.json` (`settings-file.js`), validated against this
 * same list. One list, not two: a second "models a session may start on" would be the
 * sibling spelling `docs/traps/one-spelling.md` refuses, and the picker in the settings box
 * and the picker in the team panel would then offer different answers to one question.
 */

/**
 * The ids, and nothing else. The value becomes a `--model` launch flag, so this list is
 * the wall between "the lead picks a model" and "the lead picks launch flags" — an id not
 * on it fails the dispatch before a worktree exists. A `[1m]` suffix (the 1M-context
 * variant) is accepted on any of them.
 *
 * `claude-opus-5` stays on the list under `claude-opus-5-5`: task records and team.json
 * files written before 2026-09-22 name it, and every one of them must still validate.
 * Same reason `claude-sonnet-5` stays on the list under `claude-sonnet-5-5`, added
 * 2026-09-28: dropping it would fail every team.json and task record naming it.
 *
 * Haiku is on the list because it is a real model id, but it cannot run auto mode
 * (measured, Wave 0) — a Haiku worker prompts on everything. The tool description
 * carries that warning; the panel does not second-guess an explicit choice.
 */
export const WORKER_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
];

/**
 * Used when neither the lead nor team.json names one. The maintainer's ruling
 * (2026-09-22), replacing the 2026-08-26 default of Opus 5 — same ruling underneath, that
 * workers get the heaviest model unless there is a reason not to, now pointed at the
 * heaviest model there is.
 *
 * A team.json already on disk carries its own `defaultModel` and keeps it: this is only
 * what a *new* team is seeded with, and what resolves when nothing is stored.
 */
export const DEFAULT_WORKER_MODEL = 'claude-opus-5-5';

/**
 * What every non-worker session the panel launches starts on, when `config.json` names
 * nothing. The maintainer's ruling of 2026-10-08: Claude Code's own default moved to Sonnet
 * 5.5, a relaunch brought most of a bench back on Sonnet, and the launch default is locked
 * to Opus 5.5 rather than left to whatever Claude Code's default is that day.
 *
 * A separate constant from `DEFAULT_WORKER_MODEL` although the value is the same, because
 * they are two rulings about two different things — what a lead's dispatch defaults to, and
 * what the panel's own launches start on — and changing one must not quietly change the
 * other.
 */
export const DEFAULT_LAUNCH_MODEL = 'claude-opus-5-5';

/**
 * Is this an id the panel will put after `--model`? On the list, optionally with the `[1m]`
 * suffix that selects the 1M-context variant. The one test, for the dispatch and for the
 * panel's own launch setting alike — it used to be a private helper in `dispatch.js`.
 */
export function isKnownModel(id) {
  if (typeof id !== 'string') return false;
  const base = id.endsWith('[1m]') ? id.slice(0, -4) : id;
  return WORKER_MODELS.includes(base);
}

/**
 * What each id is called in front of a human. The panel's own picker is the reason this
 * exists: `claude-opus-5-5` and `claude-opus-5` are one character apart in a dropdown the
 * maintainer — not a developer — is expected to answer correctly.
 *
 * Keyed by the same ids as the list above, in the same file, so adding a model without a
 * name is a thing you have to walk past; `test/dispatch.test.js` also refuses it.
 */
export const WORKER_MODEL_NAMES = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-fable-5': 'Fable 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

/**
 * One id → what to draw. Understands the `[1m]` suffix, because a stored default may carry
 * one and a picker that fell back to the raw id there would read as a different kind of
 * thing than the rows around it. An id with no name falls back to itself — a hand-edited
 * team.json must still be showable, or the picker would lie about what runs.
 */
export function modelLabel(id) {
  const raw = String(id ?? '');
  const wide = raw.endsWith('[1m]');
  const base = wide ? raw.slice(0, -4) : raw;
  const name = WORKER_MODEL_NAMES[base];
  if (!name) return raw;
  return wide ? `${name} (1M context)` : name;
}

/**
 * Every id's name, for a client that has to label a list it was handed. `extra` is for the
 * ids that are not on the list but still have to be drawn — a team.json's stored
 * `defaultModel`, which may be a `[1m]` variant — so the picker's own fallback is reserved
 * for an id nothing here can name at all.
 */
export const workerModelNames = (...extra) =>
  Object.fromEntries(
    [...WORKER_MODELS, ...extra.filter(Boolean).map(String)].map((id) => [id, modelLabel(id)]),
  );
