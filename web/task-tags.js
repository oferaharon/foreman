/*
 * A team task's tag — what the task *is*, from a fixed list of four, spelled once.
 *
 * Every task carries exactly one: `bug`, `feature`, `research` or `chore` (the maintainer's
 * ruling of 2026-10-20). The lead names it when it records or dispatches a task, the
 * maintainer can change it from the row, and it stays on the record for the task's whole
 * life — pending, running, in review, done. It authorizes nothing: nothing reads a tag to
 * start, merge, order or refuse a task.
 *
 * A leaf with no imports, and under `web/` rather than `server/`, for the reason
 * `web/group-hue.js` and `web/output-exts.js` are: the browser draws the tag and `web/`
 * cannot import `server/`, so the list lives in the one place both sides can reach.
 * **`server/tasks.js` and `server/index.js` import it from here**, the way `server/groups.js`
 * imports `web/group-hue.js`; the lead's tool server can import it too without dragging
 * anything else into a stdio child, which is the same reasoning that made
 * `server/worker-models.js` a leaf. `test/task-tags.test.js` holds every other file in the
 * repo to never spelling the four words itself (`docs/traps/one-spelling.md`).
 *
 * **The record holds an array** (`tags: ['bug']`), never a single `tag: 'bug'`. A second
 * group ("why it's waiting") was ruled out for now, and the array is what lets it join
 * later without migrating a record: its words would go in the same list, every record
 * written today stays valid under the wider rule, and an older build that meets one of
 * them shows only the what-tag, because `readTags` drops words it does not know while the
 * store keeps them (`TaskStore` spreads the stored record on load). None of that group is
 * built here — no second list, no second clause.
 *
 * Two readers of one list, deliberately different in temper. `parseTags` is **strict** and
 * is the only gate on a write: exactly one word from `WHAT_TAGS`, nothing else, so a task
 * can be *read* as untagged but nothing can *write* it untagged. `readTags` / `whatTag` are
 * **tolerant** and every read goes through them, never `task.tags` directly — the store
 * keeps whatever is on disk, a hand-edited `['nonsense']` included.
 */

/** The four, in the order a menu offers them. */
export const WHAT_TAGS = Object.freeze(['bug', 'feature', 'research', 'chore']);

/**
 * What each one means, worded as the ruling worded it. One phrase per tag, read wherever a
 * tag is explained — a tool description, the lead's brief, a menu hint, a chip's title —
 * so the meaning is spelled once too.
 */
export const TAG_MEANINGS = Object.freeze({
  bug: 'broken now',
  feature: 'new',
  research: 'investigate only, no code',
  chore: 'docs, cleanup, housekeeping',
});

const ONE_OF = `${WHAT_TAGS.slice(0, -1).join(', ')} or ${WHAT_TAGS.at(-1)}`;

/**
 * Strict, for writes: an array holding exactly one `WHAT_TAGS` word and nothing else.
 *
 * @param {unknown} input
 * @returns {{tags: string[]} | {error: string}} a fresh array on success; on a refusal a
 *   sentence that names the four words, fit to hand straight back to whoever asked
 */
export function parseTags(input) {
  if (!Array.isArray(input)) {
    return { error: `Tags are a list holding exactly one of ${ONE_OF}.` };
  }
  const unknown = input.find((w) => !WHAT_TAGS.includes(w));
  if (unknown !== undefined) {
    return { error: `No such tag: ${JSON.stringify(unknown)} — a task's tag is one of ${ONE_OF}.` };
  }
  if (input.length !== 1) {
    return { error: `A task carries exactly one tag, one of ${ONE_OF} — this named ${input.length}.` };
  }
  return { tags: [input[0]] };
}

/**
 * Tolerant, for reads: whatever is stored, as a list of words this build knows. Not an
 * array → `[]`; an unknown word, or a repeat, is dropped.
 *
 * @param {unknown} stored
 * @returns {string[]}
 */
export function readTags(stored) {
  if (!Array.isArray(stored)) return [];
  return stored.filter((w, i) => WHAT_TAGS.includes(w) && stored.indexOf(w) === i);
}

/**
 * The one what-tag a record carries, or `null` — the shape every display actually wants.
 *
 * @param {unknown} stored
 * @returns {string|null}
 */
export const whatTag = (stored) => readTags(stored).find((w) => WHAT_TAGS.includes(w)) ?? null;

/**
 * The custom property a tag's colour resolves through — `tagVar('bug')` → `var(--tag-bug)`.
 * The one place the token's name is spelled, as `hueVar` is for a group's slot.
 */
export const tagVar = (tag) => `var(--tag-${tag})`;
