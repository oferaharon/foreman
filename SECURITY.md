# Security

This document states the threat model plainly, in the reader's own interest. Read
it before you bind the panel to anything wider than loopback.

## The trust model

Foreman is single-user, single-host software. It is designed to run on your own
machine, for you alone, and its trust boundary is **loopback by default** — the
panel listens on `127.0.0.1` and answers only requests from the machine it runs
on. Anything reachable at that address is, by design, as trusted as a shell on
your own keyboard.

**"No authentication" is a stated non-goal, not an omission.** The panel does not
ask who is asking. It never will unless a future release changes the trust
boundary itself, and if it does, that will be called out here first.

## What the panel can do

Whoever can reach the panel can:

- Type arbitrary text into any Claude Code session running on the machine.
- Close (`/exit`) any of those sessions.
- Launch new sessions, in any folder the panel can see.
- Answer permission prompts on your behalf.
- Read every transcript the panel can see, including anything pasted or
  generated inside those conversations.

None of this requires a password, a token, or a browser tab you opened
yourself. It requires only that a request reach the panel's port.

## Binding wider than loopback

The panel binds `127.0.0.1` unless you say otherwise, under launchd as well as
by hand: you widen it by setting `bindHost` in `<FOREMAN_STATE_DIR>/config.json`
(or `$FOREMAN_HOST`) and restarting, and the boot line then says which host it used.

If you choose to bind the panel to `0.0.0.0` — to reach it from a phone or
another device on your network — you are handing everything in the list above
to **every peer that can reach that interface**, not just the devices you had
in mind. `0.0.0.0` is every network interface the machine has, not "just home
wifi": if the machine ever joins a different network, guest wifi, a coffee-shop
hotspot, a conference network, the panel is reachable there too, for as long as
it stays bound wide.

Treat a wide bind the way you would treat leaving a terminal logged in and
unlocked on that network. If you need remote access without that exposure, put
something in front of the panel that actually authenticates — a reverse proxy
with its own auth, a VPN, or a tool like Tailscale — rather than relying on the
panel itself.

## The Origin check is not authentication

The panel validates the `Origin` header on state-changing requests and on the
WebSocket upgrade. This exists to stop an ordinary web page in your browser
from silently driving the panel while you have it open in another tab (a
cross-site request). It is a **browser-only guard**.

It does nothing for a peer that isn't a browser. A LAN peer running `curl`, a
script, or any other non-browser client can set whatever `Origin` header it
likes, or none at all, and the check does not slow it down. If you have bound
the panel wide, every device on that network has exactly the access described
above, Origin header or not.

## What is refused by design

A few things the panel will not do, regardless of who is asking, because they
were built to fail closed rather than to be configured safely:

- **The folder-trust gate is never answered on your behalf.** Claude Code's own
  "do you trust this folder?" prompt is recognized and deliberately left alone —
  the panel will show it to you, but it will not click through it, from any
  client, at any permission level.
- **Dispatched workers never launch with permission checks bypassed.** That mode
  is not reachable from the dispatch path at all.
- **Destructive git operations are denied in every worker's launch settings** —
  force pushes, branch deletion, worktree removal, and similar. A worktree
  isolates files, not the repository's history; a force-push from inside one
  still reaches the real repository, which is exactly what this denial list
  exists to stop.
- **Nothing merges a pull request, and nothing closes a session, on its own.**
  Both are actions a human takes, explicitly, every time.

## Where a secret can leak

The panel's state directory is created with your account's default umask, which
on most systems means files land world-readable to any other local account. Two
places this matters if the machine is shared with anyone else, or if any process
on it runs code you didn't write:

- **Worker logs, pane snapshots, and Claude Code transcripts** can contain
  anything that passed through a conversation — pasted credentials, API
  responses, file contents. Treat the whole state directory as at least as
  sensitive as your shell history.
- **Each team's `mcp.json` is a verbatim copy of the MCP server entries you
  registered with Claude Code, including whatever lives in that entry's `env`
  block** — written world-readable. If an MCP server entry you use carries a
  credential directly in its configuration (some do, some don't — anything that
  authenticates by handing you a URL with no embedded secret is unaffected),
  that credential is copied into this file and readable by any other local
  account. Check what your own MCP entries carry before relying on this.

## `gh` and your real accounts

If you have the GitHub CLI (`gh`) authenticated on this machine, every worker
the panel dispatches inherits that login. A worker can open pull requests — and
do anything else your `gh` token's scopes allow — under your real account. The
git-level denials described above stop a worker from force-pushing or deleting
a branch; they say nothing about `gh`, which is a separate credential with its
own separate reach. If you don't want dispatched workers acting as you on a
given forge, don't authenticate `gh` (or an equivalent CLI) on the machine the
panel runs on.

## Reporting a vulnerability

Report privately, using GitHub's built-in reporting: on
[github.com/oferaharon/foreman](https://github.com/oferaharon/foreman), go to
the **Security** tab and click **Report a vulnerability**. That opens a
private advisory that only the maintainer can see — don't open a public issue
with the details. If the private form is ever unavailable, a public issue
that says only "I have something to report privately, please advise" is fine;
the vulnerability itself still shouldn't go in it.

This is a one-maintainer hobby project with no SLA. The maintainer reads
reports and replies there, but there's no promised response time.

Before reporting, check that what you found isn't already the documented
trust boundary above: the panel being reachable on your LAN with no
authentication is a deliberate design decision, not a vulnerability, unless
you've found a way past the guards described there.
