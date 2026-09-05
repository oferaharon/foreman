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
 * spawn the installer that already exists; `logs` prints what `logs.js` resolved. The
 * only judgement in the file is which advice to print, and that comes from
 * `server/homebrew.js`.
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
  ['serve', 'run the panel in this process (what the service runs; the twin of `npm start`)'],
  ['start', 'start the background service'],
  ['stop', 'stop the background service'],
  ['restart', 'restart the background service — do this after `brew upgrade`'],
  ['install-hook', "register the status hook in ~/.claude/settings.json (once, per machine)"],
  ['uninstall-hook', 'remove it again'],
  ['install-statusline', 'wrap the status line so the panel sees the rate-limit numbers'],
  ['uninstall-statusline', 'put the original status line back'],
  ['logs', 'print the two log paths this panel is actually using'],
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
