/*
 * The files modal's height rule, and nothing else.
 *
 * The complaint this exists for: the modal grew and shrank with the number of items, so
 * switching from `all` to `text` moved the box under the reader's cursor — and once it hit
 * its cap the *whole card* scrolled, pills and title sliding away with the cells. The fix
 * is two halves. The card became a column (a head that does not scroll over a content
 * region that does, `web/styles.css`), and its height is **settled once, when it opens**:
 * measured against what the `all` view needs and then left alone, so a filter change or a
 * view toggle repaints the content and never the box.
 *
 * DOM-free for the usual reason — `test/files-height.test.js` runs it in plain Node, the
 * way `files-kinds.js`, `files-preview.js` and `trust-gate.js` are tested. The arithmetic
 * is small and the interesting part is what it refuses: a measurement that has not
 * happened yet (a detached card, a bench window reporting zero) must not be turned into a
 * height, because an inline `height: 0` on a modal is a modal nobody can close. `null` is
 * "leave the box alone", and the caller sets no height at all.
 */

/** Share of the viewport the card may occupy — the maintainer's "roughly 80%". */
export const FILES_MAX_VH = 0.8;

/**
 * The height to fix the card at: what it naturally wants, capped at `FILES_MAX_VH`.
 *
 * `content` is the content region's natural height (`scrollHeight`, which is the full list
 * whether or not it currently fits) and `head` is everything else the card is made of —
 * title, subtitle, the filter bar, the note, the close row, padding and borders — measured
 * as `card - region` so it stays right even when CSS has already clamped the card.
 *
 * The cap is applied to the *total*, not to the content: the reader's 80% is 80% of the
 * box they see. Rounded up, because a fractional layout height rounded down is a content
 * region one pixel short of its own contents — a scrollbar on a list that fits.
 *
 * Returns `null` when any input is not a usable measurement (non-finite, or a viewport of
 * zero) or when the sum comes to nothing; the caller then leaves the card as it is.
 */
export function filesModalHeight(content, head, viewport, cap = FILES_MAX_VH) {
  if (![content, head, viewport, cap].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  if (viewport <= 0 || cap <= 0) return null;
  const wanted = Math.ceil(Math.max(0, content) + Math.max(0, head));
  if (wanted <= 0) return null;
  return Math.min(wanted, Math.ceil(viewport * cap));
}
