import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME } from './config.js';

/**
 * When did the shell start stamping the launcher's label into `--name`?
 *
 * A session reads its shell config once, at launch. So a pane created after that config
 * was last written is guaranteed to name its transcript after its label — which means it
 * can never be the one writing the old `<repo>-<branch>` default, and can't be mistaken
 * for a sibling.
 *
 * That matters for exactly one awkward case: a session labelled `main`, in a repo whose
 * branch is also `main`, produces the title `Alpha-main` either way. Knowing the pane
 * post-dates the wrapper change is what tells the two apart.
 *
 * Using the config's mtime keeps this self-maintaining — no timestamp to record, and
 * editing the file again only makes the panel briefly more cautious, never wrong.
 */
const CANDIDATES = ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile'];

let cached = { at: 0, value: 0 };
const TTL_MS = 60_000;

export async function shellConfigMtime() {
  if (Date.now() - cached.at < TTL_MS) return cached.value;

  const times = await Promise.all(
    CANDIDATES.map((name) =>
      fs
        .stat(path.join(HOME, name))
        .then((s) => s.mtimeMs)
        .catch(() => 0),
    ),
  );

  cached = { at: Date.now(), value: Math.max(0, ...times) };
  return cached.value;
}
