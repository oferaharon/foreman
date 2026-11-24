import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * `GET /api/accounts/install` and `POST /api/accounts/:key/install` against a real scratch
 * panel: a throwaway `HOME` (so the default config dir is a scratch one), a scratch state
 * dir whose `accounts.json` already names a second config dir, a scratch port, a scratch
 * tmux dir with no server in it, and scratch log paths so the boot's log trim touches
 * nothing real. No session runs; the panel only reads and writes the two settings files.
 *
 * What it proves is the half of the endpoint that is not `account-install.js`'s own tests:
 * that the route takes the dir **from the panel's list** and refuses every way of naming
 * one — an index off the end, a path in the key (encoded or not), a path in the body —
 * without writing anything, and that a good key writes into that dir alone.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let child;
let port;
let home;
let stateDir;
let second;
let tmuxDir;

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port: p } = probe.address();
  await new Promise((r) => probe.close(r));
  return p;
}

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-acct-api-'));
  tmuxDir = fs.mkdtempSync('/tmp/foreman-acct-');
  stateDir = path.join(home, 'state');
  second = path.join(home, '.claude-beta');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n');
  fs.writeFileSync(path.join(second, 'settings.json'), '{\n  "theme": "light"\n}\n');
  fs.writeFileSync(path.join(stateDir, 'accounts.json'), JSON.stringify({ dirs: [second] }));

  port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    TMUX_TMPDIR: tmuxDir,
    FOREMAN_PORT: String(port),
    FOREMAN_HOST: '127.0.0.1',
    FOREMAN_STATE_DIR: stateDir,
    FOREMAN_AGENT_LABEL: 'dev.foreman.account-install-api-test',
    FOREMAN_LOG_DIR: path.join(stateDir, 'logs'),
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });
  process.on('exit', () => child.kill());
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/accounts/install`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('scratch panel did not come up');
});

test.after(async () => {
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    });
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tmuxDir, { recursive: true, force: true });
});

test('the rows are the known list, default first, each read off its own file', async () => {
  const { status, body } = await api('GET', '/api/accounts/install');
  assert.equal(status, 200);
  assert.equal(body.dirs.length, 2);
  assert.deepEqual(body.dirs.map((d) => [d.key, d.isDefault, d.hook, d.statusLine]), [
    [0, true, 'missing', 'missing'],
    [1, false, 'missing', 'missing'],
  ]);
  assert.equal(body.dirs[1].configDir, '~/.claude-beta');
});

test('every way of naming a folder is refused, and nothing is written', async () => {
  const files = [path.join(home, '.claude', 'settings.json'), path.join(second, 'settings.json')];
  const before = files.map(hash);
  const evil = path.join(home, 'evil');
  for (const [route, body, want] of [
    ['/api/accounts/2/install', undefined, 404],
    ['/api/accounts/99/install', undefined, 404],
    ['/api/accounts/-1/install', undefined, 400],
    [`/api/accounts/${encodeURIComponent(evil)}/install`, undefined, 400],
    ['/api/accounts/..%2F..%2Fevil/install', undefined, 400],
    ['/api/accounts/~%2F.claude-beta/install', undefined, 400],
    ['/api/accounts/1/install', { configDir: evil }, 400],
    ['/api/accounts/1/install', { settingsPath: path.join(evil, 'settings.json') }, 400],
  ]) {
    const res = await api('POST', route, body);
    assert.equal(res.status, want, `${route} ${JSON.stringify(body)} → ${res.status} ${res.body.error}`);
  }
  assert.deepEqual(files.map(hash), before);
  assert.ok(!fs.existsSync(evil));
  assert.ok(!fs.readdirSync(stateDir).some((n) => n.startsWith('statusline')), 'no wrapper written');
});

test('a good key installs into that dir alone, backed up beside it, and a second press changes nothing', async () => {
  const mainFile = path.join(home, '.claude', 'settings.json');
  const mainBefore = hash(mainFile);
  const res = await api('POST', '/api/accounts/1/install');
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.changed, true);
  assert.deepEqual([res.body.row.hook, res.body.row.statusLine], ['installed', 'wrapped']);
  assert.match(res.body.backup, /^~\/\.claude-beta\/settings\.backup-foreman-\d+\.json$/);

  const written = JSON.parse(fs.readFileSync(path.join(second, 'settings.json'), 'utf8'));
  assert.equal(written.theme, 'light');
  assert.ok(written.hooks.Stop[0].hooks[0].command.includes(`:${port}/hook`));
  assert.ok(written.statusLine.command.includes('statusline-wrapper-claude-beta.sh'));
  assert.equal(hash(mainFile), mainBefore, 'the default account’s file is untouched');

  const after = hash(path.join(second, 'settings.json'));
  const again = await api('POST', '/api/accounts/1/install');
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal(hash(path.join(second, 'settings.json')), after);
  const backups = fs.readdirSync(second).filter((n) => n.startsWith('settings.backup-foreman-'));
  assert.equal(backups.length, 1);
});
