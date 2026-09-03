/**
 * Claude Code JSONL records -> the handful of things the panel actually renders.
 *
 * The transcript format carries a lot of bookkeeping (snapshots, attachments,
 * queue operations, mode changes). Dropping it is what keeps the panel readable,
 * so the default here is drop-unless-recognised.
 */

import { NUDGE_MARK } from './watch.js';
import { LINK_MARK } from './links.js';

const DROP_TYPES = new Set([
  'attachment',
  'file-history-snapshot',
  'queue-operation',
  'mode',
  'bridge-session',
  'last-prompt',
  'summary',
  'system',
]);

/** One line of context per tool, so a chip reads at a glance. */
function toolSummary(name, input = {}) {
  switch (name) {
    case 'Bash':
      return input.description || input.command || '';
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return shortPath(input.file_path || input.notebook_path);
    case 'Edit':
      return shortPath(input.file_path);
    case 'Glob':
      return input.pattern || '';
    case 'Grep':
      return input.pattern ? `/${input.pattern}/${input.path ? ` in ${shortPath(input.path)}` : ''}` : '';
    case 'Task':
    case 'Agent':
      return input.description || input.subagent_type || '';
    case 'WebFetch':
      return hostOf(input.url);
    case 'WebSearch':
      return input.query || '';
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} items` : '';
    case 'Skill':
      return input.skill || '';
    case 'SendMessage':
      return input.to ? `to ${input.to}` : '';
    default: {
      const first = input.file_path || input.path || input.query || input.prompt || input.command;
      return typeof first === 'string' ? first : '';
    }
  }
}

function shortPath(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return typeof url === 'string' ? url : '';
  }
}

/**
 * The media types the panel will name as an image, and the only ones the byte endpoint
 * will put in a `Content-Type`. Measured across 429 transcripts on this Mac: 1027 image
 * blocks, every one of them `source.type === 'base64'`, and only `image/jpeg` (704) and
 * `image/png` (323). GIF and WebP are here because `uploads.js` already accepts them
 * going the other way, not because one has ever been seen coming back.
 */
export const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Every image block in one record, in walk order, each carrying the ordinal the panel
 * addresses it by.
 *
 * Images arrive two ways and both are here: inside a `tool_result` (a screenshot a tool
 * captured — `content[0].content[2]` in the specimen) and at the top of a `user` record
 * (a screenshot the maintainer pasted, which also carries `imagePasteIds` and a `[Image #1]`
 * reference in the text). `toolUseId` says which, and is `null` for a pasted one.
 *
 * `index` is that ordinal and it is the whole addressing scheme: a normalized message
 * names `{uuid, index}` and the bytes come back from
 * `/api/sessions/:id/image/:uuid/:index`, which finds them by walking the same record
 * with this same function. One enumerator, called from both ends — two walks that could
 * disagree about what "the second image" means is the `isLeadName` lesson wearing a
 * different hat.
 *
 * Note the ordinal is assigned *before* anything is filtered out, so a block this panel
 * declines to show (a `url` source, a media type not in the set above) still consumes its
 * number and the ones after it keep their addresses.
 */
export function imageBlocks(rec) {
  const out = [];
  const walk = (blocks, toolUseId) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'image') out.push({ index: out.length, block: b, toolUseId });
      else if (b.type === 'tool_result') walk(b.content, b.tool_use_id ?? null);
    }
  };
  walk(rec?.message?.content, null);
  return out;
}

/** Is this a block whose bytes we can actually serve? */
export function servableImage(block) {
  const src = block?.source;
  return src?.type === 'base64' && typeof src.data === 'string' && IMAGE_MEDIA.has(src.media_type);
}

/**
 * The subset of `imageBlocks` a message may point at, as wire refs — no bytes.
 *
 * A screenshot is ~60KB of base64 and nine of them were 19% of one 2.9MB transcript.
 * Inlining that into a transcript frame would make the socket carry it once per subscribe
 * and defeat browser caching entirely, so the frame carries the name and HTTP carries the
 * bytes.
 */
function imageRefs(found, rec) {
  return found
    .filter((f) => servableImage(f.block))
    .map((f) => ({ uuid: rec.uuid, index: f.index, media: f.block.source.media_type }));
}

/** Attach `images` only when there are some — an empty array on every message is weight. */
function withImages(msg, refs) {
  return refs.length ? { ...msg, images: refs } : msg;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('\n');
}

/** Claude Code wraps slash commands in pseudo-tags; show them as a chip, not a bubble. */
function parseCommand(text) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
  // The tag already carries the slash (`<command-name>/model</command-name>`) and the chip
  // adds one, which is why every command in the panel has read `//model` since day one.
  return { name: name[1].trim().replace(/^\/+/, ''), args: (args?.[1] || '').trim() };
}

/**
 * What a slash command printed back — `Set model to Fable 5 for this session only`, `Bye!`.
 *
 * Its own `user` record, always alone: across 112 of them in this machine's transcripts not
 * one carries a `<command-name>` too, so it is never a tail on the command that caused it
 * and has to be recognised in its own right. Left alone it fell through to a plain user
 * bubble and the panel drew the literal tags as though you had typed them.
 *
 * Empty is the common case (`/clear` writes one every time) and renders as nothing at all —
 * an empty bubble that says a command happened is worse than the chip already above it.
 *
 * The text is **terminal output**, not prose: `/model` writes
 * `Set model to \x1b[1mFable 5\x1b[22m for this session only`, bold codes and all. They are
 * invisible in a terminal and raw bytes in a browser, so they come out here. This is the
 * only place in the panel that reads styled output from the transcript rather than from
 * `capture-pane`, which is why nothing was already stripping them.
 */
// Written as an explicit \u001b rather than a literal ESC byte: an invisible control
// character in source survives exactly until the next careless edit drops it, and the
// regex would then quietly start eating ordinary text shaped like `[1m` instead.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function parseCommandOutput(text) {
  const m = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(text);
  return m ? m[1].replace(ANSI_RE, '').trim() : null;
}

/**
 * A finished subagent, background command or monitor, handed back to the session as a
 * **synthetic user turn** — text nobody typed and the terminal never draws.
 *
 * Claude Code writes it as a `type: 'user'` record carrying an entire `<task-notification>`
 * envelope, and the report inside runs to pages: measured across this Mac's transcripts,
 * 472 of them, median 425 bytes, p90 8.5 KB, the largest 48 KB. `normalize.js` drops only
 * by `DROP_TYPES` and `isMeta`, so every one of them was drawn as a full user bubble — a
 * subagent's whole report, in the maintainer's voice, two screens tall, absent from the
 * terminal beside it.
 *
 * **Detection is on the record's own fields, never on the sentence inside**, the
 * `parseCommandOutput` lesson one function up: the wording of that envelope is Claude
 * Code's and will change, while a message *quoting* one has to stay the user's words.
 * Two witnesses, and both must hold — `origin.kind` (or `promptSource`, which is what a
 * record with no `origin` at all would still carry) says the harness wrote it, and the
 * anchored envelope says this is the shape we know. That conjunction is also what keeps
 * the scope narrow: whatever else `promptSource: 'system'` grows to carry falls straight
 * through to a bubble, unchanged, which is the right default for a shape nobody has read.
 *
 * What comes out is a summary line and, when there is one, a body:
 *
 * - `<summary>` is on all 472 and is self-describing — `Agent "…" finished`,
 *   `Background command "…" completed (exit code 0)`, `Monitor event: "…"` — so it is the
 *   whole of the chip's line and the chip's own label says only what kind of line it is.
 *   The task id stands in on the one record in 472 that carries no summary.
 * - The body is `<result>` (92) or `<event>` (94); the remaining ~290 are a status and a
 *   pointer to an output file and have nothing worth expanding, so their chip simply
 *   doesn't open. Both tags are matched **non-greedily**: a stray `</result>` inside a
 *   report truncates what we show rather than swallowing the envelope's own tail, which is
 *   this panel's usual trade of showing less over showing something wrong.
 */
const TASK_NOTICE_RE = /^<task-notification>[\s\S]*<\/task-notification>$/;
const NOTICE_TAGS = {
  taskId: /<task-id>([\s\S]*?)<\/task-id>/,
  summary: /<summary>([\s\S]*?)<\/summary>/,
  result: /<result>([\s\S]*?)<\/result>/,
  event: /<event>([\s\S]*?)<\/event>/,
};

function noticeTag(text, name) {
  const m = NOTICE_TAGS[name].exec(text);
  return m ? m[1].trim() : '';
}

function parseTaskNotice(rec, text) {
  const fromHarness = rec.origin?.kind === 'task-notification' || rec.promptSource === 'system';
  if (!fromHarness || !TASK_NOTICE_RE.test(text)) return null;
  return {
    summary: noticeTag(text, 'summary') || noticeTag(text, 'taskId'),
    text: noticeTag(text, 'result') || noticeTag(text, 'event'),
  };
}

function stringifyResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text || '';
        // An image block used to stringify to the literal `[image]`, which is where every
        // captured screenshot in this panel died. The bytes stay in the file and the
        // message names them in `images`; the timeline draws a strip under the chip. A
        // placeholder beside a rendered thumbnail would read as a broken one.
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Keep a huge refactor from shipping thousands of diff lines to the browser. */
const MAX_DIFF_LINES = 400;

/**
 * Pull the parts of `toolUseResult` worth rendering.
 *
 * Claude Code already computes the diff for an edit and hands it over as
 * `structuredPatch` — standard unified-diff hunks with `+`/`-`/` ` prefixed lines — so
 * the panel renders a real diff without implementing one.
 */
function resultDetail(tur) {
  if (!tur || typeof tur !== 'object') return {};
  const out = {};

  if (Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) {
    let added = 0;
    let removed = 0;
    const lines = [];
    let truncated = false;

    for (const hunk of tur.structuredPatch) {
      if (lines.length && !truncated) lines.push({ kind: 'gap', text: '⋯' });
      for (const raw of hunk.lines || []) {
        const kind = raw[0] === '+' ? 'add' : raw[0] === '-' ? 'del' : 'ctx';
        if (kind === 'add') added += 1;
        if (kind === 'del') removed += 1;
        if (lines.length < MAX_DIFF_LINES) lines.push({ kind, text: raw.slice(1) });
        else truncated = true;
      }
    }
    out.diff = { lines, added, removed, truncated, file: tur.filePath || null };
  }

  // A subagent keeps its own transcript, in this same format, at `outputFile`. That is
  // what turns "subagent · 12 steps" into something you can actually open.
  if (tur.agentId || tur.outputFile) {
    out.agent = {
      id: tur.agentId || null,
      description: tur.description || null,
      prompt: tur.prompt || null,
      model: tur.resolvedModel || null,
      status: tur.status || null,
      outputFile: tur.outputFile || null,
    };
  }

  // Bash. `stderr` alone isn't failure — plenty of tools narrate there — so the chip
  // only goes red when the result itself is flagged as an error.
  if (typeof tur.stdout === 'string' || typeof tur.stderr === 'string') {
    out.bash = {
      stdout: tur.stdout || '',
      stderr: tur.stderr || '',
      interrupted: tur.interrupted === true,
    };
  }

  return out;
}

/**
 * @param {object} rec  one parsed JSONL record
 * @returns {Array<object>} zero or more view messages
 */
export function normalizeRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const type = rec.type;

  if (type === 'custom-title') {
    return [{ kind: 'title', title: rec.customTitle, uuid: rec.uuid }];
  }

  if (DROP_TYPES.has(type)) return [];
  if (rec.isMeta) return [];

  const msg = rec.message;
  if (!msg || typeof msg !== 'object') return [];

  const base = {
    uuid: rec.uuid,
    ts: rec.timestamp,
    sidechain: rec.isSidechain === true,
  };

  if (type === 'user') {
    const content = msg.content;
    const found = imageBlocks(rec);

    // tool_result blocks close out a chip rather than opening a message.
    if (Array.isArray(content)) {
      const results = content
        .filter((b) => b && b.type === 'tool_result')
        .map((b) =>
          withImages(
            {
              ...base,
              kind: 'tool_result',
              toolUseId: b.tool_use_id,
              isError: b.is_error === true || rec.toolUseResult?.is_error === true,
              output: stringifyResult(b.content),
              ...resultDetail(rec.toolUseResult),
            },
            // Only the images inside *this* result. A record can carry several results
            // and the ordinals are record-wide, so the filter has to be by id and the
            // number has to survive it untouched.
            imageRefs(found.filter((f) => (f.toolUseId ?? null) === (b.tool_use_id ?? null)), rec),
          ),
        );
      if (results.length) return results;
    }

    // A pasted screenshot sits at the top of the record, beside the text. Claude Code
    // writes `[Image #1]` into that text and `imagePasteIds: [1]` onto the record, so
    // there is usually something to say — but not always, and a message that is *only*
    // an image used to vanish here on the empty-text check below.
    const pasted = imageRefs(found.filter((f) => f.toolUseId == null), rec);

    const text = textOf(content).trim();
    if (!text) return pasted.length ? [{ ...base, kind: 'user', text: '', images: pasted }] : [];

    const cmd = parseCommand(text);
    if (cmd) return [{ ...base, kind: 'command', name: cmd.name, args: cmd.args }];

    const out = parseCommandOutput(text);
    if (out !== null) return out ? [{ ...base, kind: 'command_output', text: out }] : [];

    // The panel's own tap on the lead's shoulder, queued by the nudge — an event line,
    // not something a human typed. Prefix-anchored with the space so a message merely
    // *mentioning* [room] stays the user's words (the parseCommandOutput lesson).
    if (text.startsWith(`${NUDGE_MARK} `)) return [{ ...base, kind: 'nudge', text }];

    // Another project's lead, delivered through a link — same family as the nudge above,
    // and typed by the panel rather than by anyone. Prefix-anchored with the space so a
    // message merely *mentioning* [link] stays the user's words (the parseCommandOutput
    // lesson, learned a third time here). The merge sentence carries no such prefix and
    // must keep drawing as a user bubble — it is the maintainer's own word.
    if (text.startsWith(`${LINK_MARK} `)) return [{ ...base, kind: 'link_message', text }];

    // Claude Code's own tap on the shoulder when a subagent, a background command or a
    // monitor finishes — same family as the nudge above, and the same reason it must not
    // wear a user bubble.
    const notice = parseTaskNotice(rec, text);
    if (notice) return [{ ...base, kind: 'task_notification', ...notice }];

    return [withImages({ ...base, kind: 'user', text }, pasted)];
  }

  if (type === 'assistant') {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const out = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text?.trim()) {
        out.push({ ...base, kind: 'assistant', text: b.text, model: msg.model });
      } else if (b.type === 'thinking' && (b.thinking || '').trim()) {
        out.push({ ...base, kind: 'thinking', text: b.thinking });
      } else if (b.type === 'tool_use') {
        out.push({
          ...base,
          kind: 'tool_use',
          toolUseId: b.id,
          name: b.name,
          summary: toolSummary(b.name, b.input),
          input: b.input,
        });
      }
    }
    return out;
  }

  return [];
}

/**
 * Fold tool_result messages into the tool_use chip they answer, so the timeline
 * shows one line per tool call instead of two.
 */
export function stitch(messages) {
  const byToolUse = new Map();
  const out = [];

  for (const m of messages) {
    if (m.kind === 'tool_use') {
      byToolUse.set(m.toolUseId, m);
      out.push(m);
    } else if (m.kind === 'tool_result') {
      const chip = byToolUse.get(m.toolUseId);
      if (chip) {
        chip.result = {
          isError: m.isError,
          output: m.output,
          ts: m.ts,
          diff: m.diff,
          bash: m.bash,
          agent: m.agent,
          // Named, not carried. The strip under the chip draws these; the bytes come
          // from `/api/sessions/:id/image/:uuid/:index`.
          images: m.images,
          // No per-tool duration is recorded, but the gap between the call and its
          // result is exactly that.
          durationMs: chip.ts && m.ts ? Math.max(0, Date.parse(m.ts) - Date.parse(chip.ts)) : null,
        };
      } else {
        out.push(m); // orphan — the opening call is older than our backfill window
      }
    } else {
      out.push(m);
    }
  }
  return out;
}
