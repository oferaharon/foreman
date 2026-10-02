import fs from 'node:fs';
import path from 'node:path';
import { credentialKeys } from './forge.js';

/**
 * A repo's own **project MCP servers** — the ones its checked-in `.mcp.json` declares —
 * carried onto a team's tool surface, by name, where the team's `projectMcpServers` list
 * asks for them.
 *
 * Why this exists at all: a lead and its workers launch with `--mcp-config <file>
 * --strict-mcp-config`, and the strict flag is what keeps a role's tool surface known — so
 * it also drops every server the repo declares for itself. A standalone session in the same
 * folder gets the repo's own tools (build, run, drive a simulator); its team did not, and a
 * hand edit to the generated file is overwritten at the next launch. The maintainer's
 * ruling (2026-10-01) is to carry them across, behind a per-team list a human ticks.
 *
 * **One function decides, and both launch paths call it.** `resolveProjectMcp` is what the
 * lead's tool surface (`leadToolSurface`, `briefs.js`) and a build worker's dispatch
 * (`index.js`) both ask, with the same repo and the same list — so a lead and a worker of
 * one team cannot disagree about which servers the repo allows. The team panel's listing
 * (`projectMcpCatalogue`) goes through the same per-server judgement (`judge`), so a row the
 * panel offers is a row the launch would copy.
 *
 * A server is copied only if all of these hold, and each refusal is a **note** — said out
 * loud in the room and the launch result, never a crash and never silence:
 *
 *   1. its name is on the team's list, and is a name this panel may put on a surface
 *      (`nameProblem`: the shape a permission rule can carry, and none of the names the
 *      panel's own entries already use);
 *   2. the repo's `.mcp.json` declares it;
 *   3. the repo's **own** Claude Code project settings approve it (`approval`) — the same
 *      gate a standalone session in that folder passes, so a team never gets a server the
 *      repo's owner has not said yes to;
 *   4. its entry carries no credential (`entryCredentials`) — the generated files are
 *      world-readable, the same refusal the forge entry gets.
 *
 * **Read from the main checkout, never from a worktree.** `.claude/settings.local.json` is
 * normally gitignored, so a worktree has no copy of it — and the approval lives there more
 * often than not. Every read here takes the team's repo, which is the main checkout.
 *
 * **Nothing here writes**, so the read-only briefs modal can call it freely.
 */

/** The repo-relative files read, in one spelling — also what the notes name. */
export const PROJECT_MCP_FILE = '.mcp.json';
export const SHARED_SETTINGS_FILE = path.join('.claude', 'settings.json');
export const LOCAL_SETTINGS_FILE = path.join('.claude', 'settings.local.json');

/**
 * Names a project server may never take, because the panel's own entries already use them
 * on a team's surface — and an allow rule spelled `mcp__<name>` would then reach *those*
 * tools too.
 *
 * `foreman` is `foremanEntry`'s key. `gitea` and `github` are the two keys
 * `leadToolSurface` may put a forge entry under (`forge.forge`, `forge.js`). Both forge
 * names are reserved whatever this repo's forge reads today, not only the detected one: the
 * forge is re-detected at every launch, and a project server called `github` on a repo whose
 * `gh` is later uninstalled would collide with the forge entry that replaces it — and
 * `mcp__github` would allow a merge tool `leadMerges` deliberately leaves unallowed.
 * Compared without case, because a permission rule's case-sensitivity is not something this
 * repo has measured, and a refusal costs less than a guess.
 */
export const RESERVED_SERVER_NAMES = ['foreman', 'gitea', 'github'];

/** The longest list the panel stores — a safety list nobody can read back is no list. */
export const MAX_PROJECT_MCP_SERVERS = 20;

/** What a name may be spelled with: what a tool name carries through unchanged. */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The allow rule for every tool of one server — the bare whole-server form, the same one
 * `mcp__foreman` uses (`### MCP` in Claude Code's permissions docs: "`mcp__puppeteer`
 * matches any tool provided by the `puppeteer` server"). One spelling, used by
 * `leadSettings` and `writeWorkerSettings` both, and only ever for a server that was
 * actually copied.
 */
export function mcpServerRule(name) {
  return `mcp__${name}`;
}

/**
 * Why `name` may not be put on a surface, or `null` when it may.
 *
 * `__` is refused because it is the separator inside a tool name: a server called
 * `gitea__pull_request_write` would get the allow rule `mcp__gitea__pull_request_write`,
 * which is not a server rule at all but the forge's merge tool, by name.
 */
export function nameProblem(name) {
  if (typeof name !== 'string') return `${JSON.stringify(name)} is not a server name`;
  if (!NAME_RE.test(name)) {
    return `${JSON.stringify(name)} is not a server name this panel carries — letters, digits, "-" and "_" only, at most 64`;
  }
  if (name.includes('__')) return `${JSON.stringify(name)} contains "__", the separator inside a tool name`;
  if (RESERVED_SERVER_NAMES.includes(name.toLowerCase())) {
    return `"${name}" is a name the panel's own servers use (${RESERVED_SERVER_NAMES.join(', ')})`;
  }
  return null;
}

/**
 * The one place `projectMcpServers`' shape is decided — `PATCH /api/team/config` stores
 * exactly what this returns. Throws, naming the entry, and refuses the whole list rather
 * than dropping the bad entry, the `normalizeReviewPaths` rule: a list that quietly
 * shortened is a list nobody looks at again.
 *
 * Membership in the repo's `.mcp.json` is deliberately **not** checked here: a server the
 * repo declares next week can be ticked today, and the launch says plainly that it was
 * skipped until then. What is refused here is only what could never be right.
 */
export function normalizeProjectMcpServers(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new Error(`projectMcpServers must be a list of server names, not ${list === null ? 'null' : typeof list}.`);
  }
  if (list.length > MAX_PROJECT_MCP_SERVERS) {
    throw new Error(`projectMcpServers holds ${list.length} entries — at most ${MAX_PROJECT_MCP_SERVERS}.`);
  }
  const clean = [];
  for (const raw of list) {
    const name = typeof raw === 'string' ? raw.trim() : raw;
    const problem = nameProblem(name);
    if (problem) throw new Error(`projectMcpServers: ${problem}.`);
    clean.push(name);
  }
  return [...new Set(clean)].sort();
}

/**
 * Keys in an entry that look like a credential, wherever an MCP entry can carry one.
 *
 * `credentialKeys` (`forge.js`) is the one test of what a credential *name* is, and it is
 * applied to every place a value can hide: `env` (where the forge refusal looks), an http
 * server's `headers` (plus `Authorization`/`Cookie`, which carry a credential under a name
 * that test was never written for), a `url`'s user-info and query, and `--flag=value` /
 * `--flag value` pairs in `args`. Any non-empty value counts, a `${VAR}` reference included
 * — the forge rule, applied unchanged.
 */
export function entryCredentials(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const found = [...credentialKeys(entry.env)];

  const headers = entry.headers && typeof entry.headers === 'object' ? entry.headers : null;
  if (headers) {
    found.push(...credentialKeys(headers));
    for (const [key, value] of Object.entries(headers)) {
      if (/^(proxy-)?authorization$|^cookie$/i.test(key) && String(value ?? '').trim() && !found.includes(key)) {
        found.push(key);
      }
    }
  }

  if (typeof entry.url === 'string') {
    try {
      const u = new URL(entry.url);
      if (u.username || u.password) found.push('url (user:password)');
      found.push(...credentialKeys(Object.fromEntries(u.searchParams)).map((k) => `url ?${k}=`));
    } catch {
      /* not a URL this can read; nothing to name */
    }
  }

  if (Array.isArray(entry.args)) {
    const flags = {};
    entry.args.forEach((arg, i) => {
      const m = /^--?([A-Za-z0-9_-]+)(?:=(.*))?$/.exec(String(arg));
      if (!m) return;
      const value = m[2] !== undefined ? m[2] : entry.args[i + 1];
      flags[m[1]] = value === undefined ? '' : String(value);
    });
    found.push(...credentialKeys(flags).map((k) => `--${k}`));
  }
  return found;
}

/** A JSON file, or `{ value: null }` when it is absent — absent is ordinary, not an error. */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? { value: null } : { value: null, error: err.message };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { value: null, error: `not valid JSON (${err.message})` };
  }
}

const objectOr = (v, fallback) => (v && typeof v === 'object' && !Array.isArray(v) ? v : fallback);
const namesIn = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * What the repo says for itself, read once: the servers `.mcp.json` declares and the two
 * project settings files that approve them. `problems` are files that exist and cannot be
 * read — said, never treated as "nothing declared" in silence.
 */
export function readProjectMcp(repo) {
  const problems = [];
  const mcp = readJson(path.join(repo, PROJECT_MCP_FILE));
  if (mcp.error) problems.push(`${PROJECT_MCP_FILE} could not be read: ${mcp.error}`);
  const shared = readJson(path.join(repo, SHARED_SETTINGS_FILE));
  if (shared.error) problems.push(`${SHARED_SETTINGS_FILE} could not be read: ${shared.error}`);
  const local = readJson(path.join(repo, LOCAL_SETTINGS_FILE));
  if (local.error) problems.push(`${LOCAL_SETTINGS_FILE} could not be read: ${local.error}`);
  return {
    declared: objectOr(objectOr(mcp.value, {}).mcpServers, {}),
    shared: objectOr(shared.value, {}),
    local: objectOr(local.value, {}),
    problems,
  };
}

/**
 * Is `name` approved by the repo's own project settings — and by which file?
 *
 * The precedence is **measured, not read off the docs** — Claude Code v2.1.280, eleven
 * combinations of the two files in the sandbox, each read back through `claude mcp list`
 * (`✔ Connected` / `⏸ Pending approval` / gone). Two of the three rules are not what the
 * documentation's own summary implies, which is why it was measured:
 *
 *   - `disabledMcpjsonServers` naming it in **either** file refuses it — over an enable in
 *     the other file, over one in the same file, and over `enableAllProjectMcpServers`.
 *     Claude Code drops a disabled server from the list entirely.
 *   - `enableAllProjectMcpServers` is read from `settings.local.json` when that file sets
 *     it at all, and from `settings.json` only otherwise: a local `false` closes a shared
 *     `true` (measured — every server went back to pending), and a local `true` opens over
 *     a shared `false`. Not "any file's `true` wins".
 *   - otherwise `enabledMcpjsonServers` in either file approves it: the two lists add up
 *     (shared naming one server and local another approved both).
 *
 * Only the repo's project files are read. The user's own `~/.claude/settings.json` and
 * `~/.claude.json` are not consulted, deliberately: an approval this panel acts on for a
 * whole team has to be one the repo's own files show.
 */
export function approval(name, { shared = {}, local = {} } = {}) {
  for (const [file, s] of [[LOCAL_SETTINGS_FILE, local], [SHARED_SETTINGS_FILE, shared]]) {
    if (namesIn(s.disabledMcpjsonServers).includes(name)) {
      return { approved: false, reason: `disabledMcpjsonServers in ${file} switches it off` };
    }
  }
  const allFile = typeof local.enableAllProjectMcpServers === 'boolean'
    ? LOCAL_SETTINGS_FILE
    : typeof shared.enableAllProjectMcpServers === 'boolean' ? SHARED_SETTINGS_FILE : null;
  const enableAll = allFile === LOCAL_SETTINGS_FILE ? local.enableAllProjectMcpServers : shared.enableAllProjectMcpServers;
  for (const [file, s] of [[LOCAL_SETTINGS_FILE, local], [SHARED_SETTINGS_FILE, shared]]) {
    if (namesIn(s.enabledMcpjsonServers).includes(name)) {
      return { approved: true, reason: `enabledMcpjsonServers in ${file}` };
    }
  }
  if (allFile && enableAll === true) return { approved: true, reason: `enableAllProjectMcpServers in ${allFile}` };
  return {
    approved: false,
    reason: `neither ${SHARED_SETTINGS_FILE} nor ${LOCAL_SETTINGS_FILE} approves it (enabledMcpjsonServers or enableAllProjectMcpServers)`,
  };
}

/**
 * The per-server judgement both callers below share — the whole of "may this server go on
 * a surface". `ok` with the entry to copy, or not `ok` with the reason in words.
 */
function judge(name, repoFacts, taken) {
  const problem = nameProblem(name);
  if (problem) return { name, ok: false, declared: false, approved: false, reason: problem };
  if (taken.has(name)) {
    return { name, ok: false, declared: false, approved: false, reason: `"${name}" is already on this surface` };
  }
  const entry = Object.hasOwn(repoFacts.declared, name) ? repoFacts.declared[name] : undefined;
  if (!entry || typeof entry !== 'object') {
    return { name, ok: false, declared: false, approved: false, reason: `the repo's ${PROJECT_MCP_FILE} does not declare it` };
  }
  const { approved, reason } = approval(name, repoFacts);
  if (!approved) return { name, ok: false, declared: true, approved: false, reason: `not approved: ${reason}` };
  const secrets = entryCredentials(entry);
  if (secrets.length) {
    return {
      name,
      ok: false,
      declared: true,
      approved: true,
      credentials: secrets,
      reason: `its entry carries ${secrets.join(', ')}, and a team's MCP config files are world-readable`,
    };
  }
  return { name, ok: true, declared: true, approved: true, reason, entry };
}

/**
 * The servers to copy onto one team surface, and a note for each one that was asked for
 * and not given. **The** answer — the lead's tool surface and every build worker's
 * dispatch call this with the same repo and the same list.
 *
 * `allow` is the team's `projectMcpServers`, as stored (a hand-edited `team.json` is
 * re-judged name by name here, and a bad name is a note rather than a throw). `taken` is
 * what the surface already carries — `foreman`, and the forge entry when there is one.
 *
 * @returns {{ servers: Record<string, object>, names: string[], notes: string[] }}
 */
export function resolveProjectMcp({ repo, allow = [], taken = [] }) {
  const list = Array.isArray(allow) ? allow : [];
  if (!list.length) return { servers: {}, names: [], notes: [] };
  const facts = readProjectMcp(repo);
  const notes = facts.problems.map((p) => `Project MCP servers: ${p}.`);
  const busy = new Set(taken);
  const servers = {};
  for (const name of list) {
    const verdict = judge(name, facts, busy);
    if (verdict.ok) {
      servers[name] = verdict.entry;
      busy.add(name);
    } else {
      notes.push(`Project MCP server ${typeof name === 'string' ? `\`${name}\`` : JSON.stringify(name)} is on this team's list and was not copied: ${verdict.reason}.`);
    }
  }
  return { servers, names: Object.keys(servers), notes };
}

/**
 * What one dispatched worker carries. A **build** worker gets the team's servers through
 * `resolveProjectMcp`, exactly as its lead does; every other kind gets none.
 *
 * Written as an allow-list on kind — `build`, and nothing else — rather than "not a
 * planner", because kinds have grown here once already and the next one should start with
 * no project tools until somebody decides otherwise. A planner reads and writes one
 * document behind a stance that walls it off from doing anything else; a tool that builds,
 * runs or drives a simulator has no place on it.
 */
export function workerProjectMcp({ kind, repo, allow = [] }) {
  if (kind !== 'build') return { servers: {}, names: [], notes: [] };
  return resolveProjectMcp({ repo, allow, taken: ['foreman'] });
}

/**
 * What the team panel lists: every server the repo declares, plus any name on the list it
 * no longer declares (so a stale tick can still be taken off). Names and verdicts only —
 * never an entry, since this is served to the browser and an entry is a command line.
 *
 * `available` is "ticking this would put it on the surface" — the same `judge` the launch
 * uses, against the panel's own reserved names. `listed` is whether it is ticked.
 */
export function projectMcpCatalogue(repo, allow = []) {
  const list = Array.isArray(allow) ? allow.filter((n) => typeof n === 'string') : [];
  const facts = readProjectMcp(repo);
  const names = [...new Set([...Object.keys(facts.declared), ...list])].sort();
  const servers = names.map((name) => {
    const v = judge(name, facts, new Set());
    return {
      name,
      listed: list.includes(name),
      declared: v.declared,
      approved: v.approved,
      available: v.ok,
      reason: v.reason,
    };
  });
  return { servers, problems: facts.problems };
}
