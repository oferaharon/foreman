/*
 * tasks.js — item 8. The tasks tab: the desktop's TASKS block, rebuilt for a narrow
 * column. Rows are **records**, not sessions — state, id, chips, PR link, branch. There
 * is no route from here into a worker session, and there is no close button: closing a
 * task ends a session and deletes a worktree, which is not a thing to have under a thumb.
 *
 *   mountTasks(host, repo)
 *
 * `host` is already in the document when this is called. Polling is driven off the
 * host's own visibility, not a callback from the lead screen — the contract has none —
 * so it works under whatever mechanism item 6's tab strip uses to hide the other tab, as
 * long as that is the ordinary `display: none`/detach kind. Each call gets a fresh host
 * (the router remounts the whole lead screen on every navigation), so a stale poll simply
 * notices `!host.isConnected` and stops; there is nothing else to clean up.
 */

import { marked } from '/vendor/marked.js';

marked.setOptions({ gfm: true, breaks: true });

/** Server-driven filter + brief=0 already did the work; nothing here re-filters. */
const POLL_MS = 3000;

/** Stored state joined with the live pane — stuck and blocked outrank the record. Copied
 *  from `web/app.js`'s `taskChipState`, not imported — items here share no render code
 *  with the desktop. */
function taskChipState(t) {
  if (t.live?.stuck) return 'stuck';
  if (t.live && (t.live.status === 'needs-decision' || t.live.needsYou)) return 'blocked';
  return t.state;
}

/** Same tiers as the desktop's `TASK_RANK` (`app.js:2728`), copied rather than imported. */
const TASK_RANK = {
  stuck: 0, blocked: 0,
  review: 1,
  dispatched: 2, working: 2, queued: 2,
  pending: 3,
  // done / failed / abandoned fall through to CLOSED_RANK
};
const CLOSED_RANK = 4;

function agoText(ms) {
  if (!ms) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function mountTasks(host, repo) {
  host.innerHTML = '';
  host.className = 'm-tk';

  const scroll = document.createElement('div');
  scroll.className = 'm-scroll m-tk-scroll';
  host.appendChild(scroll);

  const list = document.createElement('div');
  list.className = 'm-tk-list';
  scroll.appendChild(list);

  /** @type {{tasks: Array|null, error: string|null, sig: string|null}} */
  const view = { tasks: null, error: null, sig: null };

  function render() {
    // The container can outlive an in-flight fetch (navigated away mid-poll).
    if (!list.isConnected) return;

    if (view.tasks == null) {
      const sig = view.error ? `error:${view.error}` : 'loading';
      if (sig === view.sig) return;
      view.sig = sig;
      const note = document.createElement('div');
      note.className = view.error ? 'm-note is-error' : 'm-note';
      note.textContent = view.error || 'Loading tasks…';
      list.replaceChildren(note);
      return;
    }

    // The quiet case (T13): a team with no tasks yet must say so, not sit blank. Nothing
    // here measures layout, so there is no `isConnected`-before-mount trap to reintroduce
    // — the guard above is enough.
    if (!view.tasks.length) {
      const sig = 'empty';
      if (sig === view.sig) return;
      view.sig = sig;
      const note = document.createElement('div');
      note.className = 'm-note';
      note.textContent = 'No tasks yet. The lead dispatches them.';
      list.replaceChildren(note);
      return;
    }

    const rows = [...view.tasks].sort((a, b) => {
      const ra = TASK_RANK[taskChipState(a)] ?? CLOSED_RANK;
      const rb = TASK_RANK[taskChipState(b)] ?? CLOSED_RANK;
      return ra - rb || (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    // Skip the repaint when nothing on screen would actually move — a poll fires every
    // three seconds and most of them change nothing.
    const sig = rows
      .map((t) => [t.id, t.state, t.live?.status, t.live?.stuck, t.pr, t.deploy?.label, t.updatedAt].join(':'))
      .join('~');
    if (sig === view.sig) return;
    view.sig = sig;

    list.replaceChildren(...rows.map(taskRow));
  }

  function taskRow(t) {
    const chipState = taskChipState(t);
    const row = document.createElement('div');
    row.className = 'm-tk-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Brief for ${t.id}`);

    const line = document.createElement('div');
    line.className = 'm-tk-line';

    const chip = document.createElement('span');
    chip.className = `m-tk-chip is-${chipState}`;
    chip.textContent = chipState;
    line.appendChild(chip);

    const id = document.createElement('span');
    id.className = 'm-tk-id';
    id.textContent = t.id;
    line.appendChild(id);

    // A planner never opens a PR and its branch stays empty — bare, muted chip, a fact
    // about the task rather than a state competing with the one beside it.
    if (t.kind === 'plan') {
      const kind = document.createElement('span');
      kind.className = 'm-tk-chip';
      kind.textContent = 'plan';
      kind.title = t.planFile ? `Plan → ${t.planFile}` : 'A planner: writes a plan, cannot write code.';
      line.appendChild(kind);
    }

    // `done` means the PR merged; this says whether that code reached the checkout in
    // front of you. `unknown` carries no label and is skipped — no answer beats a wrong one.
    if (t.deploy?.label) {
      const dep = document.createElement('span');
      dep.className = `m-tk-chip is-${t.deploy.state}`;
      dep.textContent = t.deploy.label;
      dep.title = t.deploy.why;
      line.appendChild(dep);
    }

    if (t.pr) {
      const pr = document.createElement('a');
      pr.className = 'm-tk-pr';
      pr.href = t.pr;
      pr.target = '_blank';
      pr.rel = 'noopener';
      pr.textContent = 'PR';
      // The row opens the brief; without this a tap on the link opens it *and* the modal.
      pr.onclick = (e) => e.stopPropagation();
      line.appendChild(pr);
    }

    row.appendChild(line);

    if (t.branch) {
      const branch = document.createElement('div');
      branch.className = 'm-tk-branch';
      branch.textContent = t.branch;
      row.appendChild(branch);
    }

    const open = () => openBrief(t, chipState);
    row.onclick = () => {
      if (window.getSelection()?.toString()) return; // a drag-select ending on the row still fires click
      open();
    };
    row.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open();
    };

    return row;
  }

  /** Is the tasks tab actually the one on screen right now? No callback exists for this
   *  in the contract, so it is read off the host's own layout: `offsetParent` is null the
   *  instant an ancestor goes `display: none`, which is the ordinary way a tab strip hides
   *  the sibling panel. Reading it forces the synchronous layout that already backs it, so
   *  there is nothing async to wait on and no `requestAnimationFrame` to lose to trap T14. */
  function tabVisible() {
    return document.visibilityState === 'visible' && host.offsetParent !== null;
  }

  async function poll() {
    if (!host.isConnected) return;
    if (!tabVisible()) return; // no fetch at all while hidden — not just a slower one
    try {
      const res = await fetch(`/api/team/tasks?folder=${encodeURIComponent(repo)}&brief=0`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Could not load tasks (${res.status}).`);
      view.tasks = data.tasks || [];
      view.error = null;
    } catch (err) {
      // A missed poll only becomes an error state if nothing has ever loaded — otherwise
      // the last good list stays up and the next tick tries again.
      if (view.tasks == null) view.error = err.message || String(err);
    }
    render();
  }

  render();
  poll();
  const timer = setInterval(() => {
    if (!host.isConnected) {
      clearInterval(timer);
      return;
    }
    poll();
  }, POLL_MS);
}

/**
 * The read-only brief modal. Facts, the brief as markdown, and — for a planner — its plan,
 * collapsed. Mirrors `openTaskBrief` / `taskPlanReader` in `web/app.js` in what it shows,
 * not in how it's built: one scroller for the whole box rather than the desktop's two, which
 * is what let the desktop's `<details>` clip its own last lines (`decisions.md`,
 * 2026-08-26). A phone has no fixed chrome budget to protect, so there is nothing to buy
 * back by splitting the scroll.
 *
 * The list's `brief=0` poll never carries `body`; this fetches the one task it needs
 * rather than asking the list to carry every team's briefs on every three-second tick.
 */
function openBrief(t, chipState) {
  const back = document.createElement('div');
  back.className = 'm-tk-modal-back';
  const box = document.createElement('div');
  box.className = 'm-tk-modal';

  const head = document.createElement('div');
  head.className = 'm-tk-modal-head';
  const h = document.createElement('h2');
  h.textContent = t.id;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'm-tk-modal-x';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close');
  head.append(h, closeBtn);
  box.appendChild(head);

  const meta = document.createElement('dl');
  meta.className = 'm-tk-meta';
  const fact = (label, value) => {
    if (!value) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    meta.append(dt, dd);
  };
  fact('state', chipState);
  fact('kind', t.kind);
  fact('model', t.model);
  fact('why', t.modelReason);
  fact('source', t.source);
  fact('branch', t.branch);
  if (t.kind === 'plan') fact('plan', t.planFile);
  fact('created', agoText(t.createdAt));
  fact('updated', agoText(t.updatedAt));
  if (meta.childElementCount) box.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'm-tk-body m-tk-md';
  body.textContent = 'Loading brief…';
  box.appendChild(body);

  if (t.kind === 'plan') box.appendChild(planReader(t));

  back.appendChild(box);
  document.body.appendChild(back);

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey, true);
  closeBtn.onclick = close;
  back.onmousedown = (e) => {
    if (e.target === back) close();
  };

  fetch(`/api/team/tasks/${encodeURIComponent(t.id)}`)
    .then(async (res) => ({ ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }))
    .then(({ ok, status, data }) => {
      if (!back.isConnected) return; // closed before the fetch landed
      if (!ok) throw new Error(data.error || `Could not load the brief (${status}).`);
      const text = data.task?.body;
      if (text) {
        body.innerHTML = marked.parse(text);
      } else {
        body.textContent = 'No brief was recorded.';
        body.classList.add('is-faint');
      }
    })
    .catch((err) => {
      if (!back.isConnected) return;
      body.textContent = err.message || String(err);
      body.classList.add('is-error-text');
    });

  closeBtn.focus();
}

/**
 * A planner's document, collapsed below its brief. Fetched on first expand, never on
 * render — this modal is rebuilt fresh per open, so there is no render loop to guard
 * against here the way `renderTasks` has to on the desktop.
 */
function planReader(t) {
  const box = document.createElement('details');
  box.className = 'm-tk-plan';

  const summary = document.createElement('summary');
  const file = t.planFile || '';
  summary.textContent = file.split('/').filter(Boolean).at(-1) || 'plan';
  if (file) summary.title = file;
  box.appendChild(summary);

  const md = document.createElement('div');
  md.className = 'm-tk-plan-md m-tk-md';
  md.textContent = 'reading…';
  box.appendChild(md);

  let loaded = false;
  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true;
    try {
      const res = await fetch(`/api/team/plans/${encodeURIComponent(t.id)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.text === 'string') {
        md.innerHTML = marked.parse(data.text);
        return;
      }
      loaded = false; // let the next open retry
      md.textContent = data.error || `Could not read it (${res.status}).`;
      if (data.path) {
        const where = document.createElement('div');
        where.className = 'm-tk-plan-path';
        where.textContent = data.path;
        md.appendChild(where);
      }
    } catch (e) {
      loaded = false;
      md.textContent = e.message;
    }
  });
  return box;
}
