import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitize, sessionName, slugFor, isLeadName, uniqueSessionName } from '../server/launch.js';
import { DEFAULT_SESSION_PREFIX, validSessionPrefix } from '../server/settings-file.js';

/*
 * The name is the contract. `sessions.js` reads a session's label straight out of it, the
 * pbcopy binding is guarded on the prefix, and the launcher this Mac also runs recovers
 * the slug the same way — so this has to match that naming exactly, not approximately.
 *
 * **Everything below runs twice, once per prefix**, and that is the point of the loop
 * rather than a flourish. The prefix is configuration now (`sessionPrefix` in
 * `config.json`, defaulting to `foreman-`), so there are two live values in the world:
 * the default a stranger gets, and the one a machine running a second launcher of its own
 * records instead. A round trip proven at one of them is proven for one of those people.
 *
 * `voice-` is the second value on purpose — it is the prefix this project shipped as a
 * literal for its whole life, so a regression that reintroduces the literal would still
 * pass a suite that only ran the default.
 */
const PREFIXES = [DEFAULT_SESSION_PREFIX, 'voice-'];

test('the prefixes under test are ones the panel would actually accept', () => {
  for (const p of PREFIXES) assert.ok(validSessionPrefix(p), p);
});

for (const P of PREFIXES) {
  const at = (name) => `${name} [${P}]`;

  test(at('a component keeps only [a-z0-9-]'), () => {
    assert.equal(sanitize('Alpha'), 'alpha');
    assert.equal(sanitize('Beta With Spaces'), 'beta-with-spaces');
    assert.equal(sanitize('feature/JIRA-42'), 'feature-jira-42');
    assert.equal(sanitize('café'), 'caf-');
  });

  test(at('a session name is <prefix><folder>-<slug>'), () => {
    assert.equal(sessionName('Foreman', 'frontend', P), `${P}foreman-frontend`);
  });

  test(at('a label becomes the slug'), () => {
    assert.equal(uniqueSessionName('Alpha', 'Frontend', new Set(), P), `${P}alpha-frontend`);
  });

  test(at('no label auto-numbers from one'), () => {
    assert.equal(uniqueSessionName('Alpha', null, new Set(), P), `${P}alpha-1`);
    assert.equal(uniqueSessionName('Alpha', '   ', new Set(), P), `${P}alpha-1`, 'blank is no label');
  });

  test(at('auto-numbering takes the smallest free integer'), () => {
    const live = new Set([`${P}alpha-1`, `${P}alpha-2`, `${P}alpha-4`]);
    assert.equal(uniqueSessionName('Alpha', null, live, P), `${P}alpha-3`);
  });

  /* Two quick clicks with the same label must not collide — tmux would refuse the second. */
  test(at('a taken label falls to -2, then -3'), () => {
    const live = new Set([`${P}alpha-frontend`]);
    assert.equal(uniqueSessionName('Alpha', 'frontend', live, P), `${P}alpha-frontend-2`);
    live.add(`${P}alpha-frontend-2`);
    assert.equal(uniqueSessionName('Alpha', 'frontend', live, P), `${P}alpha-frontend-3`);
  });

  test(at('a live session in another folder is not in the way'), () => {
    const live = new Set([`${P}gamma-frontend`]);
    assert.equal(uniqueSessionName('Alpha', 'frontend', live, P), `${P}alpha-frontend`);
  });

  /*
   * The slug back out again. Restoring a snapshot relaunches by name, and the roster's
   * `label` field is no help — `sessions.js` slices only the prefix, so `<prefix>alpha-main`
   * reaches it as `alpha-main`, folder and all. Round-trip that and the session comes back
   * as `<prefix>alpha-alpha-main`, which is not the session anybody saved.
   */

  test(at('a slug comes back out of the name it went into'), () => {
    const cases = [
      ['Alpha', 'main'],
      ['gamma-marketing', '1'],
      ['Beta-frontend', 'main'],
      ['Beta With Spaces', 'frontend-2'],
      ['alpha-tickets', 'main'],
    ];
    for (const [folder, slug] of cases) {
      assert.equal(
        slugFor(sessionName(folder, slug, P), folder, null, P),
        slug,
        `${folder} / ${slug}`,
      );
    }
  });

  test(at('a slug is read against the folder basename, not the whole path'), () => {
    assert.equal(slugFor(`${P}alpha-main`, '/Users/x/Code/Alpha', null, P), 'main');
    assert.equal(
      slugFor(`${P}alpha-main`, '/Users/x/Code/Alpha/', null, P),
      'main',
      'trailing slash',
    );
    // The folder whose name contains the dashes, which is where a naive split would land
    // the slug in the middle of the folder.
    assert.equal(
      slugFor(
        `${P}beta-frontend-main`,
        '/Users/x/Beta-frontend',
        null,
        P,
      ),
      'main',
    );
    assert.equal(slugFor(`${P}gamma-marketing-1`, '/Users/x/gamma-marketing', null, P), '1');
  });

  test(at('a name that was never minted this way has no slug'), () => {
    assert.equal(slugFor('foreman-test', '/Users/x/Code/Alpha', null, P), null, 'a hand-made session');
    assert.equal(slugFor(`${P}gamma-main`, '/Users/x/Code/Alpha', null, P), null, 'another folder');
    assert.equal(slugFor(`${P}alpha-`, '/Users/x/Code/Alpha', null, P), null, 'prefix and nothing after');
    assert.equal(slugFor(`${P}alpha-main`, '', null, P), null, 'no folder to read it against');
    assert.equal(slugFor('', '/Users/x/Code/Alpha', null, P), null);
    assert.equal(slugFor(null, '/Users/x/Code/Alpha', null, P), null);
  });

  /*
   * One prefix, not two: a name minted under the *other* live prefix has no slug here.
   * This is the whole of what "no compatibility mode" means at the naming layer, and it
   * is what makes the configured value the thing a machine has to get right — not a
   * detail that quietly works either way.
   */
  test(at('a name minted under a different prefix has no slug'), () => {
    const other = PREFIXES.find((p) => p !== P);
    assert.equal(slugFor(`${other}alpha-main`, '/Users/x/Code/Alpha', null, P), null);
    assert.equal(isLeadName(`${other}alpha-lead`, '/Users/x/Code/Alpha', P), false);
  });

  /* The lead's identity *is* its name, so the prefix has to reach `isLeadName` too — a
   * lead the rail stops badging is a lead the restore stops putting back as one. */
  test(at('a lead is recognised by its slug under this prefix'), () => {
    assert.equal(isLeadName(`${P}alpha-lead`, '/Users/x/Code/Alpha', P), true);
    assert.equal(isLeadName(`${P}alpha-main`, '/Users/x/Code/Alpha', P), false);
    assert.equal(isLeadName(sessionName('Alpha', 'lead', P), '/Users/x/Code/Alpha', P), true);
  });

  /*
   * The worker case: a worker launches in a *worktree* named `<repo>-<label>` but must be
   * named for the repo, or the label lands in its session name twice. `nameComponent`
   * carries the repo; `slugFor` gets the same override or the round trip
   * duplicate/snapshot rely on breaks for workers.
   */

  test(at('a worker is named for the repo, not the worktree'), () => {
    // uniqueSessionName is what createSession calls with the component.
    assert.equal(
      uniqueSessionName('Foreman', 'add-a-search-index', new Set(), P),
      `${P}foreman-add-a-search-index`,
    );
  });

  test(at('a worker slug comes back out given the component'), () => {
    const wt = '/Users/x/.foreman/worktrees/foreman-add-a-search-index';
    assert.equal(
      slugFor(`${P}foreman-add-a-search-index`, wt, 'Foreman', P),
      'add-a-search-index',
    );
    // Without the component the worktree basename is the wrong prefix — the honest answer
    // is null (falls back to auto-numbering), never a half-eaten slug.
    assert.equal(slugFor(`${P}foreman-add-a-search-index`, wt, null, P), null);
    // The component alone is enough; the folder may be blank.
    assert.equal(slugFor(`${P}foreman-x`, '', 'Foreman', P), 'x');
  });
}

/*
 * And with no prefix argument at all, which is how every caller in `server/` uses these:
 * the configured one. This machine's own `config.json` carries a real `sessionPrefix`
 * (`voice-`), which `config.js` reads at import — so the live `SESSION_PREFIX` is not
 * `foreman-` here, and asserting against a literal would be machine-dependent. Assert
 * against `DEFAULT_SESSION_PREFIX` instead, which is what this test is actually pinning:
 * the value an unconfigured panel falls back to, not whatever this box happens to have set.
 */
test('the default is what an unconfigured panel mints', () => {
  assert.equal(sessionName('Alpha', 'main', DEFAULT_SESSION_PREFIX), 'foreman-alpha-main');
  assert.equal(slugFor('foreman-alpha-main', '/x/alpha', null, DEFAULT_SESSION_PREFIX), 'main');
  assert.equal(uniqueSessionName('Alpha', 'main', new Set(), DEFAULT_SESSION_PREFIX), 'foreman-alpha-main');
  assert.equal(isLeadName('foreman-alpha-lead', '/x/alpha', DEFAULT_SESSION_PREFIX), true);
  assert.equal(DEFAULT_SESSION_PREFIX, 'foreman-');
});
