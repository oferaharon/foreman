import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { PORT, HOST, HOST_SOURCE, SESSION_PREFIX, SESSION_PREFIX_SOURCE, STATE_DIR, STATE_DIR_SOURCE, HOME, USER_CLAUDE_CONFIG, CONFIG_FILE, CONFIG_NOTES, ALLOWED_ORIGINS, TRIGGER_TOKEN, TRIGGER_SOURCE, TRIGGER_NOTES, TRIGGER_DEDUPE_MS, VERSION, REPO_URL } from './config.js';
import { StatusEngine } from './status.js';
import { SessionRegistry } from './sessions.js';
import { ReadState } from './read-state.js';
import { Tailer } from './transcript.js';
import {
  sendText,
  sendKeys,
  isAvailable,
  readPaneState,
  capturePane,
  changeMode,
  sendLiteral,
  listPanes,
  PaneBlockedError,
  MODES,
} from './tmux.js';
import { keyForOption } from './permission.js';
// The one import in this directory that reaches outside it, and deliberately. The browser
// needs this witness at a path that resolves both as a static file and in node, so it has
// to live under `web/` — and one measured fact with three readers (the desktop composer,
// the phone's cards, this endpoint) must not become three facts. See the file's header.
import { isTrustGate } from '../web/trust-gate.js';
import { parseQuestion, planAnswer, planChat, planFreeText } from './question.js';
import { parsePlanPrompt, approvalKeys } from './plan.js';
import {
  parseModelDialog,
  parseModelConfirm,
  modelDialogOpen,
  modelConfirmOpen,
  confirmNames,
  stepToward,
  footerModelName,
} from './model.js';
import { parseEffortDialog, nudgeToward } from './effort.js';
import { MessageQueue } from './queue.js';
import { PaneLock } from './claim.js';
import { PinStore } from './pins.js';
import { GroupStore } from './groups.js';
import {
  SnapshotStore,
  benchEntries,
  restoreSessions,
  relaunchEntries,
  liveWorkers,
} from './snapshot.js';
import { TaskStore, TASK_KINDS } from './tasks.js';
import { createWorktree, removeWorktree, pruneWorktrees, runSetup, tidyLabel, WORKTREES_DIR } from './worktree.js';
import { writeWorkerSettings, answerTrustGate, resolveWorkerModel, WORKER_MODELS } from './dispatch.js';
import { ensureTeam, readTeam, teamDir, teamKey, leadSettings, normalizeReviewPaths, plannerStance, plansDir, planPath, TEAMS_DIR } from './team.js';
import { matchTrigger, findLead, MAX_TRIGGER_TEXT } from './trigger.js';
import { collectQueue, composition, mergeLine, prName, prNumber } from './merge-queue.js';
import { mergeVerdict } from './merge-check.js';
import { resolveSetup } from './setup-detect.js';
import { resolveForge, credentialKeys, READINGS } from './forge.js';
import { resolveBaseBranch, bareBase } from './base-branch.js';
import { createTeamWatch } from './watch.js';
import { createConflictScanner } from './conflicts.js';
import { pruneAllWorktrees, gcFailedWorktrees, gcGroupFilings } from './gc.js';
import { branchFacts, createDeployTracker, mergedInto } from './deployed.js';
import { originGuard, verifyOrigin, originBootLines, normalizeOrigin } from './origin.js';
import {
  seedConfigFile,
  readConfigFile,
  isLoopbackRemote,
  remoteAddressOf,
  touchesExposure,
  validateConfigPatch,
  writeConfigFile,
  allowedOriginsFrom,
  DEFAULT_BIND_HOST,
  DEFAULT_SESSION_PREFIX,
  BIND_HOST_RULE,
  EXPOSURE_KEYS,
} from './settings-file.js';
import { humanName } from './human-name.js';
import { leadBrief } from './lead-brief.js';
import { workerBrief, plannerBrief } from './worker-brief.js';
import { RoomStore } from './room.js';
import {
  LinkStore,
  jointThread,
  linkLine,
  assertSendableBody,
  MAX_LINK_TEXT,
} from './links.js';
import { readTail } from './transcript.js';
import {
  attachTerminal,
  chooseFolder,
  createSession,
  liveSessionNames,
  revealInFinder,
  slugFor,
  uniqueSessionName,
} from './launch.js';
import { saveUpload, resolveImage, pruneImages } from './uploads.js';
import { rotateLogs, rotationLines, LOG_OUT, LOG_ERR } from './logs.js';
import { FORMULA, panelIsHomebrew } from './homebrew.js';
import { listCommands } from './commands.js';
import { findFiles } from './files.js';
import { scanImages, readImage } from './images.js';
import { IMAGE_MEDIA } from './normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

const status = new StatusEngine();
const readState = new ReadState();
const queue = new MessageQueue();
const pins = new PinStore();
const groups = new GroupStore();
const snapshot = new SnapshotStore();
const tasks = new TaskStore();
const room = new RoomStore();
const links = new LinkStore();

// A worker whose tmux session vanished has crashed — the spec's failure table says mark
// it `failed` and keep the worktree as evidence. Cheap: one `list-sessions` every 30s,
// and only tasks holding a session name are ever eligible.
setInterval(async () => {
  const failed = tasks.prune(new Set(await liveSessionNames()));
  for (const id of failed) {
    const t = tasks.get(id);
    if (t) watch.postSystem(t.repo, id, `Worker ${id} crashed — its session is gone. Worktree kept at ${t.worktree}.`);
  }
  if (failed.length) broadcastRoster();
}, 30_000).unref?.();

const registry = new SessionRegistry(status, readState, queue, pins, tasks);

// Transitions + nudge live in watch.js so they can be tested; index.js owns the timer.
const watch = createTeamWatch({ registry, tasks, room, queue, readTeam });
// The one edge that has to be tied after the fact: the watcher takes the registry, so the
// registry cannot take the watcher. `stuck` on a worker's `team` object is what tells the
// rail a worker has been waiting long enough to be the maintainer's problem rather than its
// lead's.
registry.stuckFor = (taskId) => watch.flags(taskId).stuck;
setInterval(() => watch.tick(), 5_000).unref?.();

// Two workers, one file — the room's only genuine broadcast (`to: 'all'`). Git shell-outs
// are too expensive for the 5s tick, so this runs on its own slower timer.
// "Merged" and "live on this Mac" are different facts — see deployed.js. Cached per
// (repo, sha) because this is answered on the roster beat.
const deployed = createDeployTracker();

const conflicts = createConflictScanner({
  tasks,
  readTeam,
  postConflict: (repo, { tasks: pair, paths, now }) => {
    try {
      room.post(repo, {
        from: 'panel', to: 'all', kind: 'conflict', about: pair.join('+'),
        tasks: pair, paths,
        text: `Workers ${pair[0]} and ${pair[1]} are both touching: ${paths.join(', ')}. Lead decides the ordering.`,
      }, { now });
    } catch {
      /* a room post must never take the scanner down */
    }
    watch.nudgeLead(repo, { now });
  },
});
setInterval(() => conflicts.scan().catch(() => {}), 60_000).unref?.();

const app = express();

/*
 * Where a request came from — a **browser guard, not authentication**.
 *
 * A web page on some foreign site must not be able to make the maintainer's own browser act
 * as a LAN peer. That is the whole of what this buys. It restricts nobody on the network:
 * the 2026-08-27 ruling — the panel binds wide and gets no authentication, deliberately —
 * stands untouched, and this is not a boot guard.
 *
 * **First, before the body parsers and before every route**, which is what puts `/hook` on
 * the far side of it: `/hook` is a POST, so the non-GET gate covers it with no special
 * case, and a refused origin never gets its body parsed. Confirmed against the running
 * route rather than assumed, since `/hook` is mounted with its own parser above.
 *
 * **`GET` is deliberately not gated** and the reasoning lives in `origin.js` beside the
 * middleware: a cross-origin page can send a GET but cannot read the response, because no
 * `Access-Control-Allow-Origin` header is ever sent. The WebSocket is the exception — a
 * handshake is a GET that is not subject to CORS and hands over the roster on connect — so
 * it gets its own call site at `verifyClient` below.
 */
app.use(originGuard({ port: PORT, config: { allowedOrigins: ALLOWED_ORIGINS } }));

/**
 * The hook's body is JSON whatever it calls itself.
 *
 * Claude Code's hook is a `curl --data-binary @-` with no `Content-Type`, so curl labels
 * it `application/x-www-form-urlencoded` and the ordinary JSON parser skips it — leaving
 * an empty body, no `session_id`, and nothing recorded. Every hook this panel has ever
 * been sent was dropped on that line: the roster ran entirely on pane scraping, and the
 * one authoritative binding rule never fired once. The sender is not ours to fix (it is
 * written into `~/.claude/settings.json`, and sessions read that at launch and never
 * again), so the receiver stops being fussy.
 */
app.use('/hook', express.json({ type: () => true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(WEB_DIR));

// Ship marked from node_modules so the panel needs no build step and no CDN.
const MARKED = path.join(__dirname, '..', 'node_modules', 'marked', 'lib', 'marked.esm.js');
app.get('/vendor/marked.js', (_req, res) => res.type('application/javascript').sendFile(MARKED));

/* ---------------------------------------------------------------- hooks --- */

app.post('/hook', (req, res) => {
  // Answer first: a hook that waits on us adds latency to every tool call.
  res.status(204).end();
  try {
    const payload = req.body || {};
    const event = payload.hook_event_name || req.get('X-Hook-Event') || '';
    const pane = req.get('X-Tmux-Pane') || null;
    status.ingest(event, payload, pane && pane !== '' ? pane : null);
  } catch {
    /* never let a malformed hook take the server down */
  }
});

/* -------------------------------------------------------------- uploads --- */

/**
 * Take a pasted or dropped image or text file and hand back a path. The panel puts that
 * path in the message, which is exactly what dropping a file into the terminal does today.
 *
 * **The content-type list here is a body-parser filter, never the gate.** Browsers report
 * an *empty* `File.type` for a `.md` often enough that gating on it would refuse the most
 * ordinary case, and an empty type is what the client sends as `application/octet-stream`
 * — so this list is deliberately wide and `saveUpload` decides, on magic bytes for an
 * image and on extension plus a strict UTF-8 read for text. Anything this parser lets
 * through and that refuses is a 400 with the reason.
 */
app.post(
  '/api/upload',
  express.raw({ type: ['image/*', 'text/*', 'application/octet-stream'], limit: '25mb' }),
  async (req, res) => {
    try {
      // The header is percent-encoded so spaces and unicode survive the transport.
      let name = req.get('X-Filename') || '';
      try {
        name = decodeURIComponent(name);
      } catch {
        /* malformed encoding — fall back to the raw value, saveUpload sanitises it */
      }
      const saved = await saveUpload(req.body, name, Date.now());
      res.json({ path: saved.path, name: path.basename(saved.path), bytes: saved.bytes });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

/**
 * Thumbnails for the composer's attachment strip. It serves anything in the upload folder,
 * text files included, but only images are ever *asked* for — a text chip draws a glyph
 * rather than fetching the file, so nothing here needs to know which kind it is holding.
 */
app.get('/api/image/:name', (req, res) => {
  const file = resolveImage(req.params.name);
  if (!file) return res.status(404).end();
  res.sendFile(file);
});

/* ------------------------------------------------------- subagent runs --- */

/**
 * Subagent transcripts live in their own file, named by the parent's tool result.
 *
 * Only files we have actually seen referenced from a transcript are readable — the
 * client names a path, but naming one we've never encountered gets nothing. That keeps
 * this from becoming a read-any-file endpoint.
 */
const knownAgentFiles = new Set();

function rememberAgentFiles(messages) {
  for (const m of messages) {
    const f = m?.result?.agent?.outputFile;
    if (f) knownAgentFiles.add(f);
  }
}

app.get('/api/agent-run', async (req, res) => {
  const file = String(req.query.file || '');
  if (!knownAgentFiles.has(file)) {
    return res.status(404).json({ error: 'Unknown agent transcript.' });
  }
  try {
    const tailer = new Tailer(file);
    const { messages } = await tailer.start();
    tailer.stop();
    rememberAgentFiles(messages); // agents spawn agents
    res.json({ messages });
  } catch (err) {
    res.status(404).json({ error: `Could not read that agent's transcript: ${err.message}` });
  }
});

/* ------------------------------------------------------------------ api --- */

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: registry.list(), groups: groups.list() });
});

/**
 * Send a message, or hold it until the session can hear it.
 *
 * The caller doesn't decide which. It says what to send; the server looks at the pane and
 * either types it or puts it in the queue — because only the server knows, two seconds
 * later, that the session has gone idle and the message can go.
 *
 * v1 got this backwards: the browser held the message in a variable and released it when
 * the roster said idle, so closing the tab lost it.
 */
/**
 * Type it now, or hold it until the pane can hear it — whichever `claim()` decides.
 * Shared with `POST /api/trigger`, which must go through this exact logic rather than
 * a copy of it: it's what stops keystrokes landing in a permission box.
 */
async function sendOrQueue(session, text) {
  if (await claim(session)) {
    try {
      await deliver(session.paneId, text);
      return { queued: false };
    } catch (err) {
      // A prompt or a dialog opened in the gap. That's exactly what the queue is for,
      // so fall through rather than making the sender deal with it.
      if (!(err instanceof PaneBlockedError)) {
        err.status = 500;
        throw err;
      }
    }
  }

  try {
    const item = queue.add(session.paneId, text, { paneCreatedMs: await paneBirthday(session.paneId) });
    registry.refresh().catch(() => {});
    return { queued: true, item };
  } catch (err) {
    err.status = 409;
    throw err;
  }
}

app.post('/api/sessions/:id/send', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session.' });
  if (!session.paneId) {
    return res.status(409).json({ error: 'This session is read-only — it has no tmux pane.' });
  }
  const text = String(req.body?.text ?? '');
  if (!text.trim()) return res.status(400).json({ error: 'Nothing to send.' });

  try {
    const result = await sendOrQueue(session, text);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** Everything waiting for this session, oldest first. */
app.get('/api/sessions/:id/queue', (req, res) => {
  const session = registry.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session.' });
  res.json({ queued: session.paneId ? queue.list(session.paneId) : [] });
});

/** Change your mind about something you typed ahead. */
app.delete('/api/sessions/:id/queue/:itemId', (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });
  if (!queue.remove(session.paneId, req.params.itemId)) {
    return res.status(404).json({ error: 'That message is no longer queued — it may have just gone.' });
  }
  registry.refresh().catch(() => {});
  res.json({ ok: true, queued: queue.list(session.paneId) });
});

/**
 * Keep a session at the top of the rail, or let it go.
 *
 * Pinned by pane rather than by session id, so `/clear` — which mints a new id and a new
 * transcript — doesn't silently drop the pin on the way through.
 */
app.post('/api/sessions/:id/pin', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  // Absent means "the other one", so a row's button needs no state of its own.
  const pinned = req.body?.pinned === undefined ? !session.pinned : Boolean(req.body.pinned);

  /*
   * A connected lead stays pinned — the maintainer's ruling.
   *
   * The client half draws the star disabled with the link named, so the ordinary path
   * never reaches this. It is re-decided here anyway, which is the exposure-modal move
   * verbatim: the refusal is then a property of the panel rather than a habit of its
   * front end, and a LAN peer holding curl gets the same answer as the browser.
   *
   * `pinned: true` rides on the refusal because `togglePin` flips the star optimistically
   * — a client that reads this can put it back and say why, instead of the star flipping
   * and then silently flipping again on the next roster frame.
   */
  if (!pinned) {
    const held = linkHolding(session);
    if (held) {
      const { peer } = linkSides(held, path.resolve(session.paneCwd));
      return res.status(409).json({
        error:
          `This lead is connected to ${path.basename(peer)} on link ${linkNamed(held)}, and a ` +
          'connected lead stays pinned. Close the link to unpin it.',
        link: held.id,
        pinned: true,
      });
    }
  }

  if (pins.set(session.paneId, pinned, { paneCreatedMs: await paneBirthday(session.paneId) })) {
    registry.refresh().catch(() => {});
  }
  res.json({ ok: true, pinned });
});

app.post('/api/sessions/:id/key', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  // Only keys that mean the same thing regardless of what is on screen.
  const ACTIONS = { interrupt: ['Escape'] };
  const action = req.body?.action;
  const keys = ACTIONS[action];
  if (!keys) return res.status(400).json({ error: `Unknown action: ${action}` });

  try {
    await sendKeys(session.paneId, ...keys);

    // An interrupt fires no hook, so nothing else is ever going to correct the record.
    // `Stop` runs on a natural stop; Escape is not one, so the last receipt — `working` —
    // stands for the full `STATUS_STALE_MS` while the pane sits at a composer. This is
    // the one place that knows the session was just stopped, so it is the one place that
    // can say so. See `StatusEngine#interrupted` for why the receipt is dropped rather
    // than rewritten to `idle`.
    if (action === 'interrupt') status.interrupted(session.paneId, session.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Answer a permission prompt by option number.
 *
 * Deliberately strict. The caller names an option index, and we only send it if that
 * option is on screen *right now* and its label still matches what the client showed
 * the user. Anything else is refused rather than guessed — this is the one endpoint
 * that can approve something on your behalf.
 */
app.post('/api/sessions/:id/answer', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  // Re-read the pane instead of trusting the roster snapshot, which can be 2s stale.
  const live = await readPaneState(session.paneId);
  const prompt = live.prompt;
  if (!prompt) {
    return res.status(409).json({ error: 'No permission prompt is open in this session.' });
  }

  // The folder-trust gate parses as an ordinary permission box, so without this it is
  // answerable here by anything that can reach the panel — which, by the 2026-08-27 ruling,
  // is anything on the LAN. The card stopped drawing buttons for it; that alone would make
  // "the panel never answers a security gate" a habit of the front end rather than a
  // property of the panel, and every other guard on this path is written the other way
  // round: the endpoint re-reads the pane and refuses rather than trusting its caller.
  // Costs nothing — `answerTrustGate`, the one deliberate exception, sends its own key for
  // a worktree the dispatch just created and has never come through here.
  if (isTrustGate(prompt)) {
    return res.status(409).json({
      error:
        'That is Claude Code’s folder-trust gate, not a permission prompt. The panel does ' +
        'not answer security gates — answer it at the Mac, in the terminal.',
    });
  }

  const index = Number(req.body?.option);
  const key = keyForOption(prompt, index);
  if (!key) {
    return res.status(400).json({ error: `Option ${req.body?.option} is not on screen.` });
  }

  // Guard against answering a prompt that changed between render and click.
  const expected = req.body?.expectLabel;
  const actual = prompt.options.find((o) => o.index === index)?.label;
  if (expected && expected !== actual) {
    return res.status(409).json({
      error: 'The prompt changed — nothing was sent. Check the new one and answer again.',
      prompt,
    });
  }

  try {
    await sendKeys(session.paneId, key);
    res.json({ ok: true, answered: { index, label: actual } });
    registry.refresh().catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Answer one of Claude's own questions — the `AskUserQuestion` box.
 *
 * Held to the same standard as the permission endpoint, and then some, because the
 * keystrokes are ambiguous in a way a permission box's never are: the same digit toggles
 * on one screen and submits on another. So nothing is fired blind.
 *
 *   - the pane is re-read now, not trusted from the roster
 *   - every option the client displayed must still be on screen with the same label
 *   - a multi-select's toggles are followed by Tab, and the review screen is *re-read and
 *     checked* to say exactly what we chose before the submit digit is sent
 *
 * If the review doesn't match, we stop with the selections made and nothing submitted,
 * and say so. A half-answered question you can finish in the terminal beats a confidently
 * wrong answer sent on your behalf.
 */
app.post('/api/sessions/:id/question', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  const box = parseQuestion(await capturePane(session.paneId, 40));
  if (!box) return res.status(409).json({ error: 'No question is open in this session.' });

  const action = String(req.body?.action || 'answer');

  // The review screen only ever takes these two, and takes them by their own digit.
  if (action === 'submit' || action === 'cancel') {
    if (box.kind !== 'review') {
      return res.status(409).json({ error: 'This session is not on the review screen.' });
    }
    await sendKeys(session.paneId, String(action === 'submit' ? box.submitIndex : box.cancelIndex));
    res.json({ ok: true, action });
    registry.refresh().catch(() => {});
    return;
  }

  if (box.kind !== 'question') {
    return res.status(409).json({ error: 'This session is on the review screen, not a question.' });
  }

  // The two escape hatches, for when the answer isn't one of the options. See `planChat`
  // and `planFreeText` — they behave nothing alike, and only one works on every layout.
  if (action === 'chat' || action === 'text') {
    let plan;
    try {
      plan = action === 'chat' ? planChat(box) : planFreeText(box, req.body?.text);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      if (action === 'chat') {
        await sendKeys(session.paneId, plan.keys[0]);
        await new Promise((r) => setTimeout(r, 400));
        if (parseQuestion(await capturePane(session.paneId, 40))?.kind === 'question') {
          return res.status(502).json({ error: 'The question is still open — check the terminal.' });
        }
        registry.refresh().catch(() => {});
        return res.json({ ok: true, action: 'chat' });
      }

      // Open the row's editor, and check it opened before typing a word into a box that
      // might still be a list of options.
      await sendKeys(session.paneId, plan.open);
      await new Promise((r) => setTimeout(r, 300));
      const opened = parseQuestion(await capturePane(session.paneId, 40));
      if (opened?.kind !== 'question' || opened.freeTextIndex !== Number(plan.open)) {
        return res.status(409).json({
          error: 'The free-text row did not open — nothing was typed. Finish it in the terminal.',
        });
      }

      await sendLiteral(session.paneId, plan.text);
      await new Promise((r) => setTimeout(r, 250));

      // The typed text *replaces* the row's label, so the pane can be asked to show it
      // back before anything is submitted. Read from the raw capture rather than a
      // re-parse: what is on screen at this moment is a box whose free-text row no longer
      // says "Type something.", and asking the parser to bless that is asking the wrong
      // question. Flattened because a narrow pane wraps what was typed.
      const flat = (await capturePane(session.paneId, 40)).replace(/\s+/g, ' ');
      const needle = plan.text.slice(0, 40).replace(/\s+/g, ' ');
      if (!flat.includes(needle)) {
        return res.status(409).json({
          error: 'The box is not showing what was typed — nothing was submitted. Finish it in the terminal.',
        });
      }

      await sendKeys(session.paneId, plan.submit);
      await new Promise((r) => setTimeout(r, 400));
      registry.refresh().catch(() => {});
      return res.json({ ok: true, action: 'text', submitted: true, text: plan.text });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const picks = (Array.isArray(req.body?.options) ? req.body.options : []).map(Number);

  // The labels the client rendered. If any has moved or changed, the box is not the one
  // the user was looking at and no key may be sent.
  for (const { index, label } of req.body?.expect || []) {
    const actual = box.options.find((o) => o.index === Number(index))?.label;
    if (actual !== label) {
      return res.status(409).json({
        error: 'The question changed — nothing was sent. Check the new one and answer again.',
        question: box,
      });
    }
  }

  let plan;
  try {
    plan = planAnswer(box, picks);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    for (const key of plan.keys) {
      await sendKeys(session.paneId, key);
      await new Promise((r) => setTimeout(r, 120));
    }

    if (!plan.needsReview) {
      res.json({ ok: true, submitted: true });
      registry.refresh().catch(() => {});
      return;
    }

    // Tab opens the review, which is the only place a multi-select can be submitted.
    await sendKeys(session.paneId, 'Tab');
    await new Promise((r) => setTimeout(r, 350));

    const review = parseQuestion(await capturePane(session.paneId, 40));
    if (review?.kind !== 'review') {
      return res.status(409).json({
        error: 'Your choices are ticked, but the review screen did not appear — submit it in the terminal.',
        submitted: false,
      });
    }

    const chosenLabels = picks
      .map((i) => box.options.find((o) => o.index === i)?.label)
      .filter(Boolean);
    const shown = review.answers.map((a) => a.answer || '').join(' | ');
    const missing = chosenLabels.filter((l) => !shown.includes(l));
    if (missing.length) {
      return res.status(409).json({
        error: `The review screen doesn't list ${missing.join(', ')} — nothing was submitted. Finish it in the terminal.`,
        submitted: false,
        review,
      });
    }

    await sendKeys(session.paneId, String(review.submitIndex));
    res.json({ ok: true, submitted: true, answered: chosenLabels });
    registry.refresh().catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
 * The box that ends plan mode — see `plan.js` for what makes it its own parser.
 *
 * Held to the permission endpoint's standard and then some, because this screen inverts
 * the rule that endpoint was written for: here option *1* is the broad yes, and it can be
 * "clear context and bypass permissions". So nothing is answered by position, and nothing
 * is answered from the roster's copy of the box.
 */
app.post('/api/sessions/:id/plan', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  // Re-read now. The option list is built at every render, so the box the page painted is
  // not necessarily the box on screen, and approving a row you never read is the failure
  // this whole module exists to prevent.
  const box = parsePlanPrompt(await capturePane(session.paneId, 40));
  if (!box) return res.status(409).json({ error: 'No plan approval is open in this session.' });

  const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : null;
  const index = feedback === null ? Number(req.body?.index) : null;

  // The label the page showed must still be the label at that number.
  if (feedback === null) {
    const expected = req.body?.expectLabel;
    const actual = box.options.find((o) => o.index === index)?.label;
    if (expected && expected !== actual) {
      return res.status(409).json({
        error: 'The plan box changed — nothing was sent. Read the new one and answer again.',
        plan: box,
      });
    }
  }

  let keys;
  try {
    keys = approvalKeys(box, feedback === null ? { index } : { feedback });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    // No `claim()` here, the same as the permission and question endpoints: that lock is
    // about not typing two messages onto one composer line, and this pane has no composer
    // — it is holding a box, and the box is what we are addressing.
    for (const key of keys.keys) {
      if (typeof key === 'string') await sendKeys(session.paneId, key);
      else await sendLiteral(session.paneId, key.text);
      await new Promise((r) => setTimeout(r, 150));
    }
    res.json({ ok: true, answered: keys.label });
    registry.refresh().catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The plan file the box names, so you can read what you're approving.
 *
 * The path comes off scraped terminal text, which is not a source to hand to `readFile` —
 * so it is resolved and then refused unless it lands inside `~/.claude/plans`.
 */
app.get('/api/sessions/:id/plan-file', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.plan?.planPath) return res.status(404).json({ error: 'No plan file to read.' });

  const raw = session.plan.planPath.replace(/^~(?=\/|$)/, os.homedir());
  const file = path.resolve(raw);
  const root = path.join(os.homedir(), '.claude', 'plans');
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    return res.status(400).json({ error: 'That path is not in ~/.claude/plans.' });
  }

  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return res.status(404).json({ error: 'Not a file.' });
    if (stat.size > 256 * 1024) return res.status(413).json({ error: 'That plan is too big to show.' });
    res.json({ path: session.plan.planPath, markdown: await fsp.readFile(file, 'utf8') });
  } catch {
    res.status(404).json({ error: 'That plan file is not there any more.' });
  }
});

/** The permission modes a session can be put into, for the composer's picker. */
app.get('/api/modes', (_req, res) => {
  res.json({ modes: MODES.map(({ id, label }) => ({ id, label })) });
});

/**
 * Put a session into a given permission mode.
 *
 * The TUI only offers shift+tab cycling, so this steps and re-reads until the mode
 * matches — never a counted burst of keystrokes.
 */
app.post('/api/sessions/:id/mode', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });
  try {
    const result = await changeMode(session.paneId, String(req.body?.mode || ''));
    res.json({ ok: true, ...result });
    registry.refresh().catch(() => {});
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/* ------------------------------------------------------------ launch --- */

/*
 * Starting a session, the way the other launcher on this Mac starts one — see `launch.js`, which is a port
 * of its `SessionManager`, not a second opinion about how sessions should be made.
 *
 * The panel still launches nothing on its own: this runs because you asked for it, from
 * a dialog you filled in, and the folder comes back from a real Finder chooser rather
 * than from anything a page could name on its own.
 */

app.post('/api/launch/folder', async (req, res) => {
  try {
    res.json(await chooseFolder(req.body?.at || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* `pathRule` (the `//`-anchored glob shape permission rules need) moved to team.js so
 * the lead-settings builder is testable — index.js listens on import. */

/**
 * Everything that makes a session a *lead*: the team dir, the brief, the tool surface,
 * the permission stance — all launch flags and files under `STATE_DIR/teams/`, never
 * anything written into the repo.
 *
 * The tool surface has to be session-scoped (`--mcp-config` + `--strict-mcp-config`), and
 * that is the whole reason it is a launch flag: a lead launches in the repo root, the same
 * folder every *ordinary* session in that repo launches in, so tools registered at project
 * scope would let any of them dispatch workers and answer prompts on your behalf. The
 * forced `lead` label is enforcement for the same kind of reason — one lead per project,
 * because two would mean two things writing one `tasks.json`, and a forced label makes the
 * second collide into `lead-2` where the panel can spot it and refuse.
 *
 * `resume` brings a lead back with its own conversation, for **relaunch all**. It is a
 * flag on the same launch, not a second path, and the reason it is allowed to compose with
 * everything below was measured rather than reasoned about: resumed against an
 * `--append-system-prompt-file` whose contents had been rewritten in between, the session
 * answered out of the *new* file while still remembering the old conversation. So the
 * regeneration three paragraphs down keeps its meaning — a resumed lead is still *today's*
 * lead, with today's brief, today's MCP config and today's `leadMerges` stance, carrying
 * yesterday's context. Had it gone the other way this would be fresh-only.
 *
 * Note what still is *not* plumbed: `skipPermissions`. A bypass lead is not a thing, and
 * the shape of this signature is what keeps it from becoming one.
 */
async function launchLead(folder, { terminal, resume = null }) {
  // A lead without git is a lead whose every dispatch fails — workers branch from main.
  // Found by the maintainer's first real launch attempt (a folder not yet in git), so the
  // tick refuses up front with the fix in the message rather than letting the lead discover
  // it. No remote is only a warning-by-behavior: dispatch works, PRs won't — the brief
  // covers that case.
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['-C', folder, 'rev-parse', '--show-toplevel'], (err) =>
        err ? reject(err) : resolve(),
      );
    });
  } catch {
    const err = new Error(
      'Not a git repository — a team lead needs one: workers branch from main. Run `git init` (and make a first commit) there first.',
    );
    err.status = 400;
    throw err;
  }

  const { dir: tDir, config, decisionsFile } = ensureTeam(folder);

  // One lead per project, permanently — a hard refusal, not a warning. The forced
  // label makes the collision detectable: this folder's lead has exactly one name.
  const leadName = uniqueSessionName(path.basename(folder), 'lead', new Set());
  if ((await liveSessionNames()).includes(leadName)) {
    const err = new Error('This project already has a team lead.');
    err.status = 409;
    throw err;
  }

  // What this repo actually has, detected from its own origin — never a setting, never a
  // stored token (decisions.md, 2026-08-30). Everything below hangs off this one answer,
  // so the brief, the tool surface and the permission stance cannot disagree about which
  // forge the lead is on. `fresh` because a launch is rare and a minute-stale cache is
  // exactly wrong on the launch that follows `git remote add`.
  const forge = await resolveForge(folder, { fresh: true });
  const base = (await resolveBaseBranch(folder)).branch;
  // What could not be given, said out loud in the launch result rather than dropped: a
  // tool that silently isn't there is a lead that fails at the far end of a task.
  const notes = [];

  // The lead's tools: the panel's own MCP server, scoped to this repo by env, plus the
  // user's entry for *this repo's* forge if one is registered — read from ~/.claude.json,
  // never written. A GitHub repo's lead never sees the gitea server and vice versa, which
  // is also a small containment win: a lead cannot call a forge its repo has nothing to
  // do with.
  const mcpServers = {
    foreman: {
      type: 'stdio',
      command: process.execPath,
      args: [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'foreman.js')],
      env: { FOREMAN_PORT: String(PORT), FOREMAN_REPO: folder, FOREMAN_ROLE: 'lead' },
    },
  };
  // The forge the lead will actually be *able* to use. It starts as what was detected and
  // is demoted below if the entry that would have carried it is refused — the brief, the
  // settings and mcp.json are then all written from the same demoted answer, rather than
  // the brief promising a tool the file does not contain.
  let effective = forge;
  if (forge.forge && forge.via === 'mcp') {
    try {
      const userCfg = JSON.parse(await fsp.readFile(USER_CLAUDE_CONFIG, 'utf8'));
      const entry = userCfg?.mcpServers?.[forge.forge];
      // `mcp.json` is written with the default umask — `-rw-r--r--`, measured — and this
      // copies the user's entry verbatim. The maintainer's gitea entry is `{type, url}` and
      // carries nothing; the standard GitHub MCP server carries
      // GITHUB_PERSONAL_ACCESS_TOKEN in its `env`. Copying that would write a personal
      // access token world-readable into the team folder, by the feature whose ruling says
      // never store a token. So it is refused, and the refusal is reported — `gh` is the
      // supported GitHub path exactly because its credential lives in the keychain and
      // never in a config file.
      const secrets = credentialKeys(entry?.env);
      if (entry && secrets.length) {
        notes.push(
          `The registered \`${forge.forge}\` MCP server carries ${secrets.join(', ')} in its env, and ${path.basename(mcpFilePath(tDir))} is world-readable — it was not copied. ${forge.forge === 'github' ? 'Install `gh` and log in: its credential stays in the keychain.' : 'Move the credential into the MCP server process, or the lead has no forge tools.'}`,
        );
        effective = { ...forge, reading: READINGS.push, forge: null, via: null };
      } else if (entry) {
        mcpServers[forge.forge] = entry;
      } else {
        effective = { ...forge, reading: READINGS.push, forge: null, via: null };
      }
    } catch {
      // No readable user config at launch time, whatever detection saw a moment ago.
      // Demote rather than promise: the brief must describe the tools in the file.
      effective = { ...forge, reading: READINGS.push, forge: null, via: null };
    }
  }
  const mcpFile = mcpFilePath(tDir);
  await fsp.writeFile(mcpFile, JSON.stringify({ mcpServers }, null, 2));

  const briefFile = path.join(tDir, 'brief.md');
  // Who this team reports to — detected from the repo's own `git config user.name`
  // (`human-name.js`), resolved here and threaded in, never read inside the brief. A repo
  // can carry its own `user.name`, and a brief is generated per repo.
  await fsp.writeFile(
    briefFile,
    leadBrief({
      repo: folder,
      teamDir: tDir,
      decisionsFile,
      forge: effective,
      base,
      human: humanName(folder),
      // The self-merge paragraphs, and `effective` above is why they are honest: a
      // credential-carrying MCP entry has already demoted the forge to `push only` by
      // here, so a brief never promises a tool the `mcp.json` beside it does not contain.
      // Written at launch like everything else in this block, so a flip reaches the
      // *next* lead — the panel's copy says so beside the toggle.
      selfMerge: Boolean(config.toggles?.leadDecidesMerges),
    }),
  );

  // The lead never writes code — enforced, not requested. Deny the checkout, allow
  // the team dir; the shape lives in `leadSettings` (team.js), where it is tested. The
  // file is regenerated here at every launch, so a `leadMerges` flip reaches the *next*
  // lead, never a running one — the panel says so beside the toggle.
  const settingsFile = path.join(tDir, 'lead-settings.json');
  await fsp.writeFile(
    settingsFile,
    JSON.stringify(
      leadSettings({ repo: folder, dir: tDir, leadMerges: Boolean(config.toggles?.leadMerges), forge: effective }),
      null,
      2,
    ),
  );

  const created = await createSession({
    folder,
    label: 'lead',
    terminal,
    resume,
    // skipPermissions deliberately not plumbed — a bypass lead is not a thing.
    extraArgs: [
      '--append-system-prompt-file', briefFile,
      '--mcp-config', mcpFile,
      '--strict-mcp-config',
      '--settings', settingsFile,
    ],
  });

  // Pinned from birth — the lead is the row you always want findable.
  if (created.paneId) {
    pins.set(created.paneId, true, { paneCreatedMs: await paneBirthday(created.paneId) });
  }
  return { created, config, forge: effective, base, notes };
}

/** One spelling of the lead's MCP config path, because two places name it. */
function mcpFilePath(tDir) {
  return path.join(tDir, 'mcp.json');
}

app.post('/api/launch', async (req, res) => {
  try {
    if (req.body?.lead) {
      const folder = String(req.body?.folder || '').trim();
      if (!folder) return res.status(400).json({ error: 'Which folder?' });
      const { created, forge, base, notes } = await launchLead(folder, { terminal: req.body?.terminal !== false });
      await registry.refresh().catch(() => {});
      const session = created.paneId ? registry.byPane(created.paneId) : null;
      // A tool that could not be given is said out loud — here and in the room, because
      // the launch dialog closes and the room does not. A refused MCP entry means the
      // lead will discover the gap at the far end of a task otherwise.
      for (const note of notes || []) {
        room.post(folder, { from: 'panel', to: 'lead', kind: 'system', alert: true, text: note });
      }
      return res.json({
        ok: true,
        ...created,
        lead: true,
        sessionId: session?.id ?? null,
        forge: forge?.reading ?? null,
        base,
        notes: notes || [],
      });
    }

    const created = await createSession({
      folder: req.body?.folder,
      label: req.body?.label ?? null,
      skipPermissions: Boolean(req.body?.skipPermissions),
      // Absent means yes, the same shape `/api/snapshot/restore` uses — a client that
      // predates the checkbox keeps getting a window, which is what it was built expecting.
      terminal: req.body?.terminal !== false,
    });
    // The pane exists now; the roster is up to two seconds behind it.
    await registry.refresh().catch(() => {});
    const session = created.paneId ? registry.byPane(created.paneId) : null;
    res.json({ ok: true, ...created, sessionId: session?.id ?? null });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/**
 * The last few messages of a session, bounded — built for the lead's `worker_read`, and
 * useful anywhere a snapshot beats a subscription. Never more than 100.
 */
app.get('/api/sessions/:id/tail', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session.' });
  if (!session.transcriptPath) {
    return res.json({ messages: [], truncated: false, note: 'No transcript yet — the session has not spoken.' });
  }
  try {
    const count = Math.min(Math.max(1, Number(req.query.count) || 30), 100);
    res.json(await readTail(session.transcriptPath, count));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Every image this session has produced, oldest first — the whole transcript, not the
 * window on screen.
 *
 * That distinction is the whole feature. The panel never loads a transcript whole: the
 * tailer backfills a byte window and `probe` samples head and tail, so a gallery built
 * from `view.messages` would be a subset and would look complete. `scanImages` makes its
 * own streaming pass. Measured on this Mac: **10ms for a 2.9MB file** (1,115 lines, 45
 * of them parsed, 9 images) and **55ms for the largest transcript here, 26MB** (3,014
 * lines, 158 parsed, 90 images). Cheap enough to do on every open, so nothing is cached
 * and there is nothing to invalidate as the file grows.
 *
 * Refs only. The bytes are the route below.
 */
app.get('/api/sessions/:id/images', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session.' });
  if (!session.transcriptPath) {
    return res.json({ images: [], note: 'No transcript yet — the session has not spoken.' });
  }
  try {
    const { images, scan } = await scanImages(session.transcriptPath);
    res.json({ images, scan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * One image's bytes, addressed by the record it lives in and its ordinal within it.
 *
 * Immutable, and genuinely so rather than as a hopeful header: transcripts are
 * append-only, a record is written once, and the bytes at a given uuid+index never
 * change. So the browser fetches each thumbnail once no matter how many times the strip
 * is repainted or the gallery reopened — which is half the reason the refs travel over
 * the socket and the bytes do not.
 *
 * The `Content-Type` comes from the block's own `media_type` but only through
 * `IMAGE_MEDIA`, so an unexpected string in a transcript cannot be reflected into a
 * response header. `readImage` has already refused anything outside that set, which makes
 * the check here belt to its braces.
 */
app.get('/api/sessions/:id/image/:uuid/:index', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.transcriptPath) return res.status(404).end();
  try {
    const found = await readImage(session.transcriptPath, req.params.uuid, Number(req.params.index));
    if (!found || !IMAGE_MEDIA.has(found.media)) return res.status(404).end();
    res.set('Content-Type', found.media);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Length', String(found.buffer.length));
    res.end(found.buffer);
  } catch {
    res.status(404).end();
  }
});

/**
 * Another session in the same folder as this one, named after it.
 *
 * Everything `+ new` asks you for is already on the row you pressed, so this asks for
 * nothing. Three things it gets from the session rather than from the request:
 *
 *   `paneCwd`, not `cwd` — Claude Code rewrites a transcript's `cwd` when a session
 *   changes directory mid-conversation, so `cwd` is where it wandered to and `paneCwd` is
 *   where it was launched. Duplicating into the former files the copy under a different
 *   rail heading, and so out of the group its original sits in.
 *
 *   The label is the source's own slug, via `slugFor` — the inverse of the naming in
 *   `launch.js`. `uniqueSessionName` then suffixes it, so a duplicate of
 *   `<prefix>alpha-main` is `<prefix>alpha-main-2`. Letting it auto-number instead would
 *   produce `<prefix>alpha-1`, a name with no visible relationship to the row you pressed.
 *   A tmux session never minted that way yields `null` and does auto-number.
 *
 *   Bypass carries over. A copy of a session that never stops to ask must also never stop
 *   to ask — one that quietly behaved differently from its original would be worse than no
 *   button at all. The rail row says so before you press it.
 */
app.post('/api/sessions/:id/duplicate', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session.' });
  if (!session.paneCwd) return res.status(400).json({ error: 'No folder to duplicate into.' });

  try {
    const created = await createSession({
      folder: session.paneCwd,
      label: slugFor(session.tmuxSession, session.paneCwd),
      skipPermissions: Boolean(session.bypass),
    });
    await registry.refresh().catch(() => {});
    const made = created.paneId ? registry.byPane(created.paneId) : null;
    res.json({ ok: true, ...created, sessionId: made?.id ?? null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------------------------------------------------------------- team --- */

/**
 * Every team on disk — one row per `TEAMS_DIR` entry with a readable, parseable
 * `team.json`. The mobile home list's whole source: nothing else in the codebase
 * enumerates `TEAMS_DIR` today.
 *
 * `repo` is read out of the file, never reconstructed from the directory name — `teamKey`
 * turns every `/` into `-` and is not invertible (two different real paths can produce the
 * same directory name), so a reconstructed path would launch nothing and match no session.
 */
app.get('/api/teams', async (_req, res) => {
  let entries = [];
  try {
    entries = await fsp.readdir(TEAMS_DIR, { withFileTypes: true });
  } catch {
    return res.json({ teams: [] });
  }
  const teams = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stored = JSON.parse(await fsp.readFile(path.join(TEAMS_DIR, entry.name, 'team.json'), 'utf8'));
      if (!stored?.repo) continue;
      teams.push({ repo: stored.repo, name: path.basename(stored.repo) });
    } catch {
      /* no team.json, or unparseable — skip */
    }
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ teams });
});

/*
 * Dispatch — the machinery the team lead drives. No UI calls this: a worker exists
 * because a lead asked for one, which is itself because a human asked the lead first.
 *
 * The deliberate absence: `skipPermissions` is not read from the request. Workers never
 * launch with bypass — a prompt a worker hits is the escalation signal, not friction.
 */

const WORKER_CAP = Number(process.env.FOREMAN_WORKER_CAP || 3);

/**
 * The rail group a repo's workers are filed under — found by name, made if missing.
 *
 * Made with `auto`, which is the only thing that will ever let the panel delete it again:
 * these hold worktrees the panel deletes at close, so without that the heading outlives
 * everything under it. A group of the same name that the maintainer made by hand is found
 * here and used as-is — including its flag, so filing workers into it never makes it
 * disposable.
 */
function teamGroup(repoTop) {
  const name = path.basename(repoTop);
  const found = groups.list().find((g) => g.name.toLowerCase() === name.toLowerCase());
  return found || groups.create(name, { auto: true });
}

/*
 * Start a worker — and, with `id`, start a *pending* one.
 *
 * Promotion is this same handler against an existing record rather than a path of its
 * own, and that is deliberate rather than lazy: a promoted worker has to get literally
 * the same worktree, setup command, settings file, brief, MCP config, trust-gate answer,
 * group filing, queue delivery and room lines as any other dispatch. Two code paths
 * would drift, and the half nobody exercises is the half that rots — so `id` only
 * decides *where the arguments come from*, and everything from `createWorktree` down
 * cannot tell the difference.
 */
app.post('/api/team/dispatch', async (req, res) => {
  // Looked up before anything else is read, because on a promotion the record is where
  // most of the request comes from.
  const promoteId = String(req.body?.id || '').trim();
  const pending = promoteId ? tasks.get(promoteId) : null;
  if (promoteId && !pending) {
    return res.status(404).json({ error: `No such task: ${promoteId}.` });
  }
  if (pending && pending.state !== 'pending') {
    // Naming the state is the whole value of this refusal. The case that matters is a
    // worker already running under this label — "it is working" and "there is no such
    // task" are very different problems, and a lead told only "no" would retry.
    return res.status(409).json({
      error: `${promoteId} is ${pending.state}, not pending — only a pending task can be started.`,
    });
  }

  // The record says which repo it belongs to; a `folder` that disagrees is a mistake
  // worth naming rather than silently overruling, since the folder is what a worktree
  // gets cut from.
  const askedFolder = String(req.body?.folder || '').trim();
  if (pending && askedFolder && askedFolder !== pending.repo) {
    return res.status(400).json({ error: `${promoteId} belongs to ${pending.repo}, not ${askedFolder}.` });
  }

  const repo = pending ? pending.repo : askedFolder;
  const rawLabel = pending ? pending.id : String(req.body?.label || '').trim();
  // A `body` override is the point of a pending task: the brief stays cheap to change,
  // and the last moment it can change is the moment it starts.
  const body = String(req.body?.body || '').trim() || (pending ? pending.body : '');
  if (!repo) return res.status(400).json({ error: 'Which folder?' });
  if (!rawLabel) return res.status(400).json({ error: 'A worker needs a label.' });
  if (!body) return res.status(400).json({ error: 'A worker needs a task.' });

  // `plan` dispatches a planner: same worktree, same branch, same room, and a permission
  // stance that makes "cannot write code" a wall rather than a line in a prompt.
  const kind = String(req.body?.kind || pending?.kind || 'build').trim() || 'build';
  if (!TASK_KINDS.includes(kind)) {
    return res.status(400).json({ error: `No such task kind: ${kind} — it is one of ${TASK_KINDS.join(', ')}.` });
  }

  // No `tidyLabel` on a promotion: the id was tidied when the task was recorded, and
  // re-tidying a stored id is a rename waiting to happen.
  const label = pending ? pending.id : tidyLabel(rawLabel);
  // The duplicate check stands for every case except the one where the duplicate *is*
  // the record being promoted.
  if (!pending && tasks.get(label)) {
    return res.status(409).json({ error: `A task is already called “${label}” — pick another label.` });
  }
  // The team's config fills whatever the request doesn't say: cap, setup command, allow
  // entries. A repo with no team yet gets the old env-var default — dispatch worked
  // before teams existed and keeps working without one.
  const team = readTeam(repo);
  const cap = team?.maxWorkers ?? WORKER_CAP;
  // Unchanged by promotion, and it has to be: `pending` is outside `ACTIVE` precisely so
  // a backlog cannot fill the cap, which means starting one moves a task *into* the
  // counted set. A promotion at cap is refused exactly like any other dispatch — but the
  // refusal points somewhere: a plain dispatch has nowhere to go but the backlog, and a
  // promotion already has a home to go back to.
  if (tasks.active(repo).length >= cap) {
    return res.status(409).json({
      error: pending
        ? `Already ${cap} active workers on this repo — ${label} stays pending.`
        : `Already ${cap} active workers on this repo — record it with task_add and start it when a slot frees.`,
    });
  }

  // The model is the lead's call, per task, judged on size and complexity — the maintainer's
  // ruling (2026-08-26) — validated against the known list before anything touches
  // disk: an unknown id must fail the dispatch, not become a launch flag. A departure
  // from the team default needs a reason, because the room line's "why" is the whole
  // point: the maintainer wants to see when the lead has called it wrong.
  //
  // A pending record stores its model *unresolved* — `null` means "the team default at
  // the time it starts" — so a promotion resolves it here, now, and the departure line
  // below fires off that answer. Nothing writes the resolved value back onto the record
  // before launch; what lands on it is what actually launched.
  let model;
  try {
    model = resolveWorkerModel(req.body?.model ?? pending?.model, team?.defaultModel);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const modelReason = String(req.body?.modelReason || pending?.modelReason || '').trim();
  if (!model.isDefault && !modelReason) {
    return res.status(400).json({
      error: `Naming a non-default model (${model.model} over ${model.defaultModel}) needs a one-line modelReason — ${humanName(repo)} reads it in the room.`,
    });
  }

  let wt;
  try {
    await pruneWorktrees(repo);
    wt = await createWorktree({ repo, label });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Known before the file exists, so `plan_read` can tell "not written yet" apart from
  // "no such task" — and so the brief can name the exact path the planner must write to.
  const planFile = kind === 'plan' ? planPath(repo, label) : null;

  // Create if new, update if promoting. `tasks.create` throws on a duplicate id, so a
  // promotion has to be an update — and a delete-and-recreate would throw away
  // `createdAt`, which is the only record of how long an idea waited. `source` is left
  // alone on a promotion: it says where the idea came from, not who started it.
  //
  // Note this is the first thing on the promotion path to touch the record at all. If
  // `createWorktree` above threw, the handler has already returned 400 and the task is
  // still `pending` with its brief intact. Past this line the existing failure rules
  // apply exactly: setup or launch failure sets `failed` and keeps the worktree as
  // evidence, and must never fall back to `pending` — a `failed` record with a checkout
  // on disk is the evidence rule this whole system runs on.
  const fields = {
    kind,
    planFile,
    body,
    branch: wt.branch,
    worktree: wt.dir,
    base: wt.base,
    staleBase: wt.stale,
    model: model.model,
    // Validated at dispatch and posted to the room since the model argument existed, and
    // until now never stored — so every worker that has ever run has a blank one.
    modelReason: modelReason || null,
  };
  const task = pending
    ? tasks.update(label, {
        ...fields,
        state: 'queued',
        // What the maintainer said to green-light *this* task. The endpoint stores what it
        // is given rather than demanding it — the per-task-yes rule is enforced where it
        // can actually be enforced, in the `task_start` tool, which requires a confirmation
        // and posts it to the room where the maintainer can see the claim.
        startedBy: String(req.body?.startedBy || '').trim() || null,
      })
    : tasks.create({
        ...fields,
        id: label,
        repo,
        source: req.body?.source || 'chat',
      });

  // Setup before launch, so the worker's first look at the tree is a working one. A
  // failed setup fails the task and keeps the worktree — the log says why. The command
  // is detected from the tree itself (a legacy team.json `setup` still wins); nothing in
  // the request can override it, so there is exactly one answer to "what will run".
  const setup = await runSetup(wt.dir, resolveSetup(team?.setup, wt.dir).command);
  if (!setup.ok) {
    tasks.update(label, { state: 'failed' });
    return res.status(500).json({ error: `Setup failed: ${setup.error}`, logFile: setup.logFile, task });
  }

  try {
    // Both files live in the team dir; ensure it exists even when no lead has run yet.
    // `ensureTeam` also makes `plans/`, which the planner's allow rule names — a rule
    // pointing at a folder that does not exist is a rule nobody can check.
    const { dir: tDir, decisionsFile } = ensureTeam(repo);

    // A planner's stance is denies, not asks (team.js `plannerStance`): its own worktree,
    // every sibling worktree, the real checkout, and git commit/push. `writeWorkerSettings`
    // puts the destructive-git floor underneath either way.
    const stance = kind === 'plan'
      ? plannerStance({ repo: wt.top, worktree: wt.dir, plans: plansDir(repo), worktreesRoot: WORKTREES_DIR })
      : { deny: [], allow: [] };
    const settingsFile = await writeWorkerSettings({
      repo: wt.top,
      label,
      allow: [
        ...(Array.isArray(req.body?.allow) ? req.body.allow : (team?.allow ?? [])),
        ...stance.allow,
      ],
      deny: stance.deny,
    });

    // The worker's voice (Wave C): a brief teaching the two-channel escalation rule, and
    // exactly two tools — room_post and task_report — scoped to its own task by env. A
    // planner gets a different brief and the same two tools: its output is a file, and
    // it reports on it exactly the way a build worker reports on a branch.
    const wBriefFile = path.join(tDir, `worker-${label}.brief.md`);
    await fsp.writeFile(
      wBriefFile,
      kind === 'plan'
        ? plannerBrief({ repo: wt.top, taskId: label, planFile, decisionsFile, human: humanName(repo), base: bareBase(wt.base) })
        : workerBrief({ repo: wt.top, taskId: label, decisionsFile, human: humanName(repo), base: bareBase(wt.base) }),
    );
    const wMcpFile = path.join(tDir, `worker-${label}.mcp.json`);
    await fsp.writeFile(
      wMcpFile,
      JSON.stringify(
        {
          mcpServers: {
            foreman: {
              type: 'stdio',
              command: process.execPath,
              args: [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'foreman.js')],
              env: { FOREMAN_PORT: String(PORT), FOREMAN_REPO: repo, FOREMAN_ROLE: 'worker', FOREMAN_TASK: label },
            },
          },
        },
        null,
        2,
      ),
    );

    const created = await createSession({
      folder: wt.dir,
      label,
      nameComponent: path.basename(wt.top),
      terminal: false,
      // `--model` and nothing else — the model argument is a validated id, never a
      // general extra-flags channel, and skipPermissions stays unreachable from here.
      extraArgs: [
        '--settings', settingsFile,
        '--append-system-prompt-file', wBriefFile,
        '--mcp-config', wMcpFile,
        '--strict-mcp-config',
        '--model', model.model,
      ],
    });

    // Every worktree is a fresh folder, so the trust gate is expected, once. The answer
    // is guarded inside — a gate naming any other folder is left standing.
    const gate = await answerTrustGate(created.paneId, wt.dir);

    // The *name* the rail draws, not the path: the roster's folder key is
    // `basename(cwd)`, so a group filed with the absolute directory matched no session
    // and every team heading read `· 0` with its workers live three rows below.
    const group = teamGroup(wt.top);
    groups.assign(path.basename(wt.dir), group.id);

    await registry.refresh().catch(() => {});
    const session = created.paneId ? registry.byPane(created.paneId) : null;
    tasks.update(label, { state: 'dispatched', tmuxSession: created.name, pane: created.paneId });

    // The task body is the worker's first message, through the queue — delivered when
    // the composer is free, behind `claim()`, like everything else the panel types.
    if (created.paneId) {
      queue.add(created.paneId, body, { paneCreatedMs: await paneBirthday(created.paneId) });
    }

    // `event` names the machinery, so the room can colour a dispatch without reading the
    // sentence. `about` cannot do that job — it is the task id, and the transition line
    // that follows this one carries the same one. Rides the same `...rest` as `conflict`
    // and `report`; `room.js` is untouched.
    room.post(repo, {
      from: 'panel', to: 'lead', kind: 'system', about: label, event: 'dispatch',
      text: `${kind === 'plan' ? 'Planner' : 'Worker'} ${label} dispatched on ${wt.branch}${wt.stale ? ` (base: local ${wt.base} — fetch failed)` : ''}.`,
    });
    // A departure from the team default is said out loud, with the lead's why — so the
    // maintainer can see when the lead has called it wrong. The default going out silently
    // is the point of it being the default.
    if (!model.isDefault) {
      room.post(repo, {
        from: 'panel', to: 'lead', kind: 'system', about: label,
        text: `Worker ${label} launched on ${model.model}, not the default ${model.defaultModel} — ${modelReason}`,
      });
    }

    broadcastRoster();
    res.json({ ok: true, task: tasks.get(label), gate, sessionId: session?.id ?? null });
  } catch (err) {
    tasks.update(label, { state: 'failed' });
    res.status(500).json({ error: err.message, task: tasks.get(label) });
  }
});

/*
 * Record a task without starting one — the front half of `/api/team/dispatch` and
 * nothing else.
 *
 * The third place an idea can go. Today it becomes a Gitea issue (ceremony) or a
 * dispatched worker (a session, a worktree, a cap slot and money, this minute); the kind
 * of idea that is neither lives in the lead's head, which is the one thing here that does
 * not survive `/clear`. This writes it down with its context while changing it is still
 * free.
 *
 * Everything past the validation is deliberately absent: no worktree, no branch, no
 * settings file, no MCP config, no session, no trust gate, no group filing. What it does
 * keep is every check dispatch makes *before* touching disk, because the point of recording
 * an idea now is that starting it later is uneventful — an unknown model id or a colliding
 * label must fail here, while the maintainer is still in the conversation, not eight hours
 * from now against a record nothing can promote.
 */
app.post('/api/team/tasks', (req, res) => {
  const repo = String(req.body?.folder || '').trim();
  const rawLabel = String(req.body?.label || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!repo) return res.status(400).json({ error: 'Which folder?' });
  if (!rawLabel) return res.status(400).json({ error: 'A worker needs a label.' });
  if (!body) return res.status(400).json({ error: 'A worker needs a task.' });

  const kind = String(req.body?.kind || 'build').trim() || 'build';
  if (!TASK_KINDS.includes(kind)) {
    return res.status(400).json({ error: `No such task kind: ${kind} — it is one of ${TASK_KINDS.join(', ')}.` });
  }

  // `tidyLabel` rewrites what the lead typed, and the response carries the result: the id
  // is the name the task will be started by, and a lead holding the untidied string would
  // later ask to promote a record that isn't there.
  const label = tidyLabel(rawLabel);
  if (tasks.get(label)) {
    return res.status(409).json({ error: `A task is already called “${label}” — pick another label.` });
  }

  // Validated exactly as a dispatch validates it — and then thrown away. What lands on
  // the record is the *request* (`null` when omitted), because `null` means "the team
  // default at the time it starts". Freezing today's resolved default onto an idea that
  // may sit for a month would launch it on a default nobody chose, and silently: the
  // record would look explicit, so the "departure from the default" room line — the whole
  // way the maintainer sees the lead's model calls — would never fire.
  const team = readTeam(repo);
  let model;
  try {
    model = resolveWorkerModel(req.body?.model, team?.defaultModel);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const modelReason = String(req.body?.modelReason || '').trim();
  if (!model.isDefault && !modelReason) {
    return res.status(400).json({
      error: `Naming a non-default model (${model.model} over ${model.defaultModel}) needs a one-line modelReason — ${humanName(repo)} reads it in the room.`,
    });
  }

  // No `branch`, `worktree`, `base` or `planFile`: all four are facts about a checkout,
  // and there is no checkout. A plan task's `planFile` is derived at promotion by
  // `planPath(repo, id)` and `GET /api/team/plans/:id` falls back to the same call, so a
  // pending planner reads back as "no plan written yet", which is true.
  const task = tasks.create({
    id: label,
    repo,
    kind,
    body,
    source: req.body?.source || 'chat',
    state: 'pending',
    model: req.body?.model ?? null,
    modelReason: modelReason || null,
  });

  // `event` names the machinery so the room can style this without reading the sentence —
  // the same rule the dispatch line's green follows, and the reason a reword can never
  // silently turn it off. This one is styled *quieter* than a plain system line: the two
  // coloured lines in the room mean "look at this", and this one means the opposite.
  room.post(repo, {
    from: 'panel', to: 'lead', kind: 'system', about: label, event: 'pending',
    text: `${kind === 'plan' ? 'Planner' : 'Task'} ${label} recorded as pending — nothing is running.`,
  });

  broadcastRoster();
  res.json({ ok: true, id: label, task });
});

/**
 * The tickets, with live state joined on — stored state is not the whole truth.
 *
 * Two additive query params, both for a narrow client polling this every few seconds:
 * `folder` (exact match on `t.repo`) and `brief=0` (omit `body`, the bulk of the payload —
 * measured at 434 KB of 502 KB across every team's tasks). Both absent must answer exactly
 * as before: the desktop calls this unfiltered every 3s and is not being changed.
 */
app.get('/api/team/tasks', async (req, res) => {
  const folder = String(req.query.folder || '').trim();
  const includeBrief = req.query.brief !== '0';
  const byTmux = new Map(registry.list().map((s) => [s.tmuxSession, s]).filter(([k]) => k));
  const rows = await Promise.all(
    tasks.list(folder || null).map(async (t) => {
      const live = t.tmuxSession ? byTmux.get(t.tmuxSession) : null;
      const { body, ...withoutBrief } = t;
      return {
        ...(includeBrief ? t : withoutBrief),
        // `status` is the roster's word for it, not `state` — verified against
        // /api/sessions, where a first draft of this join returned undefined.
        live: live
          ? { sessionId: live.id, status: live.status, model: live.model, needsYou: live.needsYou, stuck: watch.flags(t.id).stuck }
          : null,
        // Merged is not live: `done` says the PR landed on the Gitea box, this says
        // whether the code reached the checkout — and the process — in front of you.
        deploy: await deployed.status(t).catch(() => null),
      };
    }),
  );
  res.json({ tasks: rows });
});

/**
 * One task, with its `body` — so a brief modal can fetch the one it needs instead of
 * re-pulling every team's tasks. Mirrors `GET /api/team/plans/:id`. A different method
 * (`GET`, not `POST`) on the longer path below is safe alongside `PATCH /api/team/tasks/:id`
 * and `POST /api/team/tasks/:id/close` — express matches on method too.
 */
app.get('/api/team/tasks/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: `Unknown task: ${req.params.id}` });
  res.json({ task });
});

/**
 * A planner's output — the document itself, by task id.
 *
 * Read through an endpoint rather than handed to the lead as a path to `cat`, for the
 * reason the whole `foreman` surface exists: the lead's tools are the lead's hands, and a
 * lead that shells around the panel to find things is a lead nobody can audit. A plan
 * that has not been written yet is a 404 that says so, and names where it will be.
 *
 * `task.planFile` is recorded at dispatch time and can go stale — a state-dir or team-key
 * rename (moving the checkout, renaming the repo folder) leaves it naming a path that no
 * longer exists, while the file itself sits untouched at the computed `planPath`. So a
 * recorded path that fails to read falls back to the computed one before giving up; the
 * 404 then names both, so a genuine "not written yet" is told apart from a stale record.
 */
app.get('/api/team/plans/:id', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Unknown task.' });
  if (task.kind !== 'plan') {
    return res.status(400).json({ error: `${task.id} is a ${task.kind} task — it has no plan.` });
  }
  const computed = planPath(task.repo, task.id);
  const candidates = task.planFile && task.planFile !== computed ? [task.planFile, computed] : [computed];
  for (const file of candidates) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      res.json({ ok: true, id: task.id, state: task.state, path: file, text });
      return;
    } catch {
      // Try the next candidate, if any.
    }
  }
  res.status(404).json({
    error: `No plan has been written yet — ${task.id} is ${task.state}.`,
    id: task.id, state: task.state, path: candidates[candidates.length - 1], triedPaths: candidates,
  });
});

/** The room: read since a cursor. View-only for humans, `room_read` for the lead. */
app.get('/api/team/room', (req, res) => {
  const repo = String(req.query.folder || '').trim();
  if (!repo) return res.status(400).json({ error: 'Which folder?' });
  res.json(room.read(repo, { since: Number(req.query.since) || 0 }));
});

/** Post to the room — the lead and workers, via their foreman tools. */
app.post('/api/team/room', (req, res) => {
  const repo = String(req.body?.folder || '').trim();
  const from = String(req.body?.from || '').trim();
  if (!repo || !from) return res.status(400).json({ error: 'A room post needs a folder and a sender.' });
  const { folder, ...entry } = req.body;
  try {
    const posted = room.post(repo, entry);
    // A worker's escalation is exactly what the nudge exists for; the lead's own posts
    // are not — it wrote them, it knows.
    if (from !== 'lead') watch.nudgeLead(repo);
    res.json({ ok: true, entry: posted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Team config: the toggles and dispatch defaults. PATCH is the maintainer's — the popover. */
app.get('/api/team/config', async (req, res) => {
  const repo = String(req.query.folder || '').trim();
  if (!repo) return res.status(400).json({ error: 'Which folder?' });
  const team = readTeam(repo);
  if (!team) return res.status(404).json({ error: 'No team for this folder.' });
  // `setupResolved` is computed, never stored: the same answer dispatch will use, with
  // the reason the panel shows read-only. Detection is a readdir — cheap enough per GET.
  // `models` rides along so the panel's default-model picker offers exactly the list
  // dispatch will accept, from the one place it is defined.
  //
  // `forgeResolved` and `baseResolved` are the same pattern and the same ruling (a control
  // the user cannot answer correctly should not be a control) — with one real difference
  // from `resolveSetup`, which is why this handler is now async: those two shell out to
  // git. It is cheap (`git remote get-url` and `symbolic-ref` read `.git/config`, no
  // network) but it is a process rather than a readdir, so both cache per repo. Neither is
  // ever stored, and PATCH refuses to write either.
  const [forgeResolved, baseResolved] = await Promise.all([resolveForge(repo), resolveBaseBranch(repo)]);
  res.json({ ...team, models: WORKER_MODELS, setupResolved: resolveSetup(team.setup, repo), forgeResolved, baseResolved });
});

app.patch('/api/team/config', async (req, res) => {
  const repo = String(req.body?.folder || '').trim();
  if (!repo) return res.status(400).json({ error: 'Which folder?' });
  const team = readTeam(repo);
  if (!team) return res.status(404).json({ error: 'No team for this folder.' });

  const patch = req.body?.toggles || {};
  // mergePRs is a display of intent, not a capability — it stays refusable at every
  // endpoint regardless, and it is not flippable from here either.
  delete patch.mergePRs;
  if (patch.stuckAfterMinutes !== undefined) {
    const mins = Number(patch.stuckAfterMinutes);
    if (!Number.isFinite(mins) || mins < 1) {
      return res.status(400).json({ error: 'stuckAfterMinutes must be a number of minutes, at least 1.' });
    }
    patch.stuckAfterMinutes = mins;
  }
  // The one toggle that is type-checked rather than stored as sent. Every other boolean
  // here is read for truthiness by something that merely reports; this one gates a merge,
  // and `"false"` — the string a form control hands you — is truthy. Refusing a non-boolean
  // costs a caller one fixed request; accepting one turns the toggle on by accident.
  if (patch.leadDecidesMerges !== undefined && typeof patch.leadDecidesMerges !== 'boolean') {
    return res.status(400).json({ error: 'leadDecidesMerges is true or false.' });
  }
  const next = { ...team, toggles: { ...team.toggles, ...patch } };
  if (typeof req.body?.maxWorkers === 'number') next.maxWorkers = req.body.maxWorkers;
  // Panel chrome — whether the aside's SETTINGS block is folded away. Kept out of
  // `toggles` on purpose (those are the autonomy dials) and whitelisted key by key, so
  // this never becomes a general "write anything into team.json" channel.
  if (req.body?.ui && typeof req.body.ui === 'object') {
    next.ui = { ...team.ui };
    if (req.body.ui.settingsOpen !== undefined) next.ui.settingsOpen = Boolean(req.body.ui.settingsOpen);
  }
  if (req.body?.defaultModel !== undefined) {
    // The same validation dispatch applies — a default the dispatch would refuse must
    // never be storable. Passed as the *requested* model, so the refusal reads as
    // "unknown model" with the list, not as a complaint about a file nobody edited.
    try {
      next.defaultModel = resolveWorkerModel(req.body.defaultModel, null).model;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  // The bound on `leadDecidesMerges`, and the one new top-level key this endpoint writes.
  // Whitelisted by name like every other, and validated through the one function that
  // decides the list's shape (`normalizeReviewPaths`) — so what the panel stores and what
  // `mergeVerdict` matches against cannot be two different ideas of an entry. The refusal
  // carries the thrown message verbatim, because it names the entry that was wrong and a
  // 400 saying "invalid" would send the maintainer back to guess which line.
  if (req.body?.humanReviewPaths !== undefined) {
    try {
      next.humanReviewPaths = normalizeReviewPaths(req.body.humanReviewPaths);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  // `setup` deliberately not writable — it is detected from the project's files
  // (setup-detect.js). A legacy value already in team.json is honoured; nothing new
  // writes one. If detection is wrong, that is a bug in detection, not a box to correct.
  //
  // `forge` and `base` are the same: detected per repo from the repo's own origin
  // (`forge.js`, `base-branch.js`), never stored and never patchable. A `forge` key in the
  // body is ignored exactly the way a `setup` key is — there is no whitelist entry for it
  // above, so it simply never reaches `next`, and this comment is what stops somebody
  // adding one later out of kindness.
  try {
    // Awaited, unlike the first version — a write that failed used to resolve as a 200
    // with config that never landed.
    await fsp.writeFile(path.join(teamDir(repo), 'team.json'), JSON.stringify(next, null, 2));
    // Same shape as the GET — the panel replaces its cached config with this wholesale,
    // and the model picker must not lose its option list on the first flip.
    const [forgeResolved, baseResolved] = await Promise.all([resolveForge(repo), resolveBaseBranch(repo)]);
    res.json({ ...next, models: WORKER_MODELS, setupResolved: resolveSetup(next.setup, repo), forgeResolved, baseResolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * A worker's own report — the only PATCH a worker holds, and it can only say `working`
 * or `review`. `review` posts the summary to the room and nudges the lead: this is how
 * "done" travels.
 */
app.patch('/api/team/tasks/:id', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Unknown task.' });

  // The lead's one write: the PR it just opened. Kept apart from the worker's report —
  // a PATCH carries either a state (worker) or a pr (lead), never a free-for-all.
  if (req.body?.pr !== undefined && req.body?.state === undefined) {
    const pr = String(req.body.pr || '').trim();
    if (!/^https?:\/\//.test(pr)) return res.status(400).json({ error: 'A PR is recorded by its URL.' });
    tasks.update(task.id, { pr });
    // Machinery, not speech: the lead did it, the panel is recording it, and it renders
    // as a framed system line like every other state change in the room.
    room.post(task.repo, {
      from: 'panel', to: 'lead', kind: 'system', about: task.id,
      text: `PR opened for ${task.id}: ${pr}`,
    });
    broadcastRoster();
    return res.json({ ok: true, task: tasks.get(task.id) });
  }

  const state = String(req.body?.state || '');
  if (state !== 'working' && state !== 'review') {
    return res.status(400).json({ error: 'A worker may only report "working" or "review".' });
  }
  const summary = String(req.body?.summary || '').trim();
  tasks.update(task.id, { state });

  // A planner's deliverable is a file, not a branch, so "did it actually land" is a
  // different question here — and worth asking, because a planner that reports without
  // writing anything looks exactly like one that succeeded.
  const planFile = task.kind === 'plan' ? (task.planFile || planPath(task.repo, task.id)) : null;
  const planWritten = planFile ? await fsp.access(planFile).then(() => true, () => false) : false;

  // The summary is the *worker's* words — it goes in as the worker, so the room draws it
  // as that worker speaking rather than as a panel line about it. Only the fact that this
  // is the done report travels as data (`report`), which the card renders under the
  // bubble and the lead reads straight out of `room_read`.
  try {
    room.post(task.repo, {
      from: task.id, to: 'lead', kind: 'status', about: task.id,
      text: summary || (state === 'review' ? 'Done — no summary given.' : 'Working.'),
      // `plan` rides the same `...rest` as `report` and `branch`: the lead reads the
      // path straight out of `room_read` and fetches the document with `plan_read`.
      // The room stays a log — a plan is a page long and belongs behind a tool call.
      ...(state === 'review'
        ? { report: 'review', branch: task.branch, ...(planWritten ? { plan: planFile } : {}) }
        : {}),
    });
    // Only on the bad path, which is why it is not noise: a planner that reported
    // without writing its plan is a failure nobody else would notice.
    if (state === 'review' && planFile && !planWritten) {
      room.post(task.repo, {
        from: 'panel', to: 'lead', kind: 'system', about: task.id, alert: true,
        text: `${task.id} reported done but wrote no plan at ${planFile}.`,
      });
    }
  } catch {
    /* a room post must never fail a worker's own report */
  }
  watch.nudgeLead(task.repo);

  // The branch tip, recorded while the branch still exists — after the merge and the
  // worktree sweep it is gone from this checkout, and with it any way to ask whether the
  // work in front of the maintainer is running. Off the response path: git must not slow a
  // report.
  if (state === 'review' && task.branch && task.kind !== 'plan') {
    // The base is the task's own, or the repo's detected default — never a hardcoded
    // `main`, which was wrong on every repo that calls its default branch anything else.
    Promise.resolve(task.base || resolveBaseBranch(task.repo).then((b) => b.branch))
      .then((base) => branchFacts(task.repo, { branch: task.branch, base }))
      .then((facts) => facts && tasks.update(task.id, facts))
      .catch(() => {});
  }

  broadcastRoster();
  res.json({ ok: true, task: tasks.get(task.id) });
});

/**
 * The gate in front of `outcome: "done"`. Returns `{ok: true}` when the close may proceed,
 * or `{ok: false, error}` with a message naming what to do about it.
 *
 * Written as a refusal rather than a warning on purpose: the close force-deletes the
 * branch, so "are you sure?" from a machine that already knows the answer is worse than
 * a no. And the way out is never hidden — the message names `abandon`, which is the word
 * for deliberately discarding work.
 */
async function mergedIntoBase(task) {
  const base = task.base || (await resolveBaseBranch(task.repo)).branch;
  const bare = bareBase(base) || 'main';
  const verdict = await mergedInto(task.repo, { branch: task.branch, base });
  if (verdict.gone || verdict.merged) return { ok: true, base: bare };
  return {
    ok: false,
    base: bare,
    error:
      `${task.branch} is not merged into ${bare} — checked origin/${bare} and ${bare}. ` +
      `Closing as done removes the worktree and force-deletes the branch, so this is refused. ` +
      `Merge it first (the PR, or \`git merge --no-ff ${task.branch}\` locally), then close it — ` +
      `or close with outcome "abandon" to discard the branch deliberately.`,
  };
}

/*
 * What the "done" line says about who decided this merge — one clause, on a self-merge
 * team only, and never a refusal.
 *
 * A second refusal on close would be the obvious move and is the wrong one: it would catch
 * merges the *maintainer* ordered on a team that also lets the lead decide, which breaks
 * the one thing this feature promised not to touch. So this is a visible non-event
 * instead, the same trade the trigger endpoint makes — a `done` task with no decision
 * recorded says so, in the line the maintainer already reads, and they can go and look.
 *
 * The comparison is against **the head that merged** (re-read a few lines above, because
 * review fixes commit after the review), not merely against "there is a selfMerge". A
 * verdict is bound to the commit it was taken on, so a check on commit A followed by a
 * push and a merge of commit B is exactly the case worth surfacing — and it surfaces as
 * "no merge decision recorded", which understates it slightly and errs towards being
 * looked at, which is the safe direction for this particular sentence.
 *
 * On a team with the toggle off this returns `''`, so the line is the one it has always
 * been — the same "byte-identical by default" rule the brief follows.
 */
function selfMergeClause(repo, task) {
  let team = null;
  try {
    team = readTeam(repo);
  } catch {
    /* no team, no toggle, no clause — a close must never fail over a sentence */
  }
  if (!team?.toggles?.leadDecidesMerges) return '';
  const decision = task?.selfMerge;
  const head = task?.head || null;
  if (decision?.allowed && head && decision.head === head) {
    return ` — merged on the lead's own judgment (checked ${new Date(decision.at).toLocaleString()}).`;
  }
  return ' — no merge decision recorded for this task.';
}

/**
 * Abandon a task: end its session (same guards as the bin — never type into a box),
 * remove its worktree and branch, mark it. A `failed` task keeps its worktree as
 * evidence unless the request insists.
 */
app.post('/api/team/tasks/:id/close', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Unknown task.' });

  // A pending task never ran: no session, no worktree, nothing to sweep. The rest of this
  // handler would mostly no-op its way past that — but it would still announce a worktree
  // removal that never happened, and `outcome: 'done'` would call a never-started idea
  // "merged and cleaned up". Both are the panel lying about disk, guarded here rather than
  // trusted to fall through.
  if (task.state === 'pending') {
    if (req.body?.outcome === 'done') {
      return res.status(400).json({ error: `${task.id} never started — it cannot be done.` });
    }
    tasks.update(task.id, { state: 'abandoned' });
    room.post(task.repo, {
      from: 'panel', to: 'lead', kind: 'system', about: task.id,
      text: `Pending task ${task.id} dropped before it started.`,
    });
    broadcastRoster();
    return res.json({ ok: true, task: tasks.get(task.id) });
  }

  const session = task.tmuxSession
    ? registry.list().find((s) => s.tmuxSession === task.tmuxSession)
    : null;
  if (session?.paneId) {
    const live = await readPaneState(session.paneId);
    if (live.prompt || live.plan || live.question || live.state === 'needs-decision' || live.state === 'dialog') {
      return res.status(409).json({
        error: 'The worker has something open in the terminal — answer or interrupt it first.',
      });
    }
    await sendText(session.paneId, '/exit').catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
  }

  // `done` is earned, not default: it records that the work was merged, and the lead's
  // brief requires the PR verified merged before asking for it. Everything else is an
  // abandonment, and a failed task keeps its evidence either way unless told otherwise.
  const done = req.body?.outcome === 'done' && task.state !== 'failed';
  const keepWorktree = task.state === 'failed' && !req.body?.removeWorktree;

  /*
   * **`done` is checked, not trusted.** Closing as done force-deletes the branch
   * (`git branch -D` in `removeWorktree`), and for the whole life of this feature the only
   * thing between that and a worker's unmerged commits was a sentence in the lead's brief.
   * With no forge there is nothing to verify against at all — "done" means "I merged it
   * locally", and nobody was checking.
   *
   * So: the branch must already be an ancestor of the base. Both spellings, because the
   * two paths land the merge in different places — a forge merges on the box and this
   * checkout's local branch lags it, while a no-forge merge is local and there is no
   * remote at all. Fetch first (short timeout, failure ignored) so a lead that merged on
   * the forge and has not pulled yet is not refused for a stale ref.
   *
   * Three deliberate exemptions. A planner's branch carries no commits, so there is
   * nothing to protect. A task whose branch is already gone has nothing to force-delete.
   * And `abandon` is untouched — discarding a branch is exactly what that word means.
   */
  if (done && task.branch && task.kind !== 'plan') {
    // Fail **closed**: a guard in front of a force delete that lets the close through
    // when it could not check is not a guard. `abandon` is always available and says what
    // it means, so nobody is stuck.
    const verdict = await mergedIntoBase(task).catch((err) => ({
      ok: false,
      error: `Could not check whether ${task.branch} is merged (${err.message}) — refusing, since closing as done force-deletes it. Close with outcome "abandon" if you meant to discard it.`,
    }));
    if (!verdict.ok) {
      return res.status(409).json({ error: verdict.error, branch: task.branch, base: verdict.base });
    }
  }

  // Last chance to read the branch: the sweep below deletes it. Re-read even when the
  // review report already recorded a tip, because review fixes commit after it — the tip
  // that matters is the one that got merged.
  // A planner's branch has no commits on it, so there is nothing to record and an empty
  // three-dot diff would read as "nothing to restart for" — skip it entirely.
  if (done && task.branch && task.kind !== 'plan') {
    const closeBase = task.base || (await resolveBaseBranch(task.repo)).branch;
    const facts = await branchFacts(task.repo, { branch: task.branch, base: closeBase }).catch(() => null);
    // …but keep the review-time file list if the merge already happened: a three-dot
    // diff against a main that now *contains* the branch is empty, and an empty change
    // list reads as "nothing to restart for".
    if (facts) {
      tasks.update(task.id, {
        head: facts.head,
        changed: facts.changed?.length ? facts.changed : task.changed,
      });
    }
  }

  if (!keepWorktree && task.worktree) {
    // Reported, not swallowed. `removeWorktree` no longer eats the `branch -D` failure,
    // and with the gate above in front of it a failure here means the branch is still on
    // disk after the panel said it swept it — which is a room line, not a silence.
    const swept = await removeWorktree({ repo: task.repo, dir: task.worktree, branch: task.branch, force: true }).catch(
      (err) => ({ branchRemoved: false, error: err.message }),
    );
    if (task.branch && swept && !swept.branchRemoved) {
      room.post(task.repo, {
        from: 'panel', to: 'lead', kind: 'system', about: task.id, alert: true,
        text: `${task.id}: the worktree is gone but ${task.branch} is still here — ${swept.error || 'git said no'}.`,
      });
    }
    // The folder is off disk; its filing is dead weight, and the team's group is litter
    // once the last one goes. A `failed` task keeping its worktree keeps its shelf too —
    // there is still something there to go and look at.
    groups.retireWorktree(task.worktree);
  }
  tasks.update(task.id, { state: task.state === 'failed' ? 'failed' : done ? 'done' : 'abandoned' });
  room.post(task.repo, {
    from: 'panel', to: 'lead', kind: 'system', about: task.id,
    text: done
      ? task.kind === 'plan'
        // Worth saying out loud: closing a plan task removes its worktree and branch and
        // leaves the plan itself alone — it lives in the team folder, not the checkout.
        ? `Plan task ${task.id} is done; the plan stays at ${task.planFile || planPath(task.repo, task.id)}.`
        : `Task ${task.id} is done — merged and cleaned up.${task.pr ? ` (${task.pr})` : ''}${selfMergeClause(task.repo, tasks.get(task.id))}`
      : `Task ${task.id} closed (${tasks.get(task.id).state}); worktree ${keepWorktree ? 'kept' : 'removed'}.`,
  });
  await registry.refresh().catch(() => {});
  broadcastRoster();
  res.json({ ok: true, task: tasks.get(task.id), worktreeKept: keepWorktree });
});

/* ------------------------------------------------------------ trigger --- */

/*
 * `POST /api/trigger` — a webhook puts one pre-authorized sentence into one team's lead.
 *
 * The whole feature is a machine doing the typing the maintainer would otherwise do: the
 * frontend service files a feedback issue, `review feedback issue 66` arrives here, and it
 * lands in that team's lead — which already has standing permission, written in its own
 * `decisions.md`, to run its playbook without asking. Nothing wider than that. One
 * sentence, into one session that is already running, chosen by folder.
 *
 * Every answer is a refusal until proven otherwise, and each refusal is a different status
 * because the caller can act on the difference:
 *
 *   503  the feature is off — no `FOREMAN_TRIGGER_TOKEN` at boot
 *   401  no credential, or the wrong one
 *   400  no `folder`, or one that is not an absolute path
 *   404  no team for that folder
 *   403  the phrase is not on this team's allow-list
 *   409  the identical phrase already went through inside the dedupe window
 *   409  no lead is running for that folder — and nothing is launched to fix that
 *   503  the lead's queue is full (MAX_PER_PANE): try later, something is looping
 *   200  typed, or queued for when the lead can hear it
 *
 * Two things it deliberately does not do. It does not decide for itself whether the lead
 * can hear it: `sendOrQueue` claims the pane and re-reads it live, because the roster is
 * up to a poll stale and an endpoint that checked `status === 'idle'` and then typed is
 * the exact bug the lock exists to prevent. And it never launches a lead — a fresh one has
 * not read `decisions.md`, so it would stop to ask for permission it already has, at 3am,
 * into a room nobody is reading. A 409 with a room line is a *visible* non-event, and that
 * is the better failure.
 *
 * Note that this route sits on the main app like every other one. It was planned as a
 * separate one-route listener so the panel could stay on loopback; that is no longer the
 * design, because the maintainer ruled (2026-08-27) that the panel is reachable from their
 * LAN and gets no authentication at all. The token here answers a different question from
 * "who may reach the panel": it is what stops arbitrary text being typed into a session
 * that dispatches workers on their behalf.
 */

/**
 * Is this request carrying the token? Constant-time, and it never throws on a header it
 * cannot parse.
 *
 * `timingSafeEqual` throws on unequal lengths, so the length check has to come first —
 * that leaks the token's length and nothing else, which is the usual trade. A plain `===`
 * leaks the token itself a byte at a time, and it costs three lines not to.
 */
function triggerAuthorized(req) {
  const m = /^Bearer\s+(\S+)$/.exec(String(req.get('authorization') || '').trim());
  if (!m) return false;
  const given = Buffer.from(m[1], 'utf8');
  const want = Buffer.from(TRIGGER_TOKEN, 'utf8');
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

/**
 * Phrases already accepted: `teamKey + ' ' + text` -> the ms it was accepted at.
 *
 * In memory on purpose — a panel restart clearing this is the behaviour we want, not a
 * bug. What it guards is a webhook retrying after a timeout, and by the time the panel has
 * restarted the message it would re-send is long gone. It is **not** a rate limit: a rate
 * limit answers this badly, letting a *second* issue through while blocking the retry.
 */
const triggerSeen = new Map();

/** The caller as the room should name it. Express with no `trust proxy` reports the
 *  socket's own address, which is the honest answer: whoever actually connected. */
const triggerSource = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * What a phrase looks like in a room line — collapsed to one line and clamped.
 *
 * The refusal line quotes text this endpoint never matched, and `room.jsonl` is append-only
 * and is the maintainer's scan surface. `matchTrigger` refuses anything over the cap
 * without looking at it, so without this an authenticated caller could append a megabyte
 * per request. Sliced before the collapse, so the regex never sees the long string either.
 */
function forRoom(text) {
  const raw = String(text);
  const clipped = raw.slice(0, MAX_TRIGGER_TEXT).replace(/\s+/g, ' ').trim();
  return raw.length > MAX_TRIGGER_TEXT ? `${clipped}…` : clipped;
}

app.post('/api/trigger', async (req, res) => {
  if (!TRIGGER_TOKEN) {
    return res.status(503).json({ error: 'Triggers are off — no FOREMAN_TRIGGER_TOKEN was set at boot.' });
  }
  if (!triggerAuthorized(req)) {
    // stderr and nowhere else. A refused credential must not reach the room: anyone who
    // can reach the port and guess a folder path could otherwise flood a team's
    // append-only log. A refused *phrase* is different — that caller has already proved it
    // holds the secret, and that line is exactly the one the maintainer wants to see.
    console.error(`[trigger] refused an unauthenticated request from ${triggerSource(req)}`);
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const folder = String(req.body?.folder || '').trim();
  const text = String(req.body?.text ?? '');
  // Relative would resolve against this process's cwd, which is a different folder that
  // could happen to be right — an accident, not an answer.
  if (!folder || !path.isAbsolute(folder)) {
    return res.status(400).json({ error: "A trigger needs `folder`, the repo's absolute path." });
  }
  const repo = path.resolve(folder);
  const team = readTeam(repo);
  if (!team) return res.status(404).json({ error: 'No team for this folder.' });

  const ip = triggerSource(req);
  const id = matchTrigger(text, team.triggers);
  if (!id) {
    room.post(repo, {
      from: 'panel', to: 'lead', kind: 'system', event: 'trigger', alert: true,
      text: `Trigger refused from ${ip}: "${forRoom(text)}" is not on this team's allow-list.`,
    });
    return res.status(403).json({ error: 'That phrase is not a trigger for this team.' });
  }

  const phrase = text.trim();
  const key = `${teamKey(repo)} ${phrase}`;
  const now = Date.now();
  for (const [k, at] of triggerSeen) if (now - at > TRIGGER_DEDUPE_MS) triggerSeen.delete(k);
  const last = triggerSeen.get(key);
  if (last !== undefined) {
    // No room line. This is the retry being absorbed, which is the feature working; the
    // line for the original is already there, carrying the timestamp that matters.
    return res.status(409).json({
      error: 'That exact phrase already went through — treating this as a retry.',
      trigger: id, duplicate: true, secondsAgo: Math.round((now - last) / 1000),
    });
  }
  // Stamped here — the moment the allow-list said yes, and *before* we know whether there
  // is a lead to take it. Stamping after the lead was found would read more like
  // "accepted", but a webhook retries on any non-2xx, so a folder with no lead would take
  // one alert line per retry forever, into an append-only file that is the maintainer's scan
  // surface. One line per phrase per window is the point. The only stamp that comes back
  // off is the one below, where the send itself failed and we told the caller to try
  // later.
  triggerSeen.set(key, now);

  const lead = findLead(registry.list(), repo);
  if (!lead) {
    room.post(repo, {
      from: 'panel', to: 'lead', kind: 'system', event: 'trigger', alert: true,
      text: `Trigger "${id}" from ${ip} could not be delivered: no lead is running in ${repo}. Nothing was launched.`,
    });
    return res.status(409).json({ error: 'No lead is running for this folder.', trigger: id });
  }

  // Announced at arrival, not at delivery, and that is the whole reason this line exists.
  // `queue.fail` backs off and retries forever, so a trigger that lands while the lead is
  // holding a permission box delivers whenever that box is answered — six hours later, if
  // that is when someone answers it. This timestamp is the only record that there was a
  // gap at all.
  //
  // Hence "handed to", not "delivered to". Posting at arrival means the outcome is not
  // known yet, and on a full queue this line is immediately followed by one saying the
  // message never arrived — benched, and two adjacent lines contradicting each other on the
  // maintainer's scan surface is worse than the vaguer verb. "Handed to" is true of all
  // three endings: typed, queued for hours, or refused by the line below.
  room.post(repo, {
    from: 'panel', to: 'lead', kind: 'system', event: 'trigger',
    text: `Trigger "${id}" from ${ip}: "${forRoom(phrase)}" — handed to the lead.`,
  });

  try {
    const { queued } = await sendOrQueue(lead, phrase);
    res.json({ ok: true, trigger: id, sessionId: lead.id, delivered: !queued, queued });
  } catch (err) {
    // A full queue is `sendOrQueue`'s 409, which is right for the panel's own send box —
    // whoever pressed the button can see the twenty messages waiting. A webhook cannot,
    // and "try later" is what it needs to hear, so it becomes a 503 here. The stamp comes
    // back off with it: we just told the caller to retry, and a dedupe hit on that retry
    // would contradict the status we sent.
    triggerSeen.delete(key);
    room.post(repo, {
      from: 'panel', to: 'lead', kind: 'system', event: 'trigger', alert: true,
      text: `Trigger "${id}" from ${ip} did not reach the lead: ${err.message}`,
    });
    res.status(err.status === 409 ? 503 : err.status || 500).json({ error: err.message, trigger: id });
  }
});

/* -------------------------------------------------------- merge queue --- */

/*
 * `GET /api/team/merge` and `POST /api/team/merge` — the PRs waiting on the maintainer, and
 * the button that asks their lead to merge one.
 *
 * These mirror `/api/trigger` above deliberately, because they are the same move: one
 * sentence, into one lead that is already running, chosen by folder, with the panel never
 * doing the thing itself. What the webhook does for a pre-authorized phrase, the button
 * does for the maintainer's own press — and their press *is* their explicit per-PR word
 * (decisions.md, 2026-08-30), which is the one thing the merge rule has always required.
 *
 * What is deliberately absent, and is not an oversight:
 *
 *   - **No token.** `/api/trigger` has one because a webhook is a machine on the network
 *     typing into a session that dispatches workers. This is the panel's own UI, on a
 *     panel the maintainer ruled (2026-08-27, restated 2026-08-30) is reachable from their LAN with
 *     no authentication in front of it and no plan for any. Adding one here would be a
 *     guard written quietly against a decision taken out loud.
 *   - **No merging.** No Gitea call, no `task_close`, no pull, no restart. Every one of
 *     those is the lead's, is already implemented, and is already ruled on; repeating any
 *     of them here — even in the sentence — is how a second source of truth starts.
 *   - **No launching.** No lead running is a 409 and a room line, exactly as the trigger
 *     ruling settled (2026-08-27): a fresh lead has not read `decisions.md`, and a
 *     visible non-event is the better failure.
 *
 * The refusals, and each is a status the caller can act on:
 *
 *   400  no `folder`, or one that is not absolute; no `tasks`; no `expect`
 *   404  a task id nobody has heard of
 *   409  a task that is no longer in `review`, or whose PR moved under the click
 *   409  a task with no PR yet — there is nothing to merge
 *   409  a batch that does not compose (never a single press — plan §1)
 *   409  the same task again inside the window, or one that already merged
 *   409  no lead is running — and nothing is launched to fix that
 *   503  the lead's queue is full
 *   200  typed, or queued for when the lead can hear it
 */

/**
 * Merge lines already sent: `${teamKey} ${taskId}` -> the ms it went.
 *
 * In memory, cleared by a restart, on purpose — the same idiom and the same reasoning as
 * `triggerSeen`. What it guards is the window between the press and the lead's
 * `task_close`, where the row is still on screen and a second press would ask for the same
 * merge twice; a panel restart is long past that. It is stamped only on a **successful**
 * send, which is where it differs from the trigger's: a webhook retries and must be
 * absorbed, but a human whose press was refused for want of a lead should be able to start
 * one and press again.
 */
const mergeSeen = new Map();

/** Ids sent for this team inside the window, pruned as we go. */
function sentFor(repo, now = Date.now()) {
  const prefix = `${teamKey(repo)} `;
  const ids = new Set();
  for (const [k, at] of mergeSeen) {
    if (now - at > TRIGGER_DEDUPE_MS) mergeSeen.delete(k);
    else if (k.startsWith(prefix)) ids.add(k.slice(prefix.length));
  }
  return ids;
}

/** The lead as the block needs it: enough to say whether there is one, and nothing more. */
const leadRow = (lead) =>
  lead
    ? {
        id: lead.id,
        tmuxSession: lead.tmuxSession,
        status: lead.status,
        // How many messages are waiting, not what they say: the block only needs to tell
        // the maintainer their press will land behind something, and the queue's contents
        // are another screen's business.
        queued: Array.isArray(lead.queued) ? lead.queued.length : 0,
      }
    : null;

app.get('/api/team/merge', async (req, res) => {
  const folder = String(req.query.folder || '').trim();
  // Relative would resolve against this process's cwd, which is a different folder that
  // could happen to be right — an accident, not an answer.
  if (!folder || !path.isAbsolute(folder)) {
    return res.status(400).json({ error: "The merge queue needs `folder`, the repo's absolute path." });
  }
  const repo = path.resolve(folder);
  try {
    // The forge decides whether there is a queue at all: with none, there are no PRs to
    // wait on and the block is removed rather than filled with rows that can never be
    // pressed. `forge` rides along so the client can say which, without a second call.
    const [forge, baseInfo] = await Promise.all([resolveForge(repo), resolveBaseBranch(repo)]);
    const { rows, batch } = await collectQueue({
      tasks: tasks.list(),
      repo,
      sent: sentFor(repo),
      forge: forge.forge,
      base: baseInfo.branch,
    });
    res.json({ lead: leadRow(findLead(registry.list(), repo)), rows, batch, forge: forge.reading });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/team/merge', async (req, res) => {
  const folder = String(req.body?.folder || '').trim();
  if (!folder || !path.isAbsolute(folder)) {
    return res.status(400).json({ error: "A merge needs `folder`, the repo's absolute path." });
  }
  const repo = path.resolve(folder);

  const wanted = Array.isArray(req.body?.tasks) ? req.body.tasks.map((id) => String(id || '').trim()).filter(Boolean) : [];
  if (!wanted.length) return res.status(400).json({ error: 'A merge names the tasks it is for.' });
  if (new Set(wanted).size !== wanted.length) {
    return res.status(400).json({ error: 'The same task is named twice.' });
  }

  /*
   * `expect` is required, not optional.
   *
   * It is what catches a PR that moved under the click — the row was drawn from a poll up
   * to three seconds old, and the record behind it can have been re-PR'd since. Optional
   * safety is not safety: a client that forgot the field would merge blind and nothing
   * would say so. It has to name exactly the same tasks, so "I checked the ones I meant"
   * is structural rather than a promise.
   */
  const expect = Array.isArray(req.body?.expect) ? req.body.expect : null;
  if (!expect || expect.length !== wanted.length) {
    return res.status(400).json({
      error: 'A merge needs `expect`: one {id, pr} per task, the PR the row was showing when it was pressed.',
    });
  }
  const expected = new Map(expect.map((e) => [String(e?.id || '').trim(), e?.pr == null ? null : String(e.pr)]));
  if (wanted.some((id) => !expected.has(id))) {
    return res.status(400).json({ error: '`expect` must name exactly the tasks being merged.' });
  }

  const rowsWanted = [];
  for (const id of wanted) {
    const task = tasks.get(id);
    if (!task) return res.status(404).json({ error: `Unknown task: ${id}` });
    if (path.resolve(task.repo || '') !== repo) {
      return res.status(409).json({ error: `${id} is not a task in this folder.` });
    }
    if (task.state !== 'review') {
      // Not a 400: nothing about the request was malformed. The row was true when it was
      // drawn and the task has moved since, which is the caller's cue to re-read.
      return res.status(409).json({ error: `${id} is ${task.state}, not in review — the row is out of date.`, stale: true });
    }
    if ((task.pr || null) !== expected.get(id)) {
      return res.status(409).json({
        error: `${id}'s PR changed under the click — the row said ${expected.get(id) || 'no PR'} and the record says ${task.pr || 'no PR'}.`,
        stale: true,
      });
    }
    /*
     * A planner is refused **by kind**, and ahead of the PR check on purpose.
     *
     * A plan is read and approved in conversation, not merged, and it never gets a PR —
     * so the check below would already refuse it. That is the accident, not the rule.
     * The row exists so the block's count agrees with the rail's amber `N in review`
     * (ruled 2026-08-30), and a row that exists is a row a client can name in a request;
     * whether it can be merged must be the server's answer and not a habit of items 2 and
     * 3 leaving it out. Same reason the sentence is composed here and the trust gate is
     * refused here.
     */
    if (task.kind === 'plan') {
      return res.status(409).json({ error: `${id} is a plan — it is read and approved, not merged.` });
    }
    if (!task.pr) return res.status(409).json({ error: `${id} has no PR yet — there is nothing to merge.` });
    rowsWanted.push(task);
  }

  const now = Date.now();
  const sent = sentFor(repo, now);
  let queue;
  try {
    const [forge, baseInfo] = await Promise.all([resolveForge(repo), resolveBaseBranch(repo)]);
    // Same answer the GET gives, so a press cannot succeed against a queue the panel
    // would not have drawn: with no forge there are no rows, and every id is "stale".
    queue = await collectQueue({ tasks: tasks.list(), repo, sent, forge: forge.forge, base: baseInfo.branch });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const byId = new Map(queue.rows.map((r) => [r.id, r]));
  const rows = wanted.map((id) => byId.get(id)).filter(Boolean);
  if (rows.length !== wanted.length) {
    return res.status(409).json({ error: 'The queue moved under the click — re-read it.', stale: true });
  }

  for (const row of rows) {
    if (row.state === 'merged') {
      return res.status(409).json({ error: `${row.id} has already merged and is waiting to be closed.`, stale: true });
    }
    if (row.state === 'sent') {
      // The second press. No room line: the line for the first one is already there,
      // carrying the timestamp that matters.
      return res.status(409).json({
        error: `A merge line for ${row.id} already went to the lead — it is still working on it.`,
        duplicate: true,
        secondsAgo: Math.round((now - (mergeSeen.get(`${teamKey(repo)} ${row.id}`) ?? now)) / 1000),
      });
    }
  }

  /*
   * The rule the whole design turns on: a **batch** press is refused when the batch does
   * not compose; an **individual** press is never refused, only annotated. One press
   * standing for several decisions is the thing the maintainer cannot evaluate, so the panel
   * withholds it — and it withholds it *here*, on the server, so the refusal is a property
   * of the panel and not a habit of a browser. That is the trust-gate move.
   */
  if (rows.length > 1) {
    const batch = composition(rows);
    if (!batch.allowed) {
      return res.status(409).json({
        error: batch.why || 'These PRs cannot be merged as one press.',
        batch: false,
        tasks: rows.map((r) => r.id),
      });
    }
  }

  const lead = findLead(registry.list(), repo);
  if (!lead) {
    room.post(repo, {
      from: 'panel', to: 'lead', kind: 'system', event: 'merge', alert: true,
      about: rows.map((r) => r.id).join('+'), tasks: rows.map((r) => r.id),
      text: `Merge pressed for ${rows.map((r) => prName(r)).join(', ')} but no lead is running in ${repo}. Nothing was launched, and nothing was merged.`,
    });
    return res.status(409).json({ error: 'No lead is running for this folder.', tasks: rows.map((r) => r.id) });
  }

  const line = mergeLine(rows, humanName(repo));
  try {
    const { queued } = await sendOrQueue(lead, line);
    // Stamped on success only — see `mergeSeen`.
    for (const row of rows) mergeSeen.set(`${teamKey(repo)} ${row.id}`, now);
    // `event: 'merge'`, never a matched sentence: the text is a message to a human and
    // will be reworded, and a string-matched colour turns off silently the day it is.
    room.post(repo, {
      from: 'panel', to: 'lead', kind: 'system', event: 'merge',
      about: rows.map((r) => r.id).join('+'), tasks: rows.map((r) => r.id),
      text: `${humanName(repo)} pressed merge in the panel for ${rows.map((r) => prName(r)).join(', ')} (${rows.map((r) => r.id).join(', ')}) — ${queued ? 'queued for' : 'handed to'} the lead.`,
    });
    broadcastRoster();
    res.json({ ok: true, line, queued, delivered: !queued, tasks: rows.map((r) => r.id), sessionId: lead.id });
  } catch (err) {
    room.post(repo, {
      from: 'panel', to: 'lead', kind: 'system', event: 'merge', alert: true,
      about: rows.map((r) => r.id).join('+'), tasks: rows.map((r) => r.id),
      text: `Merge pressed for ${rows.map((r) => prName(r)).join(', ')} did not reach the lead: ${err.message}`,
    });
    res.status(err.status === 409 ? 503 : err.status || 500).json({ error: err.message });
  }
});

/*
 * `POST /api/team/tasks/:id/merge-check` — may the lead merge this one on its own?
 *
 * The other half of the merge story, and it points the other way: the endpoint above is
 * the maintainer's press travelling *to* the lead, and this is the lead asking the panel
 * whether it may act without one. Behind the team's `leadDecidesMerges` toggle, which is
 * off by default and is the maintainer's own answer to "may it at all".
 *
 * Four things about it that are decisions rather than shape:
 *
 *   - **It never merges, and never will.** It returns a verdict. The merge stays the
 *     forge tool the lead already holds, so the panel gains no forge capability and the
 *     2026-08-30 ruling ("the panel holds no Gitea credentials") is untouched. There is
 *     deliberately no tool in `mcp/foreman.js` that performs one.
 *   - **The room line goes on every call, allowed or refused.** A refusal that left no
 *     trace would make "the lead never tried" indistinguishable from "the lead tried, was
 *     told no, and went round". `event: 'self-merge'`, never a matched sentence — the text
 *     is a message to a human and will be reworded, and a string-matched colour turns off
 *     silently the day it is.
 *   - **A refusal is a 200, not an error.** The verdict *is* the answer; a 4xx would make
 *     the tool report a failure where the panel did exactly its job. The 4xx cases below
 *     are the ones where there is no verdict to give: a malformed folder, an unknown task,
 *     a folder with no team.
 *   - **It records `selfMerge` on the task and adds no task state.** `TaskStore#load`
 *     spreads unknown fields through, so this survives; `TASK_STATES` is strict and a state
 *     added here would be the rollback hazard CLAUDE.md spends a paragraph on, for a
 *     feature that does not need one.
 */
app.post('/api/team/tasks/:id/merge-check', async (req, res) => {
  const folder = String(req.body?.folder || '').trim();
  if (!folder || !path.isAbsolute(folder)) {
    return res.status(400).json({ error: "A merge check needs `folder`, the repo's absolute path." });
  }
  const repo = path.resolve(folder);
  const team = readTeam(repo);
  // No team, no toggle and no room to post the refusal into — and `room.post` would create
  // the team directory as a side effect of saying no, which is worse than saying nothing.
  if (!team) return res.status(404).json({ error: 'No team for this folder.' });

  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Unknown task.' });

  let verdict;
  try {
    const [forge, baseInfo] = await Promise.all([resolveForge(repo), resolveBaseBranch(repo)]);
    verdict = await mergeVerdict({
      team,
      task,
      repo,
      forge,
      base: baseInfo.branch,
      head: req.body?.head,
      mergeable: req.body?.mergeable,
      checks: req.body?.checks,
      evidence: req.body?.evidence,
      reason: req.body?.reason,
      suiteQuote: req.body?.suiteQuote,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const at = Date.now();
  // Only on the task the caller actually named in its own folder — a verdict about
  // somebody else's task is a refusal, and writing to their record would be the endpoint
  // doing the very cross-team thing it just refused.
  if (String(task.repo || '') === repo) {
    tasks.update(task.id, { selfMerge: { at, allowed: verdict.allowed, head: verdict.head, reasons: verdict.reasons } });
  }

  const said = [
    req.body?.reason ? `Reason: ${String(req.body.reason).trim()}` : null,
    req.body?.evidence ? `Evidence: ${String(req.body.evidence).trim()}` : null,
  ].filter(Boolean).join(' — ');
  const named = task.pr ? `${prName({ pr: task.pr, prNumber: prNumber(task.pr) })} (${task.id})` : task.id;
  try {
    room.post(repo, {
      from: 'lead', to: 'all', kind: 'system', event: 'self-merge', about: task.id,
      allowed: verdict.allowed, pr: task.pr || null, head: verdict.head, reasons: verdict.reasons,
      text: verdict.allowed
        ? `Self-merge allowed for ${named}. ${said}`.trim()
        : `Self-merge refused for ${named} — ${verdict.reasons[0]}.${said ? ` ${said}` : ''}`,
    });
  } catch {
    /* a room post must never turn a verdict into an error */
  }
  broadcastRoster();
  res.json(verdict);
});

/* --------------------------------------------------------------- links --- */

/*
 * Cross-project links — two projects, one standing channel between their team leads.
 *
 * `server/links.js` owns the store and every pure part of this: the record and its rules,
 * the two speaker prefixes, the control-character refusal, the envelope, and the joint
 * thread. This section owns the *surface* — who may open one, what happens when a message
 * is sent, and what gets written down. Nothing here respells anything from that module;
 * if a sentence, a prefix or a cap appears to be needed twice, it is being spelled twice.
 *
 * The three rules this section is the enforcement of:
 *
 *   - **Only the maintainer opens or closes a link.** No `foreman` tool reaches
 *     `POST /api/team/links` — a lead opening a link would be a lead granting itself a
 *     channel. It may ask, in conversation. (Plan decision 2.)
 *   - **Nothing is ever launched.** A message for a project whose lead is not running is a
 *     409 and a room line, exactly as `/api/trigger` settled it on 2026-08-27: a fresh
 *     lead has not read `decisions.md`, and a visible non-event is the better failure.
 *   - **`speaker` is set by which endpoint composed the message, never read from a request
 *     body.** This is the lead endpoint, so it always composes with the lead prefix. A
 *     `speaker` field a caller could set would be a one-word promotion of another
 *     project's request into the maintainer's word — the same stance `skipPermissions`
 *     has in the dispatch path: not plumbed, so there is no door to find.
 *
 * And the one thing the store deliberately does not check, so this does: **both projects
 * must have a team**. `LinkStore.open` will happily link two folders; a link between
 * projects with no lead to speak on it is a card that can never do anything.
 */

/** Both endpoints of a link, as the sender and the reader of one message. */
function linkSides(link, repo) {
  return { self: repo, peer: link.a === repo ? link.b : link.a };
}

/**
 * Append one block to a project's `decisions.md`, and say whether it landed.
 *
 * **Append-only, best-effort, and never a rollback.** Two files, two independent writes:
 * if the second fails, the first stays. The alternative would be truncating the
 * maintainer's own standing record to undo half of something — the direction
 * `writeConfigFile` already refuses to go, and the one file in this system that
 * `ensureTeam` will not touch once it exists.
 *
 * The leading newline is the whole of the separation: a file that does not end in one
 * gets a blank line rather than a glued heading, and a file that does gets one blank line
 * more than it needed. Neither is worth reading the file to avoid — reading it is the
 * first step towards rewriting it.
 *
 * It may name the other project. The sandbox-names rule governs what reaches a **forge**;
 * `decisions.md` is local and is the one mechanism in this design that reaches a lead
 * that has been `/clear`ed.
 */
async function appendDecision(repo, block) {
  try {
    await fsp.appendFile(path.join(teamDir(repo), 'decisions.md'), `\n${block}`);
    return { repo, ok: true };
  } catch (err) {
    return { repo, ok: false, error: err.message };
  }
}

/** `2026-09-03`, from a post time — the heading format `decisions.md` already uses. */
const decisionDate = (at) => new Date(at).toISOString().slice(0, 10);

/** The one open link this lead's project is an endpoint of, or null. */
function linkHolding(session) {
  if (!session?.isLead) return null;
  const cwd = session.paneCwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const here = path.resolve(cwd);
  return links.list({ open: true }).find((l) => l.a === here || l.b === here) || null;
}

/** How a link names itself in prose: `lnk-3` or `lnk-3, "shared auth schema"`. */
const linkNamed = (link) => (link.label ? `${link.id}, "${link.label}"` : link.id);

/**
 * Every link, open and closed.
 *
 * `?open=1` narrows it to the live ones — which is what the connections column and the
 * lead's `link_list` both want. `?folder=<abs>` narrows it to one project's links and
 * adds `peer`/`peerName` to each row, so the other end is named in one place rather than
 * derived independently by every caller.
 *
 * The roster frame carries the same records from the same call, unshaped. Two spellings
 * of one record is how a column and a tool come to disagree about what a link is.
 */
app.get('/api/team/links', (req, res) => {
  const open = req.query.open === '1' || req.query.open === 'true';
  const folder = String(req.query.folder || '').trim();
  let rows = links.list({ open });

  if (folder) {
    if (!path.isAbsolute(folder)) {
      return res.status(400).json({ error: 'A folder filter needs the repo’s absolute path.' });
    }
    const here = path.resolve(folder);
    rows = rows
      .filter((l) => l.a === here || l.b === here)
      .map((l) => {
        const { peer } = linkSides(l, here);
        return { ...l, peer, peerName: path.basename(peer) };
      });
  }

  res.json({ links: rows });
});

/**
 * Open a link between two projects. The maintainer's own press, and nobody else's.
 *
 * The refusals, each of which the caller can act on:
 *
 *   400  a missing or relative path, a project linked to itself, an over-long label, or a
 *        label carrying a character that could forge a header line
 *   404  a project with no team — a link is between two *teams*, and a folder with no
 *        `team.json` has no lead to speak on it
 *   409  those two are already linked; close that one before opening another
 *
 * On success both projects get a `decisions.md` block and a room line, because a link is
 * a standing fact about the project and `decisions.md` is the only thing in this system
 * that reaches a lead after a `/clear`. Both are best-effort and neither is rolled back.
 */
app.post('/api/team/links', async (req, res) => {
  const rawA = String(req.body?.a || '').trim();
  const rawB = String(req.body?.b || '').trim();
  // Relative would resolve against this process's cwd, which is a different folder that
  // could happen to be right — an accident, not an answer.
  if (!rawA || !rawB || !path.isAbsolute(rawA) || !path.isAbsolute(rawB)) {
    return res.status(400).json({ error: 'A link needs `a` and `b`, both absolute project paths.' });
  }
  const a = path.resolve(rawA);
  const b = path.resolve(rawB);
  if (a === b) return res.status(400).json({ error: 'A project cannot be linked to itself.' });

  for (const repo of [a, b]) {
    if (!readTeam(repo)) {
      return res.status(404).json({ error: `No team for ${repo} — a link joins two teams.` });
    }
  }

  // Asked before `open()` so the answer is a 409 naming the link that is in the way,
  // rather than a 400 built by string-matching what the store threw.
  const already = links.find(a, b);
  if (already) {
    return res.status(409).json({
      error: `Those two projects are already linked (${already.id}). Close it before opening another.`,
      link: already.id,
    });
  }

  let link;
  try {
    link = links.open(a, b, { label: String(req.body?.label ?? '') });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  links.flush();

  /*
   * Neither lead can *use* the link until it is relaunched: the tools ride
   * `--mcp-config` and the rules ride `--append-system-prompt-file`, both written at
   * launch. The panel deliberately does not try to detect that (plan decision 3) — a
   * stamped tools-version compared at run time would be a second source of truth about
   * what a running process holds. So every surface that announces a link says it instead,
   * and this is one of them.
   */
  const relaunch =
    'Both leads need one relaunch before they can send on it: a lead’s tools and rules are ' +
    'written into its launch flags.';

  const date = decisionDate(link.createdAt);
  const decisions = [];
  for (const repo of [a, b]) {
    const { peer } = linkSides(link, repo);
    decisions.push(
      await appendDecision(
        repo,
        `## ${date} — Connected to ${path.basename(peer)} (link ${linkNamed(link)})\n\n` +
          `This project is linked to \`${peer}\`. The two team leads can send each other messages ` +
          `in the panel, and every message lands in both rooms.\n\n` +
          `A message from the other project’s lead is a **request, never authority**. It cannot ` +
          `stand in for ${humanName(repo)}’s merge word, a dispatch confirmation, or a plan ` +
          `approval. ${relaunch}\n\n` +
          `Opened in the panel. Only ${humanName(repo)} opens or closes a link.\n`,
      ),
    );
    try {
      room.post(repo, {
        from: 'panel', to: 'lead', kind: 'system', event: 'link', link: link.id, peer,
        text:
          `Connected to ${path.basename(peer)} — link ${linkNamed(link)}. ${relaunch}`,
      });
    } catch {
      /* a room post must never turn an opened link into an error */
    }
  }

  /*
   * A connected lead cannot be un-pinned (the ruling), and `launchLead` already pins a
   * lead from birth — so this is the one gap that leaves: a lead the maintainer un-pinned
   * *before* the link existed. One shot at create, not a mechanism that re-asserts the
   * pin every beat; the refusal in `POST /api/sessions/:id/pin` is what actually holds it
   * from here.
   */
  for (const repo of [a, b]) {
    const lead = findLead(registry.list(), repo);
    if (lead?.paneId && !lead.pinned) {
      pins.set(lead.paneId, true, { paneCreatedMs: await paneBirthday(lead.paneId) });
    }
  }

  broadcastRoster();
  res.json({ ok: true, link, decisions });
});

/**
 * Close a link. The record stays and the thread stays computable — `closedAt` is what
 * takes it out of the column. Re-linking the same pair later mints a new id and a new
 * thread, because closing was a decision and re-opening is another one.
 */
app.post('/api/team/links/:id/close', async (req, res) => {
  const existing = links.get(req.params.id);
  if (!existing) return res.status(404).json({ error: `No such link: ${req.params.id}.` });
  if (existing.closedAt) {
    return res.status(409).json({ error: `${existing.id} is already closed.`, link: existing });
  }

  const link = links.close(existing.id);
  links.flush();

  const date = decisionDate(link.closedAt);
  const decisions = [];
  for (const repo of [link.a, link.b]) {
    const { peer } = linkSides(link, repo);
    decisions.push(
      await appendDecision(
        repo,
        `## ${date} — Connection with ${path.basename(peer)} closed (link ${linkNamed(link)})\n\n` +
          `The link to \`${peer}\` is closed. Neither lead can send on it any more.\n\n` +
          `What was said on it stays in both projects’ rooms — they are append-only. Linking ` +
          `these two again would make a new link with a new id and a new thread.\n`,
      ),
    );
    try {
      room.post(repo, {
        from: 'panel', to: 'lead', kind: 'system', event: 'link', link: link.id, peer,
        text: `Connection with ${path.basename(peer)} closed — link ${linkNamed(link)}. Nothing more can be sent on it.`,
      });
    } catch {
      /* a room post must never turn a closed link into an error */
    }
  }

  broadcastRoster();
  res.json({ ok: true, link, decisions });
});

/**
 * One lead's message to the other, and the only endpoint in this section that types
 * anything into anything.
 *
 * Delivery is `findLead` -> `sendOrQueue` -> `PaneLock#claim` -> `sendText` ->
 * `assertNotBlocked`, reused unmodified. Three live reads of the pane, and every one of
 * them is there because something once got typed into the wrong place. Never `send-keys`,
 * and never a copy of that logic: `/api/trigger`'s own comment says so and is the
 * precedent.
 *
 * **Why the *sending* side needs a live lead too.** The endpoint is reachable from the
 * LAN with no authentication, like every other (2026-08-27, restated 2026-08-30). That
 * adds no capability — `POST /api/sessions/:id/send` already lets anyone on the LAN type
 * into any session on this Mac — but it does add the envelope's *credibility*, and it is
 * what makes the alert room line below affordable: an append-only file that is the
 * maintainer's scan surface must not be writable by anyone who can guess a link id. So a
 * message cannot be minted for a project whose lead is not running, and that refusal
 * itself writes nothing. Same reasoning as `/api/trigger` keeping a refused credential on
 * stderr and out of the room.
 *
 * The refusals:
 *
 *   400  no `folder`, or a relative one; a body that is empty, over `MAX_LINK_TEXT`, or
 *        carrying a character that can make a quoted line draw as an unquoted one
 *   404  no such link
 *   409  the link is closed, or this folder is not an endpoint of it
 *   409  no lead is running on the sending side (nothing written)
 *   409  no lead is running on the far side — room line, and nothing launched
 *   409  the far lead's queue is full
 *   200  typed, or queued for when that pane can hear it
 */
app.post('/api/team/links/:id/message', async (req, res) => {
  const folder = String(req.body?.folder || '').trim();
  if (!folder || !path.isAbsolute(folder)) {
    return res.status(400).json({ error: 'A link message needs `folder`, the repo’s absolute path.' });
  }
  const repo = path.resolve(folder);

  const link = links.get(req.params.id);
  if (!link) return res.status(404).json({ error: `No such link: ${req.params.id}.` });
  if (link.closedAt) {
    return res.status(409).json({ error: `${link.id} is closed — nothing can be sent on it.` });
  }
  const peerRepo = links.peerOf(link.id, repo);
  if (!peerRepo) {
    return res.status(409).json({ error: `${repo} is not an endpoint of ${link.id}.` });
  }

  const text = String(req.body?.text ?? '');
  let line;
  try {
    /*
     * Refused, never trimmed, escaped or shortened — `MAX_TRIGGER_TEXT`'s reasoning:
     * silently rewriting a caller's input hands them a way to have it rewritten into
     * something else. `linkLine` composes the envelope and quotes **every** line of the
     * body with this speaker's prefix, which is the whole of the injection defence.
     *
     * `speaker: 'lead'` is a literal here and must stay one. This is the lead endpoint.
     */
    assertSendableBody(text);
    line = linkLine({
      speaker: 'lead',
      body: text,
      id: link.id,
      // The project that is not the *reader's* — the reader is the far lead, so this is
      // the sender's own project.
      peer: repo,
      label: link.label,
      // Resolved for the repo that will read it: a brief and a link message addressed to
      // one lead must not call the maintainer two different things.
      human: humanName(peerRepo),
    });
  } catch (err) {
    return res.status(400).json({ error: err.message, cap: MAX_LINK_TEXT });
  }

  const sessions = registry.list();
  if (!findLead(sessions, repo)) {
    // Nothing written anywhere. See the header: this refusal is what stands between an
    // unauthenticated caller and an append-only file.
    return res.status(409).json({
      error:
        `No lead is running in ${repo}, so there is nothing to send from. ` +
        'A link message is minted for a project whose lead is live, and nothing was launched.',
    });
  }

  const peerLead = findLead(sessions, peerRepo);
  if (!peerLead) {
    /*
     * Two entries, deliberately, because they are for two different readers.
     *
     * The `system` line is the loud card on the maintainer's scan surface — the trigger
     * and merge endpoints already write exactly this shape when there is no lead, and the
     * 2026-08-27 ruling is that a visible non-event beats an auto-launched lead.
     *
     * The `link` entry is the message itself, carrying `delivered: false` and the reason,
     * so the joint thread shows it as a message that did not land rather than losing it.
     * It exists only in the sender's room, which is correct: the far room has no lead
     * reading it, and a line there about a message that never arrived is noise in the
     * wrong log.
     */
    linkRefusal(repo, link, peerRepo, text, `no lead is running in ${peerRepo}`);
    broadcastRoster();
    return res.status(409).json({
      error:
        `No lead is running for ${path.basename(peerRepo)}. Nothing was launched, and nothing was ` +
        'delivered. Bring it to the maintainer, or say it again once that lead is up — the ' +
        'panel will not start one.',
      link: link.id,
      peer: peerRepo,
      delivered: false,
    });
  }

  let queued;
  try {
    ({ queued } = await sendOrQueue(peerLead, line));
  } catch (err) {
    linkRefusal(repo, link, peerRepo, text, err.message);
    broadcastRoster();
    return res.status(err.status || 500).json({ error: err.message, link: link.id, peer: peerRepo, delivered: false });
  }

  /*
   * Both rooms take a copy, and they are identical — each room is authoritative for what
   * its own lead *said*, which is what makes the joint thread need no dedupe at all
   * (`jointThread` filters by `sender`).
   *
   * `delivered` here means **handed off**, not read: `queue.js` may hold this for hours
   * and `queued` says whether it did. That is the trigger's "handed to, not delivered to"
   * honesty — two adjacent lines contradicting each other on the maintainer's scan surface
   * is worse than the vaguer verb. The HTTP response below answers the narrower question
   * the caller asked, which is why its `delivered` is `!queued`.
   */
  const entry = {
    from: 'lead',
    to: 'lead',
    kind: 'link',
    link: link.id,
    speaker: 'lead',
    sender: repo,
    peer: peerRepo,
    text,
    delivered: true,
    queued: Boolean(queued),
  };
  for (const target of [repo, peerRepo]) {
    try {
      room.post(target, entry);
    } catch {
      /* the message is already in the far lead's pane; a failed append must not undo that */
    }
  }

  /*
   * The card's summary is **written**, not derived. `broadcastRoster` fires on every
   * registry change, and a card that computed "last message" and "unseen" from the joint
   * thread would `readAll` two `room.jsonl` files per link per beat, against logs that
   * grow forever. `touch` also counts `unseen` by speaker rather than by state, because
   * this runs server-side where "is the thread open right now" is not known.
   */
  links.touch(link.id, { text, from: repo, speaker: 'lead' });

  // No nudge. `nudgeLead` exists because a room *post* gives a lead no input; a link
  // message is already input, sitting in its composer. Nudging would deliver one event
  // twice.
  broadcastRoster();
  res.json({
    ok: true,
    link: link.id,
    peer: peerRepo,
    sessionId: peerLead.id,
    delivered: !queued,
    queued: Boolean(queued),
  });
});

/** What a refused message leaves behind, in the sender's room and nowhere else. */
function linkRefusal(repo, link, peerRepo, text, reason) {
  const entries = [
    {
      from: 'panel', to: 'lead', kind: 'system', event: 'link', alert: true,
      link: link.id, peer: peerRepo,
      text:
        `A message on link ${linkNamed(link)} did not reach the lead of ${path.basename(peerRepo)}: ` +
        `${reason}. Nothing was launched.`,
    },
    {
      from: 'lead', to: 'lead', kind: 'link', alert: true,
      link: link.id, speaker: 'lead', sender: repo, peer: peerRepo,
      text, delivered: false, reason,
    },
  ];
  for (const e of entries) {
    try {
      room.post(repo, e);
    } catch {
      /* best-effort: a refusal that cannot be written is still a refusal */
    }
  }
}

/**
 * The joint thread — one conversation, computed from both rooms.
 *
 * A **view**, not a third log: both rooms carry a copy anyway (the `worker_send` house
 * pattern), so a third store would be this plus something to keep in step. It is computed
 * per open rather than cached — a full `readAll` of the largest room on this Mac is a
 * couple of milliseconds, the same order as `scanImages`, which this repo already decided
 * is cheap enough to redo and never go stale. **Never on the roster beat**; that is what
 * the written card summary is for.
 *
 * A **closed** link's thread still reads, deliberately: a pane holding one when it closes
 * keeps rendering its history rather than blanking, which is this repo's worst failure
 * mode by its own account.
 *
 * `since` is a **timestamp**, not a `seq`. `seq` is per repo (`server/room.js`), so two
 * entries from two rooms can share any value and could never order this.
 */
app.get('/api/team/links/:id/thread', (req, res) => {
  const link = links.get(req.params.id);
  if (!link) return res.status(404).json({ error: `No such link: ${req.params.id}.` });

  const since = Number(req.query.since) || 0;
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), 500) : 200;

  let entries;
  try {
    entries = jointThread(room.readAll(link.a), room.readAll(link.b), link);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const after = since > 0 ? entries.filter((e) => (Number(e.ts) || 0) > since) : entries;
  res.json({
    link,
    entries: after.slice(-limit),
    cursor: entries.length ? Number(entries[entries.length - 1].ts) || 0 : 0,
    truncated: after.length > limit,
  });
});

/** The thread has been opened: nothing on this card is new any more. */
app.post('/api/team/links/:id/seen', (req, res) => {
  const link = links.seen(req.params.id);
  if (!link) return res.status(404).json({ error: `No such link: ${req.params.id}.` });
  broadcastRoster();
  res.json({ ok: true, link });
});

/* -------------------------------------------------------------- model --- */

/*
 * Switching model, session-only — see `model.js` for why this is the one numbered screen
 * the panel drives with arrow keys instead of a digit.
 *
 * Three endpoints rather than one because the dialog stays open between them: `open` puts
 * it up and reads it, the panel draws the real rows, and `set` steps the cursor onto the
 * one you clicked and presses `s`. The box being open in the terminal while the menu is
 * open in the browser is correct — the panel is a remote control for it, not a copy.
 */

/*
 * A bound on stepping, never a count. Five rows today, fourteen at most, and on a short
 * pane the list is a three-row scrolling window — so reaching the last row from the first
 * can be thirteen presses rather than four. Every one of them is re-read before the next.
 */
const MODEL_STEPS = 24;

/** Between one arrow key and the read that says where it landed. */
const MODEL_STEP_MS = 180;

/**
 * Escape out of whatever half of `/model` is on screen, and check it worked.
 *
 * One press is not an exit: from the `Switch model?` confirmation `Esc` goes back to the
 * picker, and only the next one reaches the composer. Verified in a scratch session — it
 * ends on `Kept model as Fable 5`, nothing committed.
 *
 * **What it asks is the witness, not the parser**, and that distinction is the whole of
 * this feature's second half. Written against `parseModelDialog` — as it was — a box the
 * panel could not *read* was a box it decided was not there: this returned `true` having
 * pressed nothing, `/model/cancel` reported success, and the session stayed blocked behind
 * a picker only the terminal could dismiss. Getting out must not depend on understanding
 * what you are getting out of. See `modelDialogOpen` in `model.js`.
 */
async function closeModelDialog(paneId) {
  const stillUp = (text) => modelDialogOpen(text) || modelConfirmOpen(text);
  for (let i = 0; i < 4; i += 1) {
    if (!stillUp(await capturePane(paneId, 40))) return true;
    await sendKeys(paneId, 'Escape').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }
  return !stillUp(await capturePane(paneId, 40));
}

/**
 * Walk the cursor round the window until every row of the list has been seen.
 *
 * On a short pane the picker shows three rows of five, so the menu the browser draws from
 * one read is missing two models — and the two it is missing are the two at the bottom,
 * which is where Sonnet and Haiku live. The box scrolls with the cursor and nothing else
 * moves it, so the only way to learn the rest is to step and re-read.
 *
 * Two things make that affordable rather than reckless. `Down` is one of the two keys in
 * this dialog that cannot commit anything — a digit writes the global default and `Enter`
 * writes it outright, and neither is ever sent from here — and the list **wraps**, so one
 * direction reaches every row and comes back to where it started.
 *
 * **The lap is the stop condition, not `… +N models`,** and that is deliberate. The count
 * is right at every size the panel actually produces (three rows at 80×23 and at 220×23,
 * two at 60×12 — `visible + N` is five in all of them), and it is one short at 60×10, where
 * the window degenerates to a single row. Nothing here is worth resting on a number that
 * has already been seen to be off by one: the walk stops when the cursor returns home, or
 * when two presses in a row teach it nothing, or on a read it cannot parse, or on the step
 * bound — never on a count. `total` stays in the parse result as what the box says, and is
 * not what this trusts.
 *
 * A completed lap leaves the cursor where it was found. A walk that stopped early does not,
 * so it is walked back. Nothing in the panel depends on where it sits, but somebody may be
 * looking at that terminal, and a menu that silently moved their selection is the panel
 * editing a screen it was only asked to read.
 */
async function readWholeModelList(paneId, first) {
  if (!first.partial) return first;

  const seen = new Map(first.options.map((o) => [o.index, o]));
  const home = first.cursorIndex;
  let at = home;

  for (let i = 0; i < MODEL_STEPS; i += 1) {
    await sendKeys(paneId, 'Down');
    await new Promise((r) => setTimeout(r, MODEL_STEP_MS));
    const next = parseModelDialog(await capturePane(paneId, 40));
    if (!next) break; // stop rather than press on into a screen we stopped understanding
    for (const o of next.options) if (!seen.has(o.index)) seen.set(o.index, o);
    const moved = next.cursorIndex;
    // A press that does not move the cursor is the end of a list that does not wrap.
    //
    // This is the stall test, and it is deliberately about the *cursor* rather than about
    // whether the press revealed a new row. "Two presses that taught us nothing, so stop"
    // was the first version and it was wrong for an ordinary reason: the window only
    // scrolls once the cursor reaches its edge, so walking from row 1 of a three-row window
    // spends two presses inside the rows already on screen. It stopped there — three models
    // of five, from exactly the state a freshly opened picker is in when the current model
    // is the first row. Caught by driving the real menu from a browser rather than by
    // driving the endpoint from a row the walk happened to start below.
    if (moved == null || moved === at) break;
    at = moved;
    if (at === home) break; // all the way round
  }

  // Back to where it was found. Bounded and re-read, like every other step here.
  for (let i = 0; i < MODEL_STEPS && at !== home; i += 1) {
    const key = stepToward(at, home);
    if (!key) break;
    await sendKeys(paneId, key);
    await new Promise((r) => setTimeout(r, MODEL_STEP_MS));
    const now = parseModelDialog(await capturePane(paneId, 40));
    if (!now) break;
    at = now.cursorIndex;
  }

  const options = [...seen.values()]
    .sort((a, b) => a.index - b.index)
    .map((o) => ({ ...o, cursor: o.index === at }));
  return {
    ...first,
    options,
    cursorIndex: at,
    currentIndex: options.find((o) => o.current)?.index ?? null,
    total: options.length,
    // Honest rather than optimistic: if the box claimed more rows than the walk ever saw,
    // this is still a partial menu and the client should know it is drawing one.
    partial: options.length < (first.total ?? options.length),
  };
}

/** Open `/model` in this session and read what it offers. */
app.post('/api/sessions/:id/model/open', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  const before = await readPaneState(session.paneId);
  if (before.prompt || before.plan || before.question || before.state === 'needs-decision') {
    return res.status(409).json({ error: 'Answer what is open in the terminal first.' });
  }
  // Already up — from a previous open, or opened by hand. Just read it.
  const already = await capturePane(session.paneId, 40);
  const showing = parseModelDialog(already);
  if (showing) {
    return res.json({ ok: true, dialog: await readWholeModelList(session.paneId, showing) });
  }
  // Up, and unreadable. Say which box, and get out of it rather than leaving the session
  // holding one the panel put there — the failure this feature exists to end was a 409
  // repeated forever over a picker nothing would close.
  if (modelDialogOpen(already) || modelConfirmOpen(already)) {
    const closed = await closeModelDialog(session.paneId).catch(() => false);
    registry.refresh().catch(() => {});
    return res.status(502).json({
      error: closed
        ? 'The model picker came up in a shape the panel could not read — it has been closed. Try again, or use /model in the terminal.'
        : 'The model picker is open in the terminal and the panel cannot read or close it. Press Esc there.',
    });
  }

  if (before.state === 'dialog') {
    return res.status(409).json({ error: `${before.dialog} is open in the terminal.` });
  }

  try {
    await sendText(session.paneId, '/model');
    await new Promise((r) => setTimeout(r, 450));
    const dialog = parseModelDialog(await capturePane(session.paneId, 40));
    if (!dialog) {
      // Never leave a half-opened modal behind holding the session. `closeModelDialog`
      // rather than one blind Escape: the box may be up and merely unreadable, which is
      // precisely the case a single press used to be asked to cover and did not.
      await closeModelDialog(session.paneId).catch(() => {});
      return res.status(502).json({ error: 'The model picker did not come up.' });
    }
    res.json({ ok: true, dialog: await readWholeModelList(session.paneId, dialog) });
  } catch (err) {
    res.status(err instanceof PaneBlockedError ? 409 : 500).json({ error: err.message });
  }
});

/** Escape out of it, leaving nothing open behind the panel. */
app.post('/api/sessions/:id/model/cancel', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });
  const closed = await closeModelDialog(session.paneId).catch(() => false);
  registry.refresh().catch(() => {});
  res.json({ ok: true, closed });
});

/**
 * Tell the roster what was just picked, and say what the label should read meanwhile.
 *
 * Both halves of the same fact, so they cannot disagree: the seed the next roster frame is
 * built from, and the name the answer carries back for the browser to paint straight away.
 * The model in the roster is scraped off the composer footer, which the terminal redraws in
 * its own time — until it does, the honest source for "what is this session running" is the
 * key this panel just pressed. A row `footerModelName` cannot read yields null, and then
 * nothing is seeded and nothing is painted: the label lags by a poll, exactly as it did
 * before, rather than being confidently wrong.
 */
function noteSwitched(paneId, target) {
  const footerModel = footerModelName(target);
  registry.noteModel(paneId, footerModel);
  return footerModel;
}

/**
 * Pick a model for this session, and only this session.
 *
 * The cursor is stepped one press at a time and the pane re-read after each, so a layout
 * that ever changes stops this rather than landing somewhere nobody chose. `s` commits.
 * **A digit would commit as the global default**, and `Enter` writes it outright — neither
 * is ever sent from here.
 */
app.post('/api/sessions/:id/model', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  const wanted = Number(req.body?.index);
  const expectLabel = req.body?.expectLabel;

  try {
    for (let step = 0; step <= MODEL_STEPS; step += 1) {
      const text = await capturePane(session.paneId, 40);
      const dialog = parseModelDialog(text);
      if (!dialog) {
        // Not open is one answer; open and unreadable is a different one, and leaving that
        // second case alone is what used to strand a session behind its own picker.
        if (modelDialogOpen(text) || modelConfirmOpen(text)) {
          const closed = await closeModelDialog(session.paneId).catch(() => false);
          registry.refresh().catch(() => {});
          return res.status(409).json({
            error: closed
              ? 'The picker changed into something the panel could not read — nothing was set, and it has been closed.'
              : 'The picker changed into something the panel can neither read nor close. Press Esc in the terminal.',
          });
        }
        return res.status(409).json({ error: 'The model picker is not open.' });
      }

      const target = dialog.options.find((o) => o.index === wanted);
      if (!target) {
        // On a short pane the box is a three-row window onto the list, so the row that was
        // clicked can be off screen entirely — which is not "no such option", it is "not
        // yet". Step toward it off the window's own bounds and re-read, the same discipline
        // as every other press here; `expectLabel` is checked the moment it comes into view,
        // which is still before anything is committed.
        const first = dialog.options[0]?.index;
        const last = dialog.options[dialog.options.length - 1]?.index;
        const key =
          dialog.windowed && wanted >= 1 && wanted <= (dialog.total ?? Infinity)
            ? wanted < first
              ? 'Up'
              : wanted > last
                ? 'Down'
                : null
            : null;
        if (!key) return res.status(400).json({ error: `Option ${wanted} is not on screen.` });
        await sendKeys(session.paneId, key);
        await new Promise((r) => setTimeout(r, MODEL_STEP_MS));
        continue;
      }
      // The row that was clicked must still be the row at that number.
      if (expectLabel && expectLabel !== target.label) {
        return res.status(409).json({
          error: 'The picker changed — nothing was sent. Open it again.',
          dialog,
        });
      }

      const key = stepToward(dialog.cursorIndex, wanted);
      if (!key) {
        await sendKeys(session.paneId, 's');
        await new Promise((r) => setTimeout(r, 400));

        // `s` is not always the last key. See `parseModelConfirm`: mid-conversation the
        // switch is held behind one more box, and until it is answered nothing has changed.
        let confirm = parseModelConfirm(await capturePane(session.paneId, 40));
        if (!confirm) {
          await new Promise((r) => setTimeout(r, 350));
          confirm = parseModelConfirm(await capturePane(session.paneId, 40));
        }

        if (confirm) {
          // The click already said "switch to this" — the box only warns what it costs. But
          // it is answered with a digit, so the model it names has to be the model that was
          // asked for; anything else and we are reading a screen we don't understand.
          if (!confirmNames(confirm.target, target)) {
            await closeModelDialog(session.paneId);
            registry.refresh().catch(() => {});
            return res.status(409).json({
              error: `The terminal asked about "${confirm.target}", not ${target.label} — nothing was changed.`,
            });
          }
          await sendKeys(session.paneId, String(confirm.yesIndex));
          await new Promise((r) => setTimeout(r, 450));
          if (parseModelConfirm(await capturePane(session.paneId, 40))) {
            return res.status(502).json({
              error: 'The switch is still waiting on a confirmation in the terminal.',
            });
          }
          const footerModel = noteSwitched(session.paneId, target);
          registry.refresh().catch(() => {});
          return res.json({ ok: true, model: target.label, footerModel, reread: true });
        }

        // No confirmation, so the picker should be gone. Still up means `s` didn't take.
        if (parseModelDialog(await capturePane(session.paneId, 40))) {
          return res.status(502).json({ error: 'The picker did not accept the change.' });
        }
        const footerModel = noteSwitched(session.paneId, target);
        registry.refresh().catch(() => {});
        return res.json({ ok: true, model: target.label, footerModel });
      }
      await sendKeys(session.paneId, key);
      await new Promise((r) => setTimeout(r, MODEL_STEP_MS));
    }
    res.status(500).json({
      error: 'The cursor would not settle on that row — nothing was set. Finish it in the terminal.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------- effort --- */

/*
 * The effort slider — see `effort.js`, and read the second paragraph of it before touching
 * anything here. Unlike the model picker beside it in the composer, **this writes a global
 * default**: there is no session-only key in that dialog, and the row inside `/model`
 * ignores `s`. Both were measured. So the panel names it as global rather than pretending
 * otherwise, and this endpoint is the only place in the codebase that deliberately changes
 * a setting outside the session it was asked from.
 */

const EFFORT_STEPS = 10; // six stops today; a bound, not a count

app.post('/api/sessions/:id/effort/open', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  const before = await readPaneState(session.paneId);
  if (before.prompt || before.plan || before.question || before.state === 'needs-decision') {
    return res.status(409).json({ error: 'Answer what is open in the terminal first.' });
  }
  const showing = parseEffortDialog(await capturePane(session.paneId, 40));
  if (showing) return res.json({ ok: true, dialog: showing });

  if (before.state === 'dialog') {
    return res.status(409).json({ error: `${before.dialog} is open in the terminal.` });
  }

  try {
    await sendText(session.paneId, '/effort');
    await new Promise((r) => setTimeout(r, 450));
    const dialog = parseEffortDialog(await capturePane(session.paneId, 40));
    if (!dialog) {
      await sendKeys(session.paneId, 'Escape').catch(() => {});
      return res.status(502).json({ error: 'The effort slider did not come up.' });
    }
    res.json({ ok: true, dialog });
  } catch (err) {
    res.status(err instanceof PaneBlockedError ? 409 : 500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/effort/cancel', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });
  await sendKeys(session.paneId, 'Escape').catch(() => {});
  registry.refresh().catch(() => {});
  res.json({ ok: true });
});

/**
 * Move the marker onto a level and confirm.
 *
 * Nudged one press at a time with the pane re-read after each, so a scale that gains a
 * stop stops this rather than landing somewhere nobody chose — it already went from five
 * to six. Arrow keys write nothing; only the `Enter` at the end does, and what it writes
 * is `effortLevel` for every session started afterwards.
 */
app.post('/api/sessions/:id/effort', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  const wanted = String(req.body?.level || '');

  try {
    for (let step = 0; step <= EFFORT_STEPS; step += 1) {
      const dialog = parseEffortDialog(await capturePane(session.paneId, 40));
      if (!dialog) return res.status(409).json({ error: 'The effort slider is not open.' });
      if (!dialog.levels.some((l) => l.id === wanted)) {
        return res.status(400).json({ error: `“${wanted}” is not on the scale.` });
      }

      const key = nudgeToward(dialog, wanted);
      if (!key) {
        await sendKeys(session.paneId, 'Enter');
        await new Promise((r) => setTimeout(r, 400));
        registry.refresh().catch(() => {});
        return res.json({ ok: true, effort: wanted, scope: 'default for new sessions' });
      }
      await sendKeys(session.paneId, key);
      await new Promise((r) => setTimeout(r, 160));
    }
    // Nothing was confirmed, so nothing was written. Say so plainly and leave it open.
    res.status(500).json({
      error: 'The marker would not settle on that level — nothing was set. Finish it in the terminal.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Show this session's folder in Finder.
 *
 * `paneCwd`, not `cwd`, for the reason it always is: the transcript's directory is
 * rewritten when a session changes directory mid-conversation, and the folder you mean by
 * "this project" is the one it was launched in — the one its rail heading is named after.
 */
app.post('/api/sessions/:id/reveal', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneCwd) return res.status(404).json({ error: 'No folder for this session.' });
  try {
    res.json({ ok: true, folder: await revealInFinder(session.paneCwd) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Put a Terminal window on a session that hasn't got one.
 *
 * The other half of `+ new`'s "Open a Terminal window" checkbox: unticked, the session is a
 * detached tmux session with nothing on the desktop to look at, and this is how you go and
 * look at it. It is also the answer for a session whose window you closed hours ago — the
 * roster's `attached` is read live off tmux, so the button comes back on its own.
 *
 * The name is re-checked against tmux rather than trusted from the roster, which is up to a
 * poll stale: attaching to a session that has since exited would open a Terminal window on
 * an error, and the point of the button is to save you typing `tmux attach` yourself.
 *
 * No guard on what the session is doing, unlike `/close` — attaching sends no keys. It is
 * the one control here that cannot land a keystroke in the wrong place.
 */
app.post('/api/sessions/:id/terminal', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.tmuxSession) {
    return res.status(404).json({ error: 'No tmux session to attach to.' });
  }
  try {
    const live = await liveSessionNames();
    if (!live.includes(session.tmuxSession)) {
      return res.status(409).json({ error: `${session.tmuxSession} is not running any more.` });
    }
    await attachTerminal(session.tmuxSession);
    res.json({ ok: true, tmuxSession: session.tmuxSession });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Close a session — `/exit`, typed the way you would type it.
 *
 * Verified in a scratch session rather than assumed: `/exit` ends Claude Code, the
 * `zsh -ilc claude` it was launched under exits with it, and tmux drops the session. It
 * works while the session is busy, so there is no "wait for it to finish" case. The
 * transcript stays on disk; `claude --resume` is what reads one back.
 *
 * It refuses while something owns the pane. A permission box, a question, a plan approval
 * or a picker would take `/exit` as *typing into itself* — six characters into a text
 * field, or worse, digits landing on options. `interrupt` — above the composer's box —
 * is the way out of those, and then this works.
 */
app.post('/api/sessions/:id/exit', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session?.paneId) return res.status(404).json({ error: 'Unknown or read-only session.' });

  // Every way a pane can be holding something, including the ones that read as
  // `needs-decision` without a parsed box behind them — the startup trust gate is one, and
  // testing only for `state === 'dialog'` would have walked straight past it. `sendText`
  // refuses these too; this is here to say *which* rather than to be the guard.
  const live = await readPaneState(session.paneId);
  if (
    live.prompt ||
    live.plan ||
    live.question ||
    live.state === 'needs-decision' ||
    live.state === 'dialog'
  ) {
    return res.status(409).json({
      error: 'Something is open in the terminal — answer or interrupt it first, then close.',
    });
  }

  try {
    await sendText(session.paneId, '/exit');
    // It takes a moment to go. Refresh after, so the row leaves the rail on this response
    // rather than at the next poll.
    await new Promise((r) => setTimeout(r, 700));
    await registry.refresh().catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(err instanceof PaneBlockedError ? 409 : 500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------- settings --- */

/*
 * `<STATE_DIR>/config.json`, seen and changed from the panel.
 *
 * Two keys are writable — `bindHost` and `allowedOrigins` — and one, `sessionPrefix`, is
 * shown and refused. `settings-file.js` owns every rule; these two handlers own only the
 * HTTP shape and the one gate that is a property of the *request* rather than of the
 * value: `isLoopbackRemote`.
 *
 * **Why the read reports two sets of values.** `HOST` and `SESSION_PREFIX` are resolved
 * once at boot, and the host's top rung is `$FOREMAN_HOST` — which on a machine whose
 * LaunchAgent still carries that key beats the file every time. So a surface that showed
 * only the file would let somebody edit a value the running panel is ignoring, save it,
 * see it saved, and reach a phone that has stopped answering with nothing anywhere saying
 * why. `live` is that fact, `hostSource` is which rung answered, and the modal says so in
 * place. Same reasoning as the boot line, aimed at a browser instead of a log.
 *
 * There is no credentials field here and there never will be — the forge is *detected*
 * from the repo's own origin and from what is registered in `~/.claude.json`
 * (`forge.js`), never configured, because a token in a world-readable JSON behind an
 * unauthenticated LAN panel is a worse liability than any convenience it buys.
 */

/** The read is not gated to loopback, deliberately: the modal has to *load* on a phone in
 *  order to show its exposure controls disabled with the reason. What it exposes is the
 *  allowlist and the bind host, which anything that has already reached this port can
 *  infer from the fact that it reached this port. */
app.get('/api/config', (req, res) => {
  const { config, notes, exists } = readConfigFile(CONFIG_FILE);
  res.json({
    file: CONFIG_FILE,
    exists,
    // What this software *is*, read off `package.json` at boot. Here rather than in the
    // page because `web/` may not carry a second copy of a fact the manifest already
    // states — the rail's footer would otherwise go on naming last month's repository
    // after a fork, and its version would drift from the tag by exactly one forgotten
    // edit. Both are `null` when the manifest could not be read, and the footer then
    // draws what it has: the mark with no link, or no version.
    version: VERSION,
    repoUrl: REPO_URL,
    // What the file holds, `null` for a key it does not have — which is a different fact
    // from the default and is drawn differently: "not set, using X" rather than "X".
    bindHost: typeof config.bindHost === 'string' ? config.bindHost : null,
    allowedOrigins: allowedOriginsFrom(config),
    sessionPrefix: typeof config.sessionPrefix === 'string' ? config.sessionPrefix : null,
    defaults: { bindHost: DEFAULT_BIND_HOST, sessionPrefix: DEFAULT_SESSION_PREFIX },
    // What this panel is actually running on, and which rung answered for the host.
    live: { host: HOST, hostSource: HOST_SOURCE, sessionPrefix: SESSION_PREFIX },
    // Whether *this* request could have written the exposure keys. The modal disables its
    // controls on it; the PATCH re-decides it server-side, so a disabled control that
    // somebody re-enables by hand still gets the 403.
    canEditExposure: isLoopbackRemote(req),
    remoteAddress: remoteAddressOf(req),
    bindHostRule: BIND_HOST_RULE,
    notes,
  });
});

app.patch('/api/config', (req, res) => {
  const body = req.body ?? {};

  /*
   * The one place in this panel where a LAN peer is refused something the machine itself
   * may do — and it is checked on `req.socket.remoteAddress`, never on the `Origin`
   * header.
   *
   * That distinction is the whole guard. `origin.js` allows a request carrying **no**
   * `Origin` at all, by construction, so that curl, the status hook and `mcp/foreman.js` work
   * without an allowlist anybody maintains — which means a LAN peer holding curl passes
   * the origin guard trivially. A loopback *origin* would therefore prove nothing here.
   * The peer address is written by the kernel and cannot be spelled.
   *
   * It does not reintroduce authentication and must not be read as a step toward it. The
   * 2026-08-27 ruling stands: no auth, and a LAN peer keeps every other capability this
   * panel has. What it may not do is widen its own reach.
   */
  if (touchesExposure(body) && !isLoopbackRemote(req)) {
    const seen = remoteAddressOf(req) || 'an address the socket did not report';
    return res.status(403).json({
      error:
        `Refused: ${EXPOSURE_KEYS.join(' and ')} can only be changed from the machine the panel ` +
        `runs on. This request came from ${seen}. Open the panel at http://127.0.0.1:${PORT} on ` +
        `that machine, or edit ${CONFIG_FILE} there and restart. ` +
        `Everything else this panel does is open to you — this one setting decides who else it is open to.`,
      remoteAddress: remoteAddressOf(req),
    });
  }

  const check = validateConfigPatch(body, { normalizeOrigin });
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  if (!Object.keys(check.patch).length) {
    return res.status(400).json({ error: 'Nothing to change — send bindHost, allowedOrigins, or both.' });
  }

  const written = writeConfigFile(CONFIG_FILE, check.patch);
  if (!written.ok) return res.status(written.status).json({ error: written.error });

  /*
   * Both writable keys are read **once at boot** — `bindHost` by `server.listen`, and
   * `allowedOrigins` by the closure `originGuard`/`verifyOrigin` were wired with. So a
   * change to either takes effect at the next restart and not before, and the response
   * says which. Making the origins live was considered and left alone: it is a
   * security-sensitive path, `currentAllowed` caches for thirty seconds anyway, and a
   * control that half-applies is worse than one that plainly waits.
   *
   * Only a value that actually *moved* counts. Re-saving the host it already had must not
   * tell somebody to restart for nothing.
   */
  const restartRequired = written.changed.length > 0;
  const reasons = [];
  if (written.changed.includes('bindHost')) reasons.push('the bind host is read when the panel starts');
  if (written.changed.includes('allowedOrigins')) reasons.push('the origin allowlist is read when the panel starts');

  res.json({
    ok: true,
    file: CONFIG_FILE,
    bindHost: typeof written.config.bindHost === 'string' ? written.config.bindHost : null,
    allowedOrigins: allowedOriginsFrom(written.config),
    sessionPrefix: typeof written.config.sessionPrefix === 'string' ? written.config.sessionPrefix : null,
    live: { host: HOST, hostSource: HOST_SOURCE, sessionPrefix: SESSION_PREFIX },
    changed: written.changed,
    restartRequired,
    restartReason: reasons.join('; '),
  });
});

/* ------------------------------------------------------------ groups --- */

/*
 * Folders filed under names you chose. The rail's own folder headings are derived and
 * unopinionated; these are the opinion.
 *
 * Every write ends with a roster broadcast rather than a bare response, because the rail
 * redraws from one frame and both windows should see the same shelf.
 */

app.get('/api/groups', (_req, res) => {
  res.json({ groups: groups.list() });
});

app.post('/api/groups', (req, res) => {
  try {
    const group = groups.create(req.body?.name);
    broadcastRoster();
    res.json({ ok: true, group, groups: groups.list() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/groups/:id', (req, res) => {
  try {
    let group = null;
    if (req.body?.name !== undefined) group = groups.rename(req.params.id, req.body.name);
    if (req.body?.collapsed !== undefined) {
      group = groups.setCollapsed(req.params.id, req.body.collapsed);
    }
    if (!group) return res.status(404).json({ error: 'No such group.' });
    broadcastRoster();
    res.json({ ok: true, group, groups: groups.list() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Delete the shelf, keep the books — its folders go back to standing on their own. */
app.delete('/api/groups/:id', (req, res) => {
  if (!groups.remove(req.params.id)) return res.status(404).json({ error: 'No such group.' });
  broadcastRoster();
  res.json({ ok: true, groups: groups.list() });
});

/** File a folder under a group, or pass `groupId: null` to take it back out. */
app.post('/api/groups/assign', (req, res) => {
  try {
    groups.assign(req.body?.folder, req.body?.groupId ?? null);
    broadcastRoster();
    res.json({ ok: true, groups: groups.list() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------------------------------------------------------- snapshot --- */

/*
 * The bench, saved and put back — see `snapshot.js` for what a snapshot holds and, more
 * to the point, what it deliberately doesn't (groups, which survive on their own; the
 * queue, which must not be replayed into a conversation that no longer exists).
 */

/** Small enough to ride every roster frame; the entries themselves come from GET. */
const snapshotSummary = (sessions = registry.list()) => {
  const snap = snapshot.get();
  return {
    savedAt: snap?.savedAt ?? null,
    count: snap?.sessions.length ?? 0,
    drift: snapshot.drift(sessions),
  };
};

app.get('/api/snapshot', (_req, res) => {
  const snap = snapshot.get();
  res.json({
    savedAt: snap?.savedAt ?? null,
    sessions: snap?.sessions ?? [],
    live: registry.list().map((s) => s.tmuxSession).filter(Boolean),
    drift: snapshot.drift(registry.list()),
  });
});

/**
 * Save the roster as it stands.
 *
 * Which rows count, and what gets recorded about each, is `benchEntries` in `snapshot.js`
 * — a lead is saved, a worker isn't, and the folder is the pane's rather than the
 * transcript's. All three have reasons worth reading before changing.
 */
app.post('/api/snapshot', (_req, res) => {
  try {
    const saved = snapshot.save(benchEntries(registry.list()));
    broadcastRoster();
    res.json({ ok: true, savedAt: saved.savedAt, sessions: saved.sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/snapshot', (_req, res) => {
  snapshot.clear();
  broadcastRoster();
  res.json({ ok: true });
});

/**
 * Start everything in the snapshot that isn't already running.
 *
 * The loop itself is `restoreSessions` in `snapshot.js` — serial, one entry's failure
 * costing only itself, each step reported over the socket as it lands because the whole
 * request runs about a minute. What lives here is the two launchers it is handed.
 */
let restoring = false;

app.post('/api/snapshot/restore', async (req, res) => {
  const snap = snapshot.get();
  if (!snap?.sessions.length) return res.status(400).json({ error: 'Nothing saved yet.' });
  if (restoring) return res.status(409).json({ error: 'A restore is already running.' });

  const terminal = req.body?.terminal !== false;
  restoring = true;
  let results = [];
  const toPin = [];

  try {
    results = await restoreSessions(snap.sessions, {
      liveNames: await liveSessionNames(),
      startSession: (opts) => createSession({ ...opts, terminal }),
      // A lead is not `createSession` with a different label. The brief, the `foreman` tools
      // and the permission stance are launch flags and files under `teams/`, so a saved
      // lead started the ordinary way comes back as an ordinary session that happens to be
      // called `lead` — and the rail, which reads the role off the name, badges it as the
      // lead anyway. The one row you would trust most, lying.
      //
      // Note what `launchLead` regenerates on the way through: brief, MCP config and
      // settings, from today's code and today's `team.json`. That is the right thing and
      // not an accident of reuse — a restored lead should be *this* lead, not a replay of
      // the one that was running before the reboot. It is also where the git check and the
      // one-lead-per-project refusal live, which is why neither is repeated here.
      startLead: async (folder, resume) => (await launchLead(folder, { terminal, resume })).created,
      onStep: (done, entry) => {
        // Pins: the lead is pinned from birth by `launchLead`, whatever the snapshot
        // says, so only the ordinary rows need replaying here.
        if (done.state === 'started' && done.paneId && entry.pinned && !done.lead) {
          toPin.push(done.paneId);
        }
        for (const ws of wss.clients) send(ws, 'restore', done);
      },
    });
  } finally {
    restoring = false;
  }

  // Pins are pane-keyed and carry the tmux birthday, so they need the panes that exist now.
  if (toPin.length) {
    const created = new Map((await listPanes().catch(() => [])).map((p) => [p.paneId, p.createdMs]));
    for (const paneId of toPin) pins.set(paneId, true, { paneCreatedMs: created.get(paneId) ?? null });
  }

  await registry.refresh().catch(() => {});
  broadcastRoster();
  res.json({ ok: true, results });
});

/* -------------------------------------------------------- relaunch --- */

/**
 * How long to wait for a session to actually go after `/exit`.
 *
 * The name is the thing being waited on, not the process: `uniqueSessionName` reads the
 * live list, so relaunching while the old `<prefix>alpha-main` is still in it mints
 * `<prefix>alpha-main-2` — a session that no longer answers to the name anybody saved,
 * pinned or filed. Measured at about three seconds for one session on this Mac; the
 * ceiling is generous because the failure it guards against is silent and permanent, while
 * waiting a few seconds longer costs nothing.
 */
const EXIT_GONE_TIMEOUT_MS = 20000;

/** Set while a relaunch is running, for the same reason `restoring` exists. */
let relaunching = false;

/**
 * Relaunch every session on the bench — the control for "I updated Claude Code".
 *
 * Snapshot → exit each → restore, where the snapshot is `relaunchEntries` against the live
 * roster rather than the saved slot (see `snapshot.js`: a relaunch must not spend the
 * maintainer's bench save, and a session id from Tuesday resumes nothing useful on Friday).
 * Two modes, and neither is a default the caller can fall into — an absent `mode` is a 400,
 * because "fresh" and "resume" differ by whether seventeen conversations survive and that
 * is not a thing to decide on someone's behalf.
 *
 * Three guards, and they are the feature rather than trim around it:
 *
 *   **Not while a worker is live.** `liveWorkers` is the whole roster minus the bench, by
 *   the same two tests the snapshot uses. Refused outright, naming the workers.
 *
 *   **A session holding something is skipped, never forced.** The pane is re-read now —
 *   not trusted from the roster, which is a poll behind — for every way it can be busy:
 *   `prompt || plan || question || needs-decision || dialog`, the list `assertNotBlocked`
 *   already keeps and the `/exit` endpoint already tests. A permission box or the startup
 *   trust gate would take `/exit` as six characters typed into itself. Left alone, still
 *   running, and named in the result — which is also why it needs no special case in the
 *   restore below: it is still in `liveNames`, so `restoreSessions` skips it.
 *
 *   **Everything is reported.** Exited, resumed, skipped and why, failed and why. A
 *   half-relaunched machine that says "done" is the failure mode here.
 *
 * The exits all happen before any relaunch, rather than interleaved one at a time. That
 * costs a window where the bench is down — the last session waits out every restore ahead
 * of it — and buys the thing that matters: `restoreSessions` is reused exactly as it is,
 * with its serial loop, its per-entry failure isolation and its skip-what-is-already-live
 * rule doing double duty as the handler for the sessions this refused to touch. A second
 * loop that exited and relaunched in step would be a second launcher path, which is the
 * one thing this file has learned not to grow.
 */
/**
 * What a relaunch would touch, without touching it.
 *
 * The dialog asks for this before it offers the two buttons, so the refusal and the count
 * are the server's answer rather than the browser's — the bench rule lives in one place
 * (`relaunchEntries`, off `benchEntries`) and a page that re-derived it could offer to
 * relaunch a worker the endpoint would then refuse.
 *
 * `resumable` rather than the id itself: the browser has no use for a session id, and the
 * one thing it could do with it is send it back.
 */
app.get('/api/relaunch', async (_req, res) => {
  const sessions = registry.list();
  res.json({
    workers: liveWorkers(sessions).map((w) => w.tmuxSession || w.title).filter(Boolean),
    sessions: relaunchEntries(sessions, { resume: true }).map((e) => ({
      folder: e.folder,
      slug: e.slug,
      tmuxSession: e.tmuxSession,
      lead: e.slug === 'lead',
      resumable: Boolean(e.resume),
    })),
  });
});

app.post('/api/relaunch', async (req, res) => {
  const mode = req.body?.mode;
  if (mode !== 'fresh' && mode !== 'resume') {
    return res.status(400).json({ error: 'Pick a mode: "fresh" or "resume".' });
  }
  if (relaunching || restoring) {
    return res.status(409).json({ error: 'A relaunch or restore is already running.' });
  }

  const terminal = req.body?.terminal !== false;

  // The roster is up to a poll behind, and this reads it to decide what to end.
  await registry.refresh().catch(() => {});
  const sessions = registry.list();

  const workers = liveWorkers(sessions);
  if (workers.length) {
    const names = workers.map((w) => w.tmuxSession || w.title).filter(Boolean);
    return res.status(409).json({
      error:
        `${workers.length} worker${workers.length === 1 ? ' is' : 's are'} still running ` +
        `(${names.join(', ')}). A worker can't be put back — no brief, no tools, and its ` +
        'worktree may be swept. Close the tasks first, then relaunch.',
      workers: names,
    });
  }

  const entries = relaunchEntries(sessions, { resume: mode === 'resume' });
  if (!entries.length) return res.status(400).json({ error: 'Nothing on the bench to relaunch.' });

  relaunching = true;
  const skipped = new Map(); // tmux session name -> why it was left alone
  const toPin = [];
  let results = [];

  try {
    /* ---- exit: every bench session that isn't holding something ---- */
    const exiting = [];
    for (const entry of entries) {
      const step = { folder: entry.folder, slug: entry.slug, name: entry.tmuxSession, phase: 'exit' };
      if (!entry.paneId) {
        skipped.set(entry.tmuxSession, 'no pane to close');
        for (const ws of wss.clients) send(ws, 'relaunch', { ...step, state: 'skipped', reason: 'no pane to close' });
        continue;
      }

      const live = await readPaneState(entry.paneId).catch(() => ({}));
      if (
        live.prompt ||
        live.plan ||
        live.question ||
        live.state === 'needs-decision' ||
        live.state === 'dialog'
      ) {
        const reason = 'holding something — answer or interrupt it first';
        skipped.set(entry.tmuxSession, reason);
        for (const ws of wss.clients) send(ws, 'relaunch', { ...step, state: 'skipped', reason });
        continue;
      }

      try {
        // `sendText` re-reads the pane a third time and refuses the same states — it is the
        // backstop under the check above, not a duplicate of it.
        await sendText(entry.paneId, '/exit');
        exiting.push(entry);
        for (const ws of wss.clients) send(ws, 'relaunch', { ...step, state: 'exited' });
      } catch (err) {
        skipped.set(entry.tmuxSession, err.message);
        for (const ws of wss.clients) send(ws, 'relaunch', { ...step, state: 'skipped', reason: err.message });
      }
    }

    /* ---- wait for the names to actually free up ---- */
    const wanted = new Set(exiting.map((e) => e.tmuxSession).filter(Boolean));
    const deadline = Date.now() + EXIT_GONE_TIMEOUT_MS;
    let stillUp = [];
    while (wanted.size) {
      stillUp = (await liveSessionNames()).filter((n) => wanted.has(n));
      if (!stillUp.length || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const name of stillUp) {
      // It never went. Relaunching now would mint a `-2`, so it doesn't: the name stays
      // live, `restoreSessions` skips it, and the report says which.
      skipped.set(name, 'did not close in time — still running');
    }

    /* ---- restore, the same loop the snapshot uses ---- */
    results = await restoreSessions(entries, {
      liveNames: await liveSessionNames(),
      startSession: (opts) => createSession({ ...opts, terminal }),
      startLead: async (folder, resume) => (await launchLead(folder, { terminal, resume })).created,
      onStep: (done, entry) => {
        if (done.state === 'started' && done.paneId && entry.pinned && !done.lead) toPin.push(done.paneId);
        const step = { ...done, phase: 'start', reason: skipped.get(done.name) ?? null };
        for (const ws of wss.clients) send(ws, 'relaunch', step);
      },
    });
  } finally {
    relaunching = false;
  }

  if (toPin.length) {
    const created = new Map((await listPanes().catch(() => [])).map((p) => [p.paneId, p.createdMs]));
    for (const paneId of toPin) pins.set(paneId, true, { paneCreatedMs: created.get(paneId) ?? null });
  }

  await registry.refresh().catch(() => {});
  broadcastRoster();

  // A skipped row was never exited, so `restoreSessions` reporting it as "already running"
  // is true but not the useful half; the reason it was left alone is.
  const report = results.map((r) => ({ ...r, reason: skipped.get(r.name) ?? null }));
  res.json({
    ok: true,
    mode,
    results: report,
    started: report.filter((r) => r.state === 'started').length,
    resumed: report.filter((r) => r.state === 'started' && r.resumed).length,
    skipped: report.filter((r) => r.state === 'skipped').length,
    failed: report.filter((r) => r.state === 'failed').length,
  });
});

/* -------------------------------------------------------- completion --- */

/** Slash commands this session accepts — built-ins, plugins, skills, project files. */
app.get('/api/sessions/:id/commands', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session.' });
  try {
    res.json({ commands: await listCommands(session.cwd) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Files under the session's working directory, for `@` mentions. */
app.get('/api/sessions/:id/files', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session.' });
  try {
    res.json({ files: await findFiles(session.cwd, String(req.query.q || ''), 20) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------ websocket --- */

const server = http.createServer(app);

/*
 * The socket is checked at the handshake, and it is the reason `origin.js` exists.
 *
 * A WebSocket handshake is **not subject to CORS and triggers no preflight** — the browser
 * sends `Origin` and the server is expected to look at it. Nothing did. So any `http://`
 * page could open `ws://<this-mac>:<port>/ws`, be handed the full roster the moment it
 * connected (see `wss.on('connection')` below, which sends it unprompted), `subscribe` to
 * any transcript on this Mac, and send `markRead`. And the roster's `id` is the session
 * UUID `/hook` accepts, so the same page could then write false status for any session.
 *
 * `verifyClient` refuses the upgrade with a 403 before any of that: the socket never
 * opens, so the roster is never sent. Again — a browser guard, not authentication. A LAN
 * peer with a websocket client and no `Origin` header is allowed, exactly as ruled.
 */
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: verifyOrigin({ port: PORT, config: { allowedOrigins: ALLOWED_ORIGINS } }),
});

/**
 * Live transcript subscriptions, keyed by client and then by *slot*.
 *
 * A slot is one pane of the panel. There was exactly one before split view, and
 * subscribing simply replaced whatever the socket was watching; now a client can hold
 * two at once and every message is stamped with the slot it belongs to, so the browser
 * knows which half of the screen it is for.
 */
const subs = new WeakMap(); // ws -> Map(slot -> sub)

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
}

function slotsOf(ws) {
  let map = subs.get(ws);
  if (!map) {
    map = new Map();
    subs.set(ws, map);
  }
  return map;
}

async function subscribe(ws, sessionId, slot = 'a') {
  unsubscribe(ws, slot);
  const session = registry.get(sessionId);
  if (!session) return send(ws, 'error', { message: 'Unknown session.', slot });

  const slots = slotsOf(ws);

  // A pane we've never seen speak has no transcript to tail — show it as empty
  // rather than attaching it to someone else's history.
  if (!session.transcriptPath) {
    slots.set(slot, { tailer: null, sessionId, path: null, paneId: session.paneId });
    return send(ws, 'transcript', { sessionId, session, messages: [], hasEarlier: false, slot });
  }

  const tailer = new Tailer(session.transcriptPath);
  const sub = { tailer, sessionId, path: session.transcriptPath, paneId: session.paneId };
  // Claim the slot *before* reading the file, not after. The read is a handful of awaits,
  // and a second subscribe landing inside that window used to find the slot empty: its
  // `unsubscribe` stopped nothing, this tailer was never recorded anywhere, and it went on
  // watching the same file and sending into the same slot for the life of the socket.
  // Every append then arrived twice and the browser, which appends without dedupe, drew it
  // twice — until the next full `transcript` frame replaced the list and hid the evidence.
  // A rotation makes that race routine: `/clear` fires two subscribes for one slot, one
  // from the rebound below and one from the client's own `adopt`.
  slots.set(slot, sub);

  tailer.on('messages', (messages) => {
    if (slots.get(slot) !== sub) return; // superseded — not ours to speak for any more
    rememberAgentFiles(messages);
    send(ws, 'messages', { sessionId, messages, slot });
  });
  tailer.on('error', () => {});

  try {
    const { messages, hasEarlier } = await tailer.start();
    // Someone else took the slot while we were reading. `unsubscribe` already stopped this
    // tailer once, but `start` has since attached a watcher and a poller of its own, so
    // stop it again and say nothing: the slot's real owner has its own frame to send.
    if (slots.get(slot) !== sub) return tailer.stop();
    rememberAgentFiles(messages);
    send(ws, 'transcript', { sessionId, session, messages, hasEarlier, slot });
  } catch (err) {
    tailer.stop();
    if (slots.get(slot) !== sub) return;
    slots.delete(slot);
    send(ws, 'error', { message: `Could not read transcript: ${err.message}`, slot });
  }
}

/** Drop one slot, or every slot when the socket goes. */
function unsubscribe(ws, slot) {
  const slots = subs.get(ws);
  if (!slots) return;
  for (const [key, sub] of slots) {
    if (slot !== undefined && key !== slot) continue;
    sub.tailer?.stop();
    slots.delete(key);
  }
}

/* ------------------------------------------------------- room subscriptions --- */

/**
 * Per-*team* frames beside the per-pane ones — the first subscription in the panel that
 * is not keyed by a pane. Same socket, its own registry: `ws -> Map(repo -> listener)`,
 * torn down with the socket exactly like slots are, and re-joined by the client's
 * `resubscribe()` (the "subscription dies with the socket" trap applies here verbatim).
 */
const roomSubs = new WeakMap(); // ws -> Map(repo -> listener)

function subscribeRoom(ws, repo, slot) {
  unsubscribeRoom(ws, repo);
  let map = roomSubs.get(ws);
  if (!map) {
    map = new Map();
    roomSubs.set(ws, map);
  }
  const listener = (postedRepo, entry) => {
    if (postedRepo === repo) send(ws, 'room-append', { repo, entry, slot });
  };
  room.on('post', listener);
  map.set(repo, listener);
  send(ws, 'room', { repo, ...room.read(repo), slot });
}

function unsubscribeRoom(ws, repo) {
  const map = roomSubs.get(ws);
  if (!map) return;
  for (const [key, listener] of map) {
    if (repo !== undefined && key !== repo) continue;
    room.off('post', listener);
    map.delete(key);
  }
}

wss.on('connection', (ws) => {
  send(ws, 'sessions', {
    sessions: registry.list(),
    groups: groups.list(),
    snapshot: snapshotSummary(),
    links: links.list({ open: true }),
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const slot = typeof msg.slot === 'string' ? msg.slot : 'a';

    if (msg.type === 'subscribe') {
      await subscribe(ws, msg.sessionId, slot);
    } else if (msg.type === 'unsubscribe') {
      unsubscribe(ws, slot);
    } else if (msg.type === 'subscribe-room') {
      if (typeof msg.repo === 'string' && msg.repo) subscribeRoom(ws, msg.repo, slot);
    } else if (msg.type === 'unsubscribe-room') {
      unsubscribeRoom(ws, typeof msg.repo === 'string' ? msg.repo : undefined);
    } else if (msg.type === 'markRead') {
      // The client only sends this when the transcript is actually scrolled to the
      // bottom — reading history shouldn't clear the badge.
      if (readState.mark(msg.sessionId, msg.ts)) registry.refresh().catch(() => {});
    } else if (msg.type === 'loadEarlier') {
      const sub = subs.get(ws)?.get(slot);
      if (!sub?.tailer) return;
      try {
        const { messages, hasEarlier } = await sub.tailer.loadEarlier();
        rememberAgentFiles(messages);
        send(ws, 'earlier', { sessionId: sub.sessionId, messages, hasEarlier, slot });
      } catch {
        send(ws, 'earlier', { sessionId: sub.sessionId, messages: [], hasEarlier: false, slot });
      }
    }
  });

  ws.on('close', () => {
    unsubscribe(ws);
    unsubscribeRoom(ws);
  });
  ws.on('error', () => {
    unsubscribe(ws);
    unsubscribeRoom(ws);
  });
});

/* ---------------------------------------------------------------- queue --- */

/**
 * When the pane this message is for was born.
 *
 * Stamped on every queued item so a restart can't misdeliver: tmux hands out `%0`, `%1`
 * … afresh with each new server, and yesterday's `%19` is today's someone else.
 */
async function paneBirthday(paneId) {
  try {
    return (await listPanes()).find((p) => p.paneId === paneId)?.createdMs ?? null;
  } catch {
    return null;
  }
}

/**
 * The one lock between a message and a pane. `server/claim.js` carries the ordering and
 * why the live pane read — not the roster snapshot — is what decides.
 */
const paneLock = new PaneLock(readPaneState);

const claim = (session) => paneLock.claim(session);

/** Type into a claimed pane, then hold it for a beat. */
async function deliver(paneId, text) {
  try {
    await sendText(paneId, text);
  } finally {
    paneLock.hold(paneId);
  }
}

/**
 * Release queued messages as sessions become ready to hear them.
 *
 * One per pass, deliberately: the moment a message lands the session starts working
 * again, so the next one has to wait anyway. Sending the whole queue at once would just
 * paste them all into the same prompt.
 */
async function flushQueues(sessions) {
  for (const session of sessions) {
    const pane = session.paneId;
    if (!pane || !session.interactive) continue;

    const item = queue.due(pane);
    if (!item) continue;
    if (!(await claim(session))) continue;

    deliver(pane, item.text)
      .then(() => queue.settle(pane, item.id))
      .catch((err) => queue.fail(pane, item.id, err.message))
      .finally(() => registry.refresh().catch(() => {}));
  }
}

/* Every poll, not just the ones where something changed — a message in backoff has to be
   retried while the rest of the roster sits still. */
registry.on('tick', (sessions) => {
  flushQueues(sessions).catch((err) => console.error('[queue]', err.message));
});

/** The rail redraws from one frame, so the shelving goes out with the sessions on it. */
function broadcastRoster() {
  const sessions = registry.list();
  const shelves = groups.list();
  const snap = snapshotSummary(sessions);
  const open = links.list({ open: true });
  for (const ws of wss.clients) send(ws, 'sessions', { sessions, groups: shelves, snapshot: snap, links: open });
}

/* Broadcast roster changes, and re-attach any client whose session rotated. */
registry.on('update', (sessions) => {
  const shelves = groups.list();
  const snap = snapshotSummary(sessions);
  const open = links.list({ open: true });
  for (const ws of wss.clients) {
    send(ws, 'sessions', { sessions, groups: shelves, snapshot: snap, links: open });
    const slots = subs.get(ws);
    if (!slots) continue;

    for (const [slot, sub] of [...slots]) {
      const current = registry.get(sub.sessionId);
      if (current) {
        // The session rotated its transcript (/clear, compaction) — follow it.
        if (current.transcriptPath !== sub.path) subscribe(ws, sub.sessionId, slot);
        continue;
      }

      // The id vanished. A pane-only session earns a real one the moment it first
      // speaks, so follow the pane rather than dumping the viewer back to nothing.
      if (sub.paneId) {
        const successor = sessions.find((s) => s.paneId === sub.paneId);
        if (successor) {
          send(ws, 'rebound', { from: sub.sessionId, to: successor.id, slot });
          subscribe(ws, successor.id, slot);
        }
      }
    }
  }
});

registry.on('error', (err) => console.error('[roster]', err.message));

/* Hook traffic beats the 2s poll; refresh immediately so dots feel instant. */
status.on('changed', () => registry.refresh().catch(() => {}));
status.on('binding', () => registry.refresh().catch(() => {}));

/* ----------------------------------------------------------------- boot --- */

/**
 * Is somebody already answering on this port, on loopback?
 *
 * **Loopback always, never `HOST`** — the collision this exists to catch is invisible on
 * every other interface. Two node servers bind 48770 at the same time with no error, one
 * on `0.0.0.0` and one on `127.0.0.1`, in either order: node sets `SO_REUSEADDR` and macOS
 * lets a specific bind sit beside a wildcard one. Measured. They then split the traffic —
 * `curl 127.0.0.1` reaches one, `curl 192.0.2.10` reaches the other, and `lsof` shows
 * two LISTEN rows. So a bind attempt is precisely the check that does not work, and an
 * HTTP probe is.
 *
 * A connection that is *accepted* counts, not just one that answers in HTTP. The
 * maintainer's ruling on what makes a second panel: anything that answers on the port.
 * Nothing else can be listening on 127.0.0.1:PORT without being a conflict, and "something
 * else has your port, here's what" is a message worth seeing regardless — which is also why
 * there is no identity endpoint to ask. That was considered and declined: fewer moving
 * parts.
 *
 * Refusing to answer is not the same as refusing the connection, so a timeout, a parse
 * error, anything that isn't a completed TCP handshake resolves `false` and the boot goes
 * ahead. A probe must never be the reason the panel didn't start.
 */
function portAnswering(port) {
  return new Promise((resolve) => {
    let connected = false;
    try {
      const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('socket', (s) => s.on('connect', () => { connected = true; }));
      req.setTimeout(1000, () => req.destroy());
      req.on('error', () => resolve(connected));
      req.on('close', () => resolve(connected));
    } catch {
      // `http.get` validates the port and throws synchronously on a bad one. A nonsense
      // `FOREMAN_PORT` should fail where it always did, at `server.listen`, and not turn into
      // a boot the guard killed.
      resolve(false);
    }
  });
}

/*
 * Which install this is, asked once.
 *
 * It changes nothing the panel *does* — only the commands it prints, in the two places a
 * boot prints any: the stand-down block below and the hook line further down. Both are
 * printed by both installs, and `npm run …` is advice you cannot follow without a
 * checkout. Everything else in `install-agent.js` that prints `npm run` lines is right as
 * it is: those only ever run from one.
 */
const IS_HOMEBREW = panelIsHomebrew();

/*
 * Stand down rather than become the second panel.
 *
 * First thing in the boot block, before the roster starts and — the part that matters —
 * before `gcFailedWorktrees`, which would otherwise sweep real worktrees and branches
 * belonging to real tasks and post the receipt into a real team's room, entirely within
 * its rights.
 *
 * **Exit 0 is a contract.** The LaunchAgent sets `KeepAlive: {SuccessfulExit: false}`, so
 * exit 0 makes launchd stand down instead of crash-looping; a genuine crash is a non-zero
 * exit or a signal and still gets restarted. There is no other `process.exit` in
 * `server/` bar the SIGTERM flush below, so 0 here means exactly one thing: I deliberately
 * declined to start.
 *
 * This is not a loopback guard. It refuses a *second panel*, never a wide bind —
 * `FOREMAN_HOST=0.0.0.0` is the maintainer's standing ruling and nothing here touches it.
 */
if (await portAnswering(PORT)) {
  console.error(`Port ${PORT} already answers on 127.0.0.1 — a panel is already running there.`);
  console.error('Two panels on one port is not an error macOS reports: one binds 0.0.0.0, one');
  console.error('binds 127.0.0.1, both succeed, and they split traffic by interface — hooks and');
  console.error('lead tool calls to one, your phone to the other. So this one is standing down.');
  console.error('');
  console.error(`  restart the panel:  ${IS_HOMEBREW ? `brew services restart ${FORMULA}` : 'npm run restart-panel'}`);
  console.error(`  a scratch panel:    FOREMAN_PORT=${PORT + 1} FOREMAN_STATE_DIR=/tmp/scratch ${IS_HOMEBREW ? `${FORMULA} serve` : 'npm start'}`);
  process.exit(0);
}

/*
 * Trim the launchd logs, if they need it.
 *
 * **After the stand-down probe, before anything this boot prints.** Both halves of that
 * are load-bearing. A panel that is about to decline to start must not touch the logs of
 * the panel already running — they are the *same two files*, and the loser of that race
 * would rotate the winner's history out from under it. And a rotation that ran after the
 * boot lines would copy them into `.1` and then truncate them away, so the one boot you
 * were watching is the one that leaves no trace.
 *
 * Nothing is printed here: the report is collected now and read out with the boot lines
 * below, where a human is looking. Nothing at all when nothing rotated.
 */
const { rotated: rotatedLogs, notes: logNotes } = rotateLogs();

/*
 * Seed `<STATE_DIR>/config.json` if there isn't one, recording the host this boot is
 * actually binding.
 *
 * **After the stand-down probe** for the same reason the rotation above is: a panel that
 * has declined to start should not write into the running panel's state dir. Only when the
 * file is absent — an existing one is somebody's answer and is never rewritten.
 *
 * Why it exists at all is in `settings-file.js`'s header and it is worth the two minutes:
 * the bind host used to live only in the LaunchAgent's job environment, the environment
 * rename killed the key that plist spells, and only a *reinstall* writes the replacement.
 * This file is what carries the answer across that gap without anyone having to remember
 * to.
 *
 * Collected now, printed with the boot lines below where somebody is looking.
 */
const configSeed = seedConfigFile(CONFIG_FILE, { bindHost: HOST, sessionPrefix: SESSION_PREFIX });

/*
 * Flush every store, then go.
 *
 * Each store is a Map behind a 2-second debounced write, so any stop loses up to two
 * seconds of task records, queued messages, pins, group filings, read marks and the
 * session bench. That was already true — but `launchctl kickstart -k`, the restart
 * command, sends SIGTERM, and `KeepAlive` adds restarts nobody asked for, so it stops
 * being theoretical. `queue.js`'s public `flush()` has said "(tests, shutdown)" in its
 * comment since it was written; this is the shutdown half finally wired up.
 *
 * Synchronous, and nothing else: no draining of in-flight requests, no SIGINT handler
 * (Ctrl-C on a scratch server keeps behaving exactly as it does today). A flush that
 * throws must not stop the four after it.
 */
process.on('SIGTERM', () => {
  for (const store of [queue, tasks, pins, groups, readState, snapshot, links]) {
    try {
      store.flush();
    } catch {
      /* best-effort, and one bad store must not take the others down with it */
    }
  }
  process.exit(0);
});

const tmuxOk = await isAvailable();
if (!tmuxOk) {
  console.warn('tmux not found — sessions will be read-only.');
}

registry.start();
pruneImages(Date.now()).catch(() => {});
// Worktree housekeeping, boot-only by design: prune stale bookkeeping everywhere the
// task store knows, then sweep failed worktrees old enough to stop being evidence —
// each with a room line first, so nothing disappears unannounced.
pruneAllWorktrees(tasks).catch(() => {});
gcFailedWorktrees({ tasks, room, groups })
  // …and then the filings those worktrees left on the rail. Last, because the sweep above
  // makes more of them: a group is only reaped once the final worktree in it has gone.
  .then(() => gcGroupFilings({ tasks, groups }))
  .then(({ removed }) => removed.length && broadcastRoster())
  .catch(() => {});

server.listen(PORT, HOST, () => {
  console.log(`Foreman  →  http://${HOST}:${PORT}`);
  // The one command a fresh install still has to be told to run — and the only reason it
  // is conditional is that there is no `npm run` to type when there is no checkout.
  console.log(`Register the status hook once with:  ${IS_HOMEBREW ? `${FORMULA} install-hook` : 'npm run install-hook'}`);

  // Which directory this panel is reading, and which rung of the resolver answered.
  // Printed rather than derived for the same reason the origins below are: the resolver
  // has a rung that only fires on a machine carrying a populated directory under the name
  // this project used to have, and a panel that quietly picked the other one looks exactly
  // like a panel whose tasks, room and rulings have vanished.
  console.log(`State: ${STATE_DIR} (${STATE_DIR_SOURCE})`);

  // …and where its output goes, in the same breath and for the same reason. These two
  // paths are already the answer to "where do I look when this misbehaves", and under a
  // service manager whose plist this repository cannot read they are the one fact the
  // service definition could get wrong silently: `FOREMAN_LOG_DIR` is what the plist uses
  // to tell the process, and this line is where the two are seen to agree. Printed on
  // every boot, including `npm start`, where they are simply the files that would be used
  // if launchd were the one starting this.
  console.log(`Logs: ${LOG_OUT}`);
  console.log(`      ${LOG_ERR}`);

  // What the boot did to its own logs, in the same breath as `Triggers:` below and for
  // the same reason: the state of the environment, at the one moment somebody is reading
  // it. Silent when nothing was over its threshold, which is nearly every boot, and
  // silent under `npm start`, where there are no launchd logs to rotate at all.
  for (const note of logNotes) console.warn(note);
  for (const line of rotationLines(rotatedLogs)) console.log(line);
  // What the settings file said, and whether this boot created it. `CONFIG_NOTES` first:
  // "there is no file" and "there is a file I could not parse" produce the same silence
  // and mean opposite things, and the second one means the host below came from a default
  // rather than from the file somebody edited.
  for (const note of CONFIG_NOTES) console.warn(note);
  if (configSeed.error) {
    console.warn(`Config: could not seed ${CONFIG_FILE} (${configSeed.error.code || configSeed.error.message}) — using ${HOST} this boot only.`);
  } else if (configSeed.seeded) {
    console.log(`Config: seeded ${CONFIG_FILE} with bindHost ${HOST}, sessionPrefix ${SESSION_PREFIX}`);
  } else {
    // Name the source when the environment won, so a file saying one thing over a panel
    // doing another is never two lines that quietly disagree. The prefix is on the same
    // line for the same reason and one more: an existing `config.json` is never seeded
    // into, so a machine that upgraded into this code has no `sessionPrefix` key at all
    // and is silently minting under the default — this line is where that shows up.
    const from = HOST_SOURCE === 'config.json' ? '' : ` from ${HOST_SOURCE === 'default' ? 'the default' : HOST_SOURCE}`;
    const prefixFrom = SESSION_PREFIX_SOURCE === 'config.json' ? '' : ' from the default';
    console.log(
      `Config: ${CONFIG_FILE} (bindHost ${HOST}${from}, sessionPrefix ${SESSION_PREFIX}${prefixFrom})`,
    );
  }

  // Whatever the token read had to say — a file that exists but can't be read, one that's
  // readable beyond you — before the verdict, so the verdict has its reason above it.
  for (const note of TRIGGER_NOTES) console.warn(note);

  // "no token" when there is genuinely no file; "no usable token" when there is one and
  // the note above says what is wrong with it. Two adjacent lines that appear to
  // contradict each other are a small version of the ambiguity this line exists to end.
  const missing = TRIGGER_NOTES.length ? 'no usable token' : 'no token';

  // Never the token itself — not truncated, not hashed, not a prefix. This lands in
  // ~/Library/Logs/foreman.log on every boot and nothing rotates that file. On or
  // off, and *where from*, because a file edited while $FOREMAN_TRIGGER_TOKEN is still set in
  // the shell is a rotation that silently didn't happen.
  console.log(TRIGGER_TOKEN
    ? `Triggers: on — token from ${TRIGGER_SOURCE}`
    : `Triggers: off — ${missing} at ${TRIGGER_SOURCE}`);

  // The origins this boot resolved, one line each with the interface and the reason.
  // This is printed rather than merely derived because the exclusion filter in `origin.js`
  // was first written from a *description* of `os.networkInterfaces()` instead of its
  // output on a real machine — and a derived list nobody ever looks at is how that comes
  // back. Six lines a boot, and a human can check the whole rule in a second.
  for (const line of originBootLines({ port: PORT, config: { allowedOrigins: ALLOWED_ORIGINS } })) {
    console.log(line);
  }
});
