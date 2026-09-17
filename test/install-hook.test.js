import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'install-hook.js');

/*
 * The real installer, in a real subprocess, against a real `settings.json` in a throwaway
 * `HOME` — never the maintainer's own file, which is what this thing exists to rewrite.
 * `os.homedir()` reads `$HOME` on POSIX, which is what makes `SETTINGS_PATH` redirectable;
 * the first test proves that rather than trusting it, because every other test here is
 * worthless if the child was pointed at the real file instead.
 *
 * A scratch `FOREMAN_PORT` too: the port is baked into the command the installer writes and
 * into how it recognises its own entry, so a test run against the default would be a test
 * whose fixtures are indistinguishable from the entry on this machine.
 */
const PORT = '48999';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-hook-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return {
    home,
    state: path.join(home, 'state'),
    settings: path.join(home, '.claude', 'settings.json'),
    write: (obj) => fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(obj, null, 2)),
    read: () => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')),
    backups: () =>
      fs.readdirSync(path.join(home, '.claude')).filter((n) => n.startsWith('settings.backup-foreman-')),
  };
}

const install = (box, args = []) =>
  run(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, HOME: box.home, FOREMAN_STATE_DIR: box.state, FOREMAN_PORT: PORT },
  });

/** Our entries in one event's list, by the shape the installer writes. */
const ours = (settings, event = 'Stop') =>
  (settings.hooks?.[event] || []).filter((e) =>
    (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(`:${PORT}/hook`)),
  );

const cmd = (settings, event = 'Stop') => ours(settings, event)[0]?.hooks?.[0]?.command || '';

test('the child really writes into the throwaway HOME, not the real one', async () => {
  const box = sandbox();
  box.write({});
  await install(box);
  assert.ok(fs.existsSync(box.settings));
  assert.equal(ours(box.read()).length, 1, 'if this fails, every test below was aimed at the real file');
});

/* ------------------------------------------------------- the command itself --- */

/**
 * `$TMUX` is `<socket path>,<pid>,<session id>` and `${TMUX%%,*}` is the socket path. A
 * pane id means nothing without it: every tmux server numbers panes from `%0`, so a
 * session on a bench's scratch server posts receipts for panes that belong to somebody
 * else here. Verified in `/bin/sh`, `/bin/bash` and `/bin/zsh`, and empty when `$TMUX` is
 * unset — which the server reads as "not told" and accepts.
 */
test('the registered command sends the tmux socket, and still says its body is JSON', async () => {
  const box = sandbox();
  box.write({});
  await install(box);
  const c = cmd(box.read());

  assert.match(c, /-H "X-Tmux-Socket: \$\{TMUX%%,\*\}"/, 'the socket header, shell-expanded');
  assert.match(c, /-H "X-Tmux-Pane: \$TMUX_PANE"/, 'and the pane it qualifies');
  assert.match(
    c,
    /-H "Content-Type: application\/json"/,
    'regressing this is how every hook the panel was ever sent came to be dropped',
  );
});

test('the socket expansion is the one the shell actually performs', async () => {
  const box = sandbox();
  box.write({});
  await install(box);
  const c = cmd(box.read());
  const expansion = c.match(/X-Tmux-Socket: (\$\{TMUX%%,\*\})"/)[1];

  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    const live = await run(shell, ['-c', `printf %s "${expansion}"`], {
      env: { ...process.env, TMUX: '/private/tmp/tmux-501/default,21056,33' },
    });
    assert.equal(live.stdout, '/private/tmp/tmux-501/default', `${shell} must split $TMUX the same way`);

    const outside = await run(shell, ['-c', `unset TMUX; printf %s "${expansion}"`]);
    assert.equal(outside.stdout, '', `${shell}: outside tmux the header must be blank, not an error`);
  }
});

/* ----------------------------------------------------------- re-installing --- */

/*
 * The installer used to skip any event that already had one of ours, so a fix to the
 * command reached nobody until somebody deleted the entry by hand — and nothing on screen
 * said so. It now replaces its own entry, recognised by the shape it writes.
 */
test('an entry this installer wrote before is replaced, not left behind', async () => {
  const box = sandbox();
  const stale = `curl -s -m 2 -X POST http://127.0.0.1:${PORT}/hook --data-binary @- >/dev/null 2>&1 || true`;
  box.write({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: stale, timeout: 5 }] }] } });

  const { stdout } = await install(box);
  assert.match(stdout, /Updated an existing Foreman hook/);

  const mine = ours(box.read());
  assert.equal(mine.length, 1, 'one entry, not the old one plus a new one beside it');
  assert.match(mine[0].hooks[0].command, /X-Tmux-Socket/);
});

test('a second install with nothing to change rewrites nothing', async () => {
  const box = sandbox();
  box.write({});
  await install(box);
  const first = fs.readFileSync(box.settings, 'utf8');
  const backupsAfterFirst = box.backups().length;

  const { stdout } = await install(box);
  assert.match(stdout, /nothing to do/);
  assert.equal(fs.readFileSync(box.settings, 'utf8'), first, 'byte-identical');
  assert.equal(box.backups().length, backupsAfterFirst, 'and no second backup for a no-op');
});

test('duplicates of our own entry collapse to one', async () => {
  const box = sandbox();
  const stale = `curl http://127.0.0.1:${PORT}/hook`;
  box.write({
    hooks: {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: stale, timeout: 5 }] },
        { matcher: '', hooks: [{ type: 'command', command: `${stale} --twice`, timeout: 5 }] },
      ],
    },
  });
  await install(box);
  assert.equal(ours(box.read()).length, 1);
});

/* ------------------------------------------------- somebody else's hook --- */

/**
 * The rung that matters most is the refusal. A hook pointing anywhere but this panel's own
 * `/hook` is not ours to rewrite, and it must survive both an install and a `--remove`.
 */
test('a hook this installer did not write is left exactly as it was', async () => {
  const box = sandbox();
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'say hello', timeout: 9 }] };
  box.write({ hooks: { Stop: [structuredClone(foreign)] }, model: 'opus' });

  await install(box);
  const after = box.read();
  assert.deepEqual(
    after.hooks.Stop.filter((e) => !ours(after).includes(e)),
    [foreign],
    'untouched, timeout and matcher and all',
  );
  assert.equal(after.model, 'opus', 'and a key this installer has never heard of survives');

  await install(box, ['--remove']);
  assert.deepEqual(box.read().hooks.Stop, [foreign]);
});

/**
 * A hook somebody hand-wrote at *our* endpoint is ours by shape and is replaced — the
 * alternative is matching the command byte for byte, which means the entry we wrote
 * yesterday reads as a stranger's and rots beside the new one. The backup is what makes
 * that recoverable.
 */
test('a hand-edited entry at our own endpoint is replaced, and the previous file is kept', async () => {
  const box = sandbox();
  const edited = `curl -s http://127.0.0.1:${PORT}/hook -H "X-Mine: 1" --data-binary @-`;
  box.write({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: edited, timeout: 30 }] }] } });

  await install(box);
  assert.equal(ours(box.read()).length, 1);
  assert.doesNotMatch(cmd(box.read()), /X-Mine/);

  const baks = box.backups();
  assert.equal(baks.length, 1, 'one backup, taken before the write');
  const kept = JSON.parse(fs.readFileSync(path.join(box.home, '.claude', baks[0]), 'utf8'));
  assert.equal(kept.hooks.Stop[0].hooks[0].command, edited, 'the backup holds what was there before');
});

/*
 * Beside `settings.json`, not the state dir. `install-statusline.js` backs up this same
 * file to this same place and its header says why: one habit, one place to look. Pinned
 * here so the two installers cannot drift apart silently.
 */
test('the backup lands beside settings.json', async () => {
  const box = sandbox();
  box.write({ hooks: {} });
  await install(box);

  assert.equal(box.backups().length, 1);
  assert.deepEqual(
    fs.existsSync(box.state) ? fs.readdirSync(box.state) : [],
    [],
    'and nothing is written to the state dir',
  );
});

test('a machine with no settings file at all gets one, and no backup of nothing', async () => {
  const box = sandbox();
  fs.rmSync(path.join(box.home, '.claude'), { recursive: true, force: true });
  await install(box);
  assert.equal(ours(box.read()).length, 1);
  assert.deepEqual(box.backups(), []);
});

/* ------------------------------------------------------------ every event --- */

test('every event the panel listens for gets exactly one entry', async () => {
  const box = sandbox();
  box.write({});
  await install(box);
  const settings = box.read();
  const events = Object.keys(settings.hooks);
  assert.ok(events.length >= 8, `expected the full event list, got ${events.join(', ')}`);
  for (const event of events) assert.equal(ours(settings, event).length, 1, event);
});
