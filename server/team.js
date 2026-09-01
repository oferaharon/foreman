import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';
import { DEFAULT_WORKER_MODEL } from './dispatch.js';

/**
 * A team is a folder under `STATE_DIR/teams/`, keyed by the repo's full path with each
 * slash as a dash — the `~/.claude/projects` convention, and for the same reason: two
 * repos called `api` in different places must not share a team. The team outlives any
 * particular lead session; a lead is disposable, its team folder is not.
 *
 * What lives here:
 *   team.json           config + autonomy toggles (Wave C reads the toggles; they exist
 *                       now so there is one place to look, with every answer visibly off)
 *   decisions.md        the maintainer's rulings, appended by the lead, survives /clear
 *   brief.md            the lead's system-prompt addition — regenerated each launch
 *   mcp.json            the lead's tool surface — regenerated each launch
 *   lead-settings.json  the lead's permission stance — regenerated each launch
 *   plans/<task>.md     what a planner worker wrote — the one place a planner may
 *                       write, and the reason it is a *subfolder*: the planner's allow
 *                       rule points at `plans/`, so decisions.md (the maintainer's rulings) and
 *                       lead-settings.json (the lead's own stance) stay out of reach.
 */

export const TEAMS_DIR = path.join(STATE_DIR, 'teams');

/** `/Users/x/Code/Api` → `Users-x-Code-Api`, the projects-dir convention. */
export function teamKey(repo) {
  return String(repo).replace(/\/+$/, '').replace(/\//g, '-').replace(/^-/, '');
}

export function teamDir(repo) {
  return path.join(TEAMS_DIR, teamKey(repo));
}

/**
 * Where a planner's output lands — one file per task, named for it.
 *
 * A subfolder rather than the team dir itself, and that is the whole security shape of
 * a planner: its settings allow `Edit(//<teamDir>/plans/**)` and nothing else, so it
 * can write its plan and cannot touch `decisions.md`, `team.json` or the lead's own
 * settings file sitting one level up. Deny beats allow in Claude Code, so the allow had
 * to be narrower than the team dir rather than the team dir minus some carve-outs.
 */
export function plansDir(repo) {
  return path.join(teamDir(repo), 'plans');
}

/** The plan file for one task. Deterministic, so the path is known before it exists. */
export function planPath(repo, taskId) {
  return path.join(plansDir(repo), `${taskId}.md`);
}

const DEFAULTS = {
  maxWorkers: 3,
  // `setup` is deliberately absent: the worktree-prepare command is detected from the
  // repo's own files (setup-detect.js), not stored. A team.json written before that
  // change may still carry one and it is honoured — but nothing writes it any more.
  allow: [], // per-repo build/test permission entries, e.g. "Bash(npm test:*)"
  // What workers launch with when the lead names nothing — Opus, the maintainer's ruling
  // (2026-08-26). The lead may name another per task; the room says which and why.
  defaultModel: DEFAULT_WORKER_MODEL,
  // Phrases an authenticated trigger may put into this team's lead, each
  // `{ id, match }` with `match` anchored `^...$` — see `server/trigger.js`, which
  // refuses the lot if one is not. **Empty is the default and empty means no**: a team
  // that has not opted in cannot be triggered, so adding a team never adds an attack
  // surface. Hand-edited, deliberately: `PATCH /api/team/config` whitelists key by key
  // and does not write this, and the merge below keeps a hand-added array through every
  // rewrite. The credential is *not* here — team.json is served to the browser by
  // `GET /api/team/config` and sits in a directory a planner may write to; the token is
  // an env var read once at boot.
  triggers: [],
  toggles: {
    // Wave C reads these. All answering starts off — autonomy is earned, not assumed.
    answerDesignQuestions: false,
    answerPermissionPrompts: false,
    approvePlans: false,
    openPRs: true,
    mergePRs: false, // exists so the answer to "can it?" is visibly no; endpoints refuse regardless
    // leadMerges is NOT mergePRs: it removes the harness permission prompt on the merge
    // tool its forge uses (`mergeRule`), it does not authorise a merge. What that costs
    // depends on the forge — on Gitea one tool covers open AND merge, so a rule cannot tell
    // them apart, and on means trusting the lead's discipline (merge only on the
    // maintainer's explicit per-PR word) instead of a prompt.
    leadMerges: false,
    flagConflicts: true,
    stuckAfterMinutes: 20,
  },
  // Panel chrome, not policy. Nothing that dispatches, watches or scans reads this — it
  // lives here for the same reason a group's collapse lives in groups.json rather than
  // localStorage: two windows should agree, and a reload shouldn't reopen what you
  // tidied away. Deliberately outside `toggles`, which is the autonomy dials and is read
  // by the lead: a bit of browser furniture in there would read as a permission.
  ui: {
    settingsOpen: false, // the aside's SETTINGS block. Closed is the default — see docs.
  },
};

/**
 * Load a team's config, or seed the whole layout on first touch.
 *
 * `ensure` is idempotent and cheap; the lead launch calls it every time. Config merges
 * over defaults so a team.json written before a new toggle existed still has it, visibly
 * at its default, rather than `undefined` deciding something.
 */
export function ensureTeam(repo) {
  const dir = teamDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  // Made here, not at dispatch: a planner's allow rule names this path, and a rule
  // pointing at a folder that does not exist is a rule nobody can check.
  fs.mkdirSync(path.join(dir, 'plans'), { recursive: true });

  const configFile = path.join(dir, 'team.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    /* first touch */
  }
  const config = {
    repo,
    ...DEFAULTS,
    ...stored,
    toggles: { ...DEFAULTS.toggles, ...(stored.toggles || {}) },
    ui: { ...DEFAULTS.ui, ...(stored.ui || {}) },
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const decisions = path.join(dir, 'decisions.md');
  // Only ever written on a fresh team dir — an existing decisions.md is somebody's
  // record and is never rewritten, reformatted or re-headed.
  if (!fs.existsSync(decisions)) fs.writeFileSync(decisions, decisionsPreamble(repo));

  return { dir, config, configFile, decisionsFile: decisions };
}

/**
 * What a brand-new team's `decisions.md` starts as.
 *
 * A header, and **never a seeded rule** — that distinction is the whole design. A lead
 * reads this file as authority, so anything in it that parses as a ruling is obeyed as
 * though a human had decided it; pre-filled "sensible defaults" would be somebody else's
 * preferences wearing the new user's name. The value of the file is that a human decided
 * every line of it.
 *
 * So the test for anything written here is: could this sentence be mistaken for a ruling
 * if it were read aloud? If yes, it is wrong. What is allowed is prose *about* the file —
 * what it is, who writes it, who obeys it, and why it exists outside the conversation.
 *
 * It is second person, because it is addressed to someone who has never run this before
 * and would otherwise meet an empty file with no idea what fills it. The lead's brief
 * carries the other half: an empty file is normal, not a sign something is missing.
 */
export function decisionsPreamble(repo) {
  return `# Decisions — ${path.basename(repo)}

## About this file

This is the standing record of what **you** have decided about this repository — scope
calls, preferences, rules you want kept. You do not have to write it: when you settle
something in conversation, the team lead appends it here, dated, in your words as closely
as it can manage.

Why it exists at all: the lead is a chat session, and a long one fills up and has to be
cleared. Everything said in that conversation goes with it. This file does not — the lead
re-reads it before its first reply in every session, a cleared one included, so a decision
you took once does not have to be taken again.

Workers read it too. A worker dispatched on a task treats any ruling here that bears on
that task as binding, even where its own brief says nothing about it.

Every entry below is here because a person decided it. Nothing is seeded, suggested or
inherited from anyone else's setup — that is the whole value of the file: if it says
something, you said it.

**There are no rulings yet.** This section describes the file; it is not an entry in it.
An empty decisions file is the ordinary state of a new team and means nothing has been
decided so far, not that anything is missing. Entries go below, newest last.
`;
}

/** `/abs/path` → the `//`-anchored glob permission rules need. A plain absolute path in
 *  an Edit rule silently matches nothing — measured, Wave B.0. And the tool is Edit,
 *  never Write: Claude Code stopped matching Write(path) rules (Wave E). */
export const pathRule = (tool, abs) => `${tool}(//${String(abs).replace(/^\/+/, '')}/**)`;

/**
 * What `leadMerges` allows, per forge — and the three cases are not the same *kind* of
 * rule, which is the whole reason this is a function rather than a constant.
 *
 * **Gitea:** `pull_request_write` is one tool that both opens and merges PRs, so a
 * permission rule cannot allow one without the other. That asymmetry is a *Gitea fact*,
 * not a general one, and the panel's copy beside the toggle has to say so per forge.
 *
 * **GitHub via `gh`:** the merge is a shell call, so the rule is a Bash prefix and it is
 * genuinely narrow — `gh pr merge` cannot open a PR. Better than Gitea's, for once.
 *
 * **GitHub via an MCP server:** nothing. Nobody here has run the GitHub MCP server, so
 * its tool name is unverified — and an unverified name in an allow rule is a rule that
 * silently does nothing, which is exactly the failure this whole item exists to stop
 * shipping. Refusing to guess costs the lead a permission prompt it can answer; guessing
 * wrong costs a toggle that reads as on and isn't. The panel says which.
 *
 * `null` (push only, no remote) allows nothing: there is no PR to merge.
 */
export function mergeRule(forge) {
  const kind = typeof forge === 'string' ? { forge, via: forge === 'github' ? 'gh' : 'mcp' } : forge || {};
  if (kind.forge === 'gitea') return 'mcp__gitea__pull_request_write';
  if (kind.forge === 'github' && kind.via === 'gh') return 'Bash(gh pr merge:*)';
  return null;
}

/**
 * The lead's permission stance — the object `lead-settings.json` is written from at
 * every lead launch. **The lead never writes code**: only workers change code, and this
 * is enforced at launch rather than asked for in a brief. The reason is not tidiness —
 * every worker is isolated in its own worktree precisely so two Claude sessions never
 * edit the same file, and the lead lives in the *real* checkout, the folder your own
 * session is open in. A lead that wrote code would reintroduce the exact collision
 * worktrees exist to prevent, at the top of the system. No exception for one-liners; the
 * lead dispatches a worker. Reading is unrestricted and has to be — scoping a task,
 * citing grounds, reading a diff to summarise a PR — so read-only git stays allowed.
 *
 * `leadMerges` on adds the one allow rule its forge needs (`mergeRule` above). It removes
 * the harness prompt the maintainer otherwise resolves per call; it does NOT authorise a
 * merge. The standing rule (merge only on the maintainer's explicit per-PR word) is the
 * lead's brief and discipline, and with this on, discipline is the only guard. Off, the
 * rule is simply absent — the classifier prompts as before.
 *
 * `forge` is the detected pair (`forge.js`), not a setting. With no forge the toggle can
 * be on and still add nothing, because there is nothing to merge.
 */
export function leadSettings({ repo, dir, leadMerges = false, forge = null }) {
  const rule = leadMerges ? mergeRule(forge) : null;
  return {
    permissions: {
      deny: [
        pathRule('Edit', repo),
        'Bash(git commit:*)',
        'Bash(git push:*)',
      ],
      allow: [
        pathRule('Edit', dir),
        ...(rule ? [rule] : []),
      ],
    },
  };
}

/**
 * The planner's permission stance — the deny/allow pair a planning worker launches with.
 * A planner researches and writes one document, and cannot write code. Mechanically it is
 * a worker in every respect — its own worktree branched from the base, its own
 * `agent/<label>` branch, the same task record, the same room, the same slot against the
 * worker cap, the same two tools — and differs in exactly two things: the brief it
 * launches with, and this stance. Its branch ends with no commits on it, and that is the
 * correct outcome rather than a failure.
 *
 * Same shape as `leadSettings` and for the same reason: the rule is enforced at launch,
 * not asked for in a prompt. A planner that quietly started implementing is the exact
 * failure this exists to prevent, and a brief is a request while a deny is a wall.
 *
 * Three things it denies and one it allows:
 *   - its own worktree, which is where it would write if it forgot what it was;
 *   - the worktrees root, so it cannot reach into a build worker's checkout either;
 *   - the real repo, the same rule the lead carries;
 *   - and it may write in `<teamDir>/plans/` — the *subfolder*, never the team dir,
 *     because deny beats allow and `decisions.md` sits one level up.
 *
 * `git commit`/`git push` go too: a planner produces a document, not a branch. The
 * destructive-git floor (`GIT_DENY`) rides along from `writeWorkerSettings`, as for
 * every worker.
 *
 * The honest limit, the same one the lead has: these are file-tool rules. A shell
 * redirect (`echo x > file`) is a Bash call, and no path rule sees it. The stance
 * raises the cost of drifting into implementation from "nothing" to "deliberately
 * routing around the panel"; it is not a sandbox.
 */
export function plannerStance({ repo, worktree, plans, worktreesRoot = null }) {
  return {
    deny: [
      pathRule('Edit', repo),
      ...(worktree ? [pathRule('Edit', worktree)] : []),
      ...(worktreesRoot ? [pathRule('Edit', worktreesRoot)] : []),
      'Bash(git commit:*)',
      'Bash(git push:*)',
    ],
    allow: [pathRule('Edit', plans)],
  };
}

/** Read without seeding — null when the repo has no team. */
export function readTeam(repo) {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(teamDir(repo), 'team.json'), 'utf8'));
    return {
      repo,
      ...DEFAULTS,
      ...stored,
      toggles: { ...DEFAULTS.toggles, ...(stored.toggles || {}) },
      ui: { ...DEFAULTS.ui, ...(stored.ui || {}) },
    };
  } catch {
    return null;
  }
}
