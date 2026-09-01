import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';

/**
 * The slash commands a session will actually accept.
 *
 * Three sources, because there is no single place that lists them:
 *
 *   built-ins  read out of the installed CLI itself, so the list tracks whatever
 *              version is on this machine instead of rotting in a hardcoded array
 *   plugins    `~/.claude/plugins/**\/commands/*.md`
 *   skills     any `SKILL.md`, which Claude Code exposes as `/name`
 *   user/project  `~/.claude/commands` and `<cwd>/.claude/commands`
 *
 * The alternative — typing `/` into a live pane and scraping the popup — would clobber
 * whatever the user had half-typed there. Not worth it for a convenience feature.
 */

const CLI_CANDIDATES = [
  '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  path.join(HOME, '.claude/local/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
];

/**
 * Commands are declared as object literals whose fields come in no fixed order —
 * `name` and `description` may be adjacent or separated by other properties. So anchor
 * on the name and search a bounded window after it rather than demanding a rigid shape.
 */
const NAME_RE = /type:"(?:local|local-jsx|prompt)",name:"([a-z0-9][a-z0-9-]{1,24})"/g;
const WINDOW = 400;

function extractBuiltins(source) {
  const found = new Map();

  for (const m of source.matchAll(NAME_RE)) {
    const name = m[1];
    if (found.has(name)) continue;

    const tail = source.slice(m.index, m.index + WINDOW);
    // Stop at the next declaration so we can't borrow its description.
    const nextDecl = tail.slice(1).search(/type:"(?:local|local-jsx|prompt)",name:"/);
    const scope = nextDecl === -1 ? tail : tail.slice(0, nextDecl + 1);

    // Most declare a plain string; a few use `get description(){ return ... }`, often
    // with a feature-flag ternary. The first literal in the getter is close enough.
    const desc =
      /description:"((?:[^"\\]|\\.){3,200})"/.exec(scope)?.[1] ??
      /get description\(\)\{[^}]*?"((?:[^"\\]|\\.){3,200})"/.exec(scope)?.[1];
    if (!desc) continue;

    found.set(name, {
      name,
      description: unescapeJs(desc),
      argumentHint: /argumentHint:"((?:[^"\\]|\\.)*)"/.exec(scope)?.[1] || null,
      source: 'built-in',
    });
  }
  return [...found.values()];
}

function unescapeJs(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\(.)/g, '$1');
}

let builtinCache = null;

async function builtins() {
  const file = CLI_CANDIDATES.find((p) => fsSync.existsSync(p));
  if (!file) return [];

  const { mtimeMs } = await fs.stat(file);
  if (builtinCache?.mtimeMs === mtimeMs) return builtinCache.commands;

  // latin-1 keeps byte offsets honest while scanning a binary for ASCII declarations.
  const source = (await fs.readFile(file)).toString('latin1');
  const commands = extractBuiltins(source);
  builtinCache = { mtimeMs, commands };
  return commands;
}

/** `--- \n name: x \n description: y \n ---` at the top of a markdown file. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

async function fromMarkdownDir(dir, source, namePrefix = '') {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    if (!file.endsWith('.md')) continue;
    const stem = file.replace(/\.md$/, '');
    let fm = {};
    try {
      fm = frontmatter(await fs.readFile(path.join(dir, file), 'utf8'));
    } catch {
      /* unreadable — still worth offering the name */
    }
    out.push({
      name: `${namePrefix}${fm.name || stem}`,
      description: fm.description || '',
      argumentHint: fm['argument-hint'] || null,
      source,
    });
  }
  return out;
}

async function pluginCommands() {
  const root = path.join(HOME, '.claude/plugins');
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'commands') out.push(...(await fromMarkdownDir(full, 'plugin')));
      else await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

async function skillCommands() {
  const roots = [path.join(HOME, '.claude/skills'), path.join(HOME, '.claude/plugins')];
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 7) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.name === 'SKILL.md') {
        try {
          const fm = frontmatter(await fs.readFile(full, 'utf8'));
          if (fm.name) {
            out.push({
              name: fm.name,
              description: (fm.description || '').split('.')[0].slice(0, 140),
              argumentHint: null,
              source: 'skill',
            });
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  for (const r of roots) await walk(r, 0);
  return out;
}

let cache = { at: 0, byCwd: new Map() };
const TTL_MS = 60_000;

/** Every command offered in this working directory, de-duplicated, name-sorted. */
export async function listCommands(cwd) {
  if (Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), byCwd: new Map() };
  const key = cwd || '';
  if (cache.byCwd.has(key)) return cache.byCwd.get(key);

  const [b, p, s, user, project] = await Promise.all([
    builtins(),
    pluginCommands(),
    skillCommands(),
    fromMarkdownDir(path.join(HOME, '.claude/commands'), 'user'),
    cwd ? fromMarkdownDir(path.join(cwd, '.claude/commands'), 'project') : [],
  ]);

  // Closest wins: a project command shadows a plugin one of the same name.
  const merged = new Map();
  for (const c of [...b, ...s, ...p, ...user, ...project]) merged.set(c.name, c);

  const list = [...merged.values()].sort((x, y) => x.name.localeCompare(y.name));
  cache.byCwd.set(key, list);
  return list;
}
