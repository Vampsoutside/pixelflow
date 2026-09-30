/**
 * Pixel avatar renderer.
 *
 * One canvas, one `px()` primitive, and a pose switch. Each pose is a branch
 * that paints a 26x34 character grid at 3px per cell, reusing the palette
 * helpers (skin / hair / outfit plus computed shades) so every pose follows
 * the customiser.
 */

import { GRID, shade } from './pixel.js';
import { isPet, drawPet } from './pets.js';

const { W, H, S } = GRID;

export { GRID, shade };

export const POSES = {
  focus: [
    { id: 'desk', name: 'At desk', icon: '📚' },
    { id: 'reading', name: 'Reading', icon: '📖' },
    { id: 'notes', name: 'Notes', icon: '📝' },
    { id: 'laptop', name: 'Coding', icon: '💻' },
    { id: 'library', name: 'Library', icon: '📚' },
    { id: 'phone', name: 'Phone', icon: '📱' },
  ],
  break: [
    { id: 'stretch', name: 'Stretch', icon: '🙆' },
    { id: 'coffee', name: 'Coffee', icon: '☕' },
    { id: 'walk', name: 'Walk', icon: '🚶' },
    { id: 'snack', name: 'Snack', icon: '🍎' },
    { id: 'music', name: 'Music', icon: '🎧' },
    { id: 'window', name: 'Window', icon: '🌤️' },
  ],
};

export const poseList = (kind) => POSES[kind] || POSES.focus;
export const findPose = (kind, id) => poseList(kind).find((p) => p.id === id) || poseList(kind)[0];

const BACKDROPS = {
  default: { sky: '#1b1b34', floor: '#262640' },
  library: { sky: '#2a2038', floor: '#33263f' },
  cafe: { sky: '#2e2418', floor: '#3a2c1c' },
  park: { sky: '#16281c', floor: '#1f3324' },
  space: { sky: '#10102a', floor: '#181838' },
};
/**
 * Paints a pose onto a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} avatar   avatar settings from the account
 * @param {string} poseId
 * @param {number} frame    animation frame counter, used for idle motion
 */
export function drawPose(canvas, avatar, poseId, frame = 0) {
  if (!canvas) return;

  // A pet replaces the person wherever an avatar would appear, so every
  // caller (timer buddy, friend rows, customiser) follows the account setting.
  if (isPet(avatar)) {
    drawPet(canvas, avatar, poseId, frame, BACKDROPS[avatar?.backdrop] || BACKDROPS.default);
    return;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;

  const {
    skin = '#f5c5a3', hair = '#4a2c2a', outfit = '#7c6fff',
    gender = 'female', hat = 'none', glasses = false, outline = true,
    backdrop = 'default',
  } = avatar || {};

  const isFemale = gender === 'female';
  const skinD = shade(skin, -26);
  const skinL = shade(skin, 22);
  const hairD = shade(hair, -34);
  const hairL = shade(hair, 26);
  const outD = shade(outfit, -34);
  const outL = shade(outfit, 26);
  const ink = outline ? '#1a1a2e' : null;

  const back = BACKDROPS[backdrop] || BACKDROPS.default;
  // Gentle idle bob, quantised so it reads as pixel steps rather than a slide.
  const bob = Math.round(Math.sin(frame * 0.075) * 1.2);

  const px = (x, y, col, w = 1, h = 1) => {
    if (!col) return;
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x * S), Math.round(y * S + bob), Math.round(w * S), Math.round(h * S));
  };

  // ── shared scene helpers ────────────────────────────────────────────────

  const floor = (color = back.floor) => {
    px(0, 31, color, W, 3);
    px(0, 31, ink, W, 1);
  };

  const shadow = () => {
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2, (H - 3) * S + bob, 15, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  /** Head at (hx, hy) with hair, eyes and a mouth. */
  const head = (hx, hy, look = 0) => {
    px(hx, hy, skin, 6, 7);
    px(hx, hy, ink, 6, 1);
    px(hx, hy + 7, skinD, 6, 1);
    px(hx - 1, hy + 2, skin, 1, 4);
    px(hx + 6, hy + 2, skin, 1, 4);

    // Hair
    px(hx, hy - 1, hair, 6, 3);
    if (isFemale) {
      px(hx - 1, hy - 1, hair, 1, 8);
      px(hx + 6, hy, hair, 1, 7);
      px(hx - 1, hy + 6, hairD, 1, 2);
    } else {
      px(hx, hy - 1, hairD, 6, 2);
      px(hx - 1, hy, hair, 1, 4);
    }

    // Eyes — blink on a long cycle, offset by look direction.
    const blinking = frame % 96 > 92;
    const ex = hx + 1 + look;
    const fx = hx + 4 + look;
    if (blinking) {
      px(ex, hy + 3, ink, 1, 1);
      px(fx, hy + 3, ink, 1, 1);
    } else {
      px(ex, hy + 3, ink, 1, 2);
      px(fx, hy + 3, ink, 1, 2);
      px(ex, hy + 3, '#6ba8ff', 1, 1);
      px(fx, hy + 3, '#6ba8ff', 1, 1);
      px(ex - 1, hy + 2, hairD, 2, 1);
      px(fx - 1, hy + 2, hairD, 2, 1);
    }

    // Mouth
    px(hx + 2, hy + 5, '#c07060', 2, 1);

    if (glasses) {
      px(ex - 1, hy + 3, '#2b2b40', 3, 1);
      px(ex - 1, hy + 4, '#2b2b40', 3, 1);
      px(fx - 1, hy + 3, '#2b2b40', 3, 1);
      px(fx - 1, hy + 4, '#2b2b40', 3, 1);
      px(ex + 2, hy + 3, '#2b2b40', 1, 1);
    }

    if (hat === 'cap') {
      px(hx - 1, hy - 2, outD, 8, 2);
      px(hx + 5, hy, outD, 3, 1);
    } else if (hat === 'beanie') {
      px(hx, hy - 2, '#e85d5d', 6, 2);
      px(hx, hy - 3, '#ff8080', 1, 1);
      px(hx, hy, '#ff8080', 6, 1);
    } else if (hat === 'headphones') {
      px(hx - 1, hy, '#3a3a55', 1, 4);
      px(hx + 6, hy, '#3a3a55', 1, 4);
      px(hx - 1, hy + 1, '#6bffda', 1, 2);
      px(hx + 6, hy + 1, '#6bffda', 1, 2);
    }
  };

  const arm = (x, y, len, vertical = true, color = skin) => {
    if (vertical) {
      px(x, y, color, 2, len);
      px(x, y + len - 1, skinD, 2, 1);
    } else {
      px(x, y, color, len, 2);
      px(x, y + 1, skinD, len, 1);
    }
  };

  // ── poses ──────────────────────────────────────────────────────────────

  const POSES_DRAW = {
    /** Seated at a desk with a laptop and an open book. */
    desk(ctx2) {
      px(0, 0, back.sky, W, H);
      floor();
      shadow();
      // Desk
      px(1, 24, '#8a6428', 24, 2);
      px(1, 24, '#b8862f', 24, 1);
      px(3, 26, '#6b4d1e', 20, 1);
      // Laptop
      px(12, 20, '#2f2f45', 9, 5);
      px(13, 21, '#1d1d33', 7, 3);
      px(13, 21, '#6bffda', 3, 1);
      px(14, 22, '#7c6fff', 5, 1);
      px(13, 23, '#6bffda', 2, 1);
      px(11, 25, '#4a4a68', 11, 1);
      // Book
      px(2, 22, '#ff6b9d', 6, 2);
      px(3, 22, '#ffffff', 4, 1);
      px(2, 24, '#c04a72', 6, 1);
      // Seated torso and legs
      px(8, 16, outfit, 9, 8);
      px(8, 16, outD, 9, 1);
      px(8, 22, outD, 2, 3);
      px(15, 22, outD, 2, 3);
      px(9, 25, '#4a4a68', 3, 2);
      px(14, 25, '#4a4a68', 3, 2);
      px(9, 27, '#2f2f45', 4, 2);
      px(13, 27, '#2f2f45', 4, 2);
      px(9, 8, skin, 6, 8);
      head(9, 1, 0);
      arm(3, 21, 6);
      arm(17, 21, 6);
    },

    /** Cross-legged with an open book held in both hands. */
    reading() {
      px(0, 0, back.sky, W, H);
      floor('#2f2f52');
      shadow();
      px(9, 18, outfit, 8, 8);
      px(9, 18, outD, 8, 1);
      px(8, 26, outD, 4, 2);
      px(14, 26, outD, 4, 2);
      px(6, 28, '#3a3a5c', 14, 2);
      head(9, 8, 0);
      // Open book across the lap, pages tilting as the page is turned
      const turn = frame % 180;
      px(6, 23, '#f5f0e0', 14, 4);
      px(6, 23, ink, 14, 1);
      px(13, 23, ink, 1, 4);
      px(8, 25, '#c9c4b4', 4, 1);
      px(14, 25, '#c9c4b4', 4, 1);
      if (turn % 3 === 0) {
        const lift = Math.round(Math.sin((turn / 180) * Math.PI * 2) * 1.5);
        px(12 - lift, 22, '#ffffff', 2, 4);
      }
      arm(4, 22, 3);
      arm(20, 22, 3);
    },

    /** Bent over a desk writing, pen moving with the frame. */
    notes() {
      px(0, 0, back.sky, W, H);
      floor();
      shadow();
      px(2, 22, '#7a5c14', 22, 1);
      px(3, 23, '#a8802c', 20, 1);
      px(4, 20, '#f7f3e6', 16, 2);
      px(4, 20, ink, 16, 1);
      // Ruled lines, with a line appearing as the writing progresses
      const lines = Math.floor((frame % 240) / 40) + 1;
      for (let i = 0; i < lines && i < 4; i += 1) px(5, 21, '#9a95a8', 10 - i, 1);
      // Torso leaning forward
      px(8, 15, outfit, 10, 8);
      px(8, 15, outD, 10, 1);
      px(8, 22, outD, 3, 4);
      px(15, 22, outD, 3, 4);
      // Head tilted down at the page
      px(9, 7, skin, 6, 8);
      px(9, 7, ink, 6, 1);
      px(9, 6, hair, 6, 4);
      px(8, 8, hair, 1, 6);
      if (isFemale) px(15, 8, hair, 1, 6);
      px(10, 12, ink, 2, 1);
      px(13, 12, ink, 2, 1);
      px(11, 14, '#c07060', 3, 1);
      // Hand and pen, sliding along the line being written
      const penX = 15 + (frame % 40) % 5;
      arm(penX, 19, 2);
      px(penX, 18, '#ffd166', 1, 2);
    },

    /** Standing, holding a laptop, code flickering on screen. */
    laptop() {
      px(0, 0, back.sky, W, H);
      floor();
      shadow();
      px(9, 27, '#4a4a68', 4, 3);
      px(13, 27, '#4a4a68', 4, 3);
      px(8, 30, '#2f2f45', 5, 2);
      px(13, 30, '#2f2f45', 5, 2);
      px(7, 12, outfit, 12, 13);
      px(7, 12, outD, 12, 1);
      px(7, 18, outL, 12, 1);
      px(9, 8, skin, 6, 4);
      head(9, 1, 0);
      // Laptop held up in front of the chest
      px(4, 14, '#2f2f45', 16, 10);
      px(5, 15, '#15152a', 14, 8);
      const scroll = frame % 6;
      px(6, 16, '#6bffda', 5 + scroll, 1);
      px(6, 17, '#7c6fff', 8 - scroll, 1);
      px(6, 18, '#6bffda', 4, 1);
      px(6, 19, '#ffb347', 6, 1);
      px(6, 21, '#3f3f5c', 12, 1);
      // Caret blinking on the active line
      if (frame % 40 < 20) px(15, 21, '#ffffff', 1, 1);
      arm(2, 20, 4);
      arm(21, 20, 4);
    },

    /** Standing between shelves, reaching for a book. */
    library() {
      px(0, 0, back.sky, W, H);
      // Shelves behind
      px(1, 4, '#5a3a24', 8, 24);
      px(17, 4, '#5a3a24', 8, 24);
      const shelf = (x, colors) => {
        px(x, 4, '#7a4f2e', 8, 1);
        px(x, 10, '#7a4f2e', 8, 1);
        px(x, 16, '#7a4f2e', 8, 1);
        px(x, 22, '#7a4f2e', 8, 1);
        colors.forEach((c, i) => {
          px(x + 1 + i * 2, 6, c, 1, 4);
          px(x + 1 + i * 2, 12, colors[(i + 2) % colors.length], 1, 4);
          px(x + 1 + i * 2, 18, colors[(i + 3) % colors.length], 1, 4);
          px(x + 1 + i * 2, 24, colors[(i + 1) % colors.length], 1, 4);
        });
      };
      const bookColors = ['#c04a72', '#4a72c0', '#c0a04a', '#4ac08a', '#8a4ac0', '#c05a4a'];
      shelf(1, bookColors);
      shelf(17, [...bookColors].reverse());
      floor('#33263f');
      shadow();
      px(9, 16, outfit, 8, 12);
      px(9, 16, outD, 8, 1);
      px(9, 27, '#2f2f45', 3, 3);
      px(14, 27, '#2f2f45', 3, 3);
      px(9, 29, '#1f1f30', 4, 2);
      px(13, 29, '#1f1f30', 4, 2);
      head(9, 7, -1);
      // Reaching up to pull a book out
      const pull = frame % 240 < 120 ? 0 : 1;
      arm(18, 12 - pull * 2, 4);
      px(19, 8 - pull * 2, '#4ac08a', 2, 3);
      arm(5, 18, 6);
      px(6, 17, '#c04a72', 2, 3);
    },

    /** Scrolling on a phone, face lit by the screen. */
    phone() {
      px(0, 0, back.sky, W, H);
      floor();
      shadow();
      px(7, 17, outfit, 12, 11);
      px(7, 17, outD, 12, 1);
      px(7, 27, '#3a3a5c', 4, 2);
      px(15, 27, '#3a3a5c', 4, 2);
      px(6, 29, '#2f2f45', 6, 2);
      px(14, 29, '#2f2f45', 6, 2);
      px(9, 9, skin, 6, 8);
      head(9, 2, 0);
      // Screen glow washes the face on a pulse
      const glow = frame % 100 < 60;
      if (glow) {
        px(10, 10, shade(skin, 30), 4, 3);
        px(10, 13, '#c8f0ff', 4, 1);
      }
      px(10, 21, '#1a1a2e', 6, 9);
      px(11, 22, '#6ba8ff', 4, 7);
      px(11, 22, '#8fc4ff', 4, 1);
      px(12, 24, '#ffffff', 2, 1);
      px(12, 26, '#ffffff', 3, 1);
      // Thumb tapping
      const tap = frame % 60 < 10 ? 1 : 0;
      arm(8 - tap, 20, 2);
      arm(16 + tap, 20, 2);
    },

    /** Arms up, mid-stretch, with a shine mark. */
    stretch() {
      px(0, 0, '#1a2a1c', W, H);
      floor('#24382a');
      shadow();
      // Sunbeam behind
      px(2, 0, 'rgba(255,240,180,.07)', 6, H);
      px(8, 0, 'rgba(255,240,180,.05)', 5, H);
      px(9, 16, outfit, 8, 10);
      px(9, 16, outD, 8, 1);
      px(9, 25, '#4a4a68', 3, 4);
      px(14, 25, '#4a4a68', 3, 4);
      px(9, 29, '#2f2f45', 4, 2);
      px(13, 29, '#2f2f45', 4, 2);
      // Both arms raised; the rise is a slow sine so it reads as a stretch
      const raise = Math.round((Math.sin(frame * 0.06) * 0.5 + 0.5) * 4);
      arm(7 - raise, 16 - raise, 5);
      arm(18, 16 - raise, 5);
      head(9, 6, 0);
      // Happy squinting eyes and open smile
      px(10, 10, ink, 2, 1);
      px(13, 10, ink, 2, 1);
      px(11, 12, '#c07060', 3, 1);
      px(11, 13, '#ffffff', 3, 1);
      // Shine marks
      if (frame % 80 < 40) {
        px(5, 6, '#ffffff', 1, 1);
        px(20, 5, '#ffffff', 1, 1);
        px(6, 5, '#ffffff', 1, 1);
      }
    },

    /** Sipping coffee at a small table. */
    coffee() {
      px(0, 0, '#2e2418', W, H);
      floor('#3a2c1c');
      shadow();
      px(1, 24, '#6b4d2e', 24, 1);
      px(1, 25, '#4a3520', 24, 1);
      px(9, 17, outfit, 8, 8);
      px(9, 17, outD, 8, 1);
      px(9, 24, outD, 3, 3);
      px(14, 24, outD, 3, 3);
      head(9, 8, 0);
      // Cup on the table, with rising steam that thins out as it climbs
      px(18, 20, '#f2ede4', 5, 4);
      px(18, 21, '#6b4a2e', 5, 2);
      px(23, 21, '#f2ede4', 1, 2);
      px(18, 24, '#c9c2b8', 5, 1);
      if (frame % 40 < 26) px(19, 18, 'rgba(255,255,255,.55)', 1, 1);
      if (frame % 40 < 18) px(21, 17, 'rgba(255,255,255,.4)', 1, 1);
      if (frame % 40 < 10) px(20, 16, 'rgba(255,255,255,.3)', 1, 1);
      // Hand bringing the cup to the mouth every so often
      const sip = frame % 160 < 40;
      arm(16, sip ? 13 : 18, sip ? 4 : 2);
      px(17, sip ? 12 : 17, '#f2ede4', 2, 2);
      arm(5, 20, 3);
    },

    /** Mid-stride outside, legs alternating. */
    walk() {
      px(0, 0, '#16281c', W, H);
      // Distant trees
      px(1, 8, '#1f3a26', 5, 14);
      px(20, 6, '#1f3a26', 6, 16);
      px(3, 5, '#2d5c38', 3, 4);
      px(21, 3, '#2d5c38', 4, 4);
      floor('#24382a');
      shadow();
      // Legs swing on a slow cycle
      const swing = Math.sin(frame * 0.1);
      const front = swing > 0 ? 1 : 0;
      px(9 + (front ? 1 : 0), 26, '#4a4a68', 3, 3);
      px(13 - (front ? 1 : 0), 26, '#4a4a68', 3, 3);
      px(9 + (front ? 1 : 0), 29, '#2f2f45', 4, 2);
      px(13 - (front ? 1 : 0), 29, '#2f2f45', 4, 2);
      px(9, 17, outfit, 8, 10);
      px(9, 17, outD, 8, 1);
      px(9, 20, outL, 8, 1);
      // Arms counter-swing
      arm(7, 19 + Math.round(swing), 5);
      arm(18, 19 - Math.round(swing), 5);
      head(9, 8, front ? 1 : -1);
      // Sun and a couple of drifting leaves
      px(22, 2, '#ffd166', 2, 2);
      px(21, 2, '#ffe9a8', 1, 1);
      const leaf = frame % 200;
      px(2 + (leaf % 12), 12 + Math.round(leaf / 12), '#8ac04a', 1, 1);
    },

    /** Eating a snack, crumbs and a bouncing apple. */
    snack() {
      px(0, 0, '#2a2418', W, H);
      floor('#3a3226');
      shadow();
      px(1, 25, '#7a5c14', 24, 1);
      px(9, 17, outfit, 8, 8);
      px(9, 17, outD, 8, 1);
      px(9, 24, outD, 3, 3);
      px(14, 24, outD, 3, 3);
      head(9, 8, 0);
      // Plate with an apple that lifts toward the mouth on a cycle
      px(17, 23, '#e8e4dc', 6, 1);
      px(17, 24, '#c9c4b8', 6, 1);
      const lift = frame % 140 < 50 ? Math.round(((frame % 140) / 50) * 5) : 0;
      px(19, 22 - lift, '#e05a4a', 3, 3);
      px(20, 21 - lift, '#7ac04a', 1, 1);
      if (lift === 0) px(19, 20, '#ff8a7a', 1, 1);
      // Open mouth waiting for the bite
      px(11, 12, '#c07060', 3, 1);
      if (lift > 0) px(11, 12, '#8a3a3a', 3, 1);
      arm(16, 18 - lift, 3);
      arm(5, 20, 3);
      // Crumbs
      px(14, 24, '#a08050', 1, 1);
      px(16, 24, '#a08050', 1, 1);
    },

    /** Headphones on, notes drifting up. */
    music() {
      px(0, 0, '#1c1436', W, H);
      // Equaliser bars pulsing at the bottom
      for (let i = 0; i < 12; i += 1) {
        const h = 2 + Math.round(Math.abs(Math.sin(frame * 0.13 + i * 0.6)) * 6);
        px(2 + i * 2, 31 - h, i % 2 ? '#7c6fff' : '#6bffda', 1, h);
      }
      floor('#241a45');
      shadow();
      px(9, 17, outfit, 8, 8);
      px(9, 17, outD, 8, 1);
      px(9, 24, outD, 3, 3);
      px(14, 24, outD, 3, 3);
      px(9, 27, '#2f2f45', 3, 2);
      px(14, 27, '#2f2f45', 3, 2);
      // Closed, enjoying eyes
      head(9, 8, 0);
      px(10, 11, ink, 2, 1);
      px(13, 11, ink, 2, 1);
      px(11, 12, '#c07060', 3, 1);
      px(11, 13, '#ffffff', 3, 1);
      // Headphones (drawn over the head's own hat layer)
      px(8, 8, '#3a3a55', 1, 5);
      px(16, 8, '#3a3a55', 1, 5);
      px(8, 10, '#6bffda', 1, 3);
      px(16, 10, '#6bffda', 1, 3);
      px(9, 7, '#3a3a55', 7, 1);
      // Notes rising from the speaker
      const note = frame % 90;
      px(20 - Math.round(note / 30), 20 - note / 6, '#6bffda', 1, 1);
      px(21 - Math.round(note / 30), 20 - note / 6, '#6bffda', 1, 1);
      px(20 - Math.round(note / 30), 19 - note / 6, '#7c6fff', 2, 1);
    },

    /** Standing at a window, looking out at the sky. */
    window() {
      px(0, 0, '#141a2e', W, H);
      // Window frame with sky beyond
      px(3, 2, '#3a3a58', 20, 22);
      px(4, 3, '#5fa8dc', 18, 20);
      // Clouds drifting past
      const drift = (frame * 0.35) % 24;
      px(5 + (drift % 18), 6, '#dff1ff', 4, 1);
      px(6 + (drift % 18), 7, '#dff1ff', 3, 1);
      px(13 - (drift % 14), 11, '#ffffff', 3, 1);
      // Hills and a sun
      px(4, 20, '#3a7a4a', 18, 3);
      px(4, 20, '#4a9a5a', 18, 1);
      px(16, 6, '#ffd166', 3, 3);
      px(17, 7, '#ffe9a8', 1, 1);
      // Frame mullions
      px(12, 3, '#3a3a58', 2, 20);
      px(4, 12, '#3a3a58', 18, 2);
      floor();
      // Character stands in front, in profile, gazing out
      px(10, 15, outfit, 8, 12);
      px(10, 15, outD, 8, 1);
      px(10, 26, '#4a4a68', 3, 3);
      px(15, 26, '#4a4a68', 3, 3);
      px(10, 29, '#2f2f45', 4, 2);
      px(14, 29, '#2f2f45', 4, 2);
      px(10, 7, skin, 6, 8);
      px(10, 7, ink, 6, 1);
      px(10, 6, hair, 6, 4);
      if (isFemale) px(16, 8, hair, 1, 8);
      px(14, 10, ink, 1, 2);
      px(11, 12, '#c07060', 3, 1);
      // Reflection in the glass
      px(6, 9, 'rgba(255,255,255,.08)', 4, 8);
      px(7, 10, 'rgba(255,255,255,.06)', 1, 6);
    },
  };

  (POSES_DRAW[poseId] || POSES_DRAW.desk)();
}

/** Creates a canvas sized for the pixel grid, ready to be appended. */
export function poseCanvas({ scale = 3, poseId = 'desk', avatar = {}, frame = 0 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = W * S;
  canvas.height = H * S;
  canvas.style.width = `${W * S * scale / 3}px`;
  canvas.style.height = `${H * S * scale / 3}px`;
  drawPose(canvas, avatar, poseId, frame);
  return canvas;
}
