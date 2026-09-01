import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { detectSetup, resolveSetup } from '../server/setup-detect.js';

/*
 * Real directories, throwaway files — the module is file-existence work, so the tests
 * make the files exist. Each case gets its own dir; nothing is shared or ordered.
 */
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-setup-detect-'));

function repo(files) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'r-'));
  for (const f of files) {
    if (f.endsWith('/')) fs.mkdirSync(path.join(dir, f), { recursive: true });
    else fs.writeFileSync(path.join(dir, f), '');
  }
  return dir;
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ---- Node ----

test('package-lock.json → npm ci', () => {
  const r = detectSetup(repo(['package.json', 'package-lock.json']));
  assert.equal(r.command, 'npm ci');
  assert.match(r.reason, /package-lock\.json/);
});

test('pnpm-lock.yaml → pnpm install --frozen-lockfile', () => {
  const r = detectSetup(repo(['package.json', 'pnpm-lock.yaml']));
  assert.equal(r.command, 'pnpm install --frozen-lockfile');
});

test('yarn.lock → yarn install --frozen-lockfile', () => {
  const r = detectSetup(repo(['package.json', 'yarn.lock']));
  assert.equal(r.command, 'yarn install --frozen-lockfile');
});

test('bare package.json → npm install', () => {
  const r = detectSetup(repo(['package.json']));
  assert.equal(r.command, 'npm install');
  assert.match(r.reason, /no lockfile/);
});

test('two Node lockfiles → unknown, reason names both', () => {
  const r = detectSetup(repo(['package.json', 'package-lock.json', 'yarn.lock']));
  assert.equal(r.command, null);
  assert.match(r.reason, /package-lock\.json/);
  assert.match(r.reason, /yarn\.lock/);
});

// ---- Swift ----

test('Package.swift → swift build', () => {
  const r = detectSetup(repo(['Package.swift']));
  assert.equal(r.command, 'swift build');
});

test('xcodeproj without Package.swift → unknown, not a guess', () => {
  const r = detectSetup(repo(['App.xcodeproj/']));
  assert.equal(r.command, null);
  assert.match(r.reason, /App\.xcodeproj/);
});

test('Package.swift beats a sibling xcodeproj — one ecosystem, one answer', () => {
  const r = detectSetup(repo(['Package.swift', 'App.xcodeproj/']));
  assert.equal(r.command, 'swift build');
});

// ---- Rust / Go ----

test('Cargo.toml → cargo fetch', () => {
  assert.equal(detectSetup(repo(['Cargo.toml'])).command, 'cargo fetch');
});

test('go.mod → go mod download', () => {
  assert.equal(detectSetup(repo(['go.mod'])).command, 'go mod download');
});

// ---- Python ----

test('uv.lock → uv sync', () => {
  assert.equal(detectSetup(repo(['pyproject.toml', 'uv.lock'])).command, 'uv sync');
});

test('poetry.lock → poetry install', () => {
  assert.equal(detectSetup(repo(['pyproject.toml', 'poetry.lock'])).command, 'poetry install');
});

test('bare requirements.txt → unknown; the reason says why', () => {
  const r = detectSetup(repo(['requirements.txt']));
  assert.equal(r.command, null);
  assert.match(r.reason, /virtualenv/);
});

test('lockless pyproject.toml → unknown', () => {
  const r = detectSetup(repo(['pyproject.toml']));
  assert.equal(r.command, null);
});

// ---- Ambiguity and absence ----

test('nothing recognisable → unknown, plainly', () => {
  const r = detectSetup(repo(['README.md', 'notes.txt']));
  assert.equal(r.command, null);
  assert.match(r.reason, /no recognisable/);
});

test('two ecosystems at the top level → unknown, reason names them', () => {
  const r = detectSetup(repo(['package.json', 'package-lock.json', 'Cargo.toml']));
  assert.equal(r.command, null);
  assert.match(r.reason, /Node/);
  assert.match(r.reason, /Rust/);
});

test('an unreadable path → unknown, not a throw', () => {
  const r = detectSetup(path.join(ROOT, 'no-such-dir'));
  assert.equal(r.command, null);
  assert.ok(r.reason);
});

// ---- This repo, the acceptance case ----

test('this repo detects as npm ci', () => {
  const here = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const r = detectSetup(here);
  assert.equal(r.command, 'npm ci');
});

// ---- resolveSetup: the stored value wins, detection fills the gap ----

test('a stored setup wins over detection, marked stored', () => {
  const r = resolveSetup('make prepare', repo(['package.json', 'package-lock.json']));
  assert.equal(r.command, 'make prepare');
  assert.equal(r.source, 'stored');
});

test('no stored value → detection, marked detected', () => {
  const r = resolveSetup(null, repo(['package.json', 'package-lock.json']));
  assert.equal(r.command, 'npm ci');
  assert.equal(r.source, 'detected');
});

test('no stored value, nothing detected → source none, reason kept', () => {
  const r = resolveSetup(null, repo(['README.md']));
  assert.equal(r.command, null);
  assert.equal(r.source, 'none');
  assert.ok(r.reason);
});
