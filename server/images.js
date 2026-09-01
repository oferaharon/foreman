import fs from 'node:fs';
import readline from 'node:readline';
import { imageBlocks, servableImage } from './normalize.js';

/**
 * The images a transcript actually contains — the whole file, not the window on screen.
 *
 * Nothing else in the panel reads a transcript whole. `Tailer` backfills a byte window
 * from the end, `loadEarlier` walks another one back, and `probe` deliberately samples
 * head and tail and never the middle. Every one of those is right for what it does and
 * every one of them would make a gallery that is a *subset* while looking complete —
 * which is the failure this file exists to avoid, so it makes its own pass.
 *
 * Both functions here stream the file a line at a time and parse only the lines that
 * could possibly matter. That guard is what makes a whole-file pass affordable: on a
 * 2.9MB transcript with nine screenshots in it, 1,115 lines, 11 parses.
 */

/** Records that cannot contain an image block never contain this substring. */
const IMAGE_HINT = 'image';

/** A caption has to be a recorded fact or it has to be nothing. */
const NOTE_MAX = 140;

function lines(file) {
  return readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
}

/**
 * The text that came with an image, in the image's own container — the first text block
 * of the `tool_result` it arrived in (`Successfully captured screenshot (1274x952,
 * jpeg)…`), or the user's own words beside a pasted one (`[Image #1] - 3 are live…`).
 *
 * Deliberately not a filename: `toolUseResult` on these records is an array that
 * duplicates the content blocks and carries no `filePath`, so there is no name to show
 * and none is invented. Same record, no cross-record join — a caption that needed the
 * `tool_use` it answers would mean parsing every assistant record in the file for a
 * nicety.
 */
function noteFor(rec, toolUseId) {
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return null;

  const container =
    toolUseId == null
      ? content
      : content.find((b) => b?.type === 'tool_result' && (b.tool_use_id ?? null) === toolUseId)?.content;
  if (!Array.isArray(container)) return null;

  const text = container.find((b) => b?.type === 'text' && String(b.text || '').trim());
  if (!text) return null;
  const line = String(text.text).trim().split('\n')[0].trim();
  if (!line) return null;
  return line.length > NOTE_MAX ? `${line.slice(0, NOTE_MAX - 1)}…` : line;
}

/**
 * Every image in the file, oldest first, as refs the browser can fetch one by one.
 *
 * Sidechain records are **in**, flagged rather than filtered. A subagent's screenshots
 * are part of what the session produced, the timeline already renders sidechain turns
 * under a `subagent · N steps` divider, and a gallery that quietly dropped them would be
 * the subset problem again in a smaller costume. (Across the 429 transcripts on this Mac
 * not one sidechain record carries an image, so this is a decision about the shape of the
 * data rather than about anything currently on disk.)
 */
export async function scanImages(file) {
  const started = process.hrtime.bigint();
  const out = [];
  let read = 0;
  let parsed = 0;

  const rl = lines(file);
  for await (const line of rl) {
    read += 1;
    if (!line || !line.includes(IMAGE_HINT)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn write, or the last line of a file being appended to
    }
    parsed += 1;
    for (const f of imageBlocks(rec)) {
      if (!servableImage(f.block)) continue;
      out.push({
        uuid: rec.uuid,
        index: f.index,
        media: f.block.source.media_type,
        ts: rec.timestamp || null,
        sidechain: rec.isSidechain === true,
        // `null` when it arrived at the top of a user record — a pasted screenshot.
        toolUseId: f.toolUseId ?? null,
        note: noteFor(rec, f.toolUseId ?? null),
      });
    }
  }

  return {
    images: out,
    scan: { lines: read, parsed, ms: Number(process.hrtime.bigint() - started) / 1e6 },
  };
}

/**
 * One image's bytes, found by walking the same record with the same enumerator the ref
 * was minted from.
 *
 * Returns `null` rather than throwing for every miss — a uuid that isn't in this file, an
 * index past the end, a block whose source we decline to serve — because the endpoint
 * answers all of those with the same 404 and a distinction the caller can't act on is
 * noise.
 */
export async function readImage(file, uuid, index) {
  if (!uuid || !Number.isInteger(index) || index < 0) return null;

  const rl = lines(file);
  try {
    for await (const line of rl) {
      // The uuid is 36 characters of hex and dashes; a line that doesn't contain it
      // cannot be the record, and this skips the JSON.parse of a 60KB base64 line for
      // every one of the thousands that aren't.
      if (!line || !line.includes(uuid)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      // The substring also matches a *child* record naming this one as its `parentUuid`,
      // so the record's own field is what decides.
      if (rec.uuid !== uuid) continue;

      const found = imageBlocks(rec).find((f) => f.index === index);
      if (!found || !servableImage(found.block)) return null;
      return {
        media: found.block.source.media_type,
        buffer: Buffer.from(found.block.source.data, 'base64'),
      };
    }
  } finally {
    rl.close();
  }
  return null;
}
