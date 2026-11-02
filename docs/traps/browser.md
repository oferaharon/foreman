# Browser and notifications

The evidence behind the **Browser and notifications** block of
[`CLAUDE.md`](../../CLAUDE.md)'s Traps index — what a browser and a phone do with what the
panel hands them: the two manifests, the three icon geometries, the notification permission
and the secure context it needs, and the one control the page does not paint at all. Each
section below is one trap, opening with the bold sentence its index line quotes.

## Two manifests on one origin

**Two manifests on one origin with the same `id` are one app, and the second one installed
replaces the first.** `/manifest.webmanifest` and `/m/manifest.webmanifest` are two
installable apps — the panel and the phone view — and `id` is what a browser keys an
installed app on. Omitted, it **defaults to `start_url`**, which reads like it would settle
it and does not always: a browser matching on the resolved id would see two apps whose
scopes differ but whose identity was never stated. Both spell `id` out, `/` and `/m/`, and
`test/icons.test.js` pins that they differ along with the short names. Verified through
Chrome's own parser rather than by reading the spec — `Page.getAppManifest` over CDP returns
what Chrome made of each file plus its error list, and both came back with `errors: []`,
distinct ids, and every icon fetching 200.

**…and `apple-touch-icon` transparency is filled in by iOS with a colour you did not
choose.** The `any` icons are a rounded tile with transparent corners, which is what makes
them sit correctly in the Dock under Chrome's installed `.app`; the Apple touch icons are
the same mark **flattened opaque and unrounded**, because iOS applies its own mask and
composites whatever is behind the alpha itself. A maskable icon is the third shape again —
full-bleed square with the content pulled into the middle 80%, since the platform crops it
to something it does not announce in advance. Three purposes, three geometries, one
`GEOMETRY` constant; `scripts/make-icons.mjs` is the only description of any of it and
`npm run icons` moves all of them at once.

## `.webmanifest` and `sips`

**A `.webmanifest` already serves as `application/manifest+json`, and `sips` cannot read an
SVG.** Two things that would each have cost a detour. Express's `send` resolves the type
from `mime-db`, which knows the extension — measured on a scratch panel, both manifests came
back with the right type off plain `express.static`, so no server change and no restart. And
this Mac has `sips` and `qlmanage` and nothing else — no `rsvg-convert`, no ImageMagick, no
PIL, no cairosvg — while `sips` has no SVG decoder at all. Rasterizing four rounded
rectangles in `node:zlib` and about a hundred lines of arithmetic beat both the Quick Look
route (whose output is a *thumbnail*, sized to its own taste) and the headless-Chrome route
(which would make regenerating an icon depend on a browser).

## A stored preference is not a granted permission

**A stored preference is not a granted permission, and printing the first over the second
reads as a bug.** The notifications opt-in lives in `localStorage`; the permission belongs
to the browser and can go back to `default` on its own — a new profile, cleared site data, a
reset. The first version of `paintNotify` (`web/app.js`) read the stored flag for its status
line and `notifyArmed()` for the checkbox, so a browser in that state drew **"On, in this
browser"** over an empty box. Nothing fired, correctly; the box just said the opposite.
Caught by looking at a screenshot of the settings section, not by any assertion — which is
the general lesson: every state a two-source control can be in wants a rendering, and the
contradictory one is the state nobody writes a test for. There are three now (never asked,
armed, remembered-but-not-granted) and `bench-states` walked all three.

## `Notification` needs a secure context

**`Notification` needs a secure context, and Chrome will not even *grant* it otherwise.**
`http://127.0.0.1` is a secure context by specification and `http://<a LAN address>` is not,
so the notifications control works in the panel opened on this Mac and cannot work from the
phone — which follows from the 2026-08-27 exposure ruling rather than being a gap in it.
Measured both ways on a scratch panel bound wide: at the LAN address `isSecureContext` is
false, the checkbox disables itself and prints which gate is shut, and every session
blocking at once still fired nothing; the same browser at `127.0.0.1` turned it on
normally. `Browser.grantPermissions` over CDP **refuses** the LAN origin outright
(*"Permission can't be granted in current context"*), which is the same fact from the other
side. This is not an argument for putting TLS in front of the panel; it is why the phone's
half of that issue was an icon.

## The needs-you notification

**The needs-you notification is derived from the roster, and must not be derived from
`needsYou`.** Every transition it fires on — a permission prompt, a question, a plan, the
trust gate, a worker's task reaching `review` — is already a field on the roster row and
already in `sessions.js`'s `#diff`, so no socket event and no endpoint were needed and
nothing needs restarting to pick it up. What is tempting and wrong is the field with the
matching name: `needsYou` also counts *"it replied and you haven't looked"*, which is an
unread badge in the rail and would put a notification on somebody's screen every time any
session finished a turn. `needsKind` in `web/notify.js` is the narrower rule, it asks about
the trust gate **first** (that screen is a fully-parsed permission box, so the general
question answers it wrongly and sends the reader to a card with deliberately no button on
it), and it applies the rail's own `quietWorker` so a worker's prompt stays its lead's
until the stuck timer fires. The module is pure for the usual reason: `test/notify.test.js`
runs it in node, the way `trust-gate.js` is tested.

## A stock checkbox is painted by the browser

**A stock checkbox is drawn by the browser from the *browser's* colour scheme, not the page's
`data-theme` — so an unticked box read as ticked.** Found on the create-room modal's bench:
with the panel in **light** theme and the browser in **dark**, an unticked native checkbox
came back a solid dark square, which in a multi-select list is exactly what "chosen" looks
like. Nothing about the page was wrong and no test would have caught it; the UA paints that
control and `data-theme` is not a signal it reads. The room picker's boxes are now drawn by
the panel — `appearance: none`, a box and a rotated-rectangle check, every colour a token —
which is `.team-toggle-row`'s own precedent. **The same exposure is still live on
`.field-check`**, the bare native checkbox in the `+ new` and settings modals; it was flagged
rather than fixed because it was out of that task's scope, and it is the next person's to
take.

## An assigned hash reloads the page on a real iPhone

**On a real iPhone every `location.hash = …` in the phone view was a whole document load,
and the Simulator never showed it — MEASURED on iOS 27 on a cabled phone, in Safari and in
the installed Home Screen app, through the Web Inspector (`ios_webkit_debug_proxy`) and the
device's own WebKit log (`idevicesyslog`).** The phone reaches the panel over plain http, and
WebKit runs such a page in a `WebContent.EnhancedSecurity` process. An assigned hash is a
*navigation*. WebCore performs it in place — `FrameLoader::loadInSameDocument`, `hashchange`,
the screen mounts — and while that happens the UI process's own asynchronous policy check on
the same navigation logs `WebPageProxy::decidePolicyForNavigationAction, swapping process …
reason=Process swap due to EnhancedSecurity change` and loads the document again in a new
process (the inspector sees it as a provisional target committing over the old one) about
30 ms later. That is the "refresh" on every tap, and it leaves a history entry with no state
on it, so the back rules built on `history.state` never saw their own entries.

The back gesture then compounds it. Its target entry now belongs to an *earlier document*,
so WebCore takes `loadDifferentDocumentItem`, which is a navigation, which swaps again — and
the swapped-in load continues the navigation the UI process already had, which was the tap
*into* the session. So the swipe back drew the same session again, and only `‹` got out.

**The fix is not to navigate.** `history.pushState` is not a navigation and the policy check
never sees it, and a step back between two entries of one document is
`loadInSameDocument` with no policy check either — both measured on the same phone after the
change, in a Safari tab and in the installed Home Screen app: one document for the whole run
(the app's was still the same document three minutes later), push, pop, push, pop, the swipe
back and `‹` both ending on the list the session was opened from. So every route change in `web/m/` goes through `pushRoute` in `web/m/history.js`,
which pushes a stamped entry and then dispatches the `hashchange` the shell routes on, as a
task, the way an assigned hash delivered it; `test/m-history.test.js` refuses a
`location.hash =` anywhere in the phone's modules. Tabs were already `replaceState`, which is
not a navigation either.

Two things about this that are easy to get wrong next time. **The Simulator is not
evidence here**: its installed app, on loopback and on an insecure hostname, measured one
document and zero reloads, so any check of phone navigation is done on a real device. And a
**keep-alive timer** once made the reload stop on the phone (a 100 ms `setInterval` writing
`sessionStorage`); why was never measured, and it is not the fix — the cause is the policy
check, and a page that makes no navigation gives it nothing to answer.
