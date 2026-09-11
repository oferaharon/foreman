import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { imageBlocks, servableImage } from './normalize.js';
import { noteFor } from './images.js';
import { prNumber } from './merge-queue.js';
/*
 * The human-facing extension set, from `web/` — the second module `server/` imports from
 * there, after `web/trust-gate.js`, and for that file's reason: the browser has to answer
 * the same question about the same path (the files button's new-item dot reads it off a
 * live message frame) and `web/` cannot import `server/`. So the list lives where both
 * sides can reach it rather than being spelled twice. `MEDIA` below stays here: it builds
 * `Content-Type` headers and is nobody's business in a browser.
 */
import { CREATE_EXTS } from '../web/output-exts.js';

/**
 * What a session produced for a human to read — the whole transcript, not the window on
 * screen.
 *
 * This is `server/images.js` widened, and the reason it reads the file whole is that
 * file's reason verbatim: nothing else in the panel reads a transcript whole. `Tailer`
 * backfills a byte window from the end, `loadEarlier` walks another one back, and `probe`
 * deliberately samples head and tail and never the middle. Every one of those is right
 * for what it does and every one of them would make a Files view that is a *subset* while
 * looking complete — so this makes its own pass.
 *
 * The pass streams a line at a time and parses only the lines that could possibly matter,
 * which is what makes a whole-file read affordable. Four hints, measured by the planner
 * against the transcripts on this Mac: **60.5 ms on the largest one (26 MB)** and
 * **2.5 ms on a typical 0.5 MB one**. `http` is the widest of the four and is the one to
 * re-measure if this ever feels slow.
 *
 * Two arrays come out, never merged: a file is addressed *into* the transcript
 * (`{uuid, index}`) and a link is a string. Merging them would invite a `url` field on a
 * file entry, and a `path` field on a link.
 *
 * Three rules it does not bend:
 *
 *   **One enumerator, both ends.** `outputBlocks` mints every address and is what
 *   `readOutput` walks to find the bytes again. Two walks that could disagree about what
 *   "index 1" means is the `isLeadName` lesson wearing a different hat — `imageBlocks`'s
 *   own header was written to prevent exactly this.
 *
 *   **The ordinal is assigned before anything is filtered.** A block the panel declines
 *   to serve still consumes its number. Renumber the survivors and the byte endpoint
 *   quietly hands back the wrong thing, only in records that had a refused block.
 *
 *   **Existence is not in the scan.** A `stat` is a disk read and this is a transcript
 *   read; the route adds `onDisk` at list time. Mixing them would make a pure function
 *   impure for one boolean.
 */

/**
 * A line that cannot carry any of the four witnesses never contains one of these.
 *
 * `"type":"create"` is a `Write` result's own field; `attachments` is `SendUserFile`'s;
 * `image` is `images.js`'s hint unchanged; `http` catches every URL. Case matters, which
 * is why `"isImage":false` — on every Bash result in the dataset — does not match `image`.
 */
const HINTS = ['"type":"create"', 'attachments', 'image', 'http'];

/**
 * Extension → `[media, kind]`, and this is the **only** table a `Content-Type` is ever
 * built from. The record's own word about media is never reflected into a response
 * header: a `SendUserFile` attachment carries a `media_type` written by a tool, and an
 * unexpected string in a transcript must not become a header.
 *
 * `.html` is here as `text/plain` on purpose. It is not in `CREATE_EXTS` (a repo's own
 * templates and statics are source, and 41 of the 62 `.html` writes measured were exactly
 * that), but `SendUserFile` hands over whatever it hands over — 3 of them were `.html` —
 * and §7 rule 4 of the plan says an `.html` file is never rendered as HTML. Serving it as
 * `text/html` from the panel's own origin is that rule broken at the byte level.
 *
 * `.svg` is an image and is served as one; the route adds `Content-Security-Policy:
 * sandbox` for the same family of reason — an `<img>` never runs an SVG's script, but a
 * browser navigated straight at the URL would.
 */
const MEDIA = new Map([
  ['.md', ['text/markdown; charset=utf-8', 'markdown']],
  ['.markdown', ['text/markdown; charset=utf-8', 'markdown']],
  ['.txt', ['text/plain; charset=utf-8', 'text']],
  ['.text', ['text/plain; charset=utf-8', 'text']],
  ['.csv', ['text/csv; charset=utf-8', 'text']],
  ['.pdf', ['application/pdf', 'other']],
  ['.rtf', ['application/rtf', 'other']],
  ['.png', ['image/png', 'image']],
  ['.jpg', ['image/jpeg', 'image']],
  ['.jpeg', ['image/jpeg', 'image']],
  ['.gif', ['image/gif', 'image']],
  ['.webp', ['image/webp', 'image']],
  ['.svg', ['image/svg+xml', 'image']],
  // SendUserFile's own two, on the tool's word rather than on the document set.
  ['.wav', ['audio/wav', 'other']],
  ['.html', ['text/plain; charset=utf-8', 'text']],
]);

/** Anything the table has never heard of, so a `.wav`-shaped surprise still serves. */
const FALLBACK_MEDIA = 'application/octet-stream';

/*
 * `CREATE_EXTS` — the extensions a **create** may list under, and the whole of the filter —
 * is imported above from `web/output-exts.js`, where its reasoning lives. It used to be
 * declared here; it moved the day the files button needed to ask the same question in the
 * browser, and there is no second copy.
 */

/** Every media string this module will ever name, for the route's belt-to-braces check. */
export const OUTPUT_MEDIA = new Set([...MEDIA.values()].map(([m]) => m).concat([FALLBACK_MEDIA]));

/**
 * A disk-sourced attachment is buffered whole to be served, so there is a ceiling on it.
 * The measured ones are ~200 KB screenshots; this is four orders of magnitude of room and
 * still a bound, because the alternative is a LAN peer making the panel hold an arbitrary
 * file in memory by asking for a record.
 */
const MAX_DISK_BYTES = 64 * 1024 * 1024;

function lines(file) {
  return readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
}

function extOf(p) {
  return path.extname(String(p || '')).toLowerCase();
}

function mediaFor(p) {
  return MEDIA.get(extOf(p)) || [FALLBACK_MEDIA, 'other'];
}

/** The decoded length of a base64 string, without decoding it. */
function base64Bytes(data) {
  const s = String(data || '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/**
 * Every addressable output in one record, in walk order, each carrying the ordinal the
 * panel addresses it by — the one enumerator both ends walk.
 *
 * Images come first and keep the ordinals `imageBlocks` gave them, *verbatim*, so an
 * address minted here and one minted by the image strip mean the same block. A
 * `Write`-created document or a `SendUserFile` attachment is then numbered from the
 * pre-filter image count, which is what keeps one index space per record without
 * renumbering anything. In practice that offset is always 0 — a `create` result and an
 * attachment result carry no image blocks — but the enumeration must be unambiguous
 * whether or not today's data happens to be tidy, because `readOutput` has only a uuid
 * and a number to go on.
 *
 * A record is at most one of *write* or *sendfile*: the two witnesses are different fields
 * of the same object and a `Write` result carries no `attachments`.
 */
export function outputBlocks(rec) {
  const imgs = imageBlocks(rec);
  const out = imgs.map((f) => ({
    source: 'image',
    index: f.index,
    block: f.block,
    toolUseId: f.toolUseId ?? null,
  }));
  const offset = imgs.length;

  const r = rec?.toolUseResult;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return out;

  // The record's own field, never the result sentence. `File created successfully at:
  // <path>` is Claude Code's wording and will be reworded; `parseCommandOutput`,
  // `parseTaskNotice` and `peerOrigin` all learned this the same way. And it is
  // `=== 'create'` rather than "has a filePath", or an `update` (65 of 851) joins a list
  // that claims to show what the session *made*, and `Edit`'s 3,921 calls join it the day
  // somebody reuses the condition.
  if (r.type === 'create' && typeof r.filePath === 'string' && typeof r.content === 'string') {
    out.push({ source: 'write', index: offset, filePath: r.filePath, content: r.content });
    return out;
  }

  if (Array.isArray(r.attachments)) {
    const caption = typeof r.caption === 'string' && r.caption.trim() ? r.caption.trim() : null;
    // `forEach`, so a malformed attachment still consumes its number.
    r.attachments.forEach((a, i) => {
      if (!a || typeof a.path !== 'string' || !a.path) return;
      out.push({
        source: 'sendfile',
        index: offset + i,
        filePath: a.path,
        bytes: Number.isFinite(a.size) ? a.size : null,
        caption,
      });
    });
  }
  return out;
}

/** Is this entry one the Files view will list and the byte route will serve? */
function accept(entry) {
  if (entry.source === 'image') return servableImage(entry.block);
  if (entry.source === 'write') return CREATE_EXTS.has(extOf(entry.filePath));
  return entry.source === 'sendfile';
}

/** One accepted entry as the wire shape — refs and facts, no bytes. */
function fileEntry(rec, entry) {
  const base = {
    source: entry.source,
    uuid: rec.uuid,
    index: entry.index,
    ts: rec.timestamp || null,
    sidechain: rec.isSidechain === true,
  };

  if (entry.source === 'image') {
    return {
      ...base,
      // 76% of the images here have no path at all — browser-automation screenshots and
      // pastes. None is invented; `docs/panel.md` already says there is no filename.
      path: null,
      name: null,
      kind: 'image',
      media: entry.block.source.media_type,
      bytes: base64Bytes(entry.block.source.data),
      note: noteFor(rec, entry.toolUseId),
    };
  }

  const [media, kind] = mediaFor(entry.filePath);
  return {
    ...base,
    path: entry.filePath,
    name: path.basename(entry.filePath),
    kind,
    media,
    bytes:
      entry.source === 'write' ? Buffer.byteLength(entry.content, 'utf8') : entry.bytes,
    note: entry.source === 'sendfile' ? entry.caption : null,
  };
}

/* ------------------------------------------------------------------ links */

/**
 * An issue or a pull request, in every spelling the forges here use — Gitea's `/pulls/`
 * included, which is what all 89 live PR records on this Mac are.
 *
 * This shape is the whole of what makes mining a *tool result* safe. Measured: 191 Bash
 * results contained one and the most in any single result was 6, against 1,458 URLs in
 * WebSearch results and 3,837 in Bash results overall.
 */
const ISSUE_PR_RE = /\/(?:issues|pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/;

/** `[title](url)`, and the title is whatever the transcript said — never invented. */
const MD_LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;

/** A bare URL in prose. `https?` only: the scan's own `http` hint is what finds the line. */
const BARE_URL_RE = /https?:\/\/[^\s<>"'`\])]+/g;

/** `created` beats `fetched` beats `cited`. */
const RANK = { created: 3, fetched: 2, cited: 1 };

/**
 * The one normalisation, and the reason each half of it exists.
 *
 * The fragment goes, or `#top` makes a third row out of one address. Trailing `.,;:)]`
 * goes, or the same URL at the end of a sentence and mid-sentence are two rows — measured
 * as a real cost, not a hypothetical. One trailing slash goes, so `…/repo` and `…/repo/`
 * are one. Returns `null` for anything that is not left looking like a URL.
 */
export function normaliseUrl(raw) {
  let u = String(raw || '').trim();
  const hash = u.indexOf('#');
  if (hash !== -1) u = u.slice(0, hash);
  while (u.length && '.,;:)]'.includes(u[u.length - 1])) u = u.slice(0, -1);
  if (u.endsWith('/')) u = u.slice(0, -1);
  if (!/^https?:\/\/[^\s/]+/.test(u)) return null;
  try {
    new URL(u);
  } catch {
    return null;
  }
  return u;
}

/**
 * `#540` for an issue or a PR, otherwise the host.
 *
 * `prNumber` rather than a second parse of `#N`: two spellings of "which PR is this" is
 * the `isLeadName` lesson, and that one already has four call sites drawing `#N` from it.
 * A URL that is issue/PR-shaped but whose number is not last (`…/pull/12/files`) falls
 * back to the host rather than having a number invented for it.
 */
function shortFor(url) {
  if (ISSUE_PR_RE.test(url)) {
    const n = prNumber(url);
    if (n) return `#${n}`;
  }
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * A tool result whose URLs are refused outright, by the shape of its own
 * `toolUseResult` — never by a sentence, and never by a cross-record join to the
 * assistant record that names the tool.
 *
 * **WebSearch** (`{query, results, durationSeconds, searchCount}`) is the one that makes
 * this a feature rather than a tidy-up: median **20** distinct URLs per searching session,
 * p90 86, max 210, none of which anybody read. One search would fill the modal with rows
 * against an `images` filter holding three. **WebFetch** (`{bytes, code, codeText, result,
 * durationMs, url}`) is refused because a fetched page's own outbound links are not
 * something the session exposed — the URL it *went to* is read off the `tool_use` input
 * instead, which is where `fetched` comes from.
 *
 * Beyond these two, a tool result contributes only issue/PR-shaped URLs, so a search hit
 * that happened to be an issue is the one thing these refusals are here to catch: it
 * would otherwise read as `created`, which is a wrong label rather than a noisy list.
 */
function refusedResult(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  if (typeof r.query === 'string' && Array.isArray(r.results)) return true;
  if (typeof r.url === 'string' && typeof r.codeText === 'string') return true;
  return false;
}

/** The text of a `tool_result` block, whichever of its two shapes it is in. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * The URLs one record exposed, with the provenance each one earned.
 *
 * Three sources and no fourth: a `WebFetch` input (`fetched`), a markdown link or a bare
 * URL in *assistant* prose (`cited`), and an issue/PR URL in a tool result (`created`).
 * Keeping raw tool results as well was costed at a **9×** multiplier — 7,699 URLs against
 * a kept set of 833 — and refused; the refusal is the feature and it is the line most
 * likely to be "improved" later.
 */
function linksFrom(rec) {
  const out = [];
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return out;

  const ts = rec.timestamp || null;
  const uuid = rec.uuid || null;
  const refused = refusedResult(rec.toolUseResult);

  for (const b of content) {
    if (!b || typeof b !== 'object') continue;

    if (b.type === 'tool_use') {
      if (b.name === 'WebFetch' && typeof b.input?.url === 'string') {
        out.push({ url: b.input.url, title: null, from: 'fetched', uuid, ts });
      }
      continue;
    }

    if (b.type === 'text' && rec.type === 'assistant' && typeof b.text === 'string') {
      let prose = b.text;
      // Titled links first, then the same text with those spans removed, so a markdown
      // link's own URL is not also collected as a bare one.
      prose = prose.replace(MD_LINK_RE, (whole, title, url) => {
        const t = String(title || '').trim();
        out.push({ url, title: t || null, from: 'cited', uuid, ts });
        return ' '.repeat(whole.length);
      });
      for (const m of prose.matchAll(BARE_URL_RE)) {
        out.push({ url: m[0], title: null, from: 'cited', uuid, ts });
      }
      continue;
    }

    if (b.type === 'tool_result' && !refused) {
      for (const m of resultText(b.content).matchAll(BARE_URL_RE)) {
        const u = normaliseUrl(m[0]);
        if (u && ISSUE_PR_RE.test(u)) out.push({ url: u, title: null, from: 'created', uuid, ts });
      }
    }
  }
  return out;
}

/**
 * Fold the raw hits into one row per address: the strongest provenance wins, the earliest
 * sighting dates it, and the first real title sticks to it.
 *
 * `uuid` and `ts` move **together**, and always as the earliest sighting's pair. They are
 * one fact — the record this row is dated by — and letting the provenance contest carry the
 * uuid while the clock carried the timestamp would produce a row whose two halves name
 * different records, which is a lie a reader cannot see.
 *
 * A title is never invented; it is only ever adopted from another sighting of the same
 * URL, which is why the winner of a provenance contest can still end up wearing the title
 * the prose gave it.
 */
function foldLinks(raw) {
  const byUrl = new Map();
  for (const hit of raw) {
    const url = normaliseUrl(hit.url);
    if (!url) continue;
    const prev = byUrl.get(url);
    if (!prev) {
      byUrl.set(url, { kind: 'link', url, title: hit.title || null, from: hit.from, short: shortFor(url), uuid: hit.uuid, ts: hit.ts });
      continue;
    }
    if (RANK[hit.from] > RANK[prev.from]) prev.from = hit.from;
    if (!prev.title && hit.title) prev.title = hit.title;
    if (hit.ts && (!prev.ts || hit.ts < prev.ts)) {
      prev.ts = hit.ts;
      prev.uuid = hit.uuid;
    }
  }
  return [...byUrl.values()].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
}

/* ------------------------------------------------------------------ the pass */

/**
 * Everything this session produced, oldest first, as refs the browser can fetch one by
 * one — plus every URL it exposed.
 *
 * Sidechain records are **in**, flagged rather than filtered, for `scanImages`' reason: a
 * subagent's output is part of what the session produced, the timeline already draws
 * sidechain turns under their own divider, and dropping them quietly would be the subset
 * problem again in a smaller costume.
 */
export async function scanOutputs(file) {
  const started = process.hrtime.bigint();
  const outputs = [];
  const rawLinks = [];
  let read = 0;
  let parsed = 0;

  const rl = lines(file);
  for await (const line of rl) {
    read += 1;
    if (!line) continue;
    let hinted = false;
    for (const h of HINTS) {
      if (line.includes(h)) {
        hinted = true;
        break;
      }
    }
    if (!hinted) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn write, or the last line of a file being appended to
    }
    parsed += 1;

    for (const entry of outputBlocks(rec)) {
      if (!accept(entry)) continue;
      outputs.push(fileEntry(rec, entry));
    }
    for (const hit of linksFrom(rec)) rawLinks.push(hit);
  }

  return {
    outputs,
    links: foldLinks(rawLinks),
    scan: { lines: read, parsed, ms: Number(process.hrtime.bigint() - started) / 1e6 },
  };
}

/**
 * One output's bytes, found by walking the same record with the same enumerator the ref
 * was minted from.
 *
 * Where the bytes come from is the whole of the difference between the three sources, and
 * the ruling behind it is that the Files view answers *"what did this session produce"*
 * rather than *"what is in this file now"*:
 *
 *   **image** — out of the record, base64 decoded, exactly as `readImage` does it.
 *   **write** — out of the record too, from `toolUseResult.content`. **Never a disk read**,
 *   which is what lets a document that has since been deleted or rewritten still preview
 *   as written, with no `stat` and no path in the request.
 *   **sendfile** — off disk, because those bytes were never in the transcript. The path is
 *   re-derived from the record first; the caller never names it.
 *
 * `index` defaults to 0 so one shape answers both a document (one per record) and an
 * image (several). Returns `null` rather than throwing for every miss — an unknown uuid,
 * an index past the end, an entry we decline to serve, a file that is gone — because the
 * endpoint answers all of those with the same 404 and a distinction the caller cannot act
 * on is noise.
 */
export async function readOutput(file, uuid, index = 0) {
  if (!uuid || !Number.isInteger(index) || index < 0) return null;

  const rl = lines(file);
  let found = null;
  try {
    for await (const line of rl) {
      // The uuid is 36 characters of hex and dashes; a line that does not contain it
      // cannot be the record, and this skips the JSON.parse of a 60KB base64 line for
      // every one of the thousands that are not.
      if (!line || !line.includes(uuid)) continue;
      let candidate;
      try {
        candidate = JSON.parse(line);
      } catch {
        continue;
      }
      // The substring also matches a *child* record naming this one as its `parentUuid`,
      // so the record's own field is what decides.
      if (candidate.uuid !== uuid) continue;
      const hit = outputBlocks(candidate).find((e) => e.index === index);
      if (!hit) return null;
      found = hit;
      break;
    }
  } finally {
    rl.close();
  }
  if (!found || !accept(found)) return null;

  if (found.source === 'image') {
    return {
      source: 'image',
      media: found.block.source.media_type,
      buffer: Buffer.from(found.block.source.data, 'base64'),
      path: null,
    };
  }

  const [media] = mediaFor(found.filePath);

  if (found.source === 'write') {
    return { source: 'write', media, buffer: Buffer.from(found.content, 'utf8'), path: found.filePath };
  }

  try {
    const st = await fsp.stat(found.filePath);
    if (!st.isFile() || st.size > MAX_DISK_BYTES) return null;
    return {
      source: 'sendfile',
      media,
      buffer: await fsp.readFile(found.filePath),
      path: found.filePath,
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
  } catch {
    return null; // handed over once, gone now
  }
}
