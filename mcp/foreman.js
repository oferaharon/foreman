#!/usr/bin/env node
import readline from 'node:readline';

import { humanName } from '../server/human-name.js';

/**
 * The team's hands — a stdio MCP server over the panel's HTTP API, serving two very
 * different surfaces off one file:
 *
 *   FOREMAN_ROLE=lead  (default)  dispatch, status, read, send, close, the room, and the
 *                             answering tools — each behind its own team toggle, and the
 *                             permission and plan-approval ones default off
 *   FOREMAN_ROLE=worker           exactly two tools: room_post and task_report. No status,
 *                             no dispatch, no reading — a worker writes to the log and
 *                             reports its own task, and can touch nothing else.
 *
 * Hand-rolled on purpose: the repo carries three dependencies and this needs a fraction
 * of the protocol — newline-delimited JSON-RPC, `initialize`, `tools/list`, `tools/call`.
 *
 * Scoping is the design, not a convenience: `FOREMAN_REPO` pins every tool to the one repo
 * this session belongs to; `FOREMAN_TASK` pins a worker to its own task. Neither is an
 * argument any tool accepts.
 */

const PORT = Number(process.env.FOREMAN_PORT || 48770);
const REPO = process.env.FOREMAN_REPO || null;
const TASK = process.env.FOREMAN_TASK || null;
const BASE = `http://127.0.0.1:${PORT}`;

// Who this team reports to, detected once at startup from the repo this process is
// pinned to (`git config user.name`, falling back to "the human"). Every tool description
// below names them, and a description is prose a model reads on every call — so this is a
// module constant *here*, where the process serves exactly one repo, and never in the
// panel, where briefs are generated for many.
const HUMAN = humanName(REPO);

// Fail closed, not open. An absent FOREMAN_ROLE used to default to 'lead' — the more
// powerful of the two surfaces — which meant a misconfigured launch silently became a
// lead instead of refusing. Every launch path must name its role explicitly now.
const ROLES = ['lead', 'worker'];
const ROLE = process.env.FOREMAN_ROLE;
if (!ROLE) {
  process.stderr.write(
    `foreman.js: FOREMAN_ROLE is not set — refusing to start. Set it to one of: ${ROLES.join(', ')}.\n`,
  );
  process.exit(1);
}
if (!ROLES.includes(ROLE)) {
  process.stderr.write(
    `foreman.js: FOREMAN_ROLE=${JSON.stringify(ROLE)} is not a recognised role — refusing to start. Valid roles: ${ROLES.join(', ')}.\n`,
  );
  process.exit(1);
}

async function api(method, url, body = null) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Panel said ${res.status}.`);
  return data;
}

const repoQ = () => `folder=${encodeURIComponent(REPO || '')}`;

/** Task id → the full task row (repo-scoped), or throw naming what's missing. */
async function taskRow(taskId) {
  const { tasks } = await api('GET', '/api/team/tasks');
  const task = tasks.find((t) => t.id === taskId && (!REPO || t.repo === REPO));
  if (!task) throw new Error(`No such task: ${taskId}`);
  return task;
}

async function sessionFor(taskId) {
  const task = await taskRow(taskId);
  if (!task.live?.sessionId) throw new Error(`Task ${taskId} has no live session (state: ${task.state}).`);
  return task.live.sessionId;
}

/** The worker's roster row — the live question/prompt/plan state rides on it. */
async function sessionRow(sessionId) {
  const { sessions } = await api('GET', '/api/sessions');
  const row = sessions.find((s) => s.id === sessionId);
  if (!row) throw new Error('The worker session vanished from the roster.');
  return row;
}

/**
 * The toggle gate. Toggles are fetched at call time so a flip in the panel applies to the
 * very next call — and a missing team reads as everything off, never everything on.
 */
async function requireToggle(name) {
  const team = await api('GET', `/api/team/config?${repoQ()}`);
  if (!team?.toggles?.[name]) {
    throw new Error(
      `The "${name}" toggle is off for this team — surface this to ${HUMAN} instead of answering.`,
    );
  }
}

const requireGrounds = (grounds) => {
  if (!String(grounds || '').trim()) {
    throw new Error(
      `No grounds given. Cite where the answer comes from (CLAUDE.md, decisions.md, or what ${HUMAN} said) — if you cannot, escalate instead.`,
    );
  }
};

/**
 * The `grounds` trade, applied to the human's *second* yes.
 *
 * A pending task was approved once, as an idea. Starting it spends money, a cap slot and
 * a worktree, and the maintainer's ruling (2026-08-26, decisions.md) is that nothing comes
 * off the backlog on the original green-light — it needs a fresh, per-task yes, however
 * short. Nothing here can prove they said it. What this does is force the lead to state
 * it, and put the claim in the room where they can see it: the same trade
 * `worker_answer_question`
 * already makes. The schema's `required` catches an omitted field at the protocol layer;
 * this catches the whitespace string that satisfies it.
 */
const requireConfirmation = (confirmation) => {
  if (!String(confirmation || '').trim()) {
    throw new Error(
      `No confirmation given. Starting a pending task needs a fresh, per-task yes from ${HUMAN} — quote it, however short. The yes that got it recorded is not this yes.`,
    );
  }
};

/** Markdown lines that carry no prose of their own — a brief almost always opens with
 *  one of these (every brief in this file starts `## Why`), so the preview has to look
 *  past them for the first line that actually says something. */
const HEADING_RE = /^#{1,6}(\s|$)/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const EMPTY_BULLET_RE = /^(?:[-*+]|\d+[.)])$/;
const isStructural = (line) => HEADING_RE.test(line) || HR_RE.test(line) || EMPTY_BULLET_RE.test(line);

/** Strip a leading heading/bullet/blockquote marker so the preview reads as a sentence,
 *  not as source. Inline markup (`**bold**`, `` `code` ``) is left alone — a 120-char
 *  preview doesn't need a real markdown stripper. */
const stripLeadingMarkers = (line) => line.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+/, '');

/** The first line of a brief that actually says something, capped — the whole body
 *  belongs in tasks.json, not in every team_status call for the rest of the project's
 *  life. A brief that is nothing but headings has no such line; falling back to the
 *  first one anyway is correct — an odd preview beats an empty one. */
function briefOf(body) {
  const lines = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = stripLeadingMarkers(lines.find((l) => !isStructural(l)) ?? lines[0] ?? '');
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * A task row, trimmed to what a lead decides on. Drops `body` (→ `brief`), and the
 * fields that are purely dispatch/deploy-tracker plumbing (`worktree`, `base`,
 * `planFile`, `tmuxSession`, `pane`, the timestamps, `source`, `head`, `changed`) — none
 * of which a lead reads off this list. `repo` is dropped too: it's already the top-level
 * field, since a lead is scoped to one. `deploy` keeps `state`/`deployed` and drops
 * `label` (a copy of `state` for the panel's badge) and `why` (a full sentence restating
 * it — a lead can ask if it needs the story).
 */
function summarizeTask(t) {
  return {
    id: t.id,
    kind: t.kind,
    state: t.state,
    branch: t.branch,
    pr: t.pr,
    model: t.model,
    modelReason: t.modelReason,
    startedBy: t.startedBy,
    staleBase: t.staleBase,
    brief: briefOf(t.body),
    live: t.live,
    deploy: t.deploy && { state: t.deploy.state, deployed: t.deploy.deployed },
  };
}

/** Resolve the lead's chosen options (labels or indexes) against the live box, and build
 *  the `expect` list so the endpoint can still refuse a box that moved. */
function resolvePicks(box, options) {
  const picks = [];
  for (const want of options) {
    let opt;
    if (typeof want === 'number' || /^\d+$/.test(String(want))) {
      opt = box.options.find((o) => o.index === Number(want));
    } else {
      const needle = String(want).toLowerCase();
      const matches = box.options.filter((o) => o.label.toLowerCase().includes(needle));
      if (matches.length > 1) throw new Error(`"${want}" matches more than one option — be exact.`);
      opt = matches[0];
    }
    if (!opt) throw new Error(`"${want}" is not one of the options on screen.`);
    picks.push(opt);
  }
  return { options: picks.map((o) => o.index), expect: picks.map((o) => ({ index: o.index, label: o.label })) };
}

/* ---------------------------------------------------------------- tools --- */

const WORKER_TOOLS = [
  {
    name: 'room_post',
    description:
      `Post to the team room — the log the lead and ${HUMAN} read. Use kind "escalation" when part of your work is gated on a decision (include question, options with implications, your recommendation, grounds you already checked, and what you are continuing with), or kind "status" for a brief progress note. You cannot read the room; answers arrive in your conversation.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['escalation', 'status'] },
        text: { type: 'string', description: 'The message. For escalations: the question, one sentence.' },
        options: {
          type: 'array',
          description: 'Escalations: the options you considered.',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, implication: { type: 'string' } },
            required: ['label'],
            additionalProperties: false,
          },
        },
        recommendation: { type: 'string' },
        blocked: { type: 'string', enum: ['all', 'partial'] },
        continuing: { type: 'string', description: 'What you are doing while you wait.' },
        grounds: { type: 'string', description: 'What in the repo/docs you already checked.' },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!TASK) throw new Error('This worker has no FOREMAN_TASK — refusing to post.');
      return api('POST', '/api/team/room', { folder: REPO, from: TASK, to: 'lead', ...args });
    },
  },
  {
    name: 'task_report',
    description:
      'Report your own task\'s state. Call with state "review" and a summary when the work is done and committed — this is how the team knows you finished.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['working', 'review'] },
        summary: { type: 'string' },
      },
      required: ['state', 'summary'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!TASK) throw new Error('This worker has no FOREMAN_TASK — refusing to report.');
      return api('PATCH', `/api/team/tasks/${encodeURIComponent(TASK)}`, args);
    },
  },
];

const LEAD_TOOLS = [
  {
    name: 'team_status',
    description:
      'The whole team at a glance: every task on this repo with its stored state and, when the worker is alive, its live status, model, and whether it is waiting on a human. Each task carries `brief` — a short preview of its recorded body, not the whole thing — since this is a roster, not a document store; read the full brief off the panel’s own `tasks.json` when one actually matters. The list includes PENDING tasks — ones recorded with task_add that have no worker, no branch and no session — so this, not your own memory, is where the backlog lives; it survives your /clear and your memory does not. Call this before reporting status or deciding anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { tasks } = await api('GET', '/api/team/tasks');
      const scoped = REPO ? tasks.filter((t) => t.repo === REPO) : tasks;
      return { repo: REPO, tasks: scoped.map(summarizeTask) };
    },
  },
  {
    name: 'task_dispatch',
    description:
      `Create a worktree branched from main and start a worker session on it; the body becomes the worker's first message. Only after ${HUMAN} has confirmed the task in conversation — never dispatch unconfirmed work. Set kind "plan" to dispatch a PLANNER instead of a builder: it researches the repo and writes a plan document, and its permissions deny writing code at all. Use a planner for anything big or vague, or where ${HUMAN} would want to see the shape before code exists — then bring them the plan (plan_read) for approval before dispatching builders against it. The worker's model is your call, judged per task on its size and complexity: omit it for the team default, or name one of claude-opus-5, claude-sonnet-5, claude-fable-5, claude-haiku-4-5-20251001 (a [1m] suffix selects the 1M-context variant). Naming a non-default model requires a modelReason — it is posted to the room, where ${HUMAN} judges the call. Note Haiku cannot run auto mode (measured): a Haiku worker prompts on everything, so it is almost never the right choice.`,
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short kebab-case name; becomes the branch, worktree and session name.' },
        body: { type: 'string', description: `The worker's brief — the task, its scope, and how to know it is done. For a planner: what to plan, why, and anything ${HUMAN} said that bounds it.` },
        kind: {
          type: 'string',
          enum: ['build', 'plan'],
          description: 'Omit or "build" for an ordinary worker. "plan" dispatches a planner, which writes a plan and cannot write code.',
        },
        model: { type: 'string', description: 'The model to launch this worker with. Omit for the team default.' },
        modelReason: { type: 'string', description: 'One line on why this task needs a non-default model. Required when model departs from the default.' },
      },
      required: ['label', 'body'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!REPO) throw new Error('This lead has no FOREMAN_REPO — refusing to dispatch anywhere.');
      // No setup override: the worktree-prepare command is detected server-side from
      // the repo's files (setup-detect.js), one answer for every dispatch. Model is
      // validated server-side against the known list — never a flags channel.
      return api('POST', '/api/team/dispatch', {
        folder: REPO,
        label: args.label,
        body: args.body,
        kind: args.kind,
        model: args.model,
        modelReason: args.modelReason,
        source: 'lead',
      });
    },
  },
  {
    name: 'task_add',
    description:
      `Record a task WITHOUT starting anything: a task record with the brief on it, a label and a kind, and no session, no worktree, no branch and no cost. Only after ${HUMAN} has confirmed the task in conversation — the same discipline as task_dispatch, and you may batch several once they have said yes to them. What it is for: an idea worth keeping that is not worth starting right now, and an approved task that has nowhere to go because the worker cap is full. Write the body as if a worker were about to read it — the moment you discuss an idea is the moment you know most about it, and an hour later that context is gone. ADDING IS NOT STARTING. A pending task never becomes a worker on its own — not on a freed slot, not on a timer, and not on the yes that got it recorded. Starting one needs a fresh, per-task yes from ${HUMAN}, however short. The model is validated now and stored as you gave it; omit it and it resolves to the team default at the moment it actually starts, which is the right answer for an idea that may sit for a month. Returns the tidied id — that, not the label you typed, is the name to start it by later, with task_start.`,
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short kebab-case name; becomes the id, and later the branch, worktree and session name.' },
        body: { type: 'string', description: 'The brief — the task, its scope, and how to know it is done. This is the whole value of recording it; write it while the context is fresh.' },
        kind: {
          type: 'string',
          enum: ['build', 'plan'],
          description: 'Omit or "build" for an ordinary task. "plan" records a planner, which when started writes a plan and cannot write code.',
        },
        model: { type: 'string', description: 'The model to start this task on. Omit for the team default as it stands when it starts.' },
        modelReason: { type: 'string', description: 'One line on why this task needs a non-default model. Required when model departs from the default.' },
      },
      required: ['label', 'body'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!REPO) throw new Error('This lead has no FOREMAN_REPO — refusing to record a task anywhere.');
      return api('POST', '/api/team/tasks', {
        folder: REPO,
        label: args.label,
        body: args.body,
        kind: args.kind,
        model: args.model,
        modelReason: args.modelReason,
        source: 'lead',
      });
    },
  },
  {
    name: 'task_start',
    description:
      `Start a PENDING task: turn a record that has been sitting in the backlog into a real worker, using the same machinery as task_dispatch — worktree, branch, session, brief. NOTHING STARTS OFF THE BACKLOG ON THE ORIGINAL GREEN-LIGHT. The yes that got a task recorded was a yes to the idea; starting it spends money, a worker slot and a worktree, so it needs a fresh, per-task yes from ${HUMAN}, however short ("yes", "go on then", "start search-index"). Quote it in \`confirmation\` — it is stored on the task and posted to the room where ${HUMAN} reads it back, so a confirmation you did not get is a claim they can see you making. Nothing else may start a pending task: not a freed slot, not a timer, not your own judgement that it is obviously next. If the cap is full the start is refused and the task stays pending — say so and leave it there. Use \`body\` only to replace the recorded brief (${HUMAN} changed the scope, or the repo moved on since it was written); omit it and the task starts on the brief it was recorded with. The model resolves now, not when it was recorded: a task recorded without one starts on the team default as it stands today.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The pending task\'s id — the tidied one task_add returned, which team_status lists.' },
        body: { type: 'string', description: 'A replacement brief. Omit to start it on the brief it was recorded with.' },
        confirmation: {
          type: 'string',
          description: `What ${HUMAN} just said to green-light THIS task, in their words. Required. Stored on the task and posted to the room.`,
        },
      },
      required: ['id', 'confirmation'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (!REPO) throw new Error('This lead has no FOREMAN_REPO — refusing to start anything anywhere.');
      requireConfirmation(args.confirmation);
      const confirmation = String(args.confirmation).trim();
      // `folder` is the repo pin, as on every other tool: the endpoint refuses an id
      // that belongs to another team rather than cutting a worktree somewhere this lead
      // has no business being.
      const started = await api('POST', '/api/team/dispatch', {
        folder: REPO,
        id: args.id,
        body: args.body,
        startedBy: confirmation,
      });
      // The audit line, posted only after the start actually succeeded — a claim about a
      // yes that started nothing would be noise in the room. If the post itself fails the
      // worker is already running, so the failure is reported *with* the result rather
      // than thrown over it.
      const audit = await api('POST', '/api/team/room', {
        folder: REPO, from: 'lead', to: args.id, kind: 'status',
        text: `Started ${args.id} — ${confirmation}`,
      }).then(() => ({ posted: true })).catch((err) => ({ posted: false, error: err.message }));
      return { ...started, audit };
    },
  },
  {
    name: 'task_close',
    description:
      `End a task: close its worker session and remove its worktree and branch. Outcome "done" ONLY when the PR is verified merged (or ${HUMAN} said so) — it records success; the default "abandon" records discarded work. A failed task keeps its worktree as evidence unless removeWorktree is true. On a pending task (never started, no worktree) this just drops the record — outcome "done" is refused, since nothing ran to be done.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        outcome: { type: 'string', enum: ['done', 'abandon'] },
        removeWorktree: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) =>
      api('POST', `/api/team/tasks/${encodeURIComponent(args.id)}/close`, {
        outcome: args.outcome || 'abandon',
        removeWorktree: Boolean(args.removeWorktree),
      }),
  },
  {
    name: 'task_set_pr',
    description:
      'Record the PR you just opened on its task, so the panel and team_status show the link.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['id', 'url'],
      additionalProperties: false,
    },
    handler: async (args) =>
      api('PATCH', `/api/team/tasks/${encodeURIComponent(args.id)}`, { pr: args.url }),
  },
  {
    name: 'worker_read',
    description:
      'The tail of a worker\'s conversation — bounded, newest last. Read this to triage, never to follow along; staying thin is part of the job.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        count: { type: 'number', description: 'Messages to read, default 30, max 100.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sid = await sessionFor(args.id);
      return api('GET', `/api/sessions/${encodeURIComponent(sid)}/tail?count=${args.count || 30}`);
    },
  },
  {
    name: 'plan_read',
    description:
      `Read the plan a planner wrote, by its task id. This is how a plan reaches you — it is a document, not a room post, so it is never dumped into the room. Read it, form your own view, and bring it to ${HUMAN} for approval: a plan is their call, the same way a merge is. Never dispatch build workers against a plan they have not approved.`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The planner task\'s id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      await taskRow(args.id); // repo-scoped: a plan on another team is not yours to read
      return api('GET', `/api/team/plans/${encodeURIComponent(args.id)}`);
    },
  },
  {
    name: 'worker_send',
    description:
      `Send a message into a worker's composer. Delivered when the worker is free to read it — queued behind whatever it is doing, never typed over a prompt. Mirrored into the room so ${HUMAN} can see what you directed.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        text: { type: 'string' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sid = await sessionFor(args.id);
      const sent = await api('POST', `/api/sessions/${encodeURIComponent(sid)}/send`, { text: args.text });
      await api('POST', '/api/team/room', {
        folder: REPO, from: 'lead', to: args.id, kind: 'chat', text: args.text,
      }).catch(() => {});
      return sent;
    },
  },
  {
    name: 'room_read',
    description:
      'Read the team room. Pass the last cursor you saw to get everything after it (capped at 200, `truncated` set if more exists). Omit `since` for the recent tail instead — roughly the last 20 entries — since the room outlives every /clear and an omitted cursor must not mean "since the dawn of the room". Either way, `cursor` is the room\'s newest entry — remember it and pass it next time.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'number', description: 'The last cursor you saw; omit for the recent tail.' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      // `args.since || 0` used to collapse "omitted" and "literal 0" into the same call,
      // which is how an omitted `since` ended up reading the entire room (measured:
      // 114,439 chars, refused by the harness). They now mean different things: a real
      // cursor — including an explicit 0, "everything from the start" — is passed
      // straight through to the endpoint's own cap (200, with `truncated`); omitted is a
      // tail, trimmed to TAIL entries after the fetch. `cursor` is untouched either way —
      // it's the endpoint's own `all[all.length-1].seq`, never affected by our trim.
      const hasCursor = args.since !== undefined && args.since !== null;
      const result = await api('GET', `/api/team/room?${repoQ()}&since=${hasCursor ? args.since : 0}`);
      if (hasCursor) return result;
      const TAIL = 20;
      return {
        entries: result.entries.slice(-TAIL),
        cursor: result.cursor,
        truncated: result.truncated || result.entries.length > TAIL,
      };
    },
  },
  {
    name: 'room_post',
    description: 'Post to the team room as the lead — a status line, a conflict flag (to: "all"), or a note addressed to one task.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A task id, or "all".' },
        kind: { type: 'string', enum: ['status', 'answer'] },
        text: { type: 'string' },
      },
      required: ['to', 'kind', 'text'],
      additionalProperties: false,
    },
    handler: async (args) => api('POST', '/api/team/room', { folder: REPO, from: 'lead', ...args }),
  },
  {
    name: 'worker_answer_question',
    description:
      `Answer a worker's AskUserQuestion box — ONLY when the team's answerDesignQuestions toggle is on AND you can cite grounds (a line in CLAUDE.md, a ruling in decisions.md, or something ${HUMAN} said). If you cannot name where the answer comes from, surface it to ${HUMAN} instead. The answer is audited in the room.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        options: {
          type: 'array',
          items: { type: ['string', 'number'] },
          description: 'The option(s) to choose, by exact label text or on-screen number.',
        },
        grounds: { type: 'string', description: 'Where this answer comes from. Required.' },
      },
      required: ['id', 'options', 'grounds'],
      additionalProperties: false,
    },
    handler: async (args) => {
      await requireToggle('answerDesignQuestions');
      requireGrounds(args.grounds);
      const sid = await sessionFor(args.id);
      const row = await sessionRow(sid);
      if (!row.question || row.question.kind !== 'question') {
        throw new Error('The worker is not on a question box right now.');
      }
      const { options, expect } = resolvePicks(row.question, args.options);
      const result = await api('POST', `/api/sessions/${encodeURIComponent(sid)}/question`, {
        action: 'answer', options, expect,
      });
      await api('POST', '/api/team/room', {
        folder: REPO, from: 'lead', to: args.id, kind: 'answer',
        text: `Answered question with: ${expect.map((e) => e.label).join(', ')}`,
        grounds: args.grounds,
      }).catch(() => {});
      return result;
    },
  },
  {
    name: 'worker_answer_permission',
    description:
      'Answer a worker\'s permission prompt — ONLY when the team\'s answerPermissionPrompts toggle is on (it is off by default, and staying off is the norm). Requires grounds; audited in the room. Never choose a broader-than-asked option.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        option: { type: 'number', description: 'The on-screen option number to press.' },
        grounds: { type: 'string', description: 'Where this answer comes from. Required.' },
      },
      required: ['id', 'option', 'grounds'],
      additionalProperties: false,
    },
    handler: async (args) => {
      await requireToggle('answerPermissionPrompts');
      requireGrounds(args.grounds);
      const sid = await sessionFor(args.id);
      const row = await sessionRow(sid);
      const label = row.prompt?.options?.find((o) => o.index === Number(args.option))?.label;
      if (!label) throw new Error('The worker is not on a permission prompt with that option right now.');
      const result = await api('POST', `/api/sessions/${encodeURIComponent(sid)}/answer`, {
        option: args.option,
        expectLabel: label,
      });
      await api('POST', '/api/team/room', {
        folder: REPO, from: 'lead', to: args.id, kind: 'answer',
        text: `Answered permission prompt with: ${label}`,
        grounds: args.grounds,
      }).catch(() => {});
      return result;
    },
  },
  {
    name: 'worker_approve_plan',
    description:
      'Answer a worker\'s plan-approval box — ONLY when the team\'s approvePlans toggle is on (off by default). Requires grounds; audited in the room. Remember: on this box option 1 is the BROAD yes; prefer the narrow option.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id.' },
        option: { type: 'number', description: 'The on-screen option number to press.' },
        grounds: { type: 'string', description: 'Where this approval comes from. Required.' },
      },
      required: ['id', 'option', 'grounds'],
      additionalProperties: false,
    },
    handler: async (args) => {
      await requireToggle('approvePlans');
      requireGrounds(args.grounds);
      const sid = await sessionFor(args.id);
      const row = await sessionRow(sid);
      const label = row.plan?.options?.find((o) => o.index === Number(args.option))?.label;
      if (!label) throw new Error('The worker is not on a plan-approval box with that option right now.');
      const result = await api('POST', `/api/sessions/${encodeURIComponent(sid)}/plan`, {
        index: Number(args.option),
        expectLabel: label,
      });
      await api('POST', '/api/team/room', {
        folder: REPO, from: 'lead', to: args.id, kind: 'answer',
        text: `Answered plan approval with: ${label}`,
        grounds: args.grounds,
      }).catch(() => {});
      return result;
    },
  },
];

const TOOLS = ROLE === 'worker' ? WORKER_TOOLS : LEAD_TOOLS;

/* ------------------------------------------------------------- protocol --- */

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

function reply(id, result) {
  out({ jsonrpc: '2.0', id, result });
}

function replyErr(id, code, message) {
  out({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'foreman', version: '2.0.0' },
    });
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return replyErr(id, -32602, `No such tool: ${params?.name}`);
    // A schema's `required` is a promise about the call, so a call that breaks it is
    // invalid params — the same layer that refuses a tool this role does not have, not a
    // handler that reads `undefined` and carries on. It matters most where the required
    // field *is* the guard: `task_start`'s confirmation, `worker_answer_*`'s grounds.
    // (The whitespace string that satisfies `required` is caught in the handler.)
    const missing = (tool.inputSchema?.required || []).filter(
      (key) => (params?.arguments || {})[key] === undefined,
    );
    if (missing.length) {
      return replyErr(id, -32602, `${tool.name} needs: ${missing.join(', ')}`);
    }
    try {
      const result = await tool.handler(params?.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      // Tool-level failure is a result, not a protocol error — the model should see it.
      return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) replyErr(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not ours to guess at
  }
  handle(msg).catch((err) => {
    if (msg.id !== undefined) replyErr(msg.id, -32603, err.message);
  });
});
rl.on('close', () => process.exit(0));
