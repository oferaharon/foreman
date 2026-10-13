#!/usr/bin/env node
/**
 * `foreman-panel` — the panel's command surface for anyone who does not have a checkout.
 *
 * `package.json`'s scripts are the whole of that surface today, and `npm run <script>`
 * needs a `package.json` in the working directory. Homebrew installs a *package*, not a
 * project, so the commands have to become a binary — and declaring it here, in the
 * repository that owns the entry points, is what lets a formula find them:
 * `std_npm_args(prefix: libexec)` creates `libexec/bin/*` **only** from the package's own
 * `bin` field, so without this file a formula would have to hand-write a shell script
 * that hardcodes an interpreter and a path, in another repository, in another language.
 *
 * Nothing here re-implements anything. `serve` is one dynamic import; the hook commands
 * spawn the installer that already exists; `logs` prints what `logs.js` resolved; `setup`
 * is the order those commands go in, and it lives in `server/setup-command.js`. The
 * only judgement in the file is which advice to print, and that comes from
 * `server/homebrew.js`.
 *
 * Every import past `homebrew.js` is deliberately dynamic and inside its own `case`, so
 * printing help costs one small module and reads nothing else on disk.
 *
 * ## Two things that would each be a bug
 *
 * **`server/install-hook.js` runs on import.** It calls `install()` / `remove()` at module
 * scope with no `invokedDirectly()` guard — unlike `install-agent.js`, which grew one so
 * its `jobEnvironment` could be tested. So the hook subcommands **spawn** it as a child.
 * Imported, `foreman-panel --help` would register a hook in `~/.claude/settings.json`.
 *
 * **`restart` is `brew services restart`, never `launchctl kickstart -k`.** This project's
 * most-repeated launchd finding is that `kickstart` does not re-read the plist, which is
 * why `npm run restart-panel` and `npm run install-agent` are not interchangeable. Under
 * Homebrew that distinction collapses in the other direction: `brew services restart` is
 * `stop` then `start`, and `start` regenerates the plist from the formula. Reaching for
 * `kickstart` here would reintroduce the exact trap on the one path where Homebrew had
 * already solved it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORMULA, brewBinary, panelIsHomebrew } from '../server/homebrew.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server');

/** One row per subcommand: the help text is generated from this, so it cannot drift. */
const COMMANDS = [
  ['setup', 'the one command after `brew install`: hook, status line, service, open it'],
  ['serve', 'run the panel in this process (what the service runs; the twin of `npm start`)'],
  ['start', 'start the background service'],
  ['stop', 'stop the background service'],
  ['restart', 'restart the background service — do this after `brew upgrade`'],
  ['install-hook', "register the status hook in ~/.claude/settings.json (once, per machine)"],
  ['uninstall-hook', 'remove it again'],
  ['install-statusline', 'wrap the status line so the panel sees the rate-limit numbers'],
  ['uninstall-statusline', 'put the original status line back'],
  ['logs', 'print the two log paths this panel is actually using'],
  ['bots', 'register a headless deployment (`bots add|remove|list`); `bots` alone says more'],
  ['version', 'print the version'],
];

/**
 * What to say when a service verb is typed from a checkout.
 *
 * These are the in-repo commands, unchanged and still the right ones there — the point is
 * only that this binary is not how you drive them. `install-agent` is the "start" because
 * it is what writes the plist and bootstraps the job; there is no `start-panel` script and
 * `npm start` is the scratch server, which is a different thing entirely.
 */
const NPM_EQUIVALENT = {
  start: 'npm run install-agent',
  stop: 'npm run stop-panel',
  restart: 'npm run restart-panel',
};

function usage() {
  const width = Math.max(...COMMANDS.map(([name]) => name.length)) + 2;
  const lines = [
    `${FORMULA} — one local web panel for every Claude Code session on this Mac.`,
    '',
    `Usage: ${FORMULA} <command>`,
    '',
    ...COMMANDS.map(([name, what]) => `  ${name.padEnd(width)}${what}`),
    '',
    `  ${'--help'.padEnd(width)}this`,
    '',
  ];
  return lines.join('\n');
}

/** Run a child to completion and exit with whatever it exited with. Never resolves. */
function passThrough(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`${FORMULA}: could not run ${command} (${err.code || err.message})`);
    process.exit(1);
  });
  // A signal death is not an exit code. Report it as a failure rather than as 0, which is
  // what `code ?? 1` would otherwise quietly become.
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
}

const BOTS_USAGE = [
  `Usage: ${FORMULA} bots <command>`,
  '',
  '  add <id> [--name "…"]   register a headless deployment and print its token, once',
  '  remove <id>             revoke its token; the copies stay until they age out',
  '  list                    the registered bots (never a token)',
  '',
  'An id is lowercase letters, digits and dashes, starting with a letter, up to 32 characters.',
  '',
].join('\n');

/**
 * `bots add|remove|list` — the registry of headless deployments, `<STATE_DIR>/bots.json`.
 *
 * The store is opened with `copies: false`: the registry and nothing else — no index load,
 * no timers, no retention run — so a registration typed into a terminal never touches the
 * copies a running panel is writing. That panel needs no restart: it re-reads `bots.json`
 * when the file changes, at the next request a helper makes.
 *
 * `add` prints the three env lines on **stdout** and everything a human reads on stderr, so
 * `bots add <id> > bot.env` leaves a file holding exactly what the deployment needs and the
 * token never has to be copied out of a scrollback. It is printed this once: the panel keeps
 * only its sha256.
 */
async function bots(args) {
  const { BotStore } = await import('../server/bots.js');
  const { PORT, STATE_DIR, BOT_RETENTION_DAYS } = await import('../server/config.js');
  const [verb, ...rest] = args;

  const refuse = (message) => {
    console.error(`${FORMULA} bots: ${message}`);
    return 1;
  };

  switch (verb) {
    case 'add': {
      let id = null;
      let name;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '--name') {
          if (i + 1 >= rest.length) return refuse('--name needs a value');
          name = rest[++i];
        } else if (arg.startsWith('--name=')) {
          name = arg.slice('--name='.length);
        } else if (arg.startsWith('-')) {
          return refuse(`unknown option ${arg}`);
        } else if (id === null) {
          id = arg;
        } else {
          return refuse(`one id at a time (got "${id}" and "${arg}")`);
        }
      }
      if (id === null) return refuse('add needs an id: bots add <id> [--name "…"]');
      let bot;
      try {
        bot = new BotStore({ copies: false }).register(id, { name });
      } catch (err) {
        if (err.code === 'EEXIST') return refuse(`${err.message}. Its token is not shown again: \`bots remove ${id}\`, then add it again for a new one.`);
        return refuse(err.message);
      }
      console.error(`Registered bot ${bot.id}${bot.name !== bot.id ? ` ("${bot.name}")` : ''}.`);
      console.error('Put these three lines in the deployment\'s environment — an env file or a secret');
      console.error('store, never the image. The token is shown this once; the panel keeps only its hash.');
      console.error('');
      // A real address rather than a `<placeholder>`: the file is meant to be loaded, and a
      // shell reads `<` as a redirect and an apostrophe as an open quote. This one is right
      // for the commonest case, and anywhere it is wrong `--check` says "unreachable".
      console.log(`FOREMAN_URL=http://host.docker.internal:${PORT}`);
      console.log(`FOREMAN_BOT=${bot.id}`);
      console.log(`FOREMAN_BOT_TOKEN=${bot.token}`);
      console.error('');
      console.error('FOREMAN_URL is the panel as the deployment reaches it. As printed, it is right for a');
      console.error('Docker Desktop container on this Mac; from anywhere else, replace host.docker.internal');
      console.error('with an address of this Mac that the deployment can reach. Then set FOREMAN_WATCH and');
      console.error('run `node foreman-helper.mjs --check` there. A running panel needs no restart.');
      return 0;
    }

    case 'remove': {
      if (rest.length !== 1) return refuse('remove takes exactly one id: bots remove <id>');
      const [id] = rest;
      let removed;
      try {
        removed = new BotStore({ copies: false }).unregister(id);
      } catch (err) {
        return refuse(err.message);
      }
      if (!removed) return refuse(`no bot "${id}" is registered`);
      console.log(`Removed bot ${id}. A running panel refuses its token within a couple of seconds.`);
      console.log(`Its copies stay in ${path.join(STATE_DIR, 'bots', id)} until they age out,`);
      console.log(`${BOT_RETENTION_DAYS} days after each conversation's last record.`);
      return 0;
    }

    case 'list': {
      if (rest.length) return refuse('list takes no arguments');
      const all = new BotStore({ copies: false }).registered();
      if (!all.length) {
        console.log(`No bots are registered. \`${FORMULA} bots add <id>\` registers one.`);
        return 0;
      }
      const width = Math.max(...all.map((b) => b.id.length)) + 2;
      for (const b of all) {
        // This Mac's own calendar date, not UTC's — it is the day somebody here typed `add`.
        const d = b.createdAt ? new Date(b.createdAt) : null;
        const when = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : 'unknown';
        console.log(`${b.id.padEnd(width)}registered ${when}${b.name !== b.id ? `  "${b.name}"` : ''}`);
      }
      return 0;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(BOTS_USAGE);
      return 0;

    default:
      console.error(`${FORMULA} bots: unknown command "${verb}"`);
      console.error('');
      console.error(BOTS_USAGE);
      return 1;
  }
}

function services(verb) {
  if (!panelIsHomebrew()) {
    console.error(`${FORMULA} ${verb} drives the Homebrew service, and this is not a Homebrew install.`);
    console.error(`From a checkout:  ${NPM_EQUIVALENT[verb]}`);
    process.exit(1);
  }
  passThrough(brewBinary(), ['services', verb, FORMULA]);
}

const [, , command, ...rest] = process.argv;

switch (command) {
  // The one command after `brew install`. Its body is `server/setup-command.js`, which
  // spawns the same installers the subcommands below spawn — this is the order, not a
  // second implementation. Imported rather than spawned because, unlike `install-hook.js`,
  // it does nothing at import: `runSetup` is a function and the module has no bottom.
  case 'setup': {
    const { runSetup } = await import('../server/setup-command.js');
    process.exit(await runSetup());
    break;
  }

  case 'serve':
    // One import and nothing else. Everything a boot does — the port probe, the log
    // rotation, the config seed, the listen — belongs to `index.js` and stays there.
    await import('../server/index.js');
    break;

  case 'install-hook':
  case 'uninstall-hook':
    passThrough(process.execPath, [
      path.join(SERVER, 'install-hook.js'),
      ...(command === 'uninstall-hook' ? ['--remove'] : []),
      ...rest,
    ]);
    break;

  // `install-statusline.js` has the `invokedDirectly()` guard its sibling lacks, so
  // importing it would be safe — it is spawned anyway, because a refusal there exits
  // non-zero and `passThrough` is what turns a child's exit code into this one's.
  case 'install-statusline':
  case 'uninstall-statusline':
    passThrough(process.execPath, [
      path.join(SERVER, 'install-statusline.js'),
      ...(command === 'uninstall-statusline' ? ['--remove'] : []),
      ...rest,
    ]);
    break;

  case 'start':
  case 'stop':
  case 'restart':
    services(command);
    break;

  case 'logs': {
    // The two paths and nothing else, so it composes: `tail -f $(foreman-panel logs)`.
    // This is the one-look check that the service definition and the process agree about
    // where output goes — the whole reason `FOREMAN_LOG_DIR` exists.
    const { LOG_OUT, LOG_ERR } = await import('../server/logs.js');
    console.log(LOG_OUT);
    console.log(LOG_ERR);
    break;
  }

  case 'bots':
    process.exit(await bots(rest));
    break;

  case 'version':
  case '--version':
  case '-v': {
    const { VERSION } = await import('../server/config.js');
    console.log(VERSION);
    break;
  }

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(usage());
    break;

  default:
    console.error(`${FORMULA}: unknown command "${command}"`);
    console.error('');
    console.error(usage());
    process.exit(1);
}
