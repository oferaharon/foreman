import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canCreate,
  capRefusal,
  countLine,
  createReason,
  MAX_MEMBERS,
  MAX_ROOM_NAME,
  orderForHere,
  roomParticipants,
  rowFolder,
  rowName,
} from '../web/rooms-create.js';
import { MAX_MEMBERS as SERVER_MAX_MEMBERS, MAX_ROOM_NAME as SERVER_MAX_ROOM_NAME } from '../server/rooms.js';

/*
 * The create-room modal.
 *
 * Two halves, the way `test/rooms-band.test.js` is two halves. `web/rooms-create.js` is a
 * real module and is driven for real — the allow-list, the here-first order, the tally and
 * every sentence a refusal is spelled with. `openCreateRoom` lives in `web/app.js`, which
 * cannot be imported (it reaches for `document` at module scope and there is no browser
 * here), so it is **lifted out of the source and run** against a stub DOM with every one of
 * its dependencies handed in by name. That is stronger than a source assertion and it is
 * what the interesting half of this feature needs: whether the button is disabled, whether
 * Escape wrote anything, and which id `openGroupRoom` was called with are all facts about
 * what the function *does*.
 *
 * What is pinned, and why each would otherwise break **silently**:
 *
 *  - **The list is an allow-list on role**, an ordinary session or a lead, never "not a
 *    worker". A negative test admits the next task kind, and the thing it would admit here
 *    is a worker in a room — the maintainer's own ruling says a worker's channel is its lead.
 *  - **A live pane is required.** Every post is typed into every other member's terminal;
 *    a picker offering a dead row makes a 404 reachable and says nothing about why.
 *  - **Here first is a sort, never a filter.** Filtering would make a cross-project room
 *    impossible to build from the panel, which is half of what rooms are for — and it would
 *    look exactly like a short list rather than like a missing feature.
 *  - **The cap is refused twice**, once by the tick and once by the server's own 400 shown
 *    verbatim. A client-side cap that quietly disagreed with the server's would refuse a
 *    press the server would have taken, or take one it refuses.
 *  - **Escape writes nothing.** A modal that posted on the way out is unrecoverable: a room
 *    is a record on disk and there is nothing in this feature that deletes one.
 *  - **Nothing about rooms joins `composerSig`.** That signature tears the whole composer
 *    down when it changes, and a message landing in a room would take the textarea out from
 *    under whoever is typing.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = text('web/app.js');
const styles = text('web/styles.css');
const mod = text('web/rooms-create.js');

/** The source with its prose taken out — `test/rooms-band.test.js`'s helper, for its reason:
 *  several checks below are negative, and the phrases they forbid belong in the comments
 *  that record the rule. */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const code = strip(app);

/* ---------------------------------------------------------- fixtures --- */

const sess = (id, over = {}) => ({
  id,
  label: id,
  title: `${id}-main`,
  project: id,
  paneId: `%${id.length}`,
  paneCwd: `/sandbox/${id}`,
  cwd: `/sandbox/${id}`,
  status: 'idle',
  interactive: true,
  isLead: false,
  team: null,
  ...over,
});

const ALPHA = sess('alpha');
const BETA = sess('beta');
const GAMMA = sess('gamma');

/* ------------------------------------------------- the participant list --- */

test('the list is leads and ordinary sessions — an allow-list on role, never “not a worker”', () => {
  const rows = roomParticipants([
    ALPHA,
    { ...BETA, team: { role: 'lead' } },
    { ...GAMMA, team: { role: 'worker' } },
  ]);
  assert.deepEqual(
    rows.map((s) => s.id),
    ['alpha', 'beta'],
  );

  // The shape of the test, not just its answer. A role this repo has not met yet — kinds
  // have already grown once — must be refused by default rather than admitted by an
  // omission, which is exactly what a negative test would do.
  assert.deepEqual(
    roomParticipants([{ ...ALPHA, team: { role: 'planner' } }]).map((s) => s.id),
    [],
    'an unknown role is not a member, because the rule names what is allowed',
  );
  assert.ok(
    !/!==\s*'worker'|!=\s*'worker'|role\s*!==/.test(strip(mod)),
    'the filter must never be written as “not a worker”',
  );
});

test('a row with no live pane is not offered — a post is typed into a terminal', () => {
  assert.deepEqual(
    roomParticipants([ALPHA, { ...BETA, interactive: false }]).map((s) => s.id),
    ['alpha'],
  );
});

test('a malformed roster draws an empty list rather than throwing', () => {
  assert.deepEqual(roomParticipants(undefined), []);
  assert.deepEqual(roomParticipants(null), []);
  assert.deepEqual(roomParticipants('sessions'), []);
  assert.deepEqual(roomParticipants([null, undefined]), []);
});

test('this is the only spelling of the allow-list on the client side', () => {
  /*
   * There used to be a second caller — `sharedParticipants`, the peer-message `@` picker's
   * source — and it was pinned to *delegate* here rather than repeat the filter, because two
   * spellings of "who is addressable" is the `isLeadName` lesson and the disagreement would
   * be in the direction of offering a worker. That picker was retired on 2026-09-05, so what
   * is pinned now is stronger and simpler: `web/app.js` holds no copy of the test at all, and
   * the only way it can ask the question is by calling this function.
   */
  assert.ok(!/team\?\.role\s*===?\s*null/.test(code), 'the role test must live only in `roomParticipants`');
  assert.ok(
    !/sharedParticipants/.test(code),
    'the retired peer-message picker must not have grown back',
  );
  assert.match(code, /roomParticipants\(state\.sessions\)/);
});

/* ------------------------------------------------------- here, then away --- */

test('the sessions in the folder you are looking at come first — and the rest still come', () => {
  const rows = [ALPHA, BETA, GAMMA];
  const ordered = orderForHere(rows, '/sandbox/gamma');
  assert.deepEqual(
    ordered.map((s) => s.id),
    ['gamma', 'alpha', 'beta'],
  );
  assert.equal(ordered.length, rows.length, 'a sort, never a filter');
});

test('with nothing open the roster’s own order stands', () => {
  assert.deepEqual(
    orderForHere([ALPHA, BETA], null).map((s) => s.id),
    ['alpha', 'beta'],
  );
});

test('the order within each half is the roster’s, so the list does not reshuffle on a beat', () => {
  const a = sess('alpha', { paneCwd: '/sandbox/alpha' });
  const b = sess('beta', { paneCwd: '/sandbox/alpha' });
  const c = sess('gamma', { paneCwd: '/sandbox/gamma' });
  assert.deepEqual(
    orderForHere([c, a, b], '/sandbox/alpha').map((s) => s.id),
    ['alpha', 'beta', 'gamma'],
  );
});

test('the folder is the launch folder, never the transcript’s `cwd`, which moves', () => {
  assert.equal(rowFolder({ paneCwd: '/sandbox/alpha', cwd: '/sandbox/alpha/sub' }), '/sandbox/alpha');
  assert.equal(rowFolder({ cwd: '/sandbox/alpha/sub' }), null, 'a wandering cwd is not a folder');
});

/* ----------------------------------------------------------- the names --- */

test('a session is called what the rail calls it, and what the member record will say', () => {
  assert.equal(rowName({ label: 'alpha-main', title: 'x', project: 'alpha', id: 'i' }), 'alpha-main');
  assert.equal(rowName({ label: null, title: 'alpha-main', project: 'alpha', id: 'i' }), 'alpha-main');
  assert.equal(rowName({ label: null, title: null, project: 'alpha', id: 'i' }), 'alpha');
  assert.equal(rowName({ label: null, title: null, project: null, id: 'i' }), 'i');
  assert.equal(rowName(null), '');
});

/* ------------------------------------------------------ the two refusals --- */

test('the create button is off without a name and off without a member, and says which', () => {
  assert.equal(canCreate('', 0), false);
  assert.equal(canCreate('', 2), false);
  assert.equal(canCreate('   ', 2), false, 'whitespace is not a name');
  assert.equal(canCreate('the checkout flow', 0), false);
  assert.equal(canCreate('the checkout flow', 1), true);

  assert.match(createReason('', 0), /needs a name/);
  assert.match(createReason('the checkout flow', 0), /at least one/);
  assert.equal(createReason('the checkout flow', 1), null);
});

test('the tally says the cap as well as the tally', () => {
  assert.equal(countLine(0, 8), '0 of 8');
  assert.equal(countLine(8, 8), '8 of 8');
});

test('the cap’s own sentence says the reason is their panes, not storage', () => {
  assert.match(capRefusal(8), /at most 8 sessions/);
  assert.match(capRefusal(8), /typed into every other member/);
});

test('the client’s caps are the server’s, held together by this assertion and nothing else', () => {
  // `test/logs.test.js`'s idiom: two spellings of one contract in two files that cannot
  // import each other's intent. A client cap below the server's refuses a press the server
  // would have taken; one above it ships a control that always ends in a 400.
  assert.equal(MAX_MEMBERS, SERVER_MAX_MEMBERS);
  assert.equal(MAX_ROOM_NAME, SERVER_MAX_ROOM_NAME);
});

/* ================================================= the modal, driven ===== */

/**
 * Just enough DOM for `openCreateRoom`, and deliberately no more.
 *
 * `test/trust-gate.test.js` set the pattern and `test/rooms-band.test.js` followed it: the
 * point is not to simulate a browser but to **record** what the builder does. Everything the
 * modal is allowed to touch is modelled; anything it grows later that this does not model
 * throws rather than passing quietly.
 */
function makeDom() {
  const listeners = [];
  const body = node('body');

  function node(tag) {
    const self = {
      tagName: String(tag).toUpperCase(),
      type: '',
      className: '',
      textContent: '',
      title: '',
      placeholder: '',
      value: '',
      checked: false,
      hidden: false,
      disabled: false,
      maxLength: -1,
      dataset: {},
      children: [],
      parent: null,
      focused: false,
      onclick: null,
      onchange: null,
      oninput: null,
      onkeydown: null,
      onmousedown: null,
      focus() {
        self.focused = true;
      },
      get isConnected() {
        let n = self;
        while (n.parent) n = n.parent;
        return n === body;
      },
      classList: {
        toggle(cls, on) {
          const has = self.className.split(/\s+/).includes(cls);
          const want = on === undefined ? !has : !!on;
          if (want === has) return;
          self.className = want
            ? `${self.className} ${cls}`.trim()
            : self.className.split(/\s+/).filter((c) => c && c !== cls).join(' ');
        },
        contains: (cls) => self.className.split(/\s+/).includes(cls),
      },
      setAttribute(k, v) {
        self.dataset[k] = v;
      },
      append(...kids) {
        for (const kid of kids) {
          // A real `append` on a node that is already a child moves it.
          if (kid.parent) kid.parent.children.splice(kid.parent.children.indexOf(kid), 1);
          kid.parent = self;
          self.children.push(kid);
        }
      },
      remove() {
        if (!self.parent) return;
        self.parent.children.splice(self.parent.children.indexOf(self), 1);
        self.parent = null;
      },
    };
    return self;
  }

  return {
    body,
    listeners,
    doc: {
      body,
      createElement: node,
      addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
      removeEventListener: (type, fn) => {
        const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
  };
}

/** Every node under `root` whose className contains `cls`, in document order. */
function all(root, cls) {
  const out = [];
  const walk = (n) => {
    if (String(n.className).split(/\s+/).includes(cls)) out.push(n);
    for (const kid of n.children) walk(kid);
  };
  walk(root);
  return out;
}
const one = (root, cls) => all(root, cls)[0] || null;

/**
 * `openCreateRoom`, lifted out of `web/app.js` and made callable.
 *
 * Brace-matched from its own `function` keyword rather than regex'd to the first `\n  }` —
 * the body has nested functions and a non-greedy match stops inside the first one. Every
 * free name it uses is a **parameter**, which is the second thing this pins: a dependency
 * the modal reaches for and this list does not name is a `ReferenceError` here rather than a
 * silent global in a browser.
 */
function liftCreateRoom() {
  const at = app.indexOf('function openCreateRoom()');
  assert.ok(at >= 0, '`openCreateRoom` must exist in web/app.js');
  let depth = 0;
  let end = -1;
  for (let i = app.indexOf('{', at); i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    else if (app[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > at, 'the function body must be balanced');
  const src = app.slice(at, end);
  const deps = [
    'document',
    'state',
    'panes',
    'postJSON',
    'openGroupRoom',
    'fetch',
    'MAX_MEMBERS',
    'MAX_ROOM_NAME',
    'canCreate',
    'capRefusal',
    'countLine',
    'createReason',
    'orderForHere',
    'roomParticipants',
    'rowFolder',
    'rowName',
  ];
  // eslint-disable-next-line no-new-func
  return new Function(...deps, `${src}\nreturn openCreateRoom;`);
}

const build = liftCreateRoom();

/** Open the box against a stub world, and hand back everything a test needs to press it. */
function openBox({ sessions = [ALPHA, BETA, GAMMA], open = null, post = null, cap = MAX_MEMBERS } = {}) {
  const { body, listeners, doc } = makeDom();
  const posts = [];
  const opened = [];
  const postJSON = async (url, payload) => {
    posts.push({ url, payload });
    if (typeof post === 'function') return post(payload);
    return { ok: true, room: { id: 'room-1', name: payload.name } };
  };
  const fetchStub = async () => ({ ok: true, json: async () => ({ rooms: [], maxMembers: cap }) });

  const openCreateRoom = build(
    doc,
    { sessions },
    [{ selected: () => open }],
    postJSON,
    (id) => opened.push(id),
    fetchStub,
    MAX_MEMBERS,
    MAX_ROOM_NAME,
    canCreate,
    capRefusal,
    countLine,
    createReason,
    orderForHere,
    roomParticipants,
    rowFolder,
    rowName,
  );
  openCreateRoom();

  const back = body.children[0];
  const escape = () => {
    for (const l of [...listeners]) if (l.type === 'keydown') l.fn({ key: 'Escape' });
  };
  return {
    body,
    back,
    listeners,
    posts,
    opened,
    escape,
    name: one(back, 'field-cap').children.find((c) => c.tagName === 'INPUT'),
    note: one(back, 'modal-note'),
    tally: one(back, 'room-pick-tally'),
    rows: all(back, 'room-pick-row'),
    create: all(back, 'ghost-btn').at(-1),
    cancel: all(back, 'ghost-btn')[0],
  };
}

/** Tick a row, the way a browser does: flip `checked`, then fire `onchange`. */
const tick = (row, on = true) => {
  const box = row.children.find((c) => c.tagName === 'INPUT');
  box.checked = on;
  box.onchange();
  return box;
};

/** Type into the name field. */
const type = (box, value) => {
  box.value = value;
  box.oninput();
};

test('the box opens with a name field, one row per participant, and the button off', () => {
  const ui = openBox();
  assert.equal(ui.back.className, 'modal-back');
  assert.equal(ui.rows.length, 3);
  assert.equal(ui.create.disabled, true);
  assert.equal(ui.tally.textContent, '0 of 8');
  assert.equal(ui.name.focused, true, 'the first field takes the caret');
  assert.equal(ui.name.maxLength, MAX_ROOM_NAME);
});

test('workers are not offered, and the rows carry ids rather than positions', () => {
  const ui = openBox({ sessions: [ALPHA, { ...BETA, team: { role: 'worker' } }, GAMMA] });
  assert.deepEqual(
    ui.rows.map((r) => r.children.find((c) => c.tagName === 'INPUT').dataset.id),
    ['alpha', 'gamma'],
  );
});

test('the open pane’s folder comes first, and the other projects still come', () => {
  const ui = openBox({ open: 'gamma' });
  assert.deepEqual(
    ui.rows.map((r) => one(r, 'room-pick-name').textContent),
    ['gamma', 'alpha', 'beta'],
  );
});

test('with nothing to offer the list says why, rather than being empty', () => {
  const ui = openBox({ sessions: [{ ...ALPHA, team: { role: 'worker' } }] });
  assert.equal(ui.rows.length, 0);
  const none = one(ui.back, 'room-pick-none');
  assert.match(none.textContent, /Workers are not members/);
});

test('a name alone will not make a room, and neither will a member alone', () => {
  const ui = openBox();
  type(ui.name, 'the checkout flow');
  assert.equal(ui.create.disabled, true, 'a name with nobody in it is a name');
  type(ui.name, '');
  tick(ui.rows[0]);
  assert.equal(ui.create.disabled, true, 'members with no name is not a room either');
  type(ui.name, 'the checkout flow');
  assert.equal(ui.create.disabled, false);
});

test('the tally counts what is ticked, and un-ticking counts back down', () => {
  const ui = openBox();
  tick(ui.rows[0]);
  tick(ui.rows[1]);
  assert.equal(ui.tally.textContent, '2 of 8');
  tick(ui.rows[1], false);
  assert.equal(ui.tally.textContent, '1 of 8');
});

test('the ninth tick is refused here, with a sentence, and the tick goes back off', () => {
  const many = Array.from({ length: 9 }, (_, i) => sess(`s${i}`));
  const ui = openBox({ sessions: many });
  for (let i = 0; i < 8; i += 1) tick(ui.rows[i]);
  assert.equal(ui.tally.textContent, '8 of 8');
  assert.ok(ui.tally.classList.contains('is-full'));

  const ninth = tick(ui.rows[8]);
  assert.equal(ninth.checked, false, 'a control that lies about its own state is worse than a no');
  assert.equal(ui.tally.textContent, '8 of 8');
  assert.match(ui.note.textContent, /at most 8 sessions/);
  assert.match(ui.note.className, /err/);
});

test('and the server’s own 400 is shown verbatim when one gets through', async () => {
  const refusal =
    'A room name is 61 characters and the cap is 60. It is refused rather than shortened.';
  const ui = openBox({
    post: () => {
      throw new Error(refusal);
    },
  });
  type(ui.name, 'x'.repeat(61));
  tick(ui.rows[0]);
  await ui.create.onclick();
  assert.equal(ui.note.textContent, refusal, 'the server’s sentence, not a paraphrase of it');
  assert.match(ui.note.className, /err/);
  assert.equal(ui.back.isConnected, true, 'a refused press leaves the box up to fix');
  assert.equal(ui.create.disabled, false, 'and leaves it pressable again');
});

test('a session that exited between the picker and the press is the server’s sentence too', async () => {
  const gone = 'No session beta. The panel is not watching one by that id — it may have exited.';
  const ui = openBox({
    post: () => {
      throw new Error(gone);
    },
  });
  type(ui.name, 'the checkout flow');
  tick(ui.rows[1]);
  await ui.create.onclick();
  assert.equal(ui.note.textContent, gone);
});

test('a successful press posts the name and the ticked ids, then opens the room it made', async () => {
  // Opened on gamma, so the list is gamma, alpha, beta — which is what makes this also a
  // test that the id travels on the row rather than on its position, and that the members
  // arrive in the order they were ticked rather than in the order they were drawn.
  const ui = openBox({ open: 'gamma' });
  type(ui.name, '  the checkout flow  ');
  tick(ui.rows[2]);
  tick(ui.rows[0]);
  await ui.create.onclick();

  assert.equal(ui.posts.length, 1);
  assert.equal(ui.posts[0].url, '/api/rooms');
  assert.equal(ui.posts[0].payload.name, 'the checkout flow', 'trimmed on the way out');
  assert.deepEqual(ui.posts[0].payload.members, ['beta', 'gamma']);
  assert.deepEqual(ui.opened, ['room-1'], 'the room that was made, by the id it came back with');
  assert.equal(ui.back.isConnected, false, 'and the box is gone');
});

test('Escape writes nothing, and takes its own listener with it', () => {
  const ui = openBox();
  type(ui.name, 'the checkout flow');
  tick(ui.rows[0]);
  ui.escape();
  assert.deepEqual(ui.posts, [], 'nothing was written');
  assert.deepEqual(ui.opened, []);
  assert.equal(ui.back.isConnected, false);
  assert.equal(ui.listeners.length, 0, 'a modal that leaves its keydown behind eats the next Escape');
});

test('cancel is the same door, and writes nothing either', () => {
  const ui = openBox();
  type(ui.name, 'the checkout flow');
  tick(ui.rows[0]);
  ui.cancel.onclick();
  assert.deepEqual(ui.posts, []);
  assert.equal(ui.back.isConnected, false);
  assert.equal(ui.listeners.length, 0);
});

test('Enter in the name field does not submit while nothing is ticked — it says why', () => {
  const ui = openBox();
  type(ui.name, 'the checkout flow');
  let prevented = false;
  ui.name.onkeydown({ key: 'Enter', preventDefault: () => (prevented = true) });
  assert.equal(prevented, true, 'never a newline in a single-line field');
  assert.deepEqual(ui.posts, [], 'and never a room nobody is in');
  assert.match(ui.note.textContent, /at least one/);
});

test('…and does submit once the card is complete, by the button’s own rule', async () => {
  const ui = openBox();
  type(ui.name, 'the checkout flow');
  tick(ui.rows[0]);
  ui.name.onkeydown({ key: 'Enter', preventDefault: () => {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(ui.posts.length, 1);
  assert.deepEqual(ui.opened, ['room-1']);
});

test('a key that is not Enter is left alone', () => {
  const ui = openBox();
  let prevented = false;
  ui.name.onkeydown({ key: 'a', preventDefault: () => (prevented = true) });
  assert.equal(prevented, false);
});

test('the server’s cap wins over the fallback once it lands', async () => {
  const ui = openBox({ cap: 3 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(ui.tally.textContent, '0 of 3');
  tick(ui.rows[0]);
  tick(ui.rows[1]);
  tick(ui.rows[2]);
  assert.equal(ui.tally.textContent, '3 of 3');
});

/* ------------------------------------------------- the standing rules --- */

test('nothing about rooms joins `composerSig`', () => {
  const sig = code.match(/const composerSig = \([\s\S]*?;\n/);
  assert.ok(sig, '`composerSig` must exist');
  assert.ok(!/room/i.test(sig[0]), 'that signature tears the whole composer down when it changes');
});

test('the modal is module scope, not per pane — a room is not a fact about one pane', () => {
  const factory = code.indexOf('function createPane(');
  const modal = code.indexOf('function openCreateRoom()');
  assert.ok(modal >= 0 && factory >= 0);
  assert.ok(modal < factory, '`openCreateRoom` sits above the pane factory, like `openNewSession`');
});

test('the band’s `+ room` is what opens it', () => {
  assert.match(code, /el\.roomsAdd\).*onclick = openCreateRoom/s);
});

test('the modal wears the repo’s own modal chrome and spells no colour of its own', () => {
  const block = styles.slice(styles.indexOf('the create-room modal'));
  const end = block.indexOf('/* ======');
  const css = end > 0 ? block.slice(0, end) : block;
  assert.match(css, /\.modal\.is-room/);
  assert.ok(
    !/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(css),
    'every colour is a token, so both themes come for free',
  );
  for (const cls of ['room-pick-list', 'room-pick-row', 'room-pick-name', 'room-pick-tally', 'room-pick-none']) {
    assert.match(css, new RegExp(`\\.${cls}\\b`), `\`${cls}\` must be styled`);
  }
});

test('the tick is drawn by the panel, never by the browser', () => {
  // Measured on the bench, and it is the reason this rule exists rather than a preference:
  // a stock checkbox is rendered by the UA, which takes its colours from the *browser's*
  // scheme rather than from this page's `data-theme`. With the panel in light theme and the
  // browser in dark, an **unticked** box came back a solid dark square — which in a
  // multi-select reads as ticked. `appearance: none` takes the UA out of the decision.
  const block = styles.slice(styles.indexOf('the create-room modal'));
  const end = block.indexOf('/* ======');
  const css = end > 0 ? block.slice(0, end) : block;
  const box = css.match(/\.room-pick-row input\[type='checkbox'\]\s*\{[^}]*\}/);
  assert.ok(box, 'the tick must carry rules of its own');
  assert.match(box[0], /appearance:\s*none/);
  assert.match(css, /input\[type='checkbox'\]:checked\s*\{[^}]*var\(--accent\)/);
  // And it stays a real checkbox: the row is a `<label>`, so the input is what the space
  // bar acts on and what `:focus-within` lights the row from.
  assert.match(css, /\.room-pick-row:focus-within/);
  const rowFn = app.slice(app.indexOf('function openCreateRoom()'));
  assert.match(rowFn.slice(0, rowFn.indexOf('\n}')), /tick\.type = 'checkbox'/);
});
