/*
 * Which renderer one entry gets in the preview overlay, which actions it can answer, and
 * the sentence along the bottom.
 *
 * DOM-free on purpose, the way `web/files-kinds.js`, `web/trust-gate.js` and
 * `web/session-colour.js` are: `test/files-preview.test.js` runs it in plain Node against
 * the shapes `GET /api/sessions/:id/outputs` really answers with, so the one rule that
 * must never quietly relax — **an `.html` or `.svg` *document* is shown as text** — is
 * pinned without a browser.
 *
 * Three things it is the only place for:
 *
 *   **The renderer is decided from `source` as well as `kind`.** The server's media table
 *   maps `.svg` to `kind: 'image'`, which is right for a *thumbnail* and wrong for a
 *   preview: an `<img>` of an SVG document is the panel handing a transcript's markup to
 *   its own renderer, which is §7 rule 4 broken one element over from `innerHTML`. So an
 *   entry that arrived **as an image block** (`source: 'image'` — a screenshot, a paste, a
 *   `Read` of a picture) keeps today's `<img>`, and an entry that is a *file* named
 *   `.svg` or `.html` is shown as text. Same field, two answers, and only the source
 *   tells them apart.
 *
 *   **The per-turn strip's refs go through it too.** A `.img-strip` ref is
 *   `{uuid, index, media}` and carries neither `kind` nor `source` (`imageBlocks` in
 *   `server/normalize.js` mints it), so a rule written only against `kind` would send the
 *   strip's own lightbox to the "no preview" branch. An entry with no `source` whose
 *   `media` is an `image/*` is an image, which is exactly what those refs are.
 *
 *   **An action is drawn only when the entry can answer it** — §4 of the plan, and the
 *   trust gate's discipline: a pasted screenshot has no path, and three images in four on
 *   this Mac are pasted screenshots, so a header that always drew `copy path` would draw a
 *   dead button on most of the gallery. `previewActions` answers the empty list rather
 *   than a disabled one.
 */

/** The four ways the overlay can paint one entry. */
export const PREVIEW_KINDS = ['image', 'markdown', 'text', 'plain-other'];

/**
 * A *document* whose bytes must never be handed to a renderer — shown as text instead.
 *
 * `.html` is §7 rule 4 verbatim. `.svg` is the same rule one element over: the panel's own
 * origin, a document the transcript happens to hold, and a format that can carry script.
 * `.htm` is here because the rule is about the format and not about the spelling.
 */
const AS_TEXT_RE = /\.(html?|svg)$/i;

/** `true` when this entry is a file named `.html`/`.htm`/`.svg`. */
function namedAsText(entry) {
  const name = entry?.name || entry?.path || '';
  return AS_TEXT_RE.test(String(name));
}

/** A ref with no `source` but an `image/*` media — the per-turn strip's own shape. */
function looksLikeImageRef(entry) {
  return !entry?.source && !entry?.kind && /^image\//i.test(String(entry?.media || ''));
}

/**
 * The renderer for one entry: `image` | `markdown` | `text` | `plain-other`.
 *
 * Order matters and is the whole of the module. `source: 'image'` is asked **before** the
 * extension, so an SVG that arrived as an image block keeps its `<img>`; the extension is
 * asked **before** `kind`, so an SVG or HTML *file* never reaches one. Everything the
 * media table has never heard of — `.pdf`, `.rtf`, a `.wav` a tool handed over — falls to
 * `plain-other`, which is a name and a sentence rather than a failed fetch.
 *
 * A link answers `plain-other` and never reaches the overlay anyway: a link is an anchor
 * in the grid (§7 rule 3) and `previewable` below is what keeps the arrow keys off it.
 */
export function previewKindFor(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'plain-other';
  if (entry.kind === 'link') return 'plain-other';
  if (entry.source === 'image') return 'image';
  if (looksLikeImageRef(entry)) return 'image';
  if (namedAsText(entry)) return 'text';
  if (entry.kind === 'image') return 'image';
  if (entry.kind === 'markdown') return 'markdown';
  if (entry.kind === 'text') return 'text';
  return 'plain-other';
}

/** Whether the overlay will open on this entry at all — everything but a link. */
export function previewable(entry) {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry) && entry.kind !== 'link';
}

/**
 * A `SendUserFile` attachment whose file is gone: nothing left anywhere to show.
 *
 * This is the one asymmetry the plan calls a gift. A `Write`'s bytes are *in the record*
 * (`toolUseResult.content`), so a deleted file still previews as written; a `SendUserFile`
 * attachment's bytes were only ever on disk, so a gone one would 404 at the byte route.
 * Saying so beats fetching and drawing the failure.
 */
export function previewLost(entry) {
  return entry?.source === 'sendfile' && entry?.onDisk === false;
}

/**
 * The actions this entry can answer, in the order the row draws them.
 *
 * Two, and the second one asks for strictly more than the first. `copy path` needs a path
 * and nothing else — a string is copyable whether or not anything is still there. `reveal
 * in Finder` needs a path **and a file at the end of it**, because Finder has nothing to
 * select otherwise: hence `onDisk === true` rather than a truth test, since `onDisk` is
 * deliberately `null` for the pathless entries (76% of the images here) and `false` for
 * the gone ones, and those are different answers that must not both read as "no".
 *
 * A gone `Write` is exactly the case that separates them. Its bytes are in the record, so
 * it still previews as written and its path is still worth copying — and there is nothing
 * on disk to reveal, so the second button is absent rather than drawn and disabled. That
 * is the trust gate's discipline again: the panel offers what it can actually do.
 *
 * There is **no `open` at all**, by the 2026-09-10 ruling — `open <file>` runs the file's
 * default handler, and this panel's own launcher uses exactly that trick. Reveal is
 * `open -R`, which selects and launches nothing.
 */
export function previewActions(entry) {
  const path = typeof entry?.path === 'string' ? entry.path.trim() : '';
  if (!path) return [];
  return entry?.onDisk === true ? ['copy-path', 'reveal'] : ['copy-path'];
}

/** The last segment of the footer: how the thing on screen is being shown. */
export function previewHow(entry) {
  switch (previewKindFor(entry)) {
    case 'image':
      return 'shown as an image';
    case 'markdown':
      return 'rendered as markdown';
    case 'text':
      // Named, because the reader of an `.html` file is entitled to know the panel is
      // declining to render it rather than failing to.
      return namedAsText(entry) ? 'shown as text, never rendered' : 'shown as text';
    default:
      return 'no preview';
  }
}

/**
 * The line along the bottom: `written by Claude at 13:48 · 1.2 KB · rendered as markdown`.
 *
 * `at` and `size` arrive already formatted — this module has no opinion about locales and
 * `shortBytes` lives with the rest of the panel's formatting. Empty when there is nothing
 * to say, which is what keeps the per-turn strip's lightbox byte-identical to before this
 * existed: a strip ref carries no `ts`, no `bytes` and no `onDisk`.
 */
export function previewFoot(entry, { at = '', size = '' } = {}) {
  if (previewLost(entry)) return 'no longer on disk, nothing to preview';
  if (!at && !size && entry?.onDisk !== false) return '';
  const bits = [];
  if (at) bits.push(`written by Claude at ${at}`);
  if (size) bits.push(size);
  // A gone `Write` says *what* you are looking at rather than how it is drawn: "as
  // written" is the fact that matters, and the how is the same one it always was.
  bits.push(entry?.onDisk === false ? 'as written — the file is no longer on disk' : previewHow(entry));
  return bits.join(' · ');
}
