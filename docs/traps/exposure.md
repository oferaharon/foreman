# Exposure

The evidence behind the **Exposure** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps index
— who can reach this panel and who may widen that: the bind host, the settings writes that
decide it, the origin guard the socket needed, and the two servers that can hold one port at
once. Each section below is one trap, opening with the bold sentence its index line quotes.

## Exposure is the one thing a LAN peer may not change

**Exposure is the one thing a LAN peer may not change, and the check is the socket, not
the header.** `PATCH /api/config` — the settings modal — writes `bindHost` and
`allowedOrigins`, and both decide who can reach this panel at all. The no-auth stance says
a LAN peer gets everything else; it does not say a LAN peer may *widen its own reach*,
so those two keys are gated on `req.socket.remoteAddress` being loopback (`isLoopbackRemote`
in `settings-file.js`, 127/8, `::1` and the IPv4-mapped `::ffff:127.0.0.1` a dual-stack
listener hands you for a plain `curl 127.0.0.1`). **A loopback `Origin` would prove
nothing** — `origin.js` allows a request with *no* `Origin` at all, by construction, so
curl, the hook and `mcp/foreman.js` need no allowlist, which means a LAN peer holding curl
sails through it. And **never an `X-Forwarded-For` rung**: a header is written by the
caller, the peer address by the kernel, and the whole value of the guard is that it cannot
be spelled. It fails closed — no address is not loopback. The modal disables its own
controls off `canEditExposure` from the GET, and the PATCH re-decides it server-side, so
re-enabling them in devtools still gets the 403; measured both ways on a scratch panel
bound wide. This is not authentication and must not grow into it.

**…and `sessionPrefix` is in that file but is not writable from it.** It resolves once at
boot and is the *only* prefix the panel recognises, so a value written here takes effect at
the next restart — at which point every session minted under the old one keeps running,
stays in the rail, and stops being *named*: `slugFor` yields nothing so `⧉` auto-numbers,
`isLeadName` stops matching the lead, and a snapshot cannot restore a row under its own
name. `validateConfigPatch` refuses it by name with that reason (`PREFIX_REFUSAL`), ahead
of the generic unknown-key refusal, because a person who tries it deserves the *why* rather
than "not a key". The modal shows it read-only with the same sentence on hover.

## A settings write merges; a boot read does not

**A settings write merges; a boot read does not.** `readConfigFile` answers `{}` for a file
it could not parse — right for a boot (settings that are not there, fall back to loopback,
loudly) and catastrophic for a write, because merging into `{}` and writing back replaces a
file with a typo in it, recoverable in any editor, with a two-key file that has thrown the
rest away. `writeConfigFile` therefore **refuses** an unparseable file with a 409, and
otherwise merges so a key this version has never heard of survives. Temp file **in the same
directory** then `rename`, because rename is only atomic within one filesystem and a temp
dir on another volume degrades silently to copy-then-delete — and the reader that must
never see half a file is a boot deciding what to bind.

## The panel can be bound wider than loopback

**The panel can be bound wider than loopback, and it has no authentication — a stated
non-goal, not a gap.** `bindHost` decides who can reach it: `127.0.0.1` by default, and a
wider bind is something an operator records deliberately. What a wide bind grants, spelled
out because it is easy to under-read: anything that can reach the port can launch sessions,
type arbitrary text into any session on the machine, `/exit` them, dispatch workers, answer
permission prompts, and read every transcript over `/ws` — which is not read-only in spirit,
it carries `markRead`. The team endpoints live on the same port, so the merge path is
reachable too. And `0.0.0.0` is **every** interface the machine has, not one network: a
machine that later joins another network is on that one as well.

None of that is an oversight. Authentication was argued for this panel, the cost of leaving
it out was named, and the project's stance is that it stays out — so **do not quietly add an
auth requirement, or a boot guard that refuses a wide bind.** The origin check below is the
only thing here that resembles one, and it is a *browser* guard: it must not grow into
authentication. The stance can be revisited, but deliberately, not by a guard slipped in
under a bug fix.

The bind used to live only in the shell that started the process, so a plain `npm start` put
it back on loopback silently. It now rides in the LaunchAgent's own job environment
(`npm run install-agent`), so it survives a crash, a reboot, and the routine restart
(`npm run restart-panel`). `npm start` by hand still binds loopback only — correct and
expected, because the panel that matters isn't the one `npm start` starts.

## The installer must not hardcode the bind

**The installer must not hardcode the bind, and the panel records the one it is actually
using.** `jobEnvironment()` used to put a literal `FOREMAN_HOST: '0.0.0.0'` into *every*
plist it generated, unconditionally — so anybody running the installer got a LAN-exposed
panel without being asked. The code default has always been loopback (`config.js`), which
made the installer the whole of the exposure. The host is now **resolved** — `$FOREMAN_HOST`
→ `<STATE_DIR>/config.json`'s `bindHost` → `127.0.0.1` — and the plist carries the key only
when it is not loopback, the same omit-when-default rule `FOREMAN_PORT` and
`FOREMAN_STATE_DIR` already followed. A wide bind survives an upgrade by having been
*recorded* rather than by being everyone's default: the panel **seeds `config.json` at its
first boot** with the host it is actually using, so an install whose plist already carries a
wide host writes that fact down without anybody doing anything. That seeding is the belt to
a brace: renaming the environment variable killed the key any older plist spells, and only a
*reinstall* writes the replacement — so a restart at the wrong moment produces a panel that
comes up perfectly, on loopback, with nothing in any log and a phone that has simply stopped
answering. If the seeding is ever removed, doing the rename and the reinstall in one sitting
is the only thing left guarding that. `server/settings-file.js` is the module and its header
is the long version.

## Two node servers can bind the same port at once

**Two node servers can bind the same port at once, silently, and split traffic by
interface — VERIFIED.** `SO_REUSEADDR` plus macOS letting a specific bind sit beside a
wildcard one means a process on `0.0.0.0:48770` and one on `127.0.0.1:48770` both succeed,
in either order, with no error from either `listen()` call. They then answer differently
depending on which interface the request arrived on — `curl 127.0.0.1:48770` reaches one,
`curl <lan-address>:48770` reaches the other — and only `lsof -iTCP:48770` shows two
`LISTEN` rows; nothing on either process's own output says so. Worse than "two panels":
the hook posts to `127.0.0.1` (`install-hook.js`) and `mcp/foreman.js` calls
`http://127.0.0.1:${PORT}`, so all hook traffic and every lead tool call reach whichever
panel is bound to loopback while a phone on the LAN reaches the other — which is
meanwhile polling tmux, flushing the same `queue.json`, and running its own worktree GC
against real tasks. This is why the boot guard (`index.js`, before `server.listen`) is an
HTTP probe of `127.0.0.1:<port>`, never a bind attempt — a bind attempt is precisely the
check that does not detect this. Anything answering there means refuse and
`process.exit(0)`; refused, timed out, or threw all mean go ahead. The exit code is a
contract with the plist's `KeepAlive: {SuccessfulExit: false}` (`install-agent.js`) — 0
means "I deliberately declined to start", not a crash, so launchd stands down instead of
looping.

## A WebSocket handshake is exempt from CORS

**A WebSocket handshake is exempt from CORS, so `/ws` was the whole hole — and the guard
that closes it is a *browser* guard, not authentication.** `new WebSocketServer({server,
path:'/ws'})` had no `verifyClient`, and a handshake triggers no preflight: any `http://`
page a browser visited could open `ws://<host>:48770/ws`, be handed the full roster the
moment it connected, `subscribe` to any transcript and send `markRead`. The roster's `id`
is the session UUID `/hook` accepts as `text/plain` (also no preflight), so the same page
could then write false status for any session — `/hook` alone was nearly harmless because
the ids are UUIDs and the socket is what hands them out. `server/origin.js` is one pure
decision with three call sites: an `app.use` gating every non-GET, `verifyClient`, and
`/hook` (a POST, so the gate covers it — confirmed against the running route, not assumed).

Four things about it that a later reader will want to undo, each for a reason:

- **It restricts nobody on the local network.** The no-auth stance above holds: no header,
  no check — curl, the hook's curl and `mcp/foreman.js` are allowed *by construction*, not
  by a list. A device on the local network is allowed by clause 3, derived at run time, so a
  DHCP lease that moves fixes itself. This is not a boot guard and must never grow into auth.
- **`GET` is deliberately not gated.** A cross-origin page can send one but cannot read the
  response, because no `Access-Control-Allow-Origin` is ever sent. The socket is the
  exception and that is why it has its own call site.
- **The address filter is a filter, not "everything non-internal".** RFC-1918 and
  `fc00::/7` in; `fe80::/10` out, because on macOS most non-internal addresses are
  link-local and some of those interfaces are peer-to-peer ones a browser has no business
  reaching across; and `utun*` out, because that is where VPN and overlay-network
  interfaces land, and allowing every tunnel ships a panel reachable from every VPN the
  machine ever joins with nobody having decided that. A tunnel that should be reachable is
  a *named* addition to the list, never a side effect of a loose filter.
- **`Origin: null` is refused and an absent header is allowed** — they are not the same
  case. `null` is a sandboxed iframe or a `data:` URL, which is attacker-reachable.

The boot prints the origins it resolved, one line each with the interface and the reason,
because this clause was first written from a *description* of `os.networkInterfaces()`
rather than its output, and a derived list nobody looks at is how that comes back.
