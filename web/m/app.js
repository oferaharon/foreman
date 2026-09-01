/*
 * The mobile shell — item 5.
 *
 * A second, much smaller front door at `/m` that shows **team leads only**: no ordinary
 * sessions, no worker sessions, no merge control, no room. The lead is already the thing
 * that decides what is worth the maintainer's attention, so leads-only makes that
 * architecture literal instead of building a second triage layer with less information than
 * the first.
 *
 * This file owns four things and nothing else: the websocket, the roster, a two-screen
 * hash router, and the home list with its launch button. The lead screen (item 6), the
 * answer cards (item 7) and the tasks tab (item 8) are separate modules behind a fixed
 * contract — see `mountLead` / `buildCard` / `mountTasks` in their stubs.
 *
 * It shares the panel's websocket, its API and its five answering endpoints, and shares no
 * render code at all with `web/app.js`. That is deliberate: `app.js` is a shared shell plus
 * a per-pane factory built around split view, and a responsive squeeze of it would make
 * every future desktop change a phone change too.
 */

import { mountLead, updateLead } from './lead.js';

/* ------------------------------------------------------------- state --- */

/*
 * One slot. The socket's frames all carry a `slot` because the desktop can hold two panes
 * open at once; a phone shows one thing at a time, so everything here is slot `a` — the
 * value the server defaults to, and the way the panel behaved before there were two.
 */
const SLOT = 'a';

const state = {
  /** `[{repo, name}]` from `GET /api/teams`, or null before the first answer. */
  teams: null,
  /** The roster, or null until the first frame — an empty array is a real answer and
      would otherwise be indistinguishable from "we have not asked yet". */
  sessions: null,
  connected: false,
};

/*
 * In-flight launches and their errors live in module scope, not on the button. The home
 * list is rebuilt from scratch on every roster frame, so a `disabled` set on a node is
 * wiped long before the launch returns — the desktop's duplicate button learned this the
 * hard way. Three fast taps must start one lead, not three.
 */
const launching = new Set();
const launchErrors = new Map();

/* -------------------------------------------------------------- bus --- */

/** type -> Set(handler). Screens subscribe through their ctx and never touch this. */
const bus = new Map();

function busOn(type, fn) {
  if (!bus.has(type)) bus.set(type, new Set());
  bus.get(type).add(fn);
}

function busOff(type, fn) {
  bus.get(type)?.delete(fn);
}

function emit(type, msg) {
  for (const fn of [...(bus.get(type) || [])]) {
    try {
      fn(msg);
    } catch (err) {
      console.error('[m]', type, err);
    }
  }
}

/* --------------------------------------------------------- websocket --- */

let ws = null;
let retry = 0;

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}/ws`);

  ws.onopen = () => {
    retry = 0;
    state.connected = true;
    paintConn();

    /*
     * Re-subscribe whatever is open. A subscription is *server* state — a tailer holding a
     * byte offset in a transcript — so a dropped socket or a panel restart takes it with
     * it, while the roster keeps arriving because that is broadcast to every client. The
     * result is a screen that looks perfectly alive above a transcript that silently
     * stopped minutes ago, and nothing on it says so. This is the single most expensive
     * bug in this project's history; it has been re-introduced once already, by a refactor
     * that re-subscribed a variable that no longer existed.
     */
    if (route.kind === 'lead' && route.sessionId) {
      send({ type: 'subscribe', sessionId: route.sessionId, slot: SLOT });
    }

    // The team list changes when a lead is launched in a folder that never had one, which
    // can happen at the Mac while the phone is asleep. Cheap enough to re-ask on every
    // open; it is four rows of two strings.
    loadTeams();
  };

  ws.onclose = () => {
    state.connected = false;
    paintConn();
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 400 * 2 ** retry);
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle(msg);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  if (msg.type === 'sessions') {
    state.sessions = msg.sessions || [];
    onRoster();
  } else if (msg.type === 'rebound') {
    onRebound(msg);
  }
  // Everything reaches the open screen either way — the roster included, since item 6's
  // header reads model and `ctx:` off it.
  emit(msg.type, msg);
}

/* ------------------------------------------------------------ router --- */

/*
 * Two screens: `#/` and `#/lead/<sessionId>`. The hash is the whole route, so the phone's
 * back gesture works without any history bookkeeping of ours.
 */
const route = { kind: 'home', sessionId: null };

/** The mounted screen's teardown, or null on the home screen. */
let leadCtx = null;
let leadEverSeen = false;
let goneTimer = null;

function parseHash() {
  const m = /^#\/lead\/(.+)$/.exec(location.hash || '#/');
  if (m) return { kind: 'lead', sessionId: decodeURIComponent(m[1]) };
  return { kind: 'home', sessionId: null };
}

function navigate() {
  const next = parseHash();
  if (next.kind === route.kind && next.sessionId === route.sessionId) return;

  leaveRoute();
  route.kind = next.kind;
  route.sessionId = next.sessionId;

  if (route.kind === 'lead') enterLead();
  else enterHome();
}

function leaveRoute() {
  if (route.kind === 'lead') {
    send({ type: 'unsubscribe', slot: SLOT });
    leadCtx?._dispose();
    leadCtx = null;
    leadEverSeen = false;
    clearTimeout(goneTimer);
    goneTimer = null;
  }
  if (route.kind === 'home') {
    clearInterval(homeTick);
    homeTick = null;
  }
  el.screen.replaceChildren();
}

/* --------------------------------------------------------------- dom --- */

const app = document.getElementById('app');

const el = {
  head: document.createElement('header'),
  title: document.createElement('div'),
  conn: document.createElement('span'),
  refresh: document.createElement('button'),
  screen: document.createElement('div'),
};

el.head.className = 'm-head';
el.title.className = 'm-title';
el.title.textContent = 'Leads';
el.conn.className = 'm-conn';
el.conn.textContent = '●';
el.refresh.className = 'm-icon-btn';
el.refresh.type = 'button';
el.refresh.textContent = '⟳';
el.refresh.setAttribute('aria-label', 'Refresh');
el.refresh.addEventListener('click', refresh);
el.head.append(el.title, el.conn, el.refresh);

el.screen.className = 'm-screen';

app.append(el.head, el.screen);

function paintConn() {
  el.conn.classList.toggle('is-down', !state.connected);
  el.conn.title = state.connected ? 'connected' : 'reconnecting…';
}

/* --------------------------------------------------------------- home --- */

let homeList = null;
let homeSignature = null;
let homeTick = null;

/*
 * How often the home screen repaints itself with nothing incoming.
 *
 * The roster is only broadcast when something *changed* (`sessions.js`'s `changed()` diff),
 * and a lead sitting genuinely idle is by definition changing nothing — so without this the
 * age is frozen at whatever it was when the last frame happened to arrive, and a card reads
 * `2m` an hour later. That is worse than showing no age at all: a stale number looks live.
 *
 * 30s, which is half the finest bucket that can move. `relativeTime`'s smallest step is a
 * minute (`now` → `1m` → `2m`), so the age on screen is never more than half a bucket
 * behind. Ticking faster buys nothing — the string cannot change more often than once a
 * minute. Ticking at 60s would let a boundary sit visibly wrong for most of a minute, on a
 * screen you pick up and glance at.
 *
 * `setInterval` rather than `requestAnimationFrame`, and not only because this is not an
 * animation: an automated Chrome window reports `document.visibilityState: 'hidden'` and
 * Chrome suspends rAF there, so a bench would show a tick that never fires and a bug that
 * is not in this file. `setInterval` survives it — measured rather than assumed, with a
 * control interval of this same period inside the bench page firing at 30.025s and 60.026s
 * while `visibilityState` read `hidden` throughout.
 *
 * And what the signature guard buys is visible in the same run: over 66s the tick fired
 * twice and the list repainted **once**, at the moment an age string actually changed
 * (`49m`→`50m`, `3m`→`4m`) — with one websocket frame received in the whole run, the
 * initial roster. A tick that repainted unconditionally would have rebuilt the list under
 * a thumb for nothing, twice a minute, for ever.
 */
const HOME_TICK_MS = 30_000;

function enterHome() {
  el.head.hidden = false;
  app.classList.remove('no-head');

  const scroll = document.createElement('div');
  scroll.className = 'm-scroll';
  homeList = document.createElement('div');
  homeList.className = 'm-teams';
  scroll.appendChild(homeList);
  el.screen.appendChild(scroll);

  // Mounted first, painted second. Anything that measures itself before its container is
  // in the document silently draws nothing — a busy screen then self-heals on the next
  // frame while a quiet one stays blank for hours, which is exactly how the desktop's room
  // panel shipped once.
  homeSignature = null;
  renderHome();

  // Torn down in `leaveRoute`, not left running behind the lead screen. `renderHome` would
  // bail on `homeList.isConnected` anyway once the screen is swapped, so a leak here is
  // silent rather than visible — which is exactly why it gets an explicit stop.
  clearInterval(homeTick);
  homeTick = setInterval(renderHome, HOME_TICK_MS);
}

/**
 * The lead for a team, or null.
 *
 * Matched on `paneCwd` — the pane's *launch* folder — because that is the identical value
 * `SessionRegistry#team` passes to `isLeadName` when it decides `isLead` in the first
 * place. `cwd` is the transcript's and moves when a session changes directory
 * mid-conversation, which is how the desktop once lost a session's binding entirely.
 */
function leadFor(repo) {
  return (state.sessions || []).find((s) => s.isLead && s.paneCwd === repo) || null;
}

/**
 * Is this lead holding something that needs a human?
 *
 * Spelled out rather than taken from `needsYou`, and this is not style. `needsYou` folds
 * in `unread > 0`, and `unread` is the *panel viewer's* read state — a server-side
 * watermark cleared by `markRead` the moment anyone scrolls a transcript to the bottom on
 * any device. A team indicator keyed on it says "handled" because somebody looked, which
 * on 2026-08-27 hid a finished worker and a PR waiting on the maintainer's merge word.
 */
function isBlocked(lead) {
  return (
    Boolean(lead.prompt) ||
    Boolean(lead.plan) ||
    Boolean(lead.question) ||
    lead.status === 'needs-decision'
  );
}

/**
 * Workers actually running for this team.
 *
 * Live panes, not task records. The store is deliberately never pruned when a pane dies,
 * so a crashed or hand-`/exit`ed worker leaves `working` on disk for ever and the desktop's
 * `N tasks` goes on advertising a worker that does not exist. The roster holds only
 * sessions with a live pane, so this number cannot be inflated that way.
 *
 * `review` is excluded so the row's two numbers are disjoint: a worker in `review` has
 * stopped and is waiting on the maintainer, and `N in review` is already its name. A reader
 * adds two numbers on one line, so they must never describe the same worker twice.
 *
 * And it is counted off `workerOf` and `team.state`, which `sessions.js` writes out of one
 * `#team()` call — the existing guard against a row being told it is a worker in one field
 * and something else in another. Counting off the task store, off `ACTIVE`, or off a fresh
 * `/api/team/tasks` fetch re-introduces exactly the divergence that guard exists to stop.
 *
 * Consequence, accepted rather than a bug: the phone and the Mac deliberately show
 * different numbers for the same team. The desktop can afford the looser count because the
 * worker rows are nested three lines under it; the phone has nothing else.
 */
function teamWorkers(repo) {
  return (state.sessions || []).filter((s) => s.workerOf === repo && s.team?.state !== 'review');
}

function liveWorkers(repo) {
  return teamWorkers(repo).length;
}

/**
 * Is this session *running*, as opposed to waiting on somebody?
 *
 * The second dot's whole rule, and it is deliberately the negative of `isBlocked` rather
 * than a list of the states that count. `status` is already the panel's own answer —
 * `sessions.js` lets a prompt, a plan or a picker outrank the hook precisely so that a
 * session holding a box never reads `working` — but the hook can still be a poll behind a
 * box that has just appeared, and `isBlocked` reads the box itself. Blocked is waiting; the
 * top dot has it, and a row must never claim both about the same fact.
 */
function isWorking(s) {
  return Boolean(s) && s.status === 'working' && !isBlocked(s);
}

/**
 * Workers of this team that are actually running right now.
 *
 * Built on `teamWorkers` rather than on its own filter so the `review` exclusion above
 * cannot drift: a worker in `review` has stopped and is waiting on the maintainer, which is
 * the top dot's business and not this one's — and the reason it is counted off the roster
 * rather than the task store is written out there in full.
 */
function workingWorkers(repo) {
  return teamWorkers(repo).filter(isWorking).length;
}

/**
 * How long ago, coarsely — `now`, `12m`, `3h`, `2d`.
 *
 * A local copy of `relativeTime` in `web/app.js` (~line 212), which is what the desktop
 * rail's duration column already reads. It mirrors that function deliberately and must go
 * on mirroring it: the same lead is on both screens, and one fact bucketed by two
 * vocabularies reads `59m` on the Mac and `1h` on the phone for the same instant. There is
 * no module boundary between `web/app.js` and this file to hang a shared helper on — they
 * do not import from each other — so this is a copy with a pointer, not an abstraction.
 * Change one, change the other.
 */
function relativeTime(ms) {
  if (!ms) return '';
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** One row's worth of facts, so a repaint can be skipped when nothing on screen moved. */
function homeRow(team) {
  const lead = leadFor(team.repo);
  if (!lead) {
    return {
      team,
      lead: null,
      dot: false,
      working: false,
      unread: 0,
      workers: 0,
      review: 0,
      blocked: false,
      ctx: null,
      age: '',
    };
  }
  const review = lead.team?.review || 0;
  const blocked = isBlocked(lead);
  // The second dot, and a separate rule on purpose — the two are never folded into one
  // condition. The top slot always means *this wants you*; the bottom always means *this
  // is running*. A team can be both at once (a blocked lead over a working worker) and
  // most often is neither.
  //
  // Hoisted out of the object literal only so `age` below can read it. Nothing else moved.
  const working = isWorking(lead) || workingWorkers(team.repo) > 0;
  return {
    team,
    lead,
    blocked,
    // The whole rule, and only this rule.
    dot: blocked || review > 0,
    working,
    unread: lead.unread || 0,
    workers: liveWorkers(team.repo),
    review,
    /*
     * How full this lead's context is — the number that says which one is heading for a
     * `/clear`, on the only screen that shows every team at once.
     *
     * `null` is a normal reading and not an error. `contextPct` is scraped off the composer
     * footer, which any box covers completely, so it is absent for exactly as long as a
     * lead is blocked — the same trap as `model` and `activity`, and they move together
     * because they are one line. The maintainer's call, taken when it was put to them: it
     * simply disappears then. The row is not silent while it does, because a blocked lead
     * is what lights the top dot.
     */
    ctx: Number.isFinite(lead.contextPct) ? Math.round(lead.contextPct) : null,

    /*
     * How long this lead has been sitting there — and the empty string is a state, not a
     * failure.
     *
     * Idle only, and idle here is spelled out as *not blocked and not working* rather than
     * `status === 'idle'`, so it cannot disagree with the two dots the row already draws. A
     * blocked lead is waiting on the maintainer and the word beside this one already says
     * `blocked`; an age there would be a second, quieter way of saying the same thing.
     *
     * `working` is the **team's** — `isWorking(lead) || workingWorkers(repo) > 0` — and
     * that is a ruling, not the nearest field to hand. The maintainer, 2026-08-30, asked
     * outright: *"While a worker is working from my perspective the lead is still working.
     * I am only interested to see idle time (while nothing is working — not the lead and
     * not its workers)."* So the number answers **is this whole team asleep**, not *is this
     * lead's own turn over* — an idle lead with a worker still grinding is a team that is
     * moving, and it shows no age. Do not narrow this to `!isWorking(lead)` to match the
     * desktop rail: the rail is a list of sessions and answers the per-session question,
     * this is a list of *teams* and deliberately does not. The same ruling is why the
     * desktop was left alone entirely — it was raised and declined in the same breath.
     *
     * Computed here rather than in `metaParts` on purpose. `renderHome`'s signature and the
     * card have to agree about what the age *string* is, or the tick fires against a
     * signature that never moves and the number on screen freezes — the whole failure this
     * feature exists to avoid. One field, both readers.
     *
     * And it is the bucketed string in the signature, never `lastActivity` itself: the raw
     * millisecond stamp differs on almost every roster frame, which would make the
     * signature differ on almost every roster frame and retire it as a repaint guard.
     */
    age: !blocked && !working ? relativeTime(lead.lastActivity) : '',
  };
}

function stateWord(row) {
  if (!row.lead) return 'no lead running';
  if (row.blocked) return 'blocked';
  // `dialog` is a box the panel will not answer — `/model`, `/effort`, the trust gate's
  // cousins. Saying `idle` there would be a lie, and it is not in the dot's rule.
  return row.lead.status || 'unknown';
}

function renderHome() {
  if (!homeList?.isConnected) return;

  if (!state.teams || !state.sessions) {
    const sig = 'loading';
    if (sig === homeSignature) return;
    homeSignature = sig;
    const note = document.createElement('div');
    note.className = 'm-note';
    note.textContent = 'Loading teams…';
    homeList.replaceChildren(note);
    return;
  }

  if (!state.teams.length) {
    const sig = 'empty';
    if (sig === homeSignature) return;
    homeSignature = sig;
    const note = document.createElement('div');
    note.className = 'm-note';
    note.textContent =
      'No teams yet. A team directory is created the first time a lead is launched in a folder — do that once at the Mac and the folder appears here.';
    homeList.replaceChildren(note);
    return;
  }

  const rows = state.teams.map(homeRow);

  // Repaint only when something a reader could see has changed. The roster is broadcast on
  // every real change and a list rebuilt under a thumb is a list that eats taps.
  const sig = JSON.stringify(
    rows.map((r) => [
      r.team.repo,
      r.lead?.id || null,
      stateWord(r),
      // The rendered string, not `lastActivity` — see the field's own note in `homeRow`.
      r.age,
      r.dot,
      r.working,
      r.ctx,
      r.unread,
      r.workers,
      r.review,
      launching.has(r.team.repo),
      launchErrors.get(r.team.repo) || '',
    ]),
  );
  if (sig === homeSignature) return;
  homeSignature = sig;

  homeList.replaceChildren(...rows.map(teamNode));
}

function teamNode(row) {
  const wrap = document.createElement('div');
  wrap.className = 'm-team';

  /*
   * One grid, three columns: the dot's gutter, the text, and a trailing control column
   * that the badge takes on line 1 and the launch button on line 2.
   *
   * The whole body is the tap target when there is a lead to open — and is a plain `div`
   * when there is not, because the launch button lives *inside* it and a `<button>` inside
   * a `<button>` is invalid markup whose disabled form swallows the child's clicks
   * outright. That would have killed the one control that matters on a team with no lead.
   */
  const body = document.createElement(row.lead ? 'button' : 'div');
  body.className = `m-team-body${row.lead ? '' : ' is-static'}`;
  if (row.lead) {
    body.type = 'button';
    body.addEventListener('click', () => {
      location.hash = `#/lead/${encodeURIComponent(row.lead.id)}`;
    });
  }

  /*
   * The gutter is two reserved slots, not one dot that moves.
   *
   * The maintainer's call, taken when it was put to them: the top slot always means *this
   * wants you* and the bottom always means *this is running*, whether or not the other is
   * drawn. A lone dot that slid into the middle would be a dot you have to read the row to
   * interpret, which is the one thing a dot is for. So both slots are always in the DOM and
   * an unlit one is simply not painted — the geometry cannot drift, because there is no
   * branch that changes it.
   */
  const gutter = document.createElement('span');
  gutter.className = 'm-dots';
  gutter.append(
    slotDot('m-dot-wait', row.dot, row.blocked ? 'holding a box' : 'a task is waiting on you'),
    slotDot('m-dot-work', row.working, 'this team is working'),
  );
  body.appendChild(gutter);

  const name = document.createElement('span');
  name.className = 'm-team-name';
  name.textContent = row.team.name;
  body.appendChild(name);

  // A muted numeric badge, deliberately not the dot and deliberately not amber: it answers
  // a different question — the lead has said something since I last looked. Every count on
  // this row drops entirely at zero, this one included.
  if (row.lead && row.unread > 0) {
    body.classList.add('has-badge');
    const badge = document.createElement('span');
    badge.className = 'm-badge';
    badge.textContent = row.unread > 99 ? '99+' : String(row.unread);
    badge.title = `${row.unread} unread ${row.unread === 1 ? 'reply' : 'replies'}`;
    body.appendChild(badge);
  }

  const meta = document.createElement('span');
  meta.className = 'm-team-meta';
  meta.append(...metaParts(row));
  body.appendChild(meta);

  /*
   * The context percentage, at the right-hand end of the same line.
   *
   * It rides in the trailing column rather than inside the meta text, which keeps the
   * meta's own `overflow: hidden` ellipsis doing what it already does — a `2 workers · 3 in
   * review` that has to give way gives way on its own, and the percentage never ellipsises
   * into `3` + `4`. Grid also means it cannot make the row taller: it lands in a cell that
   * already exists, beside a meta line it is smaller than.
   *
   * It shares that cell with the launch button below, and the two are mutually exclusive by
   * construction — a percentage needs a lead and the button is only built when there is
   * none. Nothing is layered.
   */
  if (row.ctx != null) {
    const ctx = document.createElement('span');
    ctx.className = 'm-team-ctx';
    ctx.textContent = `${row.ctx}%`;
    ctx.title = `${row.ctx}% of this lead's context used`;
    body.appendChild(ctx);
  }

  if (!row.lead) {
    // The row *is* the launch menu: the home list is the teams that already exist, which
    // is precisely the folder menu the ruling asked for, so there is no path typing and no
    // second screen for a four-item choice.
    //
    // It sits on the second line, beside `no lead running`, rather than spanning both. On
    // line 1 it took the trailing column from the name, and the row that most needs
    // reading — the one you are about to launch into — was the one whose name ellipsised.
    const busy = launching.has(row.team.repo);
    const start = document.createElement('button');
    start.type = 'button';
    start.className = `m-team-launch${busy ? ' is-busy' : ''}`;
    start.textContent = busy ? 'starting…' : 'start lead';
    start.disabled = busy;
    start.addEventListener('click', () => startLead(row.team));
    body.appendChild(start);
  }

  wrap.appendChild(body);

  const err = launchErrors.get(row.team.repo);
  if (err) {
    const line = document.createElement('div');
    line.className = 'm-team-error';
    // The server's own sentence, verbatim. "Not a git repository — a team lead needs one"
    // and "This project already has a team lead" are both real answers and both tell you
    // what to do next; a rewrite here would lose that.
    line.textContent = err;
    wrap.appendChild(line);
  }

  return wrap;
}

/** One slot of the gutter. Off means unpainted, never absent — see `teamNode`. */
function slotDot(kind, on, title) {
  const dot = document.createElement('span');
  dot.className = `m-dot ${kind}${on ? ' is-on' : ''}`;
  if (on) dot.title = title;
  return dot;
}

/** The second line: state, then the counts, each dropping entirely at zero. */
function metaParts(row) {
  const parts = [];
  const word = document.createElement('span');
  word.className = `m-team-state${row.blocked ? ' is-blocked' : ''}`;
  word.textContent = stateWord(row);
  parts.push(word);

  // Straight after the state word, so it reads as one clause — `idle · 2h`. Its own class,
  // never a borrowed one: the boxed `.m-team-review` sits in this same line and takes a
  // third row of its own (the maintainer's call, 2026-08-30), and an age sharing that name
  // would inherit the box.
  if (row.age) {
    const a = document.createElement('span');
    a.className = 'm-team-age';
    a.textContent = ` · ${row.age}`;
    a.title = 'idle for this long';
    parts.push(a);
  }

  if (row.workers > 0) {
    const w = document.createElement('span');
    // `workers`, not `running`: the same line already carries the lead's own state, and
    // `idle · 2 running` invites a half-second of "idle, or running?" every read.
    w.textContent = ` · ${row.workers} ${row.workers === 1 ? 'worker' : 'workers'}`;
    parts.push(w);
  }

  if (row.review > 0) {
    const r = document.createElement('span');
    r.className = 'm-team-review';
    r.textContent = ` · ${row.review} in review`;
    parts.push(r);
  }

  return parts;
}

async function startLead(team) {
  if (launching.has(team.repo)) return;
  launching.add(team.repo);
  launchErrors.delete(team.repo);
  renderHome();

  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `terminal: true` on purpose. A Terminal window is the only place the folder-trust
      // gate can be answered if this folder's record was lost, and there is no terminal on
      // a phone. It costs a window on a Mac nobody is sitting at.
      body: JSON.stringify({ lead: true, folder: team.repo, terminal: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Launch failed (${res.status}).`);

    if (data.sessionId) {
      // Straight into it — and note what that lands on: a session that has not yet written
      // a transcript carries a synthetic `pane-19` id, `subscribe` answers with an empty
      // transcript, and the registry issues a `rebound` the moment it first speaks. See
      // `onRebound`.
      location.hash = `#/lead/${encodeURIComponent(data.sessionId)}`;
    }
  } catch (err) {
    launchErrors.set(team.repo, err.message || String(err));
  } finally {
    launching.delete(team.repo);
    renderHome();
  }
}

/* --------------------------------------------------------------- lead --- */

function enterLead() {
  // The lead screen draws its own header (back, team, model, `ctx:`, interrupt), so the
  // shell's stands down and the frame takes over the status-bar inset.
  el.head.hidden = true;
  app.classList.add('no-head');

  // A hash typed, bookmarked or reloaded can name anything. The home list only ever links
  // leads, so this is the one door an ordinary or worker session could come through.
  const known = sessionOf(route.sessionId);
  if (known && !known.isLead) return showGone('not-lead');

  const host = document.createElement('div');
  host.className = 'm-host';
  el.screen.appendChild(host);

  leadCtx = makeCtx();
  leadEverSeen = Boolean(sessionOf(route.sessionId));

  // Mounted before anything paints, for the reason in `enterHome`.
  mountLead(host, leadCtx);

  send({ type: 'subscribe', sessionId: route.sessionId, slot: SLOT });
}

/**
 * The screen's window onto the shell. These six names are the contract items 6, 7 and 8
 * are written against; nothing else here is public.
 */
function makeCtx() {
  const mine = [];
  return {
    /*
     * A live getter, not a snapshot. A freshly launched lead's id changes under it (see
     * `onRebound`) and a screen holding the old string would go on filtering every frame
     * against an id the server has stopped using — a permanently blank transcript on the
     * one session the maintainer just started.
     */
    get sessionId() {
      return route.sessionId;
    },
    session: () => sessionOf(route.sessionId),
    /*
     * How many workers this lead has running, for the mark on its `tasks` tab.
     *
     * Answered here rather than handed the roster, so `liveWorkers` stays the one place
     * that decides what a running worker is. Two spellings of that rule could disagree —
     * the home list saying `2 workers` over a tab reading `3` is the `isLeadName` lesson
     * in a smaller costume — and the phone's whole claim over the desktop's count is that
     * it is the honest one.
     *
     * `paneCwd` is the pane's *launch* folder, which is the identical value
     * `SessionRegistry#team` hands `isLeadName`, and the same key `leadFor` matches on.
     * `cwd` is the transcript's and moves when a session changes directory.
     */
    workers: () => {
      const repo = sessionOf(route.sessionId)?.paneCwd;
      return repo ? liveWorkers(repo) : 0;
    },
    send: (msg) => send({ slot: SLOT, ...msg }),
    on: (type, fn) => {
      mine.push([type, fn]);
      busOn(type, fn);
    },
    off: (type, fn) => {
      busOff(type, fn);
    },
    /* Shell-internal: every handler a screen registered goes when the screen does, so a
       route change cannot leave a dead screen listening to the socket. */
    _dispose() {
      for (const [type, fn] of mine) busOff(type, fn);
      mine.length = 0;
    },
  };
}

function sessionOf(id) {
  return (state.sessions || []).find((s) => s.id === id) || null;
}

/**
 * The registry moved a session from its synthetic id to a real one.
 *
 * Until a session has written a transcript it appears as `pane-19`; the moment it first
 * speaks the registry issues this frame and — importantly — **re-subscribes the slot
 * itself**, immediately after sending it. So the client follows the id and must not
 * subscribe again; the desktop does exactly the same.
 *
 * A phone that just tapped `start lead` and was dropped into the new lead is in precisely
 * this state, which is what makes this the shell's problem rather than the lead screen's.
 * `replaceState` rather than assigning `location.hash`, because that would fire a
 * `hashchange`, re-route, and tear down the screen that is mid-subscribe.
 */
function onRebound(msg) {
  if (route.kind !== 'lead' || msg.from !== route.sessionId) return;
  route.sessionId = msg.to;
  leadEverSeen = false;
  clearTimeout(goneTimer);
  goneTimer = null;
  history.replaceState(null, '', `#/lead/${encodeURIComponent(msg.to)}`);
  updateLead(sessionOf(msg.to));
}

function onRoster() {
  if (route.kind === 'home') {
    renderHome();
    return;
  }

  const session = sessionOf(route.sessionId);
  if (session) {
    /*
     * The id survived, but it may not be a lead any more — and that is not hypothetical.
     * Measured on the bench: a lead was launched from the phone, opened, and then `/exit`ed.
     * Its pane died, and the registry re-bound that *same session id* to the only other
     * unbound pane in the folder — an ordinary, non-lead session. The screen went on
     * updating, under the same URL, now showing a conversation the phone is not allowed to
     * show at all.
     *
     * So the route re-checks the fact it was opened on. No grace period: `isLead` is read
     * off the session's tmux name and cannot flicker for a lead that is still a lead.
     */
    if (!session.isLead) return showGone('not-lead');
    leadEverSeen = true;
    clearTimeout(goneTimer);
    goneTimer = null;
    updateLead(session);
    return;
  }

  updateLead(null);

  /*
   * Missing from the roster. That is normal for a beat — a rotation or a rebound removes
   * the old id in the same frame that carries the new one — so it is only a gone session
   * if it stays missing. Armed only for a session we have actually seen: you cannot say
   * one went away if it was never there, and a launch navigates a step ahead of the
   * broadcast that would prove it.
   */
  if (!leadEverSeen || goneTimer) return;
  goneTimer = setTimeout(() => {
    goneTimer = null;
    if (route.kind !== 'lead' || sessionOf(route.sessionId)) return;
    showGone();
  }, 4000);
}

function showGone(reason = 'exited') {
  // Stop reading a transcript this screen has no business holding open.
  send({ type: 'unsubscribe', slot: SLOT });
  leadCtx?._dispose();
  leadCtx = null;
  clearTimeout(goneTimer);
  goneTimer = null;
  el.screen.replaceChildren();

  const box = document.createElement('div');
  box.className = 'm-gone';
  const text = document.createElement('div');
  text.className = 'm-gone-text';
  text.textContent =
    reason === 'not-lead'
      ? 'That session is not a team lead. This view shows leads only.'
      : 'This lead is no longer running. It was closed or it exited.';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'm-back';
  back.textContent = '‹ leads';
  back.addEventListener('click', () => {
    location.hash = '#/';
  });
  box.append(text, back);
  el.screen.appendChild(box);
}

/* --------------------------------------------------------------- api --- */

async function loadTeams() {
  try {
    const res = await fetch('/api/teams');
    const data = await res.json();
    // Sorted here as well as on the server: the order is a promise about where a row will
    // be, and it should not depend on which end sorted it. The desktop rail reorders by
    // urgency; a list that reorders under a thumb is how you tap the wrong row.
    state.teams = (data.teams || [])
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en'));
  } catch {
    state.teams = state.teams || [];
  }
  if (route.kind === 'home') renderHome();
}

async function loadRoster() {
  // First paint, before the socket lands. Never overwrites a socket frame — that one is
  // newer by construction.
  if (state.sessions) return;
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (!state.sessions) {
      state.sessions = data.sessions || [];
      onRoster();
    }
  } catch {
    /* the socket is the real source; it will be along */
  }
}

function refresh() {
  el.refresh.classList.add('is-busy');
  loadTeams().finally(() => el.refresh.classList.remove('is-busy'));
  if (ws?.readyState !== WebSocket.OPEN && ws?.readyState !== WebSocket.CONNECTING) {
    retry = 0;
    connect();
  }
}

/* --------------------------------------------------------------- boot --- */

window.addEventListener('hashchange', navigate);

paintConn();
// No route yet, so `navigate` always mounts one — including a reload that landed straight
// on `#/lead/<id>`, which has to come back to that lead rather than to the list.
route.kind = null;
navigate();

loadTeams();
loadRoster();
connect();
