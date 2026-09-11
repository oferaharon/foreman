/*
 * web/anchor-target.js — every anchor `marked` mints gets `target="_blank"` and
 * `rel="noopener noreferrer"` before its HTML ever reaches `innerHTML`.
 *
 * `marked` (`gfm: true`, the option every caller in this repo sets) autolinks a bare URL
 * and a bare `www.` host — measured against the vendored copy — with no `target` and no
 * `rel`, and nothing downstream cleans the anchor up. So a URL sitting in a transcript is,
 * today, a link that navigates the *panel itself* away, dropping every subscription in
 * both panes — precisely the failure `forgeLink`'s own comment already warns about ("the
 * panel is a thing you leave running, and navigating it away would drop every subscription
 * in both panes"). On the phone it walks the reader out of the installed PWA.
 *
 * This runs on the HTML **string** `marked.parse` returns, before it is ever assigned to
 * `innerHTML` — not on a live DOM node. That is what keeps it testable in plain node the
 * way `web/forge-mark.js` is: no DOM, no jsdom, one string in and one string out — and it
 * is why every `marked.parse(...)` call site in this repo routes through the one function
 * below instead of growing its own anchor cleanup.
 *
 * It only ever touches an `<a>` tag that carries `href` and declares no `target` of its
 * own, so the panel's hand-built anchors (`forgeLink`, the PR chips), which already set
 * `target='_blank'` themselves, are left exactly as they are if this ever runs over text
 * that happens to contain one — and a tag with no `href` at all (`marked` never emits one,
 * but a caller should not have to know that) is untouched too.
 */

const ANCHOR_OPEN_RE = /<a\b[^>]*>/gi;
const HREF_RE = /\shref\s*=/i;
const TARGET_RE = /\starget\s*=/i;

/**
 * Add `target="_blank" rel="noopener noreferrer"` to every plain `<a href>` in an HTML
 * string. Idempotent — an anchor that already declares `target` is left alone — and a
 * no-op on anything falsy, so a caller need not guard an empty parse itself.
 */
export function withBlankTargets(html) {
  if (!html) return html;
  return html.replace(ANCHOR_OPEN_RE, (tag) => {
    if (!HREF_RE.test(tag) || TARGET_RE.test(tag)) return tag;
    const close = tag.endsWith('/>') ? '/>' : '>';
    const body = tag.slice(0, tag.length - close.length);
    return `${body} target="_blank" rel="noopener noreferrer"${close}`;
  });
}
