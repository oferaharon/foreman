/*
 * context-window.js — how full a headless agent's context is, computed once.
 *
 * A "bot" row (a `claude -p` or Agent SDK run whose transcript a helper ships to the panel)
 * has no composer footer to scrape `ctx: N%` from, so the panel computes it from the
 * transcript. This is the one function that does, so every caller agrees. Pure, and it
 * imports nothing but `worker-models.js`, the leaf the model names already live in.
 *
 * The rule matches Claude Code 2.1.296's own (read from the shipped binary, and checked
 * against a live session's status-line payload: 40,564 tokens / 1,000,000 → 4):
 *
 *   1. the latest assistant record carrying `message.usage`, skipping `<synthetic>`,
 *      `isApiErrorMessage` and `isUnmetered` records;
 *   2. `usage.iterations`' last entry when that is a non-empty array, else the top level;
 *   3. input + cache-creation + cache-read, a missing field counting as 0 — output tokens
 *      are not context and are excluded;
 *   4. over the window, clamped to 0..100.
 *
 * Two traps are the reason for the shape. **One API response is several assistant records,
 * each carrying the same `usage`** (one per content block), so usage is never summed across
 * records — the latest one is the answer. And **the `[1m]` suffix survives only in
 * `requestedModel`** (`message.model` is the bare id), so a window looked up by `model`
 * alone is 200k-wrong for a `[1m]` request on a model whose entry is 200k.
 *
 * Model, effort and context are always read off the ONE record chosen in step 1, so they
 * can never mix two turns.
 */

import { modelLabel } from './worker-models.js';

/**
 * Context window by `message.model`. Every entry was MEASURED — `claude -p --output-format
 * json`, `modelUsage[<model>].contextWindow`, Claude Code 2.1.296 — and the transcript's own
 * `cost-state` carries no `contextWindow`, so it cannot be read from the file: hence a
 * table. A model not here is `null`, never a guess.
 */
export const CONTEXT_WINDOWS = {
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
};

const WIDE_SUFFIX = '[1m]';
const WIDE_WINDOW = 1_000_000;

/** The window for one record's `model` + `requestedModel`, or `null` when unknown. */
export function windowFor(model, requestedModel) {
  if (typeof requestedModel === 'string' && requestedModel.endsWith(WIDE_SUFFIX)) return WIDE_WINDOW;
  if (typeof model !== 'string') return null;
  return Object.hasOwn(CONTEXT_WINDOWS, model) ? CONTEXT_WINDOWS[model] : null;
}

/**
 * What to draw for a model, resolved here so no client formats a `null` (the
 * `a-blocked-session-reports-no-model` crash). `null` in, `null` out; an id with no name
 * falls back to the id itself, as `modelLabel` does. The `[1m]` request counts.
 */
export function modelName(model, requestedModel) {
  if (typeof model !== 'string' || !model) return null;
  const wide = typeof requestedModel === 'string' && requestedModel.endsWith(WIDE_SUFFIX);
  return modelLabel(wide && !model.endsWith(WIDE_SUFFIX) ? model + WIDE_SUFFIX : model);
}

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

function qualifying(r) {
  if (!r || r.type !== 'assistant') return false;
  const m = r.message;
  if (!m || typeof m !== 'object' || !m.usage || typeof m.usage !== 'object') return false;
  if (m.model === '<synthetic>') return false;
  if (r.isApiErrorMessage === true || r.isUnmetered === true) return false;
  return true;
}

/**
 * `records` in file order (parsed jsonl objects). Always answers an object of the same
 * shape: with no qualifying record every field is `null`, so a caller never has to guard
 * the result itself.
 *
 *   { tokens, window, pct, model, modelName, requestedModel, effort }
 *
 * `pct` is `null` when there is no window — tokens are still returned, so a row can say
 * `ctx 41k` instead of a guessed percentage.
 */
export function contextOf(records) {
  let rec = null;
  if (Array.isArray(records)) {
    for (let i = records.length - 1; i >= 0; i--) {
      if (qualifying(records[i])) { rec = records[i]; break; }
    }
  }
  if (!rec) {
    return { tokens: null, window: null, pct: null, model: null, modelName: null, requestedModel: null, effort: null };
  }
  const u = rec.message.usage;
  const last = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : null;
  const src = last && typeof last === 'object' ? last : u;
  const tokens = count(src.input_tokens) + count(src.cache_creation_input_tokens) + count(src.cache_read_input_tokens);
  const model = typeof rec.message.model === 'string' ? rec.message.model : null;
  const requestedModel = typeof rec.requestedModel === 'string' ? rec.requestedModel : null;
  const window = windowFor(model, requestedModel);
  const pct = window ? Math.min(100, Math.max(0, Math.round((tokens / window) * 100))) : null;
  const effort = typeof rec.effort === 'string' && rec.effort ? rec.effort : null;
  return { tokens, window, pct, model, modelName: modelName(model, requestedModel), requestedModel, effort };
}
