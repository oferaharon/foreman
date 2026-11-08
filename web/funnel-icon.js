/*
 * The rail filter's one glyph: a funnel, in `currentColor`.
 *
 * Its own leaf because two builders draw it — the group header in `web/app.js` and the room
 * row in `web/rooms-band.js` — and the band module cannot import `app.js`. One spelling, so
 * the two funnels on one rail cannot come to differ (docs/traps/one-spelling.md). The rail
 * head's clear toggle is static markup in `web/index.html` and carries the struck version as
 * its own `<svg>`; the path is the same string.
 */

/** A funnel, 11px, hidden from the accessibility tree — the button it sits in carries the
 *  words. `struck` draws a slash through it, for a control whose press lets the filter go. */
export function funnelIcon(struck = false) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2 3h12l-4.6 5.4v4.4l-2.8 1.4V8.4z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  if (struck) {
    const slash = document.createElementNS(ns, 'path');
    slash.setAttribute('d', 'M1.5 1.5l13 13');
    slash.setAttribute('stroke', 'currentColor');
    slash.setAttribute('stroke-width', '1.5');
    slash.setAttribute('stroke-linecap', 'round');
    svg.append(slash);
  }
  return svg;
}
