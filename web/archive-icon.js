/*
 * The rooms band's archive glyph: a lidded box, in `currentColor`, at the funnel's 11px so
 * the two controls at the end of a room row are one size (`web/funnel-icon.js`).
 */

/** Hidden from the accessibility tree — the button it sits in carries the words. */
export function archiveIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(ns, 'path');
  // The lid, the box under it, and the slot you would lift it by.
  path.setAttribute('d', 'M1.75 2.75h12.5v3H1.75zM3 5.75v7.5h10v-7.5M6.25 8.5h3.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);
  return svg;
}
