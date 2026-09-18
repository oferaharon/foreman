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
 * Two assertions here, and a third that is deliberately absent:
 *
 *   (a) link integrity, BOTH directions — every index link resolves to a file and to a
 *       heading that really exists in it, and every `docs/traps/*.md` on disk is pointed
 *       at by at least one index line. The second direction is what stops a trap being
 *       written where nobody reads it.
 *   (b) no `@path` imports in `CLAUDE.md` — see the assertion message; this one is worth
 *       more than it looks.
 *   (c) NOT YET: the format assertion that every non-blank line inside `## Traps` is a
 *       sub-heading or an index entry. It cannot pass until the last subsystem has moved
 *       out, and it is the last item of the split, not this one.
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
