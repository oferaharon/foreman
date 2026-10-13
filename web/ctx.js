/*
 * web/ctx.js — how full a context window is, painted one way everywhere it is painted.
 *
 * Lifted out of `web/app.js` when the bots band needed it, because the rule is that a bot's
 * `ctx` looks **exactly** like a dev session's (plan item 6, the maintainer's Q3), and the
 * band is a pure module that a node test drives — it cannot import `app.js`, which reaches
 * for `document` at module scope. Two copies of the three bands would be the
 * `docs/traps/one-spelling.md` lesson in its smallest costume: they agree the day they are
 * written and nothing holds them together afterwards. So both import this one.
 *
 * A dev session's number is scraped off its footer and is always a percentage. A bot's is
 * computed by the panel (`server/context-window.js`) and is a percentage only when the
 * panel knows the model's window; for a model it has never heard of the server sends
 * `pct: null` with the token count, and `ctxFor` then draws `41k` rather than a guessed
 * percentage. No tone on that one — a band of "fine / tight / hot" over a number with no
 * denominator would be a colour claiming something nobody measured.
 */

/**
 * Context pressure, one rule shared by the rail and the header so they can't drift:
 * under 50% is fine, 50–70% is worth noticing, above that it's getting tight.
 */
export function ctxTone(pct) {
  if (pct == null) return '';
  if (pct < 50) return 'ctx-ok';
  if (pct <= 70) return 'ctx-warn';
  return 'ctx-hot';
}

export function ctxEl(pct) {
  const el = document.createElement('span');
  el.className = `ctx ${ctxTone(pct)}`;
  el.textContent = `${pct}%`;
  el.title = `${pct}% of the context window used`;
  return el;
}

/** `41k`, `1.2M`, `850` — a token count short enough for the rail's meta line. */
export function tokensText(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * A panel-computed `{tokens, window, pct}` as the node a row or a head draws, or `null`
 * when there is nothing to say.
 *
 * With a percentage it is `ctxEl` — the dev session's node, byte for byte, with the token
 * count added to the hover. Without one it is the same `.ctx` span carrying the count and
 * no tone, and its hover says why there is no percentage.
 */
export function ctxFor(ctx) {
  const tokens = Number.isFinite(ctx?.tokens) ? ctx.tokens : null;
  const pct = Number.isFinite(ctx?.pct) ? ctx.pct : null;
  if (pct != null) {
    const el = ctxEl(pct);
    if (tokens != null && Number.isFinite(ctx?.window)) {
      el.title = `${pct}% of the context window used — ${tokens.toLocaleString()} of ${ctx.window.toLocaleString()} tokens`;
    }
    return el;
  }
  if (tokens == null) return null;
  const el = document.createElement('span');
  el.className = 'ctx';
  el.textContent = tokensText(tokens);
  el.title = `${tokens.toLocaleString()} tokens in context — the panel does not know this model's window, so it shows no percentage`;
  return el;
}

/** The same fact as words, for a hover or an accessible name. */
export function ctxText(ctx) {
  if (Number.isFinite(ctx?.pct)) return `${ctx.pct}%`;
  if (Number.isFinite(ctx?.tokens)) return tokensText(ctx.tokens);
  return '';
}
