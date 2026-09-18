import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * `CLAUDE.md`'s Traps section is an index: one line per trap, carrying that trap's own
 * bold conclusion verbatim and a plain markdown link to the file under `docs/traps/` that
 * holds the evidence. Nothing in `server/`, `web/` or `mcp/` reads either file — they are
 * read by whoever opens a session here — so a broken link, a missing anchor or a trap file
 * nobody points at fails *silently*, in the one place this repo cannot afford it. Same
 * shape as `test/logs.test.js`: a test that reads non-JavaScript files and holds them
 * against each other, because nothing else can.
 *
 * Three assertions here, and a fourth kind that is deliberately absent:
 *
 *   (a) link integrity, BOTH directions — every index link resolves to a file and to a
 *       heading that really exists in it, and every `docs/traps/*.md` on disk is pointed
 *       at by at least one index line. The second direction is what stops a trap being
 *       written where nobody reads it.
 *   (b) no `@path` imports in `CLAUDE.md` — see the assertion message; this one is worth
 *       more than it looks.
 *   (c) the format assertion — every non-blank line inside `## Traps` is a sub-heading, a
 *       block's one intro paragraph, or an index entry in the format. That fails EXACTLY
 *       when somebody pastes a measurement back inline, which is the thing being
 *       prevented. Deliberately NOT a byte cap on the file: a cap turns an honest
 *       paragraph into a red test at the worst possible moment and the only available fix
 *       is to raise the number, after which it means nothing. It also asks the wrong
 *       question — the file was never bad because it was large, it was bad because the
 *       evidence was inline. So the shape is what is asserted.
 *
 * And a `t.diagnostic()` with the byte counts, which asserts nothing: visible every run,
 * no false failures, and the one number the split is judged on.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');
const TRAPS_DIR = path.join(ROOT, 'docs', 'traps');

/*
 * `README.md` is the directory's own front page — what the directory is, and that
 * `CLAUDE.md` indexes it. It is not a trap file and must not be indexed as one: an index
 * line pointing at it would be a line that teaches nobody anything.
 */
const NOT_A_TRAP_FILE = new Set(['README.md']);

const claude = fs.readFileSync(CLAUDE_MD, 'utf8');

/** GitHub's heading anchor: lowercase, drop everything but letters, digits, spaces and hyphens, spaces to hyphens. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 \-]/g, '')
    .trim()
    .replace(/ /g, '-');
}

/** Every `](docs/traps/…)` link in CLAUDE.md, with its file and optional anchor. */
function indexLinks(text) {
  const out = [];
  const re = /\]\(docs\/traps\/([A-Za-z0-9._-]+\.md)(?:#([A-Za-z0-9-]+))?\)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ file: m[1], anchor: m[2] || null });
  return out;
}

/** Every `## …` / `### …` heading in a trap file, as its anchor. */
function anchorsOf(file) {
  const text = fs.readFileSync(path.join(TRAPS_DIR, file), 'utf8');
  return new Set(
    text
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => slug(line.replace(/^#{1,6} /, '').trim())),
  );
}

const trapFilesOnDisk = () =>
  fs
    .readdirSync(TRAPS_DIR)
    .filter((f) => f.endsWith('.md') && !NOT_A_TRAP_FILE.has(f))
    .sort();

// --------------------------------------------------------- (a) links, both directions ---

test('the traps directory exists and holds at least one trap file', () => {
  assert.ok(fs.existsSync(TRAPS_DIR), `${TRAPS_DIR} is missing — CLAUDE.md's Traps index points into it`);
  assert.ok(trapFilesOnDisk().length > 0, 'docs/traps/ holds no trap file, so the index points at nothing');
});

test('every index link in CLAUDE.md resolves to a file that exists', () => {
  const links = indexLinks(claude);
  assert.ok(links.length > 0, 'CLAUDE.md carries no docs/traps/ link at all — the index is not wired up');
  for (const { file } of links) {
    assert.ok(
      fs.existsSync(path.join(TRAPS_DIR, file)),
      `CLAUDE.md links to docs/traps/${file}, which does not exist. A trap whose evidence ` +
        'cannot be opened is worse than the paragraph it replaced.',
    );
  }
});

test('every anchor an index link names is a real heading in that file', () => {
  const anchors = new Map();
  for (const { file, anchor } of indexLinks(claude)) {
    if (!anchor) continue;
    if (!anchors.has(file)) anchors.set(file, anchorsOf(file));
    assert.ok(
      anchors.get(file).has(anchor),
      `CLAUDE.md links to docs/traps/${file}#${anchor}, which is not a heading in that file. ` +
        `Headings there: ${[...anchors.get(file)].join(', ')}`,
    );
  }
});

test('every trap file on disk is pointed at by at least one index line', () => {
  const linked = new Set(indexLinks(claude).map((l) => l.file));
  for (const file of trapFilesOnDisk()) {
    assert.ok(
      linked.has(file),
      `docs/traps/${file} is on disk and nothing in CLAUDE.md points at it. A trap written ` +
        'where nobody reads it is a trap nobody pays for twice — they pay for it again.',
    );
  }
});

// ---------------------------------------------------- (b) no `@path` imports, measured ---

/*
 * The one finding that would silently cost the whole split. Measured 2026-09-17 on Claude
 * Code v2.1.257, in a scratch directory with `claude -p` and a unique token in the
 * imported file: `CLAUDE.md` containing `@docs/traps/ghost.md` answered with the token and
 * made NO tool call — the import is inlined into the system prompt at load time. The same
 * file written as an ordinary markdown link answered "NONE". So `@` is not lazy, and a
 * split that reaches for it produces a perfectly split repository with ZERO saving and
 * nothing on screen saying so.
 *
 * Claude Code's own `/init` prompt recommends it for exactly this situation — "use
 * `@path/to/import` syntax ... to inline content on demand without bloating CLAUDE.md" —
 * so the suggestion will keep arriving. This test is the backstop.
 */
test('CLAUDE.md contains no `@path` import — they are inlined eagerly, not on demand', () => {
  const offenders = claude
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^@\S/.test(line));

  assert.deepEqual(
    offenders,
    [],
    'CLAUDE.md carries an `@path` import. MEASURED 2026-09-17 on Claude Code v2.1.257: an ' +
      '`@` import is inlined into the system prompt at load time, not read on demand — the ' +
      'imported token came back with no tool call, while the same file as a plain markdown ' +
      'link came back unknown. So `@docs/traps/x.md` costs exactly as much as pasting the ' +
      'file inline, looks correct on disk, and says nothing. Use a plain markdown link. ' +
      `Offending line(s): ${offenders.map(([n, l]) => `${n}: ${l}`).join(' | ')}`,
  );
});

// ------------------------------------------------- (c) the shape of the Traps section ---

/*
 * The re-growth guard, and the reason it is a shape and not a number.
 *
 * `CLAUDE.md` was 200,569 B because every trap carried its evidence inline: a bold
 * conclusion followed by the measurement that proved it, read in full by every session
 * opened in this folder whether it was about to touch that code or not. The split moved
 * the evidence to `docs/traps/` and left the conclusions behind as one-line entries. What
 * would undo it is not growth — it is somebody pasting a measurement back into the index,
 * which reads as an improvement while it happens and is invisible afterwards.
 *
 * So the assertion is structural. Inside `## Traps`, blocks separated by blank lines, each
 * block is exactly one of:
 *
 *   - a `###` sub-heading, on a line of its own;
 *   - that heading's ONE intro paragraph — it must come directly after the heading and
 *     carry the block's `Evidence:` link, which is what stops a second paragraph (a pasted
 *     measurement is a paragraph) passing as an intro;
 *   - a list of index entries, each opening with a backticked surface or a bolded platform
 *     name, carrying a bold conclusion and a `docs/traps/` link, and ENDING on its link
 *     line — prose appended to an entry fails there;
 *   - the single `---` that closes the section.
 *
 * Proven able to fail rather than asserted to be: a real trap paragraph was pasted back
 * into the section, this test went red naming its line numbers, and the paragraph was
 * removed. A test that cannot fail is worse than no test.
 */

const HEADING = /^#{3,6} /;
const RULE = /^-{3,}$/;
const ENTRY_OPENS = /^- (?:`|\*\*)/;
const TRAP_LINK = /\]\(docs\/traps\/[A-Za-z0-9._-]+\.md(?:#[A-Za-z0-9-]+)?\)/;
const BOLD = /\*\*[^*]/;
/** An entry's last line: its link, alone, optionally introduced by the `·` a cross-link uses. */
const ENDS_ON_LINK =
  /^\s*(?:·\s*)?\[[^\]]+\]\(docs\/traps\/[A-Za-z0-9._-]+\.md(?:#[A-Za-z0-9-]+)?\)$/;

/** The lines of `## Traps`, each with its 1-indexed line number in CLAUDE.md. */
function trapsSectionLines(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## Traps/.test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).map((line, i) => ({ line, n: start + 2 + i }));
}

/** Consecutive non-blank runs, in order. */
function blocksOf(numbered) {
  const blocks = [];
  let cur = [];
  for (const row of numbered) {
    if (row.line.trim() === '') {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else cur.push(row);
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

/** Split one list block into its entries: a `- ` line plus the `  `-indented lines under it. */
function entriesOf(block) {
  const entries = [];
  for (const row of block) {
    if (/^- /.test(row.line)) entries.push([row]);
    else if (entries.length) entries[entries.length - 1].push(row);
    else entries.push([row]);
  }
  return entries;
}

test('every line inside `## Traps` is a heading, a block intro, or an index entry', () => {
  const numbered = trapsSectionLines(claude);
  assert.ok(numbered, 'CLAUDE.md has no `## Traps` section — the index is gone, not merely malformed');

  const problems = [];
  const blocks = blocksOf(numbered);
  let previousWasHeading = false;

  for (const block of blocks) {
    const first = block[0];
    const text = block.map((r) => r.line).join(' ');

    if (HEADING.test(first.line)) {
      if (block.length > 1) {
        problems.push(`${block[1].n}: a sub-heading's block carries more than the heading line`);
      }
      previousWasHeading = true;
      continue;
    }

    if (RULE.test(first.line) && block.length === 1) {
      previousWasHeading = false;
      continue;
    }

    if (/^- /.test(first.line)) {
      for (const entry of entriesOf(block)) {
        const head = entry[0];
        const body = entry.map((r) => r.line).join(' ');
        if (!ENTRY_OPENS.test(head.line)) {
          problems.push(
            `${head.n}: an index entry must open with a backticked surface or a bolded platform name`,
          );
        }
        if (!BOLD.test(body)) {
          problems.push(`${head.n}: an index entry must carry its trap's bold conclusion`);
        }
        if (!TRAP_LINK.test(body)) {
          problems.push(`${head.n}: an index entry must link into docs/traps/`);
        }
        if (!ENDS_ON_LINK.test(entry[entry.length - 1].line)) {
          problems.push(
            `${entry[entry.length - 1].n}: an index entry must end on its docs/traps/ link — ` +
              'anything after it is evidence, and evidence lives in the trap file',
          );
        }
      }
      previousWasHeading = false;
      continue;
    }

    // Anything left is a paragraph. Exactly one is legal per block: the intro under its
    // heading, carrying that block's Evidence link.
    if (previousWasHeading && TRAP_LINK.test(text)) {
      previousWasHeading = false;
      continue;
    }

    problems.push(
      `${first.n}: a paragraph that is not a block's intro — "${first.line.trim().slice(0, 60)}…"`,
    );
    previousWasHeading = false;
  }

  assert.deepEqual(
    problems,
    [],
    'The Traps section of CLAUDE.md is an INDEX, not the evidence. Every trap keeps its ' +
      'conclusion here as a one-line entry and its measurement in a file under docs/traps/, ' +
      'because the whole file is read by every session opened in this folder before it ' +
      'knows what it is about to touch — that is what took it to 200,569 B. If you have a ' +
      'new trap: one entry here (surface first and greppable, then the conclusion in bold ' +
      'lifted verbatim from the trap, then the link), and the proof in the trap file. If ' +
      'you have new evidence for an existing trap, it belongs in that trap file. See ' +
      `CONTRIBUTING.md. Offending line(s):\n  ${problems.join('\n  ')}`,
  );
});

// ------------------------------------------------------- the diagnostic, asserting none ---

test('the sizes, for the record', (t) => {
  const claudeBytes = fs.statSync(CLAUDE_MD).size;
  const files = trapFilesOnDisk().map((f) => [f, fs.statSync(path.join(TRAPS_DIR, f)).size]);
  const evidence = files.reduce((n, [, b]) => n + b, 0);
  const entries = blocksOf(trapsSectionLines(claude) || [])
    .filter((b) => /^- /.test(b[0].line))
    .reduce((n, b) => n + entriesOf(b).length, 0);

  t.diagnostic(`CLAUDE.md: ${claudeBytes.toLocaleString()} B (was 200,569 B before the split)`);
  t.diagnostic(
    `Traps index: ${entries} entries → ${files.length} files, ${evidence.toLocaleString()} B of evidence`,
  );
  for (const [f, b] of files) t.diagnostic(`  docs/traps/${f}: ${b.toLocaleString()} B`);
});
