/*
 * worker-models.js — the models a worker may be launched on, and the effort levels it may
 * be launched at, spelled once.
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
 * `claude-opus-5`, `claude-sonnet-5` and `claude-fable-5` are **retired**, by the
 * maintainer's ruling of 2026-11-10 ("remove from worker model options old models like opus
 * 5 fable 5 and sonnet 5"): off this list, so nothing can launch them and an explicit
 * request for one is refused like any unknown id. Task records naming them still draw —
 * they are on `DISPLAY_MODEL_NAMES` below — and a *stored* default that names one (a
 * team.json's `defaultModel`, the panel's `launchModel`) is read as its successor, through
 * `RETIRED_MODEL_SUCCESSORS` and `readStoredModel` below, rather than failing every
 * dispatch in a team nobody has touched.
 *
 * Haiku is on the list because it is a real model id, but it cannot run auto mode
 * (measured, Wave 0) — a Haiku worker prompts on everything. The tool description
 * carries that warning; the panel does not second-guess an explicit choice.
 */
export const WORKER_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-2',
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
/**
 * Retired id → the model a *stored* mention of it is read as, by the maintainer's ruling of
 * 2026-11-10. Spelled once, here (`docs/traps/one-spelling.md`); `readStoredModel` is the
 * only reader. A `[1m]` suffix rides along.
 *
 * For stored values only — a team.json's `defaultModel` and `launchModel` in `config.json`.
 * An *explicit* request for a retired id (a lead's `model`, a PATCH) is refused like any
 * unknown id: `isKnownModel` knows nothing about this map, on purpose.
 */
export const RETIRED_MODEL_SUCCESSORS = Object.freeze({
  'claude-opus-5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-fable-5': 'claude-fable-5-2',
});

/**
 * A stored model id as it is to be read: a retired id becomes its successor (keeping a
 * `[1m]` suffix), anything else comes back untouched — including a non-string or an id
 * nobody knows, which the caller's own `isKnownModel` still gets to refuse. **Maps on read
 * and never writes**: nobody's team.json or config.json is rewritten for this; a later save
 * from the panel simply stores the successor.
 */
export function readStoredModel(id) {
  if (typeof id !== 'string') return id;
  const wide = id.endsWith('[1m]');
  const base = wide ? id.slice(0, -4) : id;
  if (!Object.hasOwn(RETIRED_MODEL_SUCCESSORS, base)) return id;
  return RETIRED_MODEL_SUCCESSORS[base] + (wide ? '[1m]' : '');
}

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
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-fable-5-2': 'Fable 5.2',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

/**
 * Names for models the panel **shows and never launches** — what a bot's transcript says it
 * ran on (`server/bots.js` → `server/context-window.js`'s `modelName`), drawn beside rows
 * that read `Sonnet 5.5` so a deployment on Haiku 5.5 does not read as `claude-haiku-5-5`.
 *
 * **Display only, and the separation is the point.** None of these is on `WORKER_MODELS`,
 * so `isKnownModel` refuses every one of them: a lead cannot dispatch a worker on one, the
 * launch-model setting cannot be saved as one, and neither picker offers one —
 * `workerModelNames` walks `WORKER_MODELS`, never this map. Moving an id from here onto the
 * list above is a ruling about what the panel may start, not a naming fix; `test/model-
 * names.test.js` pins both halves. (`claude-fable-5-1` made that move on 2026-10-14, by the
 * maintainer's ruling, and moved back on 2026-11-10 when Fable 5.2 replaced it — "we don't
 * need to keep 5.1" — so closed task records naming it still draw `Fable 5.1` and nothing can
 * launch it. `claude-opus-5`, `claude-sonnet-5` and `claude-fable-5` made the same move on
 * 2026-11-10 — "remove from worker model options old models like opus 5 fable 5 and sonnet
 * 5" — with one difference: team.json files and `config.json` may still *store* one, so
 * those read as their successor (`RETIRED_MODEL_SUCCESSORS`, above).)
 *
 * In this file rather than in `context-window.js` because `modelLabel` below is the one
 * spelling of "what a model is called", and a second table elsewhere would be the
 * `one-spelling` trap's sibling: a name added to one and not the other.
 */
export const DISPLAY_MODEL_NAMES = Object.freeze({
  'claude-fable-5': 'Fable 5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-5': 'Sonnet 5',
});

/**
 * One id → what to draw. Understands the `[1m]` suffix, because a stored default may carry
 * one and a picker that fell back to the raw id there would read as a different kind of
 * thing than the rows around it. An id with no name falls back to itself — a hand-edited
 * team.json must still be showable, or the picker would lie about what runs.
 *
 * The launchable names first, then the display-only ones (`DISPLAY_MODEL_NAMES`): naming a
 * model here says nothing about whether the panel will put it after `--model` — that is
 * `isKnownModel`'s question alone.
 */
export function modelLabel(id) {
  const raw = String(id ?? '');
  const wide = raw.endsWith('[1m]');
  const base = wide ? raw.slice(0, -4) : raw;
  const name = Object.hasOwn(WORKER_MODEL_NAMES, base)
    ? WORKER_MODEL_NAMES[base]
    : Object.hasOwn(DISPLAY_MODEL_NAMES, base)
      ? DISPLAY_MODEL_NAMES[base]
      : null;
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

/*
 * The effort a worker is launched at — the maintainer's ruling of 2026-11-10. Until then
 * every worker inherited the global `effortLevel` in `~/.claude/settings.json`, which is
 * `xhigh` for Opus 5.5 on this Mac, so every task ran at xhigh whatever it was. Now a team
 * has a default (`defaultEffort` in team.json, a picker beside the worker model) and the
 * lead may depart from it per task with a one-line reason the room shows — the model's
 * pattern exactly, and in this file for the model's reason: `mcp/foreman.js` names the
 * levels in `task_dispatch`'s description and must not import `dispatch.js`.
 *
 * It reaches the worker as `claude --effort <level>`. MEASURED on Claude Code v2.1.296 in
 * the sandbox: the flag is session-only — `~/.claude/settings.json` hashed identical across
 * every launch — every assistant record in the transcript carries the launched level as its
 * `effort` (which is where the rail reads effort from, never the footer), the banner reads
 * `Opus 5.5 with high effort`, and it survives `/clear`.
 *
 * Not the same list as the screen readers'. `EFFORT_RE` in `tmux.js` and the track in
 * `effort.js` read what Claude Code *draws*, which includes `ultracode`; this is what the
 * `--effort` flag *accepts*, which does not. Two contracts that share most of their words.
 */

/**
 * What `--effort` accepts, in the CLI's own order (`claude --help`, v2.1.296). The wall
 * between "the lead picks an effort" and "the lead picks launch flags", exactly as
 * `WORKER_MODELS` is: a level not on it fails the dispatch before a worktree exists.
 *
 * It matters more here than for the model, because the CLI does **not** refuse a bad
 * value — MEASURED: `--effort bogus` prints a warning above the banner, ignores the flag
 * and starts on the global default (xhigh), exit 0. Unvalidated, a typo would launch the
 * very effort this feature exists to stop being the default, and say nothing.
 */
export const WORKER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * What a worker starts at when neither the lead nor team.json names one — and so what
 * every team.json written before this existed reads as, through `withDefaults` (team.js).
 * `high`, by the 2026-11-10 ruling: the point of the feature is that workers stop
 * defaulting to xhigh.
 */
export const DEFAULT_WORKER_EFFORT = 'high';

/** Is this a level the panel will put after `--effort`? Exact match — no case folding. */
export const isKnownEffort = (level) => typeof level === 'string' && WORKER_EFFORTS.includes(level);

/**
 * Models that take no effort level at all. MEASURED on v2.1.296: Haiku 4.5 launched with
 * `--effort max` (and `xhigh`, and `low`) starts normally, prints no warning, draws a banner
 * with no effort in it, and writes **no `effort` field** on any transcript record — the flag
 * is accepted and silently dropped. Every other model on `WORKER_MODELS` that was measured
 * (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.1, and Fable 5.2 at every level `low` to `max`)
 * records exactly the level it was launched with.
 *
 * So a worker on one of these is launched *without* `--effort` and its task records `null`,
 * because a record saying `high` for a session that ran at no effort would be a claim
 * nothing on this Mac made true. A lead that names an effort for one is refused rather than
 * humoured, for the same reason.
 */
export const MODELS_WITHOUT_EFFORT = ['claude-haiku-4-5-20251001'];

/** Does this model id (a `[1m]` suffix allowed) take an effort level? */
export function takesEffort(model) {
  const raw = String(model ?? '');
  const base = raw.endsWith('[1m]') ? raw.slice(0, -4) : raw;
  return !MODELS_WITHOUT_EFFORT.includes(base);
}
