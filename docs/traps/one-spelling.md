# One spelling

The evidence behind the **one spelling** line of [`CLAUDE.md`](../../CLAUDE.md)'s Traps
index. This file is the exception in this directory: it holds no story of its own. Every
one of the eight below was learned somewhere else and is written up in its own subsystem
file, where the reader who is editing that code will find it. What is here is the thing
they have in common, said once — because it is the most-repeated lesson in `CLAUDE.md` and
no single file owns it, which is how it came to be paid for eight times under eight
different names.

## The lesson

**Two spellings of one contract agree the day they are written and diverge silently
afterwards.** Nothing fails at the moment they part: each spelling is still valid where it
is written, each reader still answers, and the disagreement surfaces somewhere else
entirely and much later — a session claimed under a name the panel can no longer say back,
a restart that restarts nothing, the second image served for the first. That silence is
the whole cost. It is also why every instance below is held together by a *mechanism*
rather than by a comment: a comment is a third spelling.

Three resolutions, in the order to reach for them:

1. **One spelling, imported.** The only one that cannot drift. Where the obvious import is
   a cycle, write the leaf module rather than accept the second spelling —
   `server/room-header.js` is that decision, taken with the alternative named.
2. **A test, where an import is genuinely impossible** — across a language boundary, out of
   a browser module into a server one, or into CSS. It is strictly weaker than an import
   and is chosen only when there is no import to make.
3. **A refusal.** A *sibling* name — one letter apart, doing a different thing — is refused
   outright rather than held together, because nothing can hold it together.

## The instances

Each links to the file that proves it. Read the one guarding the code you are about to
edit; read them all only if you are about to add a second reader of something.

- **The naming contract.** `server/launch.js` (`sessionName`, `slugFor`, `isLeadName`,
  `uniqueSessionName`), and `sessionPrefix`'s five readers across `launch.js`,
  `sessions.js` and `tmux.js` — all from one export, "because two spellings of a naming
  contract is the `isLeadName` lesson in another costume", and **one prefix, never two**.
  What a mismatch costs was measured rather than guessed.
  [launch#the-name-a-launch-mints-is-a-contract](launch.md#the-name-a-launch-mints-is-a-contract)
  · [launch#what-a-non-matching-prefix-costs](launch.md#what-a-non-matching-prefix-costs)

- **The launchd label — three copies in three languages.** `server/logs.js`
  (`DEFAULT_AGENT_LABEL`), `package.json`'s `restart-panel`/`stop-panel`, and
  `scripts/backup-state.sh`. Two of the three cannot import anything, so `test/logs.test.js`
  is "the only mechanism available"; the failure is `npm run restart-panel` kickstarting a
  job that does not exist, with no error and no output.
  [platform-launchd#the-launchd-label-has-three-copies](platform-launchd.md#the-launchd-label-has-three-copies)

- **One ordinal space, two readers.** `server/normalize.js` (`imageBlocks`) with
  `server/outputs.js` (`outputBlocks`). "Two walks that could disagree about what 'the
  second image' means" hands back the wrong picture; the widened walk hands back the wrong
  file.
  [files-and-images#image-ordinals](files-and-images.md#image-ordinals)
  · [files-and-images#the-ordinal-rules-second-reader](files-and-images.md#the-ordinal-rules-second-reader)

- **Member resolution, once on each side of the wire.** `server/rooms-line.js`
  (`resolveMember`) with `web/rooms-pane.js` (`memberRow`), which "cannot import the real
  one (that pulls in `server/observe.js`), so `test/rooms-pane.test.js` drives both against
  one set of fixtures and asserts they agree — held together by a test rather than by a
  comment." Drift here is a post typed into a stranger.
  [rooms#a-room-member-is-resolved-tmuxsession-first](rooms.md#a-room-member-is-resolved-tmuxsession-first)

- **The refusal: a sibling name.** `mcp/foreman.js` (`room_*` vs `group_*`),
  `server/rooms.js` (`GroupRoomStore`) and the socket frames. `rooms_post` beside
  `room_post` is "one letter between two things that do different things, which is a wrong
  call waiting to happen"; what is refused is a *sibling* name, not the word "room".
  [mcp-and-naming#group-rooms-and-the-sibling-name](mcp-and-naming.md#group-rooms-and-the-sibling-name)

- **One `localStorage` key, two views.** `web/prefs.js` is imported by the desktop and by
  both phone files "because `/` and `/m/` are one origin and two spellings of one
  `localStorage` key is a setting that appears to work."
  [pane-parsers#ghost-text](pane-parsers.md#ghost-text)

- **A constant CSS cannot import.** `web/group-hue.js` (`GROUP_COLOUR_COUNT`) against
  `web/tokens.css`'s `--group-N` tokens: spelled once in JavaScript and pinned by
  `test/group-hue.test.js` against the actual count of tokens, "because CSS cannot import a
  constant and the two would otherwise drift silently."
  [rail-and-groups#the-spines-ring-of-ten-hues](rail-and-groups.md#the-spines-ring-of-ten-hues)

- **The one resolved by an import, with the test named as the alternative.**
  `server/room-header.js` holds the writer and the reader of a room delivery's header
  together and "is the reason the two spellings cannot drift; a test holding them apart was
  the alternative and is strictly weaker when an import is available." It is a leaf module
  precisely because the obvious import was a cycle.
  [transcript#a-room-delivery-leaves-the-same-record-a-typed-message-leaves](transcript.md#a-room-delivery-leaves-the-same-record-a-typed-message-leaves)
