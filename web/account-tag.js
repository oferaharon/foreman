/**
 * The account tag a session wears in its pane header and rail row — which Claude account it
 * runs on (`server/account.js` reads it off the process; the roster carries it as `account`).
 *
 * Pure, so the rule is tested without a DOM, and one spelling for both places it is drawn.
 *
 * The text is the nickname when the maintainer set one (`accountNicknames` in `config.json`,
 * keyed by account uuid), otherwise the config folder's name — `default` for `~/.claude`,
 * `.claude-work` for `CLAUDE_CONFIG_DIR=~/.claude-work`. **Never the email**: the email is in
 * the hover only, beside the plan and the folder. `null` when the roster could not say, which
 * draws nothing — no tag rather than a wrong one.
 */
export function accountTag(account) {
  if (!account || typeof account.folder !== 'string' || !account.folder) return null;
  const nickname = typeof account.nickname === 'string' && account.nickname ? account.nickname : null;
  const facts = [];
  if (account.signedIn) {
    if (account.email) facts.push(account.email);
    if (account.plan) facts.push(account.plan);
  } else {
    facts.push('not signed in');
  }
  if (account.configDir) facts.push(account.configDir);
  return {
    text: nickname || account.folder,
    title: `Claude account${nickname ? ` “${nickname}”` : ''}: ${facts.join(' · ')}`,
    nicknamed: Boolean(nickname),
  };
}

/** The tag as a node, or `null`. `document` is the caller's, so this module needs none. */
export function accountTagEl(doc, account, cls = 'account-tag') {
  const tag = accountTag(account);
  if (!tag) return null;
  const el = doc.createElement('span');
  el.className = `${cls}${tag.nicknamed ? '' : ' is-folder'}${account.signedIn ? '' : ' is-signed-out'}`;
  el.textContent = tag.text;
  el.title = tag.title;
  return el;
}
