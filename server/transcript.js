import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BACKFILL_BYTES } from './config.js';
import { normalizeRecord, stitch } from './normalize.js';

/**
 * Read a byte range and return whole JSON lines, dropping any leading partial.
 *
 * Exported for `observe.js`, which reads its own byte windows out of the same transcripts
 * this file tails. It is exported rather than reimplemented there deliberately: two byte-
 * window readers that could disagree about where a line ends is the `imageBlocks` lesson —
 * one walk, two callers, or the day a record straddles a window boundary they hand back
 * different records and nothing says so.
 */
export async function readRange(file, start, end, { dropLeadingPartial }) {
  if (end <= start) return { records: [], nextOffset: end };
  const fh = await fsp.open(file, 'r');
  try {
    const len = end - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');

    if (dropLeadingPartial) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }

    // Anything after the final newline is a half-written line; leave it for next time.
    const lastNl = text.lastIndexOf('\n');
    const consumed = lastNl === -1 ? '' : text.slice(0, lastNl);
    const heldBack = lastNl === -1 ? text : text.slice(lastNl + 1);

    const records = [];
    for (const line of consumed.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* torn write — skip it */
      }
    }
    return { records, nextOffset: end - Buffer.byteLength(heldBack, 'utf8') };
  } finally {
    await fh.close();
  }
}

/**
 * Cheap metadata probe: head for identity, tail for recency and title.
 * Never reads the middle — these files reach megabytes and the roster touches many.
 */
export async function probe(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return null;
  }

  const headEnd = Math.min(stat.size, 16 * 1024);
  const { records: head } = await readRange(file, 0, headEnd, { dropLeadingPartial: false });

  const tailStart = Math.max(0, stat.size - 64 * 1024);
  const { records: tail } = await readRange(file, tailStart, stat.size, {
    dropLeadingPartial: tailStart > 0,
  });

  const all = head.concat(tail);
  if (!all.length) return null;

  const meta = {
    path: file,
    size: stat.size,
    mtime: stat.mtimeMs,
    sessionId: null,
    // Where the session *is*, which is not necessarily where it started: Claude Code
    // records the working directory on every record, and it moves when the session
    // changes directory. `projectDir` below is the one that doesn't move.
    cwd: null,
    // The folder Claude Code filed this transcript under — `~/.claude/projects/<cwd with
    // every slash as a dash>`, stamped at launch and never rewritten. That makes it the
    // only stable answer to "which pane could this be", which is what binding needs.
    projectDir: path.basename(path.dirname(file)),
    gitBranch: null,
    version: null,
    title: null,
    firstTs: null,
    lastTs: null,
    // Effort is recorded on every assistant turn. The pane footer also shows it, but
    // only sometimes — that right-hand slot rotates through hints — so the transcript
    // is the only place it can be read reliably.
    effort: null,
    // Timestamps of assistant *replies* only. Unread counts what Claude said to you,
    // not the hundreds of tool calls it made getting there.
    replyTimes: [],
  };

  for (const r of head) {
    meta.sessionId ||= r.sessionId || r.session_id || null;
    meta.cwd ||= r.cwd || null;
    meta.gitBranch ||= r.gitBranch || null;
    meta.version ||= r.version || null;
    if (r.timestamp && !meta.firstTs) meta.firstTs = r.timestamp;
  }

  const seen = new Set(); // head and tail overlap on small files
  for (const r of all) {
    if (r.uuid) {
      if (seen.has(r.uuid)) continue;
      seen.add(r.uuid);
    }
    if (r.type === 'custom-title' && r.customTitle) meta.title = r.customTitle;
    if (r.timestamp && (!meta.lastTs || r.timestamp > meta.lastTs)) meta.lastTs = r.timestamp;
    meta.sessionId ||= r.sessionId || r.session_id || null;
    meta.cwd ||= r.cwd || null;

    if (r.type === 'assistant' && r.effort) meta.effort = r.effort;

    if (
      r.type === 'assistant' &&
      r.timestamp &&
      !r.isSidechain &&
      Array.isArray(r.message?.content) &&
      r.message.content.some((b) => b?.type === 'text' && b.text?.trim())
    ) {
      meta.replyTimes.push(r.timestamp);
    }
  }
  meta.replyTimes.sort();

  // The first user turn makes a better label than a bare directory name.
  if (!meta.title) {
    for (const r of head) {
      if (r.type === 'user' && !r.isMeta && typeof r.message?.content === 'string') {
        const line = r.message.content.trim().split('\n')[0];
        if (line && !line.startsWith('<')) {
          meta.title = line.length > 60 ? `${line.slice(0, 57)}…` : line;
          break;
        }
      }
    }
  }

  return meta;
}

/**
 * The last `count` normalized messages of a transcript, one bounded read — no watcher,
 * no offset held, nothing to clean up. Built for the team lead's `worker_read`, where
 * *bounded* is the point: the lead triages tails, it never follows along.
 *
 * Reads a fixed byte window from the end and keeps the newest `count` messages of it. A
 * conversation whose recent messages are enormous may return fewer than asked — honest,
 * and better than an unbounded read growing with the file.
 */
export async function readTail(file, count = 30, { windowBytes = BACKFILL_BYTES } = {}) {
  const stat = await fsp.stat(file);
  const start = Math.max(0, stat.size - windowBytes);
  const { records } = await readRange(file, start, stat.size, {
    dropLeadingPartial: start > 0,
  });
  const messages = stitch(records.flatMap(normalizeRecord));
  return {
    messages: messages.slice(-count),
    truncated: start > 0 || messages.length > count,
  };
}

/**
 * Follows one transcript file, emitting normalized messages as they land.
 * Emits: 'messages' (array), 'error'.
 */
export class Tailer extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.offset = 0;
    this.watcher = null;
    this.reading = false;
    this.pending = false;
    this.earliestOffset = 0;
  }

  /** Backfill the tail of the file, then follow it. */
  async start() {
    const stat = await fsp.stat(this.file);
    const start = Math.max(0, stat.size - BACKFILL_BYTES);
    const { records, nextOffset } = await readRange(this.file, start, stat.size, {
      dropLeadingPartial: start > 0,
    });
    this.offset = nextOffset;
    this.earliestOffset = start;

    this.#watch();
    return {
      messages: stitch(records.flatMap(normalizeRecord)),
      hasEarlier: start > 0,
    };
  }

  /** Walk further back for "load earlier". */
  async loadEarlier(bytes = BACKFILL_BYTES) {
    if (this.earliestOffset === 0) return { messages: [], hasEarlier: false };
    const start = Math.max(0, this.earliestOffset - bytes);
    const { records } = await readRange(this.file, start, this.earliestOffset, {
      dropLeadingPartial: start > 0,
    });
    this.earliestOffset = start;
    return {
      messages: stitch(records.flatMap(normalizeRecord)),
      hasEarlier: start > 0,
    };
  }

  #watch() {
    try {
      this.watcher = fs.watch(this.file, { persistent: false }, () => this.#drain());
    } catch (err) {
      this.emit('error', err);
    }
    // fs.watch misses some appends on network and synced volumes; poll as a floor.
    this.poller = setInterval(() => this.#drain(), 1500);
    this.poller.unref?.();
  }

  async #drain() {
    if (this.reading) {
      this.pending = true;
      return;
    }
    this.reading = true;
    try {
      const stat = await fsp.stat(this.file);
      if (stat.size < this.offset) {
        // Truncated or replaced — start over from here rather than misparse.
        this.offset = 0;
        this.earliestOffset = 0;
      }
      if (stat.size > this.offset) {
        const { records, nextOffset } = await readRange(this.file, this.offset, stat.size, {
          dropLeadingPartial: false,
        });
        this.offset = nextOffset;
        const messages = stitch(records.flatMap(normalizeRecord));
        if (messages.length) this.emit('messages', messages);
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.reading = false;
      if (this.pending) {
        this.pending = false;
        this.#drain();
      }
    }
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    clearInterval(this.poller);
    this.removeAllListeners();
  }
}
