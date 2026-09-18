# MCP and naming

The evidence behind the **MCP and naming** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps
index — the tool names a session is handed and the environment the MCP child is handed with
them: why group rooms are spelled `group_*`, what a stdio child inherits, and what
`--strict-mcp-config` would cost an ordinary session. Each section below is one trap,
opening with the bold sentence its index line quotes.

## Group rooms and the sibling name

**`room_post` and `room_read` were already taken, and so were `room-append` and
`markRoomRead` — so group rooms are `group_*` in every spelling they have.**
`mcp/foreman.js` registers `room_post` / `room_read` for the **team** room (and `room_post`
on `WORKER_TOOLS` as well), and one MCP server cannot register two tools under one name; the
socket already spells `subscribe-room` / `room` / `room-append`, keyed by `repo`, and
`web/app.js` switches on the frame's `type` and *then* filters on `msg.repo` — so a
group-room frame arriving under `room-append` with a `roomId` and no `repo` is silently
swallowed today, and breaks the **team** room the day somebody adds a group handler under
that name. Renaming the team-room tools was never an option: every lead and worker brief
names them and `test/brief.test.js` pins them.

So: tools `group_list` / `group_post` / `group_read`, frames `group-room` /
`group-room-append`, messages `subscribe-group-room` / `unsubscribe-group-room` /
`markGroupRoomRead`, store class `GroupRoomStore` beside `room.js`'s `RoomStore`, and the
pane kind `group-room` because `room` is the team room's word. **What is refused is a
*sibling* name, not the word "room"** — `rooms_post` beside `room_post`, or `RoomsStore`
beside `RoomStore`, is one letter between two things that do different things, which is a
wrong call waiting to happen and is the `isLeadName` lesson in yet another costume. The HTTP
routes are allowed to be `/api/rooms` precisely because no team-room route is spelled that
way. And note the split it deliberately refuses: giving standalones `room_*` and leads
`group_*` would mean a lead and a standalone in one room reading their own briefs and
disagreeing about what the tool is called.

## An MCP stdio child inherits the pane id

**An MCP stdio child inherits `TMUX_PANE`, which is why one static config serves every
session — and why `--strict-mcp-config` must never be copied onto it.** Both measured on
Claude Code v2.1.257, in a scratch tmux session in the sandbox's `alpha`, against a stub
stdio MCP server that dumped its own environment.

The stub's environment carried `TMUX_PANE=%213` and
`TMUX=/private/tmp/tmux-501/default,65729,213`, and `%213` was exactly the pane tmux
reported for that session; it also carried `CLAUDE_CODE_SESSION_ID` and
`CLAUDE_PROJECT_DIR`. So the identity is readable at **run time** and nothing about who a
session is has to be baked in at launch: `server/session-launch.js` writes **one**
`session-brief.md` and **one** `session-mcp.json` under `STATE_DIR` for the whole machine —
no per-session artefact, nothing to garbage-collect, nothing that goes stale across a
`/clear` (the pane does not change), and a live MCP process can never name a *stale* pane
because it cannot outlive its own. Benched through the real launcher: `group_list` from a
freshly launched session answered `{"you":"%0","rooms":[]}`, and the duplicate of it
answered `{"you":"%1","rooms":[]}` — one file, two identities. `mcp/foreman.js` fails closed
when `TMUX_PANE` is absent, twice over: a `session` with no pane refuses to start at all
(those three tools are its whole surface) and a lead refuses per call and keeps its other
fifteen tools.

The second half is the expensive one. **`--mcp-config` merges; `--strict-mcp-config` makes
it a replacement.** `launchLead` passes the strict flag and is right to — a lead should hold
`foreman` and its forge and nothing else — but copying that line into the standalone path
would silently strip every connector the user has registered off **every ordinary session
the panel launches**, with nothing on screen saying so. Measured twice and both answers were
**11 servers** with the merge: the planner's stub run and the launch bench. The two
enumerations of that 11 differ by one connector — the bench listed the user's `gitea`, seven
`claude.ai` connectors, `claude-in-chrome`, `computer-use` and `foreman`, the earlier run
listed eight connectors — so the **count** is the measurement and the breakdown is not.
`standaloneArgs()` is the one helper, it passes `--append-system-prompt-file` and
`--mcp-config` and never `--strict-mcp-config`, and there are **four** call sites, not three:
`/api/launch`'s non-lead branch, the duplicate endpoint, and `restoreSessions`' `startSession`
in *both* snapshot restore and relaunch-all. `test/session-launch.test.js` reads
`server/index.js`, balances parens round every `createSession(` and refuses one that carries
neither the helper nor a named exemption — proven non-vacuous by deleting the flags from one
site and watching it name the line.
