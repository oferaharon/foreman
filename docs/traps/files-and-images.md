# Files and images

The evidence behind the **Files and images** block of [`CLAUDE.md`](../../CLAUDE.md)'s
Traps index — what a session produced for a human to read: the ordinal that addresses one,
the readers that must agree about it, what may be cached, and the gallery that reads the
whole file. Each section below is one trap, opening with the bold sentence its index line
quotes.

## Image ordinals

**An image in a transcript is addressed by an ordinal, and exactly one function may
compute it.** A screenshot arrives as ~60KB of base64 — 9 of them were 19% of one 2.9MB
file — so a normalized message names `{uuid, index, media}` and the bytes come over HTTP
(`/api/sessions/:id/image/:uuid/:index`), never over the socket. `index` is the image's
position in a depth-first walk of the record, and `imageBlocks` in `normalize.js` is that
walk for *both* ends: the message that names an image and the endpoint that reads it back.
Two walks that could disagree about what "the second image" means is the `isLeadName`
lesson in a different costume. Note the ordinal is assigned **before** anything is
filtered, so a block the panel declines to serve (a `url` source, an unexpected media
type) still consumes its number — renumber the survivors and the endpoint quietly hands
back the wrong picture, only in records that had a refused block. Measured across 429
transcripts on this Mac: 1027 image blocks, every one `source.type === 'base64'`, only
`image/jpeg` (704) and `image/png` (323), and **not one on a sidechain record** — so the
decision to keep sidechain images (flagged, not filtered) is about the shape of the data
rather than anything on disk.

## The ordinal rule's second reader

**The ordinal rule now has a second reader.** `outputBlocks` (`server/outputs.js`) is
`imageBlocks` widened: an image keeps the exact ordinal `imageBlocks` gave it, and a
`Write`-created document or a `SendUserFile` attachment is then numbered starting from the
pre-filter image count — one index space per record, and still assigned **before** `accept()`
filters anything, for `imageBlocks`'s own reason. `readOutput` and `revealablePath` are the
two ends that walk it back to find bytes or a path; a third reader that disagreed about what
index 1 means would hand back the wrong file rather than the wrong picture.

## The caching split

**`Cache-Control: immutable` is right for a transcript record and wrong for a disk file.**
`GET /api/sessions/:id/output/:uuid/:index` splits its caching on where the bytes came from:
an `image` or a `write` entry's bytes are a transcript record, written once, so `immutable`
is genuinely true. A `sendfile` attachment is bytes on disk that can be overwritten between
two opens, so it gets `no-store` plus an `ETag` off `mtime`+`size` instead — the same header
on both would pin the first version of a screenshot in the browser forever.

## A Write of an existing path

**A `Write` of an existing path is `update`, not `create`.** `outputBlocks` keys on
`toolUseResult.type === 'create'`, never on "does `filePath` exist" — 65 of 851 `Write`s on
the measured Mac were overwrites, and keying on the weaker test puts them in a view whose
whole promise is "what did this session make," and quietly admits `Edit`'s calls the day
somebody reuses the condition. `parseCommandOutput`, `parseTaskNotice` and `peerOrigin` all
learned the same lesson about a result's own field beating its sentence.

## The files view's two containers

**`.files-grid`/`.files-list` carry a `display` that beats `[hidden]`.** Both containers are
always painted and only the `hidden` attribute decides which is on screen — a view toggle is
a one-line repaint, never a second fetch — but each also carries an unconditional `display`
rule, and an author rule always beats the `[hidden]` UA default regardless of specificity.
Without `.files-grid[hidden], .files-list[hidden] { display: none; }` the losing container
stayed on screen under the winning one. PR #138's bug; scoped to these two rather than a
blanket `[hidden]` override, which would have to be proven safe against every other `hidden`
toggle in the stylesheet.

## When the files view refreshes

**The refresh must key on the `toolUseResult` record landing, not the tool call going out.**
The files dot's own signal (`anyNewOutput`) answers on the tool *call* — right for a boolean
— while `scanOutputs` needs the `toolUseResult` record, which is not in the transcript until
the result lands. Refreshing on the `Write` frame ran the scan a beat early: it came back
without the file, and the path in that sentence stayed plain until the pane was reopened.
PR #142's fix re-asks at the one place a chip's own resolved-but-unlinked path can change its
answer — where the matching `tool_result` patches the chip in place — which is also why it
cannot loop: a refresh that finds nothing leaves the chip unlinked and nothing re-triggers
until the next result.

## The PAT substring in a worktree path

**`test/session-launch.test.js` greps the serialised MCP config for `PAT` and trips on any
worktree whose path contains "path."** The test asserts `session-mcp.json` never mentions a
credential-shaped word, checked against the whole serialised file — which also contains the
absolute path to `mcp/foreman.js`, worktree directory included. `PAT` is a substring of
`PATH`, so a worktree named along the lines of `agent/paths-and-files` fails a test about
credentials for a reason that has nothing to do with one. Known, not fixed here — the fix is
anchoring the assertion to the `env` block rather than the whole serialisation.

## The gallery reads the whole file

**The gallery has to read the whole file, and nothing else here does.** The tailer
backfills a byte window, `loadEarlier` walks another one back, `probe` deliberately samples
head and tail and never the middle. Every one of those is right, and every one of them
would make a gallery that is a subset while looking complete — the specimen session proves
it, 9 images and *none* of them in the window the panel opened on. `scanImages` streams the
file and parses only lines containing `image`: 1,115 lines and 45 parses for a 2.9MB
transcript at **~10ms**, 3,014 lines and 158 parses for the largest one on this Mac at 26MB
at **~55ms**. Cheap enough to redo on every open, so nothing is cached and nothing goes
stale. `readImage` streams the same way, guarded on the uuid — and the record's own `uuid`
field is what decides, because every reply names its parent in `parentUuid` and a
take-the-first-match would return the wrong image for any record that has children, which
is all of them.

## Thumbnails

**A thumbnail with `width: auto` is zero pixels wide until its bytes land.** Measured: a
`0 x 86px` box. Every image in a strip pops into existence as it arrives, shoving the ones
after it sideways, so `.img-thumb img` carries a `min-width` floor. And a related bench
artifact that will cost you an hour: `loading="lazy"` defers until Chrome actually
*renders* the page, which an automated window does not do until something forces a frame —
so thumbnails plainly on screen read back `complete: false`, and a screenshot fixes them.
Same family as the `requestAnimationFrame` / `ResizeObserver` trap the room panel hit;
`document.visibilityState` is still the first thing to check. The strip loads eagerly
anyway (one turn, one to three images, nothing to defer); the gallery keeps `lazy` because
it can hold ninety.
