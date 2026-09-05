import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readPeer, listPeers, guessTmuxSession } from '../server/peers.js';
import { SESSION_PREFIX } from '../server/config.js';

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-peers-'));

function write(pid, contents) {
  fs.writeFileSync(path.join(dir, `${pid}.json`), contents);
}

write(
  '111',
  JSON.stringify({
    pid: 111,
    sessionId: 'session-alpha',
    cwd: '/Users/x/Code/alpha',
    name: 'alpha',
    nameSource: 'user',
    tmux: 'foreman-alpha:@3.%42',
  }),
);

write('222', '{ this is not json');

write(
  '333',
  JSON.stringify({
    pid: 333,
    sessionId: 'session-beta',
    cwd: '/Users/x/Code/beta',
    name: 'beta',
    nameSource: 'derived',
    // no tmux field at all
  }),
);

// A key file that must never be mistaken for a registry entry.
fs.writeFileSync(path.join(dir, '111.abc123.key'), JSON.stringify({ peerToken: 'x'.repeat(32) }));

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a full entry resolves, with the pane id split out of tmux', () => {
  const peer = readPeer(111, dir);
  assert.deepEqual(peer, {
    pid: 111,
    name: 'alpha',
    nameSource: 'user',
    tmuxSession: 'foreman-alpha',
    paneId: '%42',
    cwd: '/Users/x/Code/alpha',
    sessionId: 'session-alpha',
  });
});

test('a missing file returns null', () => {
  assert.equal(readPeer(999, dir), null);
});

test('a malformed file returns null rather than throwing', () => {
  assert.doesNotThrow(() => readPeer(222, dir));
  assert.equal(readPeer(222, dir), null);
});

test('an entry with no tmux field keeps the name but yields a null paneId', () => {
  const peer = readPeer(333, dir);
  assert.equal(peer.name, 'beta');
  assert.equal(peer.tmuxSession, null);
  assert.equal(peer.paneId, null);
});

test('an absent directory fails closed for both readers', () => {
  const nowhere = path.join(dir, 'does-not-exist');
  assert.equal(readPeer(111, nowhere), null);
  assert.deepEqual(listPeers(nowhere), []);
});

test('listPeers returns every readable entry and skips key files and junk', () => {
  const peers = listPeers(dir);
  const names = peers.map((p) => p.name).sort();
  assert.deepEqual(names, ['alpha', 'beta']);
  assert.equal(peers.length, 2, 'the malformed entry and the .key file are both excluded');
});

test('guessTmuxSession prefixes the name, and nothing more', () => {
  assert.equal(guessTmuxSession('gamma'), `${SESSION_PREFIX}gamma`);
});
