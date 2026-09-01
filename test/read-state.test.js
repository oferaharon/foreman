import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReadState } from '../server/read-state.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-read-'));
  return path.join(dir, 'read.json');
}

test('first sight of a session marks its history read', () => {
  const rs = new ReadState(tmpStore());
  rs.ensureBaseline('s1', '2026-08-24T10:00:00.000Z');
  assert.equal(rs.get('s1'), '2026-08-24T10:00:00.000Z');
  rs.stop();
});

test('baseline never overwrites an existing watermark', () => {
  const rs = new ReadState(tmpStore());
  rs.ensureBaseline('s1', '2026-08-24T10:00:00.000Z');
  rs.ensureBaseline('s1', '2026-08-24T12:00:00.000Z');
  assert.equal(rs.get('s1'), '2026-08-24T10:00:00.000Z', 'a later baseline must not skip messages');
  rs.stop();
});

test('watermarks only move forward', () => {
  const rs = new ReadState(tmpStore());
  rs.mark('s1', '2026-08-24T10:00:00.000Z');
  assert.equal(rs.mark('s1', '2026-08-24T11:00:00.000Z'), true);
  assert.equal(rs.mark('s1', '2026-08-24T09:00:00.000Z'), false, 'an older ts must not un-read');
  assert.equal(rs.get('s1'), '2026-08-24T11:00:00.000Z');
  rs.stop();
});

test('a missing timestamp is ignored rather than clearing the mark', () => {
  const rs = new ReadState(tmpStore());
  rs.mark('s1', '2026-08-24T10:00:00.000Z');
  assert.equal(rs.mark('s1', null), false);
  assert.equal(rs.get('s1'), '2026-08-24T10:00:00.000Z');
  rs.stop();
});

test('watermarks survive a restart', () => {
  const file = tmpStore();
  const a = new ReadState(file);
  a.mark('s1', '2026-08-24T10:00:00.000Z');
  a.stop(); // flushes

  const b = new ReadState(file);
  assert.equal(b.get('s1'), '2026-08-24T10:00:00.000Z');
  b.stop();
});

test('prune drops sessions that left the roster', () => {
  const rs = new ReadState(tmpStore());
  rs.mark('keep', '2026-08-24T10:00:00.000Z');
  rs.mark('gone', '2026-08-24T10:00:00.000Z');
  rs.prune(new Set(['keep']));
  assert.equal(rs.get('keep'), '2026-08-24T10:00:00.000Z');
  assert.equal(rs.get('gone'), null);
  rs.stop();
});

test('a corrupt store starts clean instead of throwing', () => {
  const file = tmpStore();
  fs.writeFileSync(file, '{ not json');
  const rs = new ReadState(file);
  assert.equal(rs.get('anything'), null);
  rs.stop();
});
