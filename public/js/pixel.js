/**
 * Shared pixel-art primitives.
 *
 * Lives apart from avatar.js so the pet renderer can use the same grid and
 * colour maths without either module having to import the other.
 */

export const GRID = { W: 26, H: 34, S: 3 };

/** Mixes `amount` into each channel of a hex colour. */
export function shade(hex, amount) {
  if (!hex || hex[0] !== '#') return hex;
  const num = parseInt(hex.slice(1), 16);
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const parts = [(num >> 16) + amount, ((num >> 8) & 0xff) + amount, (num & 0xff) + amount];
  return `#${parts.map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}
