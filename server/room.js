import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { teamDir } from './team.js';

/**
 * The team's chatroom — one append-only `room.jsonl` per team, outliving every session
 * in it.
 *
 * It is a *log, not a transport*: workers write to it and never read it; anything the
 * lead wants a worker to know travels by `worker_send` into the worker's composer and is
 * mirrored here. The maintainer's view is read-only. So this store optimises for exactly two
 * moves: append one line, read since a cursor.
 *
 * Delivery is addressed (`to`: a task id, `'lead'`, or `'all'`) but storage and display
 * are single — one file, one stream, lanes drawn client-side. The cursor is `seq`, a
 * monotonic integer per team, because two posts can share a millisecond.
 *
 * Kinds: `system` (state changes, posted by the panel), `status`, `escalation` (a
 * worker's "I need a decision": `question`, `options` with their implications,
 * `recommendation`, `blocked` all-or-partial, what it is `continuing` with meanwhile, and
 * `grounds` — what it already checked, which is how the lead tells an honest "I couldn't
 * find this" from a worker that didn't look), `chat` (mirrored lead→worker sends),
 * `answer` (autonomous answers, carrying their grounds — the audit trail).
 */
export class RoomStore extends EventEmitter {
  constructor() {
    super();
    this.seqs = new Map(); // repo -> last seq handed out
  }

  file(repo) {
    return path.join(teamDir(repo), 'room.jsonl');
  }

  #nextSeq(repo) {
    if (!this.seqs.has(repo)) {
      // First touch since boot: recover the counter from the file's last line.
      const entries = this.readAll(repo);
      this.seqs.set(repo, entries.length ? entries[entries.length - 1].seq : 0);
    }
    const seq = this.seqs.get(repo) + 1;
    this.seqs.set(repo, seq);
    return seq;
  }

  /**
   * Append one entry. `from` is who is speaking (a task id, `'lead'`, `'panel'`);
   * `to` is who it concerns (`'lead'`, a task id, `'all'`).
   */
  post(repo, { from, to = 'lead', kind = 'status', ...rest }, { now = Date.now() } = {}) {
    if (!from) throw new Error('A room post needs a sender.');
    const entry = { seq: this.#nextSeq(repo), ts: now, from, to, kind, ...rest };
    fs.mkdirSync(teamDir(repo), { recursive: true });
    fs.appendFileSync(this.file(repo), `${JSON.stringify(entry)}\n`);
    this.emit('post', repo, entry);
    return entry;
  }

  /** Every entry — boot-time cursor recovery and small rooms. Torn lines skipped. */
  readAll(repo) {
    let text;
    try {
      text = fs.readFileSync(this.file(repo), 'utf8');
    } catch {
      return [];
    }
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* torn write — skip */
      }
    }
    return entries;
  }

  /** Entries after `since` (a seq), capped from the end — the lead reads tails here too. */
  read(repo, { since = 0, limit = 200 } = {}) {
    const all = this.readAll(repo);
    const after = since > 0 ? all.filter((e) => e.seq > since) : all;
    return {
      entries: after.slice(-limit),
      cursor: all.length ? all[all.length - 1].seq : 0,
      truncated: after.length > limit,
    };
  }
}
