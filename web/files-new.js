/*
 * Did this message just put something new in the files modal?
 *
 * The `files` button's dot is the unread badge's model applied to outputs: per browser, per
 * pane, in memory, cleared by looking. Nothing on the server knows about it and nothing is
 * persisted — this is a fact about one reader's attention, not about the session.
 *
 * It is derived from the **message frames the pane already receives** rather than from a
 * second scan, which is the whole reason the feature is affordable: `appendMessages` is
 * handed every live record anyway, so one predicate over it costs a walk of a handful of
 * fields. The modal still makes its own whole-file pass when it opens (`openFiles`) — the
 * scan is the authority on *what* is in there, this is only the hint that something is.
 *
 * DOM-free on purpose, the way `web/files-kinds.js`, `web/trust-gate.js` and
 * `web/quota.js` are, so `test/files-new.test.js` can run it in plain Node against the
 * normalized shapes `server/normalize.js` really emits.
 *
 * --- Two things it knowingly gets slightly wrong, and which way they lean ---
 *
 * **A boolean, never a count.** The dot is the whole of what is drawn, so the flag is
 * exactly what is drawn and nothing more. A number would be a *claim* — and the two
 * numbers available here cannot be made to agree with the modal: the predicate sees only
 * live frames (a pane opened mid-session has a history of outputs it must not count, which
 * is what makes the first load zero), while the modal counts the whole transcript. A badge
 * reading `3` over a modal with one new row is the "showing something wrong" this repo
 * keeps choosing against, and a count nobody renders is the dead `tip` field one trap over.
 *
 * **A `Write` that overwrote an existing file still lights it.** The modal lists a create
 * and not an update (`toolUseResult.type === 'create'`, `server/outputs.js`), and that
 * field is not carried onto the normalized message — only the record has it. Measured
 * across the transcripts on this Mac: of 349 `Write`s to a human-facing extension, **34
 * were updates** — so roughly one dot in ten can be a document the reader has already seen
 * in the list, rewritten. Accepted, because the asymmetry runs the opposite way to the
 * permission-prompt `classify` one: a dot that did not need to be there costs one click,
 * and an item that never lit the dot is one the reader never learns about. (The witness
 * does exist if precision is ever wanted: a create's `structuredPatch` is empty — 795 of
 * 795 — so a stitched result carrying no `diff` is a create, 61 of 61 updates carry one.
 * It would mean counting on the *result* rather than the call, which is a two-message
 * protocol for a boolean.)
 */

import { isHumanFacingPath } from './output-exts.js';

/** `[title](url)`, and a bare `http(s)` URL — `server/outputs.js`'s two, non-global. */
const MD_LINK_RE = /\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)/;
const BARE_URL_RE = /https?:\/\/[^\s<>"'`\])]+/;

/**
 * An issue or a PR URL in a tool result — `gh`'s own output, and a forge MCP server's.
 *
 * Anchored on the scheme as well as the shape, because the path fragment alone matches a
 * local route (`/pulls/3/files` in this very repo's prose). `server/outputs.js` mines the
 * same thing out of a result and calls it `created`, which is the strongest provenance a
 * link row can wear — the one link in the set most worth a reader's attention, so the dot
 * would be poorer for skipping it.
 *
 * One place it is wider than the server: the server refuses a **WebSearch** result whole
 * (median 20 URLs, p90 86) and would therefore not count a search hit that happened to be
 * an issue. That refusal turns on the `toolUseResult`'s own shape, which the normalized
 * message does not carry — so a search that surfaced an issue lights the dot here and
 * contributes no row there. It is the same lean as the `Write`-update case above: one
 * unnecessary click, never a missed item.
 */
const ISSUE_PR_URL_RE = /https?:\/\/\S*\/(?:issues|pull|pulls|merge_requests)\/\d+/;

/**
 * Does this normalized message put something in the files modal's set?
 *
 * Mirrors `server/outputs.js`'s five witnesses, each reduced to what survives
 * normalisation:
 *
 *   - a `Write` to a human-facing extension — the list lives in `web/output-exts.js`
 *     precisely so this cannot drift from the server's filter;
 *   - a `SendUserFile`, which is never extension-filtered, on either side;
 *   - any message carrying `images` (a tool's screenshot, or one the maintainer pasted —
 *     the scan lists both, so counting one and not the other would make the dot a subset);
 *   - a `WebFetch`, the `fetched` link;
 *   - a markdown link or a bare URL in **assistant** prose, the `cited` link. Assistant
 *     only, exactly as the scan has it: a URL the maintainer typed is not something the
 *     session exposed, and a `user` record carrying one must not light the button.
 *   - an issue/PR URL in a tool result, the `created` link (see above).
 */
export function isNewOutput(msg) {
  if (!msg || typeof msg !== 'object') return false;

  // Before the kind tests, because images ride on two of them (`tool_result` and `user`)
  // and the message's own array is the same one the strip draws from.
  if (Array.isArray(msg.images) && msg.images.length) return true;

  if (msg.kind === 'tool_use') {
    const input = msg.input && typeof msg.input === 'object' ? msg.input : {};
    if (msg.name === 'Write') return isHumanFacingPath(input.file_path);
    if (msg.name === 'SendUserFile') return true;
    if (msg.name === 'WebFetch') return typeof input.url === 'string' && !!input.url;
    return false;
  }

  if (msg.kind === 'assistant') {
    const text = typeof msg.text === 'string' ? msg.text : '';
    return MD_LINK_RE.test(text) || BARE_URL_RE.test(text);
  }

  if (msg.kind === 'tool_result') {
    const out = typeof msg.output === 'string' ? msg.output : '';
    // The `includes` first: a Bash result can be tens of kilobytes and most hold no URL at
    // all, and a substring scan is the cheap way to find that out.
    return out.includes('http') && ISSUE_PR_URL_RE.test(out);
  }

  return false;
}

/** Did any of a batch bring something? One pass, stopping at the first. */
export function anyNewOutput(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) if (isNewOutput(m)) return true;
  return false;
}
