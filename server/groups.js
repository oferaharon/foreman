import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';

const FILE = path.join(STATE_DIR, 'groups.json');

const MAX_NAME = 40;

/*
 * Where worktrees live. Duplicated from `worktree.js` rather than imported, because that
 * module runs git and this one is a JSON file — the only thing needed here is the prefix
 * that tells a panel-made checkout apart from a folder somebody filed by hand.
 */
const WORKTREES_DIR = path.join(STATE_DIR, 'worktrees');

const underWorktrees = (f) => f.startsWith(`${WORKTREES_DIR}${path.sep}`);

/*
 * Groups made before `auto` existed carry no flag, and the maintainer has live ones —
 * reading them as auto-created would delete filing they did by hand. The tell is the shape of
 * the folders: the rail files what it draws, which is a *basename*, so a hand-made group
 * only ever holds bare folder names. A group whose folders are all absolute paths under
 * `worktrees/` can only have come from a dispatch. Empty is not enough evidence either way,
 * so an unflagged empty group stays hand-made and stays put.
 */
const looksAuto = (folders) => folders.length > 0 && folders.every(underWorktrees);

/**
 * Groups of folders, made by hand.
 *
 * The rail already groups by folder, which it derives rather than being told — one
 * heading per `basename(cwd)`. That is the right unit and the wrong altitude once there
 * are a dozen of them: four of those headings are one product and three are things you
 * last touched in March, and the rail can't know which is which. So you say.
 *
 * A group holds **folders**, not sessions. Sessions come and go with every `/clear` and
 * every terminal you close; the folder is the durable thing, and it's what the heading
 * you'd be filing already is. A folder belongs to at most one group — a rail where the
 * same session appears twice is the thing this feature is supposed to fix.
 *
 * Collapse state lives here too rather than in the browser, for the same reason read
 * watermarks do: two windows should agree, and a reload shouldn't reopen everything you
 * just tidied away.
 *
 * Nothing here is pruned against the live roster. A folder with no session running is
 * simply not drawn — but it is still filed, and it comes back where you put it.
 *
 * With one exception, and it is the whole of `auto`. A group the *panel* made for a team
 * holds worktrees the panel itself deletes when the task closes, so its folders can never
 * come back — the heading is left standing over nothing, permanently. Those are reaped;
 * anything you filed by hand is not, because an empty group you made is a decision and
 * an empty group we made is litter.
 */
export class GroupStore {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    this.file = file;
    this.groups = []; // [{ id, name, collapsed, auto, folders: [] }]
    this.seq = 0;
    this.dirty = false;
    this.#load();

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw?.groups) ? raw.groups : [];
      for (const g of list) {
        if (!g || typeof g.id !== 'string' || typeof g.name !== 'string') continue;
        const folders = Array.isArray(g.folders) ? g.folders.filter((f) => typeof f === 'string') : [];
        this.groups.push({
          id: g.id,
          name: g.name.slice(0, MAX_NAME),
          collapsed: Boolean(g.collapsed),
          auto: 'auto' in g ? Boolean(g.auto) : looksAuto(folders),
          folders,
        });
      }
      this.seq = Number.isInteger(raw?.seq) ? raw.seq : this.groups.length;
    } catch {
      /* first run, or hand-edited into nonsense — start clean */
    }
  }

  #flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ seq: this.seq, groups: this.groups }, null, 2));
    } catch {
      /* best-effort */
    }
  }

  /** Write now rather than waiting for the next tick (tests, shutdown). */
  flush() {
    this.#flush();
  }

  /** Copies, so callers can't reach in and mutate the store. */
  list() {
    return this.groups.map((g) => ({ ...g, folders: [...g.folders] }));
  }

  get(id) {
    return this.groups.find((g) => g.id === id) || null;
  }

  /** Which group a folder is filed under, or null. */
  groupOf(folder) {
    return this.groups.find((g) => g.folders.includes(folder))?.id ?? null;
  }

  #clean(name) {
    const trimmed = String(name ?? '').trim().slice(0, MAX_NAME);
    if (!trimmed) throw new Error('A group needs a name.');
    return trimmed;
  }

  #assertUnique(name, exceptId = null) {
    const taken = this.groups.some(
      (g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) throw new Error(`There's already a group called “${name}”.`);
  }

  /**
   * @param {string} name
   * @param {{auto?: boolean}} [opts] `auto` marks a group the panel made for a team —
   *   the only kind it will ever delete on its own. Default false: everything that comes
   *   in over the API is somebody filing something.
   */
  create(name, { auto = false } = {}) {
    const clean = this.#clean(name);
    this.#assertUnique(clean);
    this.seq += 1;
    const group = { id: `g${this.seq}`, name: clean, collapsed: false, auto: Boolean(auto), folders: [] };
    this.groups.push(group);
    this.dirty = true;
    return { ...group, folders: [] };
  }

  rename(id, name) {
    const group = this.get(id);
    if (!group) return null;
    const clean = this.#clean(name);
    this.#assertUnique(clean, id);
    group.name = clean;
    this.dirty = true;
    return { ...group, folders: [...group.folders] };
  }

  /** The group goes; its folders don't — they fall back to their own headings. */
  remove(id) {
    const at = this.groups.findIndex((g) => g.id === id);
    if (at < 0) return false;
    this.groups.splice(at, 1);
    this.dirty = true;
    return true;
  }

  setCollapsed(id, collapsed) {
    const group = this.get(id);
    if (!group) return null;
    group.collapsed = Boolean(collapsed);
    this.dirty = true;
    return { ...group, folders: [...group.folders] };
  }

  /**
   * File a folder under a group, or (with `null`) let it stand on its own again.
   *
   * Always a move, never a copy: it leaves whatever group it was in first, because one
   * folder in two groups would draw its sessions twice.
   */
  assign(folder, groupId) {
    const name = String(folder ?? '').trim();
    if (!name) throw new Error('Which folder?');
    if (groupId != null && !this.get(groupId)) throw new Error('No such group.');

    let changed = false;
    for (const g of this.groups) {
      if (g.id === groupId) continue;
      const at = g.folders.indexOf(name);
      if (at >= 0) {
        g.folders.splice(at, 1);
        changed = true;
      }
    }

    const target = groupId == null ? null : this.get(groupId);
    if (target && !target.folders.includes(name)) {
      target.folders.push(name);
      changed = true;
    }

    if (changed) this.dirty = true;
    return changed;
  }

  /**
   * A worktree has been deleted — take its filing with it, and clear up after.
   *
   * Two spellings, because there have been two. A dispatch files the folder *name* the rail
   * draws (`basename(cwd)`), which is the only key that ever matches a session; the first
   * version filed the absolute directory instead, which matched nothing and is still on
   * disk in front of the maintainer. Both are unfiled, and the basename only for a path
   * genuinely under `worktrees/` — otherwise closing a task could quietly unfile a real
   * project that happens to share the name.
   *
   * @param {string} dir the worktree directory, gone or about to be
   * @returns {{unfiled: string[], removed: string[]}}
   */
  retireWorktree(dir) {
    const full = String(dir ?? '').trim();
    if (!full) return { unfiled: [], removed: [] };

    const spellings = underWorktrees(full) ? [full, path.basename(full)] : [full];
    const unfiled = spellings.filter((f) => this.assign(f, null));
    return { unfiled, removed: this.reap() };
  }

  /**
   * Drop the auto-made groups that have run dry.
   *
   * Emptiness is the whole test, and it is also the guard the spec asks for: a team group
   * somebody hand-filed a real project into is not empty, so it stays — its dead
   * worktrees leave and the project keeps its shelf.
   *
   * @returns {string[]} ids removed
   */
  reap() {
    const dead = this.groups.filter((g) => g.auto && g.folders.length === 0).map((g) => g.id);
    for (const id of dead) this.remove(id);
    return dead;
  }

  stop() {
    clearInterval(this.timer);
    this.#flush();
  }
}
