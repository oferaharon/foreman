/*
 * The pinned group's order, as the rail's grip changes it: where a dragged block lands, and
 * which block the pointer is over.
 *
 * Pure for the reason every module beside it gives — `renderRail` is where a rule like this
 * gets quietly re-derived inline, and both of these are wrong in ways that render perfectly.
 * An off-by-one in the insertion point drops a row one place below where the line said it
 * would go; a drop on a row's own place that still writes is a request, a roster broadcast
 * and a repaint for nothing. No DOM, no storage — numbers and ids in, numbers and ids out.
 *
 * The order itself is the server's (`PinStore`); this only says what to ask it for.
 */

/**
 * The pinned rows, top first — by the position the server keeps (`pinOrder`). A row without
 * one sorts last rather than first, which only a frame from an older server could carry.
 */
export function byPinOrder(a, b) {
  return (a?.pinOrder ?? Infinity) - (b?.pinOrder ?? Infinity) || 0;
}

/**
 * Where a block lands, as the whole new order: the one at `from` taken out and put in front
 * of the block that was at `target`, or at the end when `target` is the count. Null when
 * that is where it already is — just above itself or just below — or when either index is
 * out of range, so a drop that changes nothing never writes.
 *
 * @param {string[]} order pane ids, top first
 * @param {number} from index being moved
 * @param {number} target insertion point in `order`, `0..order.length`
 * @returns {string[]|null}
 */
export function movedPinOrder(order, from, target) {
  if (!Array.isArray(order)) return null;
  if (!Number.isInteger(from) || !Number.isInteger(target)) return null;
  if (from < 0 || from >= order.length || target < 0 || target > order.length) return null;
  if (target === from || target === from + 1) return null;
  const next = order.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target > from ? target - 1 : target, 0, moved);
  return next;
}

/**
 * The insertion point for a pointer at `y`: in front of the first block whose middle is
 * below it, or the count when it is below every middle. A block is measured whole — a
 * pinned lead and the workers nested under it are one block — so the line can never land
 * between a lead and its own workers.
 *
 * @param {Array<{top: number, bottom: number}>} blocks top first, in viewport px
 * @param {number} y
 */
export function pinDropIndex(blocks, y) {
  for (let i = 0; i < blocks.length; i++) {
    if (y < (blocks[i].top + blocks[i].bottom) / 2) return i;
  }
  return blocks.length;
}
