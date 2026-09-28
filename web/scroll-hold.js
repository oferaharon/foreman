/*
 * Holding the reader's place across a repaint that adds content *above* them.
 *
 * The complaint this exists for: pressing `load earlier` loaded the older messages and then
 * threw the reader to the bottom of the conversation, because the `earlier` frame went
 * through `renderMain`, which rebuilds the whole pane and always ends at the bottom. That is
 * right for opening a session and wrong for this one frame — the reader was at the top,
 * asking for what is above it.
 *
 * What is held is the distance from the **bottom**, not `scrollTop`: the new messages land
 * above the reader, so everything they were looking at moves down by exactly the height that
 * was added, and `scrollHeight - scrollTop` is the one number that does not change.
 *
 * And note **where** the read happens, because the room panel learned it the expensive way
 * (`docs/traps/rooms.md#a-repaint-that-measures-anything`): before `paint`. Read after
 * `replaceChildren`, `scrollTop` is a forced layout on an emptied box, clamped to 0 before
 * it is read. So the read, the paint and the write are one call, in that order, and the
 * caller cannot put the read on the wrong side of the swap.
 *
 * DOM-free for the usual reason — `test/scroll-hold.test.js` runs it in plain Node against a
 * fake box, the way `files-height.js` and `panel-fold.js` are tested.
 */

/**
 * Run `paint`, then put `box` back at the same distance from its bottom it was at before.
 * `box` is anything with `scrollTop` and `scrollHeight` — the stream element, in practice.
 */
export function holdFromBottom(box, paint) {
  const fromBottom = box.scrollHeight - box.scrollTop;
  paint();
  box.scrollTop = box.scrollHeight - fromBottom;
}
