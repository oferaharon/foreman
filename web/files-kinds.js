/*
 * Which pill an entry lives under, and how the two arrays the endpoint returns become one
 * list.
 *
 * `GET /api/sessions/:id/outputs` answers `{outputs, links}` and never merges them — a
 * file is addressed *into* the transcript (`{uuid, index}`) and a link is a string, and
 * `server/outputs.js`'s header says merging them would invite a `url` field on a file and
 * a `path` field on a link. That stays true on the wire. The **modal** still has to draw
 * one grid out of both, so the merge happens here, in one pure function, rather than
 * inline in `openFiles` where it could not be tested.
 *
 * DOM-free on purpose, the way `web/session-colour.js`, `web/quota.js` and
 * `web/trust-gate.js` are: `test/files-kinds.test.js` runs it in plain Node against the
 * endpoint's own two shapes, so the six counts and each pill's membership are pinned
 * without a browser.
 *
 * One rule the filter row rests on: **every item is under exactly one pill, and `all` is
 * the sum.** A pill whose count did not add up to what its click produced would be worse
 * than no counts at all, so `filesCounts` and `filesFor` ask the same `pillFor` rather
 * than each carrying their own idea of what an entry is.
 */

/** The six pills, in the order the row draws them. `all` first, `other` last. */
export const FILE_KINDS = ['all', 'images', 'markdown', 'text', 'links', 'other'];

/**
 * The pill one entry belongs under, or `null` for something that is not an entry at all.
 *
 * A link is recognised by its own `kind: 'link'` — the field `server/outputs.js` stamps on
 * every link row and on no file row — rather than by "has a `url`", because the day a file
 * entry grows a URL-shaped field is the day a document quietly moves into the links pill.
 *
 * Everything the media table has never heard of falls to `other`, which is the same
 * default the server's own `mediaFor` takes. A file entry with no `kind` at all is `other`
 * and not a refusal: it is still something the session produced, and dropping it would
 * make the modal a subset while looking complete.
 */
export function pillFor(entry) {
  // `Array.isArray` beside the `typeof` for `server/outputs.js`'s reason: an array is an
  // object, so without it a stray `[]` on the wire reads as an entry with no kind and
  // lands in `other`, where it would be counted and drawn as a cell.
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  switch (entry.kind) {
    case 'link':
      return 'links';
    case 'image':
      return 'images';
    case 'markdown':
      return 'markdown';
    case 'text':
      return 'text';
    default:
      return 'other';
  }
}

/**
 * Newest first, and an entry the transcript never dated goes last.
 *
 * Timestamps are compared as strings, which is `foldLinks`' own choice one module over:
 * every `ts` here is the record's own ISO-8601 UTC stamp, so lexicographic order *is*
 * chronological order, and `Date.parse` on a few hundred rows to reach the same answer is
 * work for nothing. An undated entry sorts last rather than first — it is the one case a
 * bare descending compare gets backwards, since `''` is less than every real stamp.
 */
function byNewest(a, b) {
  const at = typeof a?.ts === 'string' ? a.ts : '';
  const bt = typeof b?.ts === 'string' ? b.ts : '';
  if (at === bt) return 0;
  if (!at) return 1;
  if (!bt) return -1;
  return at < bt ? 1 : -1;
}

/**
 * The endpoint's two arrays as one list, newest first — files and links interleaved.
 *
 * Interleaved rather than files-then-links because the list's promise is "what this
 * session produced, newest first" and a link is one of those things; grouping them would
 * make the `all` view a different order from every other pill's.
 *
 * `sort` is stable in every engine this runs on, so two entries sharing a timestamp keep
 * the order they arrived in — outputs before links, both in transcript order.
 */
export function filesItems(data) {
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const links = Array.isArray(data?.links) ? data.links : [];
  const items = [];
  for (const o of outputs) if (pillFor(o)) items.push(o);
  for (const l of links) if (pillFor(l)) items.push(l);
  return items.sort(byNewest);
}

/** The number beside each pill. `all` is the total, and the other five partition it. */
export function filesCounts(items) {
  const counts = { all: 0, images: 0, markdown: 0, text: 0, links: 0, other: 0 };
  for (const it of items || []) {
    const pill = pillFor(it);
    if (!pill) continue;
    counts.all += 1;
    counts[pill] += 1;
  }
  return counts;
}

/** What one pill shows — the whole list for `all`, one kind for the other five. */
export function filesFor(items, kind) {
  const list = Array.isArray(items) ? items : [];
  if (!kind || kind === 'all') return list.filter((it) => pillFor(it));
  return list.filter((it) => pillFor(it) === kind);
}

/**
 * The word the list view's kind column shows — the file's own extension where there is
 * one, never the pill it lives under.
 *
 * A `.pdf` and a `.rtf` are both the `other` pill, and a reader scanning a column of
 * "other, other, other" has learned nothing the pill row didn't already say. The extension
 * is the fact that tells two `other` rows apart, so it is what this shows — `pdf`, `rtf`,
 * `csv`, `html`, whatever `server/outputs.js`'s own media table names the file. `pillFor`
 * still decides what a reader can *filter by*; this only decides what one row *says*.
 *
 * Two kinds the extension can't speak for. An image mostly has no path at all (76% of the
 * gallery, per the plan) so there is no extension to read — every image row says `img`.
 * A link is a string, not a file, and reuses the short form `server/outputs.js` already
 * computed through `prNumber` — `#540` for an issue or a PR, `link` for anything else,
 * never a re-parse of the URL.
 */
export function kindLabel(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.kind === 'link') {
    return typeof item.short === 'string' && item.short.startsWith('#') ? item.short : 'link';
  }
  if (item.kind === 'image') return 'img';
  const name = typeof item.name === 'string' ? item.name : typeof item.path === 'string' ? item.path : '';
  const dot = name.lastIndexOf('.');
  const ext = dot > -1 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
  return ext || (typeof item.kind === 'string' ? item.kind : '');
}
