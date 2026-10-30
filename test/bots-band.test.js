import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  activeText,
  BOT_KEY_PREFIX,
  botActivityAt,
  botAgeText,
  botEntries,
  botFacts,
  botLineParts,
  botLineText,
  botsBandShape,
  botsHead,
  botsSig,
  botTitle,
  convLineParts,
  convState,
  diskText,
  dotState,
  dotText,
  modelText,
  nextBotTick,
  paintBotsHead,
  patchBotsBand,
  patchConversations,
  relightBotsBand,
  relightConversations,
  seenText,
} from '../web/bots-band.js';
import { ctxEl, ctxFor, ctxText, ctxTone, tokensText } from '../web/ctx.js';
import { ageText } from '../web/group-summary.js';

/*
 * The bots band and the bot pane (plan `remote-agents-plan`, item 6).
 *
 * Two halves, for `test/rooms-band.test.js`'s reason: `web/bots-band.js` and `web/ctx.js` are
 * real modules driven for real here — the order, the two lines, the dot, the in-place patch
 * under a stub DOM — and what lives in `web/app.js` cannot be imported, so its contracts are
 * held against the source.
 *
 * What is pinned, and why each would otherwise fail **silently**:
 *
 *  - **Never a row in `sessions`, and nothing about attention.** A bot rides the roster frame
 *    beside the sessions; the band reads `'bots' in msg`, draws no unread count, hoists
 *    nothing and notifies nothing — and a helper gone quiet is grey, never red.
 *  - **Two lines and one record.** Line 2 is the newest reply's model · effort · ctx, never a
 *    sum or a max of two conversations' contexts, plus `N active` only when N > 1; the age is
 *    on line 1, right-aligned, where the rooms band puts a room's (ruling of 2026-10-13).
 *  - **A bot opens where a session does** — the main pane, the rail's selected marker, split
 *    and reload as for a session — and a room never replaces one (ruling of 2026-10-13).
 *  - **A row already in place is never moved** — the rooms band's scroll-jump lesson.
 *  - **A bot's `user` record is a prompt, never the maintainer's bubble; its markdown goes
 *    through the escaping renderer; its images and subagents come off the bot routes.**
 *    The plan's traps 6, 7 and 8, each of which a reader would only notice once it bit.
 *  - **Nothing about bots joins `composerSig`.**
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const html = text('web/index.html');
const styles = text('web/styles.css');
const band = text('web/bots-band.js');

/** The source with its prose taken out — `rooms-band.test.js`'s `strip`, for its reason:
 *  a negative assertion run over the raw file fails on the sentences recording the rule. */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const code = strip(app);

const fn = (name, src = app) => {
  const m = src.match(new RegExp(`\\n(?:  )?(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n(?:  )?\\}`));
  assert.ok(m, `\`${name}\` must exist`);
  return m[0];
};

/** A **module-level** function, whole: from its declaration to the first closing brace in
 *  column 0. `fn` stops at the first two-space `}`, which inside a top-level function is the
 *  end of its first block rather than of the function. */
const top = (name, src = app) => {
  const at = src.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `\`${name}\` must exist`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
};

/* ------------------------------------------------------------- fixtures --- */

const NOW = Date.parse('2026-10-12T12:00:00Z');
const MIN = 60_000;

const bot = (id, over = {}) => ({
  id,
  name: id,
  helper: { online: true, lastSeen: NOW - 10_000 },
  conversations: 2,
  active: 0,
  lastTs: null,
  lastActiveAt: null,
  current: null,
  ...over,
});

const current = (over = {}) => ({
  cid: '11111111-2222-4333-8444-555555555555',
  at: new Date(NOW - 5 * MIN).toISOString(),
  model: 'claude-sonnet-5-5',
  modelName: 'Sonnet 5.5',
  effort: 'medium',
  ctx: { tokens: 41_000, window: 1_000_000, pct: 4 },
  ...over,
});

const conv = (cid, over = {}) => ({
  cid,
  root: 'main',
  project: '-workspace',
  title: `conversation ${cid.slice(0, 8)}`,
  firstTs: new Date(NOW - 30 * MIN).toISOString(),
  lastTs: new Date(NOW - 20 * MIN).toISOString(),
  lastAppendAt: NOW - 20 * MIN,
  size: 1000,
  prompts: 1,
  model: 'claude-haiku-5-5',
  modelName: 'Haiku 5.5',
  effort: 'medium',
  ctx: { tokens: 27_000, window: 1_000_000, pct: 3 },
  finished: true,
  entrypoint: 'sdk-cli',
  version: '2.1.296',
  activeAt: NOW - 20 * MIN,
  active: false,
  ...over,
});

const CID = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;

/* ------------------------------------------------------------ the stub --- */

/**
 * Just enough DOM for the patches, recording what they do — `test/rooms-band.test.js`'s
 * stub, plus `replaceChildren`, which the meta line is rebuilt with. Anything the module
 * grows that this does not model throws rather than passing quietly.
 */
function withDom(run) {
  const real = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      const node = {
        tagName: tag.toUpperCase(),
        type: '',
        className: '',
        textContent: '',
        title: '',
        hidden: false,
        dataset: {},
        attrs: {},
        children: [],
        parent: null,
        onclick: null,
        setAttribute: (k, v) => (node.attrs[k] = v),
        removeAttribute: (k) => delete node.attrs[k],
        append(...kids) {
          for (const kid of kids) {
            if (kid.parent) kid.parent.children.splice(kid.parent.children.indexOf(kid), 1);
            kid.parent = node;
            node.children.push(kid);
          }
        },
        replaceChildren(...kids) {
          for (const kid of node.children) kid.parent = null;
          node.children = [];
          node.append(...kids);
        },
        remove() {
          if (!node.parent) return;
          node.parent.children.splice(node.parent.children.indexOf(node), 1);
          node.parent = null;
        },
      };
      return node;
    },
  };
  try {
    return run();
  } finally {
    globalThis.document = real;
  }
}

/** A container counting every insertion — a move is what a row in place must never make. */
const container = () => ({
  children: [],
  moves: 0,
  insertBefore(kid, ref) {
    this.moves += 1;
    if (kid.parent) kid.parent.children.splice(kid.parent.children.indexOf(kid), 1);
    kid.parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (ref && at < 0) throw new Error('insertBefore: the reference node is not a child');
    if (at < 0) this.children.push(kid);
    else this.children.splice(at, 0, kid);
  },
});

const part = (row, cls) => row.children.find((c) => c.className.split(' ').includes(cls));
const metaText = (row) => part(row, 'bot-meta').children.map((c) => c.textContent);

/* ------------------------------------------------------------ the order --- */

test('bots are drawn newest activity first, and one that has shipped nothing sits last by id', () => {
  const bots = [
    bot('zeta', { lastActiveAt: NOW - 60 * MIN }),
    bot('quiet'),
    bot('alpha', { lastActiveAt: NOW - 1 * MIN }),
    bot('also-quiet'),
    bot('mid', { lastTs: new Date(NOW - 30 * MIN).toISOString() }),
  ];
  assert.deepEqual(
    botEntries(bots).map((e) => e.bot.id),
    ['alpha', 'mid', 'zeta', 'also-quiet', 'quiet'],
  );
  assert.equal(botEntries(bots)[0].key, `${BOT_KEY_PREFIX}alpha`);
});

test('the activity clock is the server’s own `lastActiveAt`, then the last record, then the reply', () => {
  assert.equal(botActivityAt(bot('a', { lastActiveAt: 5, lastTs: '2026-10-12T00:00:00Z' })), 5);
  assert.equal(botActivityAt(bot('a', { lastTs: '2026-10-12T00:00:00Z' })), Date.parse('2026-10-12T00:00:00Z'));
  assert.equal(botActivityAt(bot('a', { current: current() })), NOW - 5 * MIN);
  assert.equal(botActivityAt(bot('a')), null);
});

test('a malformed frame draws an empty band rather than throwing', () => {
  assert.deepEqual(botEntries(undefined), []);
  assert.deepEqual(botEntries('bots'), []);
  assert.deepEqual(botEntries([null, {}, { id: '' }, { id: 7 }]), []);
});

/* -------------------------------------------------------------- the dot --- */

test('the dot is grey when the helper has gone quiet — never red — and that wins over active', () => {
  assert.equal(dotState(bot('a', { helper: { online: false, lastSeen: NOW - 3 * 3600_000 } })), 'offline');
  assert.equal(dotState(bot('a', { helper: { online: false, lastSeen: null }, active: 2 })), 'offline');
  assert.equal(dotState(bot('a', { active: 1 })), 'active');
  assert.equal(dotState(bot('a')), 'online');
  assert.equal(dotState(null), 'offline');

  // Said in words too, so nothing is carried by colour alone.
  assert.equal(dotText(bot('a', { helper: { online: false, lastSeen: NOW - 3 * 3600_000 } }), NOW), 'helper offline — last seen 3h ago');
  assert.equal(dotText(bot('a', { helper: { online: false, lastSeen: null } }), NOW), 'helper offline — never seen');
  assert.equal(dotText(bot('a', { active: 2 }), NOW), 'helper online — 2 conversations active');

  // The stylesheet: grey on the offline dot, the session dot's tokens for the others, and
  // no `--decision` anywhere on a bot dot — red is "needs you" and a bot never does.
  const dots = styles.slice(styles.indexOf('.bot-dot {'), styles.indexOf('.bot-name {'));
  assert.match(dots, /\.bot-dot\.is-offline \{ background: var\(--ink-faint\); \}/);
  assert.match(dots, /\.bot-dot\.is-active \{ background: var\(--working\); animation: pulse/);
  assert.match(dots, /\.bot-dot\.is-online \{ background: var\(--idle\); \}/);
  assert.doesNotMatch(dots, /--decision/);
});

test('`seenText` is the rail’s one age ladder, said as a phrase', () => {
  assert.equal(seenText(NOW - 10_000, NOW), 'just now');
  assert.equal(seenText(NOW - 5 * MIN, NOW), `${ageText(NOW - 5 * MIN, NOW)} ago`);
  assert.equal(seenText(null, NOW), '');
  // One formatter: the module asks `ageText` and spells no bucket of its own.
  assert.match(band, /import \{ ageText \} from '\.\/group-summary\.js';/);
  assert.doesNotMatch(strip(band), /86400|3600\b/);
});

/* ------------------------------------------------------------- line two --- */

test('line two is the newest reply’s model · effort · ctx, then `N active` — and no age', () => {
  const b = bot('alpha', { current: current(), lastActiveAt: NOW - 2 * MIN, active: 2 });
  assert.deepEqual(
    botLineParts(b).map((p) => p.kind),
    ['model', 'effort', 'ctx', 'active'],
  );
  assert.equal(botLineText(b), 'Sonnet 5.5 · medium · 4% · 2 active');
});

test('the age sits right-aligned on line one — the rooms band’s place and register, one formatter', () => {
  // The words: the rail's one ladder, and nothing at all for a bot that has shipped nothing.
  const b = bot('alpha', { current: current(), lastActiveAt: NOW - 2 * MIN });
  assert.equal(botAgeText(b, NOW), ageText(NOW - 2 * MIN, NOW));
  assert.equal(botAgeText(b, NOW), '2m');
  assert.equal(botAgeText(bot('quiet'), NOW), '');
  // One formatter: `botAgeText` asks `ageText`, and nothing in the module spells another.
  assert.match(fn('botAgeText', band), /return at \? ageText\(at, now\) : '';/);
  assert.doesNotMatch(strip(band), /relativeTime|toFixed|Math\.floor/);

  // The place: a third grid column on line one, the meta line spanning under it — so the row
  // stays two lines — and the rooms band's own type for an age.
  const row = styles.match(/\.bot-row \{[\s\S]*?\n\}/)[0];
  assert.match(row, /grid-template-columns: 0\.85rem 1fr auto;/);
  const age = styles.match(/\.bot-age \{[\s\S]*?\n\}/)[0];
  assert.match(age, /grid-column: 3;/);
  assert.match(age, /grid-row: 1;/);
  const roomAge = styles.match(/\.room-age \{[\s\S]*?\n\}/)[0];
  for (const decl of ['font-size: 0.6rem;', 'color: var(--ink-faint);']) {
    assert.ok(roomAge.includes(decl) && age.includes(decl), `the rooms band’s ${decl}`);
  }
  assert.match(styles, /\.bot-age:empty \{ display: none; \}/);
  assert.match(styles, /\.bot-meta \{\n  grid-column: 2 \/ -1;/);
});

test('`N active` appears only when more than one conversation is', () => {
  assert.equal(activeText(0), '');
  assert.equal(activeText(1), '', 'one active conversation is what the pulsing dot already says');
  assert.equal(activeText(2), '2 active');
  assert.ok(!botLineText(bot('a', { current: current(), active: 1 })).includes('active'));
});

test('contexts are never summed or maxed — the row reads the one `current` record', () => {
  // `current` is the server's single newest qualifying reply; the row has no other source.
  const b = bot('a', { current: current({ ctx: { tokens: 50_000, window: 1_000_000, pct: 5 } }), active: 3 });
  assert.equal(botLineParts(b).find((p) => p.kind === 'ctx').text, '5%');
  assert.doesNotMatch(strip(band), /Math\.max\([^)]*ctx|reduce\([^)]*ctx|\+= [a-z.]*ctx/i);
});

test('the model is the resolved name, else the raw id as written — never a formatter on null', () => {
  // The server sends the raw id as the name for a model nothing names (`modelLabel`'s fallback).
  assert.equal(modelText({ model: 'claude-future-9', modelName: 'claude-future-9' }), 'claude-future-9');
  assert.equal(modelText({ model: 'claude-fable-5-1', modelName: null }), 'claude-fable-5-1');
  assert.equal(modelText({ model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5' }), 'Sonnet 5.5');
  assert.equal(modelText({ model: null, modelName: null }), '');
  assert.equal(modelText(null), '');
  // A bot that has shipped nothing yet draws an empty line, not a line of separators.
  assert.equal(botLineText(bot('a')), '');
  // Nothing in the module reaches for a model formatter.
  assert.doesNotMatch(band, /shortModel|\.replace\(\/\\s\*\\\(/);
});

test('a reply with no effort (Haiku 4.5) and a model with no known window still draw honestly', () => {
  const b = bot('a', {
    current: current({ model: 'claude-mystery', modelName: 'claude-mystery', effort: null, ctx: { tokens: 41_200, window: null, pct: null } }),
  });
  assert.deepEqual(
    botLineParts(b).map((p) => p.text),
    ['claude-mystery', '41k'],
  );
  assert.equal(botAgeText(b, NOW), '5m', 'the age is still drawn, on line one');
});

test('the hover spells the row out, and says it is read-only', () => {
  const t = botTitle(bot('alpha-bot', { name: 'Alpha nightly', current: current(), conversations: 3 }), NOW);
  assert.match(t, /^Alpha nightly \(alpha-bot\)\n/);
  assert.match(t, /3 conversations kept/);
  assert.match(t, /\nlast active 5m ago\n/);
  assert.match(t, /newest reply: Sonnet 5\.5 · medium · 4%/);
  assert.match(t, /read-only/);
});

/* ------------------------------------------------------------ ctx, one way --- */

test('a bot’s ctx is painted by the dev session’s own function, lifted into one leaf', () => {
  assert.equal(ctxTone(null), '');
  assert.equal(ctxTone(49), 'ctx-ok');
  assert.equal(ctxTone(50), 'ctx-warn');
  assert.equal(ctxTone(70), 'ctx-warn');
  assert.equal(ctxTone(71), 'ctx-hot');
  assert.equal(tokensText(850), '850');
  assert.equal(tokensText(41_200), '41k');
  assert.equal(tokensText(1_200_000), '1.2M');
  assert.equal(tokensText(1_000_000), '1M');
  assert.equal(ctxText({ pct: 4 }), '4%');
  assert.equal(ctxText({ tokens: 41_200, pct: null }), '41k');
  assert.equal(ctxText(null), '');
  withDom(() => {
    const el = ctxEl(64);
    assert.equal(el.className, 'ctx ctx-warn');
    assert.equal(el.textContent, '64%');
    const withPct = ctxFor({ tokens: 41_000, window: 1_000_000, pct: 4 });
    assert.equal(withPct.className, 'ctx ctx-ok');
    assert.equal(withPct.textContent, '4%');
    // No window, no percentage, and no tone: a colour over a number with no denominator
    // would be claiming something nobody measured.
    const noPct = ctxFor({ tokens: 41_200, window: null, pct: null });
    assert.equal(noPct.className, 'ctx');
    assert.equal(noPct.textContent, '41k');
    assert.equal(ctxFor({ tokens: null, window: null, pct: null }), null);
  });
  // One spelling: `web/app.js` imports both and defines neither any more.
  assert.match(app, /import \{ ctxEl, ctxFor \} from '\.\/ctx\.js';/);
  assert.doesNotMatch(code, /function ctxTone\(|function ctxEl\(/);
  assert.match(band, /import \{ ctxFor, ctxText \} from '\.\/ctx\.js';/);
});

/* ------------------------------------------------------------ the patch --- */

test('the band is patched in place: nodes reused, nothing moved that is already in place', () => {
  withDom(() => {
    const list = container();
    const bots = [
      bot('alpha', { lastActiveAt: NOW - 1 * MIN, current: current(), active: 2 }),
      bot('beta', { lastActiveAt: NOW - 30 * MIN, current: current({ model: 'claude-haiku-5-5', modelName: 'Haiku 5.5' }) }),
      bot('gamma', { lastActiveAt: NOW - 3 * 3600_000, helper: { online: false, lastSeen: NOW - 2 * 3600_000 } }),
    ];
    const first = patchBotsBand(list, bots, { now: NOW });
    assert.equal(list.children.length, 3);
    assert.equal(list.moves, 3, 'three new rows, three insertions');
    assert.deepEqual(metaText(first[0]), ['Sonnet 5.5', 'medium', '4%', '2 active']);
    assert.equal(part(first[0], 'bot-age').textContent, '1m');
    assert.equal(part(first[1], 'bot-age').textContent, '30m');
    assert.equal(part(first[0], 'bot-dot').className, 'bot-dot is-active');
    assert.equal(part(first[2], 'bot-dot').className, 'bot-dot is-offline');
    assert.match(first[2].className, /is-offline/);
    // Two lines, no third: line one is a dot, a name and the age, line two the meta line —
    // and nothing else on the row.
    assert.deepEqual(
      first[0].children.map((c) => c.className),
      ['bot-dot is-active', 'bot-name', 'bot-age', 'bot-meta'],
    );

    // A beat on which beta's helper flickered and alpha is now open: same nodes, no moves.
    list.moves = 0;
    const again = patchBotsBand(list, bots, { now: NOW, openIds: ['alpha'] });
    assert.deepEqual(again, first, 'every node reused');
    assert.equal(list.moves, 0, 'a row already in place is never moved');
    assert.match(again[0].className, /is-open/);
    // The session row's open marker, said its way: `aria-current` only while true.
    assert.equal(again[0].attrs['aria-current'], 'true');
    assert.equal('aria-current' in again[1].attrs, false);

    // Gamma speaks and goes to the top: the one row that has to move is the only one moved.
    list.moves = 0;
    bots[2] = { ...bots[2], lastActiveAt: NOW, helper: { online: true, lastSeen: NOW } };
    const moved = patchBotsBand(list, bots, { now: NOW });
    assert.equal('aria-current' in first[0].attrs, false, 'and it comes off when the bot is no longer open');
    assert.deepEqual(
      moved.map((r) => r.dataset.botKey),
      ['bot:gamma', 'bot:alpha', 'bot:beta'],
    );
    assert.equal(list.moves, 1);
    assert.equal(moved[0], first[2], 'the same node, moved — not a new one');

    // A bot removed by `foreman-panel bots remove` goes before the pass, and nothing else moves.
    list.moves = 0;
    patchBotsBand(list, bots.filter((b) => b.id !== 'gamma'), { now: NOW });
    assert.equal(list.children.length, 2);
    assert.equal(list.moves, 0);
  });
});

test('a row’s click opens its bot, and the handler is re-bound so it never closes over a stale record', () => {
  withDom(() => {
    const list = container();
    const opened = [];
    const [row] = patchBotsBand(list, [bot('alpha')], { onOpen: (id) => opened.push(id), now: NOW });
    row.onclick();
    assert.deepEqual(opened, ['alpha']);
    const [same] = patchBotsBand(list, [bot('alpha')], { onOpen: (id) => opened.push(`again:${id}`), now: NOW });
    same.onclick();
    assert.deepEqual(opened, ['alpha', 'again:alpha']);
  });
});

test('the clock re-ages a row without building or moving anything', () => {
  withDom(() => {
    const list = container();
    const bots = [bot('alpha', { lastActiveAt: NOW - 2 * MIN, current: current() })];
    patchBotsBand(list, bots, { now: NOW });
    list.moves = 0;
    const meta = part(list.children[0], 'bot-meta').children.slice();
    relightBotsBand(list, bots, NOW + 60 * MIN);
    assert.equal(part(list.children[0], 'bot-age').textContent, '1h');
    assert.deepEqual(part(list.children[0], 'bot-meta').children, meta, 'line two untouched');
    assert.equal(list.moves, 0);
  });
  assert.equal(nextBotTick([bot('a', { lastActiveAt: NOW - 30_000 })], NOW), 30_000);
  assert.equal(nextBotTick([bot('a')], NOW), null, 'a band of silent bots holds no timer');
});

test('the signature carries every field the face reads and not the clock, joined with real punctuation', () => {
  const bots = [bot('alpha', { lastActiveAt: NOW, current: current(), active: 2 }), bot('beta')];
  const sig = botsSig(bots);
  assert.equal(sig.split('~').length, 2);
  assert.ok(sig.includes('|'));
  assert.doesNotMatch(sig, /[\u0000-\u001f]/, 'no control bytes — the `mergeSig` trap');
  assert.notEqual(botsSig(bots, { openIds: ['alpha'] }), sig, 'the open row');
  const moved = [{ ...bots[0], current: current({ ctx: { tokens: 90_000, window: 1_000_000, pct: 9 } }) }, bots[1]];
  assert.notEqual(botsSig(moved), sig, 'a new reply’s ctx');
  const quiet = [{ ...bots[0], helper: { online: false, lastSeen: NOW } }, bots[1]];
  assert.notEqual(botsSig(quiet), sig, 'the helper going quiet');
  assert.doesNotMatch(strip(fn('botsSig', band)), /Date\.now|ageText/, 'the clock moves with the timer, not the frame');
});

/* ------------------------------------------------- the conversation list --- */

test('a conversation is active, finished or idle — and its line is its own record’s facts', () => {
  assert.equal(convState(conv(CID(1), { active: true, finished: false })), 'active');
  assert.equal(convState(conv(CID(1), { active: false, finished: true })), 'finished');
  assert.equal(convState(conv(CID(1), { active: false, finished: false })), 'idle');
  const parts = convLineParts(conv(CID(1), { root: 'ag-team-one' }));
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['root', 'state', 'model', 'effort', 'ctx', 'started'],
  );
  assert.equal(parts[0].text, 'ag-team-one');
  assert.equal(parts[1].text, 'finished');
  assert.equal(parts[2].text, 'Haiku 5.5');
  assert.match(parts[5].text, /^started /, 'last, because it is the part that gives way');
});

test('the conversation list is patched in place by cid, marks the open one, and never draws one twice', () => {
  withDom(() => {
    const list = container();
    const convs = [conv(CID(1), { active: true, finished: false }), conv(CID(2)), conv(CID(2))];
    const picked = [];
    const first = patchConversations(list, convs, { selected: CID(2), onPick: (c) => picked.push(c), now: NOW });
    assert.equal(first.length, 2, 'a cid seen twice is drawn once');
    assert.match(first[1].className, /is-open/);
    assert.equal(first[1].attrs['aria-current'], 'true');
    assert.equal(part(first[0], 'bot-conv-dot').className, 'bot-conv-dot is-active');
    first[0].onclick();
    assert.deepEqual(picked, [CID(1)]);

    list.moves = 0;
    const again = patchConversations(list, convs, { selected: CID(1), now: NOW });
    assert.deepEqual(again, first);
    assert.equal(list.moves, 0, 'a selection change moves nothing');
    assert.match(again[0].className, /is-open/);

    list.moves = 0;
    relightConversations(list, convs, NOW + 3 * 3600_000);
    assert.equal(part(list.children[1], 'bot-conv-age').textContent, '3h');
    assert.equal(list.moves, 0);
  });
});

/* ------------------------------------------------------- the settings list --- */

test('the settings list says enough to tell "never deployed" from "refused" from "gone quiet"', () => {
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  const quiet = botFacts(
    {
      ...bot('gamma', { helper: { online: false, lastSeen: NOW - 2 * 3600_000, instance: 'i-1', since: NOW - 3 * 3600_000, helperVersion: '1.0.0', host: 'vm', roots: [{ label: '*', path: '/data/projects' }], claudeVersions: ['2.1.296'] } }),
      disk: { bytes: 19 * 1024, files: 2 },
      lastRefusal: { at: NOW - 3 * MIN, status: 401, reason: 'unknown bot or wrong token' },
    },
    { now: NOW, bytesText: kb },
  );
  const get = (facts, k) => facts.find(([label]) => label === k)?.[1];
  assert.equal(get(quiet, 'helper'), 'offline — last seen 2h ago');
  assert.equal(get(quiet, 'roots'), '* = /data/projects');
  assert.equal(get(quiet, 'disk'), '19 KB in 2 files');
  assert.equal(get(quiet, 'last refusal'), '401 unknown bot or wrong token — 3m ago');

  const never = botFacts({ ...bot('beta', { helper: { online: false, lastSeen: null } }), disk: { bytes: 0, files: 0 }, lastRefusal: null }, { now: NOW, bytesText: kb });
  assert.equal(get(never, 'helper'), 'never seen');
  assert.equal(get(never, 'last refusal'), 'none');
  assert.equal(diskText({ bytes: 1024, files: 1 }, kb), '1 KB in 1 file');

  // Disk use is per bot (the maintainer's Q5), through the panel's one size formatter.
  assert.match(top('fillBotsList'), /botFacts\(row, \{ now, bytesText: shortBytes \}\)/);
  assert.match(top('shortBytes'), /GB/);
  // Read-only: the section fetches and draws, and nothing in it writes.
  assert.match(top('fillBotsList'), /fetch\('\/api\/bots'\)/);
  assert.doesNotMatch(strip(top('fillBotsList')), /postJSON|method:|PATCH|DELETE|tokenHash|fetch\([^)]*,/);
  // …and it is in the settings box, after the browser-local preferences.
  assert.match(top('openSettings'), /fillBotsList\(botsList\);/);
});

/* ------------------------------------------------------------- the fold --- */

/** A head node that counts its writes — a fold repaint that changed nothing writes nothing. */
function headNode(init = {}) {
  const node = { writes: 0, attrs: {}, ...init };
  return new Proxy(node, {
    set(target, key, value) {
      if (key !== 'writes') target.writes += 1;
      target[key] = value;
      return true;
    },
    get(target, key) {
      if (key === 'setAttribute') return (k, v) => ((target.attrs[k] = String(v)), (target.writes += 1));
      if (key === 'removeAttribute') return (k) => delete target.attrs[k];
      if (key === 'getAttribute') return (k) => (k in target.attrs ? target.attrs[k] : null);
      return target[key];
    },
  });
}

const headNodes = () => ({
  head: headNode({ title: '', attrs: { 'aria-expanded': 'true' } }),
  caret: headNode({ textContent: '▾' }),
  count: headNode({ textContent: '', hidden: true }),
  dot: headNode({ hidden: true, title: '' }),
});

const writes = (n) => n.head.writes + n.caret.writes + n.count.writes + n.dot.writes;

test('open, the head reads `bots` and nothing else — exactly what it read before it could fold', () => {
  const bots = [bot('a', { active: 2 }), bot('b')];
  const h = botsHead(bots, { folded: false });
  assert.equal(h.folded, false);
  assert.equal(h.caret, '▾');
  assert.equal(h.countText, '', 'no count while the rows are on screen to count');
  assert.equal(h.dot, false, 'no head dot while the rows are on screen saying it themselves');
  assert.equal(h.count, 2);
  assert.equal(h.active, 1);
  assert.match(h.title, /^Fold the bots band/);
  assert.equal(botsHead().folded, false, 'open by default');
});

test('folded, the head reads `bots · N`, N the bots registered — every row the band would draw', () => {
  const bots = [bot('a'), bot('b'), bot('c', { helper: { online: false } }), null, { id: '' }, 'x'];
  const h = botsHead(bots, { folded: true });
  assert.equal(h.caret, '▸');
  assert.equal(h.count, 3, 'malformed entries are not bots, as the band itself does not draw them');
  assert.equal(h.countText, '· 3');
  assert.equal(h.countText, `· ${botEntries(bots).length}`, 'one count: the band’s own entries');
  assert.equal(h.dot, false, 'nothing running, no dot');
  assert.equal(h.title, 'Show the bots — 3 bots');
  assert.equal(botsHead([bot('a')], { folded: true }).title, 'Show the bots — 1 bot');
});

test('folded, the band’s amber dot shows while any bot is active — so a fold never hides activity', () => {
  const bots = [bot('a'), bot('b', { active: 1 }), bot('c', { active: 3 })];
  const h = botsHead(bots, { folded: true });
  assert.equal(h.dot, true);
  assert.equal(h.active, 2);
  assert.equal(h.dotText, '2 bots active');
  assert.equal(h.title, 'Show the bots — 3 bots, 2 active');
  assert.equal(botsHead([bot('a', { active: 1 })], { folded: true }).dotText, '1 bot active');
});

test('the folded dot is the rows’ own `dotState`: a quiet helper’s stale `active` lights nothing', () => {
  // Offline wins over active on the row (a grey dot), so the folded head must agree with the
  // row you would see if you opened it — never pulse for a bot whose row would not.
  const quiet = bot('q', { active: 2, helper: { online: false, lastSeen: NOW - 10 * MIN } });
  assert.equal(dotState(quiet), 'offline');
  const h = botsHead([quiet, bot('b')], { folded: true });
  assert.equal(h.active, 0);
  assert.equal(h.dot, false);
  for (const b of [quiet, bot('b', { active: 1 })]) {
    assert.equal(botsHead([b], { folded: true }).dot, dotState(b) === 'active', b.id);
  }
});

test('the fold paints the head’s own four nodes, and a repaint that changed nothing writes nothing', () => {
  // No `withDom` here on purpose: a paint that built a node would throw on `document`.
  const n = headNodes();
  const bots = [bot('a', { active: 1 }), bot('b')];
  paintBotsHead(n, botsHead(bots, { folded: true }));
  assert.equal(n.head.attrs['aria-expanded'], 'false');
  assert.equal(n.caret.textContent, '▸');
  assert.equal(n.count.textContent, '· 2');
  assert.equal(n.count.hidden, false);
  assert.equal(n.dot.hidden, false);
  assert.equal(n.dot.title, '1 bot active');
  assert.equal(n.dot.attrs['aria-label'], '1 bot active');
  assert.match(n.head.title, /^Show the bots — 2 bots, 1 active$/);

  const before = writes(n);
  paintBotsHead(n, botsHead(bots, { folded: true }));
  // The dot's aria-label is the one attribute set unconditionally while it shows.
  assert.equal(writes(n) - before, 1, 'only the dot’s label is re-said; nothing else is touched');

  paintBotsHead(n, botsHead(bots, { folded: false }));
  assert.equal(n.head.attrs['aria-expanded'], 'true');
  assert.equal(n.caret.textContent, '▾');
  assert.equal(n.count.textContent, '');
  assert.equal(n.count.hidden, true);
  assert.equal(n.dot.hidden, true);
  assert.equal(n.dot.attrs['aria-label'], undefined);
  assert.doesNotThrow(() => paintBotsHead({}, botsHead(bots)), 'no head, no paint');
  assert.doesNotThrow(() => paintBotsHead(n, null));
});

test('the band’s height shape moves on a fold and on rows coming or going, and not on activity', () => {
  const quiet = [bot('a', { current: current() }), bot('b')];
  assert.equal(botsBandShape([]), 'none');
  assert.equal(botsBandShape([], { folded: true }), 'none', 'no bots, no band, folded or not');
  assert.equal(botsBandShape(quiet), '2|1', 'two rows, one of them two lines tall');
  assert.equal(botsBandShape(quiet, { folded: true }), 'folded');
  // A reply landing changes the ages and the meta words, never the band's height…
  const busy = [bot('a', { current: current({ effort: 'high' }), active: 1, lastActiveAt: NOW }), bot('b')];
  assert.equal(botsBandShape(busy), botsBandShape(quiet));
  // …while a bot's first reply grows its row a line, and a new bot adds one.
  assert.equal(botsBandShape([bot('a', { current: current() }), bot('b', { current: current() })]), '2|2');
  assert.equal(botsBandShape([...quiet, bot('c')]), '3|1');
  // Folded, nothing a row does can change the head's height.
  assert.equal(botsBandShape([...quiet, bot('c')], { folded: true }), 'folded');
});

test('the fold toggle hides the list by its own flag and never touches a row', () => {
  const toggle = top('toggleBotsFold');
  assert.match(toggle, /botsFolded\.set\(!botsFolded\.on\)/);
  const paint = top('paintBotsFold');
  assert.match(paint, /el\.botsList\.hidden = folded/);
  // The rooms band's archived fold repainted its rows round its own focused button and the
  // band jumped to the top; this fold re-appends, patches and rebuilds nothing.
  for (const body of [strip(toggle), strip(paint)]) {
    assert.doesNotMatch(body, /patchBotsBand|replaceChildren|\.append\(|insertBefore|innerHTML|renderRail/);
  }
  assert.match(code, /if \(el\.botsHead\) el\.botsHead\.onclick = toggleBotsFold;/, 'bound once, the head is markup');
});

test('the rows are patched under a shut fold too, so opening it is a flag and not a patch', () => {
  const render = strip(top('renderBotsBand'));
  assert.ok(render.indexOf('paintBotsFold()') < render.indexOf('patchBotsBand('), 'the head is painted every beat');
  assert.doesNotMatch(render, /botsFolded\.on\)?\s*(\)|&&)\s*return/, 'no early return on the fold');
  assert.match(render, /followBotsHeight\(\);\n\}$/, 'the rooms band is re-asked after every beat that reaches it');
});

test('the rooms grip’s ceiling follows the bots band: net of its height, and re-asked when it changes', () => {
  assert.match(code, /const roomsBand = resizer\(\{\n  handle: el\.roomsGrip,/);
  // #196's subtraction stays, and it is measured, so a folded band gives the room back.
  assert.match(code, /const bots = el\.railBots\?\.getBoundingClientRect\(\)\.height \?\? 0;/);
  assert.match(code, /return \(bottom - top - bots\) \/ remPx\(\) - RAIL_LIST_MIN;/);
  const follow = strip(top('followBotsHeight'));
  assert.match(follow, /botsBandShape\(state\.bots, \{ folded: botsFolded\.on \}\)/);
  assert.match(follow, /if \(shape === botsShapeLast\) return;/, 'only when the height can have moved');
  assert.match(follow, /roomsBand\?\.applyNow\(\);/);
  assert.match(strip(top('toggleBotsFold')), /followBotsHeight\(\);/);
});

test('the fold is a browser preference, and the head’s hidden parts each carry their own `[hidden]` rule', () => {
  assert.match(app, /import \{ botsFolded \} from '\.\/prefs\.js';/);
  assert.doesNotMatch(code, /localStorage[^\n]*botsFolded|foreman\.botsFolded/, 'one spelling of the key, in prefs.js');
  assert.match(styles, /\.bots-list\[hidden\] \{ display: none; \}/);
  assert.match(styles, /\.bots-count\[hidden\],\n\.bots-head-dot\[hidden\] \{ display: none; \}/);
  // The head's dot is the row's own amber pulse and nothing louder.
  assert.match(html, /<span class="bot-dot is-active bots-head-dot" id="botsHeadDot" role="img" hidden><\/span>/);
  const headCss = styles.slice(styles.indexOf('.bots-head {'), styles.indexOf('.bots-list {')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(headCss, /--decision|--danger|\bred\b/);
});

/* ---------------------------------------------------- the rail and the frame --- */

test('the band is a sibling of `.rail-list`, below the sessions and above the rooms, and its one control is its head', () => {
  const list = html.indexOf('id="railList"');
  const bots = html.indexOf('id="railBots"');
  const rooms = html.indexOf('id="railRooms"');
  assert.ok(list > 0 && bots > list && rooms > bots, 'list, then bots, then rooms');
  const listTag = html.slice(list, html.indexOf('</div>', list));
  assert.ok(!listTag.includes('railBots'), 'never inside the session list');
  const markup = html.slice(html.indexOf('<div class="rail-bots"'), rooms);
  // Registering a bot is the CLI's job, so the only button in the band is the head folding it.
  assert.equal((markup.match(/<button/g) || []).length, 1, 'one button: the head');
  assert.match(markup, /<button\s+class="bots-head"\s+id="botsHead"\s+type="button"\s+aria-expanded="true"\s+aria-controls="botsList"/);
  assert.match(markup, /<span class="bots-title">bots<\/span>/, 'the word on screen is "bots" (Q2)');
  // …and nothing was added to the rail head, which cannot take a sixth control.
  const head = html.slice(html.indexOf('<div class="rail-actions">'), html.indexOf('<div class="rail-stat"'));
  assert.doesNotMatch(head, /bot/i);
});

test('the whole band is gated on `.app.has-bots` by `display`, never by `[hidden]`', () => {
  assert.match(styles, /\.rail-bots \{\n  display: none;/);
  assert.match(styles, /\.app\.has-bots \.rail-bots \{ display: flex; \}/);
  assert.match(top('renderBotsBand'), /el\.app\.classList\.toggle\('has-bots', bots\.length > 0\)/);
  // The line naming the open conversation carries a `display`, so it needs its own rule.
  assert.match(styles, /\.bot-conv-head\[hidden\] \{ display: none; \}/);
});

test('the frame is read with `in`, beside the rooms, and never folded into the sessions', () => {
  assert.match(app, /if \('bots' in msg\) state\.bots = Array\.isArray\(msg\.bots\) \? msg\.bots : \[\];/);
  const handle = top('handle');
  assert.ok(handle.indexOf("'bots' in msg") < handle.indexOf('pane.adopt()'), 'set before `adopt`, which restores a bot pane');
  assert.doesNotMatch(code, /state\.sessions\s*=\s*[^;]*bots/);
  assert.doesNotMatch(code, /notifyRoster\([^)]*bots/);
});

test('nothing about bots asks for attention: no unread, no hoist, no notification', () => {
  const render = strip(top('renderBotsBand'));
  assert.doesNotMatch(render, /unread|needsYou|notify|inbox/i);
  assert.doesNotMatch(strip(band), /unread|needsYou|notify|inbox/i);
  assert.doesNotMatch(text('web/notify.js'), /bots?\b/);
  // And a bot pane never marks anything read: `view.selected` stays null the whole time.
  assert.match(fn('openBot'), /view\.selected = null;/);
  assert.doesNotMatch(strip(app.slice(app.indexOf('function openBot('), app.indexOf('  /* -------------------------------------------------------------- main --- */'))), /markRead|markReadIfCaughtUp/);
});

/* ------------------------------------------------------------- the pane --- */

test('`renderMain` returns the bot pane before `current()`, and it never builds a composer', () => {
  const main = fn('renderMain');
  const at = main.indexOf("if (view.kind === 'bot') return renderBotPane();");
  assert.ok(at > 0);
  assert.ok(at < main.indexOf('const s = current();'));
  const pane = strip(fn('renderBotPane'));
  // None of the session head's controls, and no composer: nothing here acts on anything.
  assert.doesNotMatch(pane, /buildComposer|buildHead\(|togglePin|paintPin|pin-btn|head-files|openFiles|syncAttach|attachTerminal|duplicat|close-btn|revealFolder|buildModel|buildEffort|mention/i);
  assert.match(pane, /bot-readonly/);
});

test('`receive` takes the bot frames before its session guard, and the bot’s `error` too', () => {
  const recv = fn('receive');
  const guard = recv.indexOf("if (view.kind !== 'session') return;");
  for (const type of ["'bot'", "'bot-messages'", "'bot-earlier'", "'bot-conversations'"]) {
    const at = recv.indexOf(`msg.type === ${type}`);
    assert.ok(at > 0 && at < guard, `${type} is handled before the guard`);
  }
  const err = recv.indexOf("msg.type === 'error' && view.kind === 'bot'");
  assert.ok(err > 0 && err < guard);
  // Every frame is checked against the bot this pane holds.
  assert.match(fn('receiveBot'), /msg\.botId !== view\.bot\.id/);
});

test('nothing about bots joins `composerSig`', () => {
  const sig = app.slice(app.indexOf('const composerSig'), app.indexOf('let lastComposerSig'));
  assert.ok(sig.length > 0);
  assert.doesNotMatch(sig, /bot/i);
});

test('a bot pane is remembered as its own shape and restored only while the bot is registered', () => {
  // No `autoSplit`: a bot sits in the main pane and never made the split it is in.
  assert.match(app, /state\.opened\[slot\] = \{ kind: 'bot', bot: botId, cid: cid \|\| null \};/);
  assert.match(app, /function rememberOpenBot\(slot, botId, cid = null\) \{/);
  assert.doesNotMatch(code, /rememberOpenBot\([^)]*threadSplit/);
  const adopt = app.match(/function adopt\(\) \{[\s\S]*?\n  \}/)[0];
  const branch = adopt.slice(adopt.indexOf("if (last?.kind === 'bot') {"), adopt.indexOf('const pick ='));
  assert.ok(branch.length > 0);
  assert.match(branch, /if \(state\.bots\.some\(\(b\) => b\?\.id === last\.bot\)\) return openBot\(last\.bot, last\.cid \?\? null\);/);
  assert.match(branch, /rememberOpenBot\(slot, null\);/);
  // …and it never takes the split's ownership from a bot entry, which would overwrite a
  // room's answer from the other slot.
  assert.doesNotMatch(strip(branch), /threadSplit|autoSplit/);
  // A reconnect re-takes the conversation on screen, never `null` — a reader is never moved.
  assert.match(fn('resubscribe'), /send\(\{ type: 'subscribe-bot', botId: view\.bot\.id, cid: view\.botCid, slot \}\)/);
  // …and every way out gives the subscription back.
  assert.match(fn('close'), /if \(view\.kind === 'bot'\) send\(\{ type: 'unsubscribe-bot', slot \}\);/);
  for (const name of ['open', 'openShared', 'openGroup']) assert.match(fn(name), /leaveBot\(\);/, name);
});

test('a bot opens where a session does — `openSession`’s routing, line for line', () => {
  /*
   * The maintainer's ruling of 2026-10-13: a bot row replaces what the main pane shows,
   * exactly as a session row does, and that pane keeps focus — so the next rail click (a
   * session, or another bot) replaces it in turn. In split view it goes wherever a session
   * would, the focused side; nothing here opens a split or claims one.
   */
  const open = strip(top('openBotPane'));
  const session = strip(top('openSession'));
  for (const line of ['const pane = sessionPane();', 'if (!pane) return;', 'if (!holdsMain(pane)) threadSplit = false;', 'setFocus(pane.slot);']) {
    assert.ok(open.includes(line) && session.includes(line), `both say \`${line}\``);
  }
  assert.match(open, /pane\.openBot\(id\);/);
  assert.doesNotMatch(open, /openSplit|threadSplit = true|p\.botId\(\)/);

  // What "a pane the rail drives" means now: a session, a bot or a sleeper, said as an allow-list.
  assert.match(top('holdsMain'), /return kind === 'session' \|\| kind === 'bot' \|\| kind === 'asleep';/);
  const pane = top('sessionPane');
  assert.match(pane, /if \(here && holdsMain\(here\)\) return here;/);
  assert.match(pane, /return panes\.find\(holdsMain\) \|\| here;/);
});

test('rooms keep their side-pane routing, and a room never replaces a bot', () => {
  // "One non-session pane at a time" is now one *room* at a time: both room openers look for
  // a pane holding something that is not main content, so a bot is passed over the way a
  // session is — opening a room beside a lone bot splits rather than taking its pane.
  assert.match(top('roomTarget'), /const holder = panes\.find\(\(p\) => !holdsMain\(p\)\);/);
  assert.match(top('openSharedRoom'), /const holder = panes\.find\(\(p\) => !holdsMain\(p\)\);/);
  assert.match(top('mountGroupRoom'), /openSplit\(\{ adopt: false, focus: false \}\)/);
  assert.match(top('mountGroupRoom'), /if \(!existing\) threadSplit = true;/);
});

test('the bot pane’s own `close` is gone; its head carries the session head’s split control', () => {
  /*
   * The old `close` meant "put back what the bot was opened beside" — and in the main pane
   * nothing is behind it. A bot is left the way a session is, by clicking another row; what
   * the session head offers beside that is `split` / `close` (this pane), and the bot head
   * now has that same control, worded by the same function.
   */
  assert.doesNotMatch(code, /closeBot|Close this bot/);
  const pane = strip(fn('renderBotPane'));
  assert.match(pane, /split\.className = 'ghost-btn split-toggle';/);
  assert.match(pane, /syncSplitBtn\(split\);/);
  // Re-worded on the beat that re-words a session's, since `openSplit` and `closePane` only
  // call `renderHead` and never rebuild a head.
  const head = fn('renderHead');
  const bot = head.slice(head.indexOf("if (view.kind === 'bot') {"), head.indexOf('const s = current();'));
  assert.match(bot, /renderBotHead\(\);\n\s+syncSplitBtn\(host\.querySelector\('\.split-toggle'\)\);\n\s+return;/);
});

test('the bot row takes the session row’s selected marker, all three signals', () => {
  const session = styles.match(/\.session-row\.is-open \{[\s\S]*?\n\}/)[0];
  const bot = styles.match(/\.bot-row\.is-open \{[\s\S]*?\n\}/)[0];
  assert.match(session, /background: var\(--row-open\);/);
  assert.match(bot, /background: var\(--row-open\);/);
  assert.match(bot, /border-left-color: var\(--accent\);/);
  assert.match(styles, /\.bot-row\.is-open \.bot-name \{ color: var\(--ink\); \}/);
  // The 3px edge is carried by every row as transparent, the session row's reason: grown on
  // the open one only, the content would step sideways as the selection moved.
  const row = styles.match(/\.bot-row \{[\s\S]*?\n\}/)[0];
  assert.match(row, /border-left: 3px solid transparent;/);
  assert.match(styles.match(/\.session-row \{[\s\S]*?\n\}/)[0], /border-left: 3px solid transparent;/);
  // And the rail's marker follows every pane holding the bot, as a session's does.
  assert.match(top('renderBotsBand'), /const openIds = panes\.map\(\(p\) => p\.botId\(\)\)\.filter\(Boolean\);/);
});

/* ------------------------------------------------- the stream: traps 6, 7, 8 --- */

test('the stream reuses `groupMessages` and `renderMessage` with one options argument', () => {
  assert.match(app, /function renderMessage\(m, how = null\) \{/);
  assert.match(app, /function buildMessage\(m, how = null\) \{/);
  assert.match(fn('renderBotStream'), /for \(const m of groupMessages\(view\.botMessages\)\) frag\.append\(renderMessage\(m, how\)\);/);
  // Not a copy: exactly one `buildMessage` and one `groupMessages` in the file.
  assert.equal(code.match(/function buildMessage\(/g).length, 1);
  assert.equal(code.match(/function groupMessages\(/g).length, 1);
  // The session path is the default and is unchanged — path links run only for it.
  const render = fn('renderMessage');
  assert.ok(render.indexOf('if (how) return node;') < render.indexOf('linkPathsInTree(node);'));
});

test('a bot’s `user` record is labelled `prompt` and never drawn as the maintainer’s bubble (trap 6)', () => {
  const build = fn('buildMessage');
  const user = build.slice(build.indexOf("case 'user': {"), build.indexOf("case 'assistant': {"));
  assert.ok(user.indexOf('how?.prompt') < user.indexOf("div.className = 'msg-user';"), 'the prompt branch comes first');
  assert.match(user, /label\.textContent = 'prompt';/);
  assert.match(user, /body\.textContent = m\.text;/, 'text, never markup');
  assert.match(fn('botRender'), /prompt: true,/);
  // Neutral, not the accent bubble that says "you said this".
  const css = styles.slice(styles.indexOf('.msg-prompt {'), styles.indexOf('.msg-prompt-label {'));
  assert.doesNotMatch(css, /--accent/);
});

test('a bot’s markdown goes through the escaping renderer `briefHtml` uses (trap 7)', () => {
  assert.match(fn('botRender'), /markdown: briefHtml,/);
  assert.match(fn('buildMessage'), /div\.innerHTML = how \? how\.markdown\(m\.text \|\| ''\) : withBlankTargets\(marked\.parse\(m\.text \|\| ''\)\);/);
  // Every other prose register a bot reaches: a notice chip's body and a subagent's return.
  assert.match(fn('renderChip'), /prose\.innerHTML = how \? how\.markdown\(body\) : withBlankTargets\(marked\.parse\(body\)\);/);
  assert.match(fn('renderAgentRun'), /body\.innerHTML = how \? how\.markdown\(finalText\) : withBlankTargets\(marked\.parse\(finalText\)\);/);
  // The renderer shows raw HTML as text and keeps an anchor only for a scheme a reader means.
  const brief = top('briefHtml');
  assert.match(brief, /renderer\.html = /);
  assert.match(brief, /renderer\.link = /);
  const src = app.match(/const SAFE_HREF_RE = (\/.*\/i);/)[1];
  const re = new Function(`return ${src}`)();
  for (const ok of ['https://example.com', 'http://x', 'mailto:a@b', '#frag', '/api/x']) assert.ok(re.test(ok), ok);
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:x', 'data:text/html,1', 'vbscript:x', '//evil.example/x']) {
    assert.ok(!re.test(bad), bad);
  }
});

test('images and subagent transcripts come off the bot routes, never the session’s (trap 8)', () => {
  const render = fn('botRender');
  assert.match(render, /\/api\/bots\/\$\{encodeURIComponent\(botId\)\}\/conversations\/\$\{encodeURIComponent\(cid\)\}/);
  assert.match(render, /imageSrc: \(ref\) => `\$\{base\}\/image\/\$\{encodeURIComponent\(ref\.uuid\)\}\/\$\{ref\.index\}`/);
  // The bare `result.agent.id`, and never the `outputFile` a bot's transcript names (trap 4).
  assert.match(render, /agentUrl: \(agent\) => \(agent\?\.id \? `\$\{base\}\/agent\/\$\{encodeURIComponent\(agent\.id\)\}` : null\)/);
  assert.doesNotMatch(strip(render), /outputFile|agent-run/);
  const strip8 = fn('imageStrip');
  assert.match(strip8, /const srcOf = how \? \(ref\) => how\.imageSrc\(ref\) : \(ref\) => imageSrc\(sessionId, ref\);/);
  const run = fn('renderAgentRun');
  assert.match(run, /const runUrl = how\n\s+\? how\.agentUrl\(agent\)/);
  assert.match(run, /inner\.append\(renderMessage\(m, how\)\);/);
  // The live path patches a chip's result through the same options.
  assert.match(fn('appendBotMessages'), /applyResult\(chipNodes\.get\(m\.toolUseId\), \{[^}]*\}, how\)/);
});
