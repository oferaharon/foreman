import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PORT, USER_CLAUDE_CONFIG } from './config.js';
import { resolveForge, credentialKeys, READINGS } from './forge.js';
import { resolveBaseBranch } from './base-branch.js';
import { humanName } from './human-name.js';
import { leadBrief } from './lead-brief.js';
import { workerBrief, plannerBrief } from './worker-brief.js';
import { teamDir, planPath, readTeam, teamDefaults } from './team.js';
import { sessionBrief } from './session-launch.js';

/**
 * One assembly of what a session is launched *reading* — used by the launch that writes
 * the file and by the read-only briefs modal that shows it.
 *
 * The reason this file exists at all is that the modal's whole claim is "this is what the
 * next lead will read". A second copy of the assembly would be a claim that decays: the
 * two would agree on the day they were written and disagree at the first change to
 * either, silently, because nothing on screen can tell you a brief is a generation
 * behind. So the launch path (`launchLead` in `index.js`) and `GET /api/briefs` call
 * exactly these functions, and `test/briefs.test.js` pins that the two come out byte-
 * identical for one set of inputs.
 *
 * **The demotion is the part that cannot be left out of the shared half.** A forge whose
 * registered MCP entry carries a credential is refused at launch (`mcp.json` is
 * world-readable) and the forge is demoted to `push only` *before* the brief is written,
 * so the brief never promises a tool the file beside it does not contain. A modal that
 * resolved the forge and skipped the demotion would show a lead being handed forge tools
 * it will not have — the one thing a read-only view of a brief must not do.
 *
 * **Nothing here writes.** `ensureTeam` is deliberately not imported: reading a brief must
 * not seed a team directory, a `team.json` or a `decisions.md` for a repo nobody has
 * started a team on. Every path is computed (`teamDir`, `planPath`) and every config read
 * falls back to `teamDefaults` rather than to a file being created. The launch path still
 * calls `ensureTeam` itself, before it calls in here — that is where seeding belongs,
 * because that is where a team actually begins.
 */

/** The lead's own MCP config path. One spelling: the note below names its basename. */
export function mcpFilePath(dir) {
  return path.join(dir, 'mcp.json');
}

/** Where `mcp/foreman.js` lives, resolved from this file rather than from a cwd. */
const FOREMAN_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'foreman.js');

/**
 * The panel's own stdio MCP entry, scoped to a repo and a role by env. Built here so the
 * launch and anything that describes the launch spell it once — an entry that differed by
 * a field between the two would be a tool surface nobody could check.
 */
export function foremanEntry({ repo, role, task = null, port = PORT }) {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [FOREMAN_MCP],
    env: {
      FOREMAN_PORT: String(port),
      FOREMAN_REPO: repo,
      FOREMAN_ROLE: role,
      ...(task ? { FOREMAN_TASK: task } : {}),
    },
  };
}

/**
 * The lead's tool surface, and the forge it will actually be *able* to use.
 *
 * Starts as what was detected and is demoted when the entry that would have carried the
 * forge is refused or missing — the brief, the settings and `mcp.json` are then all
 * written from the same demoted answer. `notes` is what could not be given, said out loud
 * rather than dropped: a tool that silently isn't there is a lead that fails at the far
 * end of a task.
 *
 * `userConfigFile` is the test seam — the same shape `detectForge`'s `deps` has, and for
 * the same reason: no test should need a real `~/.claude.json`.
 */
export async function leadToolSurface({ repo, teamDir: tDir, forge, port = PORT, userConfigFile = USER_CLAUDE_CONFIG }) {
  const mcpServers = { foreman: foremanEntry({ repo, role: 'lead', port }) };
  const notes = [];
  let effective = forge;
  if (forge?.forge && forge.via === 'mcp') {
    try {
      const userCfg = JSON.parse(await fsp.readFile(userConfigFile, 'utf8'));
      const entry = userCfg?.mcpServers?.[forge.forge];
      // `mcp.json` is written with the default umask — `-rw-r--r--`, measured — and this
      // copies the user's entry verbatim. A gitea entry of `{type, url}` carries nothing;
      // the standard GitHub MCP server carries GITHUB_PERSONAL_ACCESS_TOKEN in its `env`.
      // Copying that would write a personal access token world-readable into the team
      // folder, by the feature whose ruling says never store a token. So it is refused,
      // and the refusal is reported — `gh` is the supported GitHub path exactly because
      // its credential lives in the keychain and never in a config file.
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
  return { mcpServers, forge: effective, notes };
}

/**
 * Everything a lead is launched reading, for one repo: its brief, the tool surface that
 * brief describes, the demoted forge and the base branch both were written from.
 *
 * `config` is the team's own (`toggles.leadDecidesMerges` decides whether the self-merge
 * paragraphs are in the brief at all). The caller supplies it because the launch has
 * already seeded it and the modal deliberately has not — see the file header.
 *
 * `fresh` is the launch's answer and not the modal's: a launch is rare and a minute-stale
 * forge cache is exactly wrong on the launch that follows `git remote add`, while the
 * modal is a page somebody opens and the cache is what keeps it cheap.
 */
export async function assembleLead({ repo, teamDir: tDir, decisionsFile, config = {}, port = PORT, fresh = false, deps = {} }) {
  const detected = await resolveForge(repo, { fresh, ...(deps.forge || {}) });
  const base = (await resolveBaseBranch(repo)).branch;
  const { mcpServers, forge, notes } = await leadToolSurface({
    repo,
    teamDir: tDir,
    forge: detected,
    port,
    ...(deps.userConfigFile ? { userConfigFile: deps.userConfigFile } : {}),
  });
  const brief = leadBrief({
    repo,
    teamDir: tDir,
    decisionsFile,
    // The demoted answer, never `detected` — see the file header. This is the whole
    // reason the modal and the launch share a function rather than a shape.
    forge,
    base,
    // Who this team reports to, detected from the repo's own `git config user.name`. A
    // repo can carry its own, and a brief is generated per repo.
    human: humanName(repo),
    selfMerge: Boolean(config?.toggles?.leadDecidesMerges),
  });
  return { brief, forge, detected, base, notes, mcpServers };
}

/**
 * The four briefs for one repo, as the *next* session launched there would read them.
 *
 * `taskId` is a placeholder: worker and planner briefs are per task, and there is no task
 * here. A literal `<task>` is chosen over a plausible-looking id because a brief with a
 * real-looking label in it invites a reader to go looking for that task.
 *
 * `standalone` is the one machine-wide file (`session-launch.js`) and takes no repo, so it
 * comes back whether or not one was named.
 */
export async function briefsFor(repo, { port = PORT, taskId = '<task>', deps = {} } = {}) {
  const standalone = sessionBrief();
  if (!repo) return { repo: null, briefs: { standalone } };

  const tDir = teamDir(repo);
  const decisionsFile = path.join(tDir, 'decisions.md');
  // Read without seeding, and fall back to what a repo with no team.json would get. The
  // modal renders a repo nobody has started a team on with the same defaults dispatch
  // would use, rather than creating the directory to find out.
  const config = readTeam(repo) || teamDefaults(repo);
  const hasTeam = Boolean(readTeam(repo));

  const lead = await assembleLead({ repo, teamDir: tDir, decisionsFile, config, port, deps });
  const base = lead.base;
  const human = humanName(repo);

  return {
    repo,
    hasTeam,
    base,
    taskId,
    forge: lead.forge.reading,
    notes: lead.notes,
    briefs: {
      lead: lead.brief,
      worker: workerBrief({ repo, taskId, decisionsFile, human, base }),
      planner: plannerBrief({ repo, taskId, planFile: planPath(repo, taskId), decisionsFile, human, base }),
      standalone,
    },
  };
}
