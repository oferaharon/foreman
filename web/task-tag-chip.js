/*
 * What a task row draws for its tag, and what the tag's menu offers — the two pure halves of
 * the control, out of `web/app.js` so a test can drive them (`app.js` reaches for the DOM at
 * module scope and imports `/vendor/marked.js`, so `node --test` cannot load it).
 *
 * The list itself is not here. The four words, their meanings and the colour token's name
 * are spelled once, in `web/task-tags.js`, and everything below is read off that leaf —
 * `test/task-tags.test.js` refuses a second spelling anywhere in the repo.
 *
 * **The colour is a variable, never a class.** `colour` is `tagVar(tag)`, which the row sets
 * as `--tag` and `.team-task-tag` / `.m-tk-tag` read. There is no `is-<tag>` class, because
 * an `is-*` class on a pill beside the state chips is one renamed selector away from being
 * drawn by a `.team-chip.is-*` rule — and the chips are not this feature's to touch.
 *
 * Read through `whatTag`, never `task.tags` directly: the store keeps whatever is on disk, a
 * hand-edited `['nonsense']` included, and that has to read as untagged.
 */

import { TAG_MEANINGS, WHAT_TAGS, tagVar, whatTag } from './task-tags.js';

/** What an untagged row offers in the tag's place, on the desktop. The phone draws nothing. */
export const UNTAGGED_TEXT = '+ tag';

/**
 * The pill for one task's stored tags.
 *
 * @param {unknown} stored the record's `tags`, as it came off the wire
 * @returns {{tag: string|null, text: string, title: string, colour: string|null}}
 *   `tag: null` is an untagged row — `text` is then the faint `+ tag` and `colour` is null,
 *   so nothing sets `--tag` and the rule's own fallback applies
 */
export function tagChip(stored) {
  const tag = whatTag(stored);
  if (!tag) {
    return { tag: null, text: UNTAGGED_TEXT, title: 'No tag yet — say what this task is.', colour: null };
  }
  return { tag, text: tag, title: `${tag}: ${TAG_MEANINGS[tag]}`, colour: tagVar(tag) };
}

/**
 * The four, in the leaf's order, each with its meaning as the hint and a tick on the one the
 * task carries now. Picking the ticked one again is allowed and harmless — the route
 * rewrites the same word — so no item is disabled.
 *
 * @param {unknown} stored
 * @returns {Array<{tag: string, label: string, hint: string, checked: boolean}>}
 */
export function tagMenu(stored) {
  const current = whatTag(stored);
  return WHAT_TAGS.map((tag) => ({ tag, label: tag, hint: TAG_MEANINGS[tag], checked: tag === current }));
}
