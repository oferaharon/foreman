import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME, USER_CLAUDE_CONFIG } from './config.js';

const run = promisify(execFile);

/**
 * Which forge a repo lives on — **derived from that repo's own `origin`**, never a
 * setting, never a stored token.
 *
 * The maintainer's rulings, both load-bearing here: a control the user cannot answer
 * correctly should not be a control (2026-08-26, so this is detected and shown read-only,
 * exactly like `setup-detect.js`), and never store a forge token (2026-08-30, so the only
 * thing this ever asks is *what is already installed*).
 *
 * Because it is per repo, two forges coexist with nothing new: team config and the lead's
 * `mcp.json` are already written per repo, so one project can be on GitHub while every
 * other stays on a self-hosted Gitea, and each lead only ever sees the one its own repo
 * needs.
 *
 * **Detection is two independent questions, and the answer is a pair.** They are separate
 * because the obvious single question — "does the remote's host match the registered MCP
 * server's URL?" — is not a detector at all: measured on this Mac, the Gitea remote and
 * the Gitea MCP server share an IP by coincidence and differ in port, and a forge MCP
 * server need not live on the same host as the git remote in the first place.
 *
 *   1. **What does `origin` point at?** `github.com` → GitHub; any other host → a
 *      self-hosted forge; no `origin` at all → nothing.
 *   2. **Is tooling for it on this machine?** `gh` on `PATH` (preferred — its credential
 *      lives in the keychain, never in a config file) or a registered `github` MCP server;
 *      a registered `gitea` MCP server for the self-hosted case.
 *
 * A pair of yes/no gives four readings, and these four words are the maintainer's ruled
 * vocabulary (2026-08-31, Q9) — they are what the panel shows and what the README says:
 *
 *   `GitHub`      origin is github.com and there are tools for it
 *   `Gitea`       origin is elsewhere and the gitea MCP server is registered
 *   `push only`   a remote exists, no tools for it — GitLab, Bitbucket, Forgejo, anything
 *                 else. Named for what you *can* do; `no remote` would be a lie the
 *                 pushed branch contradicts.
 *   `no remote`   no origin. Workers still branch, commit and stop there.
 *
 * **What this deliberately does not do.** It does not ask the forge anything — no network,
 * no auth check, no `gh auth status` (which talks to github.com and would put a round trip
 * on the panel's paint path). Presence of the tooling is the whole test; a `gh` that is
 * installed but logged out reads as `GitHub` and fails later, loudly, in the lead's own
 * hands. And a host-based rule cannot tell GitHub Enterprise from Gitea: a self-hosted
 * GitHub with a gitea MCP registered reads `Gitea`. Both are the documented limits of
 * detecting instead of asking, and both fail towards "the lead tries a tool and is told
 * no", never towards a silent wrong merge.
 */

/** The four readings. The words are ruled; nothing may spell them differently. */
export const READINGS = {
  github: 'GitHub',
  gitea: 'Gitea',
  push: 'push only',
  none: 'no remote',
};

/**
 * The host out of a git remote URL, lowercased and without its port, or `null` when the
 * remote names no host at all (a local path — `git clone /some/repo` — or an unparseable
 * string).
 *
 * Both spellings, because git accepts both and a repo cloned over SSH is the common one:
 *   `https://host/o/r.git`, `http://host:3002/o/r.git`, `ssh://git@host:22/o/r.git`
 *   `git@host:o/r.git` — scp-like, no scheme, and `URL` cannot parse it
 */
export function remoteHost(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  // scp-like: `user@host:path`, distinguished from a URL by having no `://` and by the
  // colon being followed by a path rather than a port. `git@host:22/o/r` is not valid
  // scp-like syntax, so a numeric tail is still a path here.
  if (!raw.includes('://')) {
    const m = /^(?:[^@/]+@)?([^/:]+):(?!\/)/.exec(raw);
    return m ? m[1].toLowerCase() : null;
  }

  try {
    const { hostname } = new URL(raw);
    return hostname ? hostname.toLowerCase() : null; // `file:///path` has none
  } catch {
    return null;
  }
}

/** github.com and its `www.` spelling. Nothing else — Enterprise is self-hosted. */
const isGitHubHost = (host) => host === 'github.com' || host === 'www.github.com';

/**
 * Public forges that are **not** GitHub and are **not** Gitea, by name.
 *
 * Without this list the rule "any non-GitHub host is a self-hosted forge" makes a
 * `gitlab.com` repo read `Gitea` on any Mac with a gitea MCP server registered — which is
 * this one, and which is the *exact case* the maintainer's `push only` ruling was written
 * for ("this Mac for any GitLab or Bitbucket repo"). Found on the bench, not by reasoning:
 * the panel confidently labelled a GitLab remote `Gitea` and handed its lead the gitea
 * tools.
 *
 * `codeberg.org` is here because it runs **Forgejo**, the Gitea fork, and nobody has tried
 * Forgejo against this code. Its API is close and it may well work — which is exactly why
 * it must not be *implied* to work. `push only` until somebody actually runs it.
 *
 * The honest limit, and it is the same one GitHub Enterprise has: a **self-hosted** GitLab
 * at `gitlab.mycompany.com` is indistinguishable by host from a self-hosted Gitea, so it
 * still reads `Gitea` and the lead's first gitea tool call fails. A host list cannot fix
 * that; only asking the forge could, and asking costs a network round trip on the paint
 * path. It fails loudly in the lead's hands rather than quietly anywhere.
 */
const NOT_GITEA_HOSTS = new Set([
  'gitlab.com',
  'www.gitlab.com',
  'bitbucket.org',
  'www.bitbucket.org',
  'codeberg.org',
  'git.sr.ht',
  'sourceforge.net',
]);

/**
 * The pair → one of the four readings. Pure, so the table is testable without a repo.
 *
 * @param {{remote: string|null, host: string|null, tools: {gh?: boolean, githubMcp?: boolean, giteaMcp?: boolean}}} pair
 * @returns {{reading: string, forge: 'github'|'gitea'|null, via: 'gh'|'mcp'|null, host: string|null, reason: string}}
 */
export function readingFor({ remote = null, host = null, tools = {} } = {}) {
  if (!remote) {
    return {
      reading: READINGS.none,
      forge: null,
      via: null,
      host: null,
      reason: 'this checkout has no origin remote',
    };
  }

  if (isGitHubHost(host)) {
    // `gh` first, and the preference is a security one rather than a taste: its login
    // lives in the keychain, while the standard GitHub MCP server carries a
    // `GITHUB_PERSONAL_ACCESS_TOKEN` in its `env` — and this panel copies a chosen MCP
    // entry into a world-readable `mcp.json` (see `credentialKeys` below).
    if (tools.gh) {
      return { reading: READINGS.github, forge: 'github', via: 'gh', host, reason: 'origin is on github.com, and `gh` is installed' };
    }
    if (tools.githubMcp) {
      return { reading: READINGS.github, forge: 'github', via: 'mcp', host, reason: 'origin is on github.com, and a `github` MCP server is registered' };
    }
    return {
      reading: READINGS.push,
      forge: null,
      via: null,
      host,
      reason: 'origin is on github.com, but neither `gh` nor a `github` MCP server is installed',
    };
  }

  // A public forge we know is neither GitHub nor Gitea. Naming it is worth a sentence the
  // reader can act on — and stops a registered gitea server from claiming it.
  if (NOT_GITEA_HOSTS.has(host)) {
    return {
      reading: READINGS.push,
      forge: null,
      via: null,
      host,
      reason: `origin is on ${host}, which has no PR support here — only GitHub and Gitea do`,
    };
  }

  // Any other host — and also a remote with no host at all, which is a local path or a
  // spelling this parser did not recognise. Both are honestly `push only` when there are
  // no tools: something is configured that a branch can be pushed to.
  if (tools.giteaMcp) {
    return {
      reading: READINGS.gitea,
      forge: 'gitea',
      via: 'mcp',
      host,
      reason: host
        ? `origin is on ${host}, and a \`gitea\` MCP server is registered`
        : 'origin is a local path, and a `gitea` MCP server is registered',
    };
  }
  return {
    reading: READINGS.push,
    forge: null,
    via: null,
    host,
    reason: host ? `origin is on ${host}, and no tools for it are installed` : 'origin is a local path with no forge tools',
  };
}

/**
 * Is `gh` on the PATH a launched session would have?
 *
 * Not `which gh` — this runs on the paint path and a subprocess per GET is exactly the
 * cost `setup-detect.js`'s header refuses. And not `process.env.PATH` alone either: the
 * panel runs under launchd, whose PATH is `/usr/bin:/bin:/usr/sbin:/sbin` plus whatever
 * `install-agent.js` injected — while the session that will actually *run* `gh` is a
 * login shell (`zsh -ilc`) that sources `~/.zshrc`. So the usual install directories are
 * checked too, and the question this answers is "does this Mac have gh", not "can this
 * process spawn it".
 */
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin')];

export function onPath(program, { pathValue = process.env.PATH || '', extra = EXTRA_BIN_DIRS } = {}) {
  const dirs = [...pathValue.split(path.delimiter).filter(Boolean), ...extra];
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, program), fs.constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/**
 * Keys in an MCP entry's `env` that look like a credential.
 *
 * `<teamDir>/mcp.json` is written with the default umask — `-rw-r--r--` on this Mac — and
 * the panel copies the user's registered entry into it verbatim. The maintainer's own Gitea
 * entry is `{type, url}` with no credential (the token lives in the MCP server process on
 * the Gitea box), so they are safe by luck; the standard GitHub MCP server is not like that.
 * Copying such an entry would write a personal access token world-readable into the team
 * folder — by the feature whose ruling says never store a token. So the entry is refused,
 * and the launch says so out loud rather than quietly dropping a tool.
 */
export function credentialKeys(env) {
  if (!env || typeof env !== 'object') return [];
  return Object.entries(env)
    .filter(([key, value]) => /token|secret|password|passwd|api[_-]?key|\bkey\b|credential/i.test(key) && String(value ?? '').trim())
    .map(([key]) => key);
}

/** `git remote get-url origin`, or null. No network: it reads `.git/config`. */
async function readRemote(repo) {
  try {
    const { stdout } = await run('git', ['-C', repo, 'remote', 'get-url', 'origin']);
    return stdout.trim() || null;
  } catch {
    return null; // no origin, or not a git repo at all
  }
}

/** What is registered in `~/.claude.json`. Read, never written — same as the lead launch. */
async function readUserMcp() {
  try {
    const cfg = JSON.parse(await fsp.readFile(USER_CLAUDE_CONFIG, 'utf8'));
    return cfg?.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  } catch {
    return {};
  }
}

/**
 * The pair, answered for one repo. `deps` is the test seam — every outside read arrives
 * through it, so the table above can be exercised without a git repo or a home directory.
 */
export async function detectForge(repo, deps = {}) {
  const { remote: getRemote = readRemote, mcp: getMcp = readUserMcp, hasGh = () => onPath('gh') } = deps;
  const [remote, servers] = await Promise.all([getRemote(repo), getMcp()]);
  const tools = {
    gh: Boolean(hasGh()),
    githubMcp: Boolean(servers?.github),
    giteaMcp: Boolean(servers?.gitea),
  };
  return { ...readingFor({ remote, host: remoteHost(remote), tools }), remote, tools };
}

/**
 * Cached per repo, because `GET /api/team/config` is on the paint path.
 *
 * `setup-detect.js` is synchronous and its header promises "one readdir, no network, no
 * shelling out". This one *does* shell out — `git remote get-url` reads `.git/config`, so
 * it costs a process rather than a request, but it costs a process — so it is async and it
 * remembers its answer. That comment is edited rather than copied on purpose: pasting
 * setup-detect's would ship a lie about this module's own cost.
 *
 * Short, not forever: an `origin` can be added, and a `gh` can be installed, while the
 * panel is running. A minute of staleness on a read-only line is cheaper than a git
 * process per roster beat.
 */
const cache = new Map(); // repo -> { at, value }
const TTL_MS = 60_000;

export async function resolveForge(repo, deps = {}) {
  const key = String(repo || '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS && !deps.fresh) return hit.value;
  const value = await detectForge(repo, deps);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test seam, and the boot path's way of not inheriting another run's answers. */
export function resetForgeCache() {
  cache.clear();
}
