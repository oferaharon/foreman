/*
 * How long a session may sit idle before the panel puts it to sleep — the one spelling.
 *
 * A leaf with no imports, under `web/` so the settings picker can load it as it is, and
 * imported by `server/hibernate.js` (which re-exports it to the settings validator) the way
 * `group-hue.js` is shared. A second literal of this list anywhere is the drift
 * `docs/traps/one-spelling.md` is about: a picker offering a choice the validator refuses,
 * or the other way round.
 *
 * `off` is first and is the default, by the maintainer's ruling of 2026-10-29: hibernation
 * closes sessions, so nothing does it until somebody turns it on.
 */

export const HIBERNATE_CHOICES = Object.freeze(['off', '30m', '1h', '4h', '12h']);

export const DEFAULT_HIBERNATE = 'off';

const MINUTE = 60_000;

const MS = Object.freeze({ '30m': 30 * MINUTE, '1h': 60 * MINUTE, '4h': 240 * MINUTE, '12h': 720 * MINUTE });

/** How the settings picker words each choice — beside the list, so the two cannot drift. */
const LABELS = Object.freeze({ off: 'off', '30m': '30 min', '1h': '1 h', '4h': '4 h', '12h': '12 h' });

/** A choice as the picker draws it; anything that is not a choice is drawn as itself. */
export const hibernateLabel = (choice) => (isHibernateChoice(choice) ? LABELS[choice] : String(choice ?? ''));

/** Whether a value is one of the choices, spelled exactly. */
export const isHibernateChoice = (choice) => typeof choice === 'string' && HIBERNATE_CHOICES.includes(choice);

/**
 * The idle time a choice stands for, or `null` for `off` — and for anything that is not a
 * choice at all. An absent or unknown setting reads as `off`, never as the shortest wait:
 * the cost of a wrong "asleep" is somebody's work, the cost of a wrong "awake" is memory.
 *
 * @param {unknown} choice
 * @returns {number|null}
 */
export function hibernateMs(choice) {
  if (!isHibernateChoice(choice) || choice === 'off') return null;
  return MS[choice];
}
