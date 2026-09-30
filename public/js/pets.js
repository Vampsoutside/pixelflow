/**
 * Pixel pet renderer.
 *
 * Sits alongside avatar.js on the same 26x34 grid and speaks the same pose
 * vocabulary, so a pet can stand in wherever a person avatar would: the
 * floating timer buddy, friend rows, the customiser stage and the presets.
 *
 * The fur colour follows the outfit swatch, so the existing customiser still
 * drives the whole look.
 */

import { GRID, shade } from './pixel.js';

const S = GRID.S;
const W = GRID.W;
const H = GRID.H;

export const PETS = [
  { id: 'cat', name: 'Cat', emoji: '🐱' },
  { id: 'dog', name: 'Dog', emoji: '🐶' },
];

/** True when the account has swapped their avatar for a pet. */
export function isPet(avatar) {
  const id = avatar?.companion;
  return id === 'cat' || id === 'dog';
}

export function petName(avatar) {
  return PETS.find((p) => p.id === avatar?.companion)?.name || 'Pet';
}

/**
 * Paints a pet onto a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} avatar   account avatar settings
 * @param {string} poseId   one of POSES.break / POSES.focus
 * @param {number} frame    animation frame counter
 * @param {object} back     { sky, floor } from the chosen backdrop
 */
export function drawPet(canvas, avatar, poseId, frame = 0, back = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;

  const dog = avatar?.companion === 'dog';

  const fur = avatar?.outfit || '#7c6fff';
  const furD = shade(fur, -44);
  const furL = shade(fur, 30);
  const cream = shade(fur, 86);
  const ink = avatar?.outline === false ? null : '#1a1a2e';
  const sky = back.sky || '#1b1b34';
  const floorCol = back.floor || '#262640';

  const bob = Math.round(Math.sin(frame * 0.075) * 1.2);
  const wag = Math.sin(frame * 0.17);
  const blink = frame % 96 > 92;
  // A short-eyes pose is used for the resting breaks.
  const eyesShut = poseId === 'sleep' || poseId === 'stretch';

  const px = (x, y, col, w = 1, h = 1) => {
    if (!col) return;
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x * S), Math.round(y * S + bob), Math.round(w * S), Math.round(h * S));
  };

  const floor = () => {
    px(0, 31, floorCol, W, 3);
    px(0, 31, ink, W, 1);
  };

  const shadow = (w = 13) => {
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2, (H - 3) * S + bob, w, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  // ── species pieces ────────────────────────────────────────────────────

  /** Ears, muzzle and tail are the only places the two species really differ. */
  const ears = (hx, hy) => {
    if (dog) {
      // Floppy ears hanging down the sides of the head.
      px(hx - 2, hy + 1, furD, 2, 7);
      px(hx - 2, hy + 7, furD, 3, 2);
      px(hx + 8, hy + 1, furD, 2, 7);
      px(hx + 8, hy + 7, furD, 3, 2);
    } else {
      // Upright triangular ears with a pink inner.
      px(hx + 1, hy - 3, fur, 2, 1);
      px(hx, hy - 2, fur, 3, 1);
      px(hx - 1, hy - 1, fur, 5, 1);
      px(hx + 1, hy - 3, '#f0a0b0', 1, 1);
      px(hx + 8, hy - 3, fur, 2, 1);
      px(hx + 8, hy - 2, fur, 3, 1);
      px(hx + 7, hy - 1, fur, 5, 1);
      px(hx + 8, hy - 3, '#f0a0b0', 1, 1);
    }
  };

  const tail = (bx, by) => {
    const lift = Math.round(wag * 2);
    if (dog) {
      // Wagging, held out to the side.
      px(bx + 6, by - 1 - lift, fur, 4, 1);
      px(bx + 9, by - 2 - lift, fur, 1, 2);
      px(bx + 8, by - 3 - lift, cream, 2, 1);
    } else {
      // Curled around the front paws.
      px(bx + 6, by + 2, fur, 4, 1);
      px(bx + 9, by + 1, fur, 1, 2);
      px(bx + 9, by - 1, fur, 1, 1);
      px(bx + 8, by - 1, cream, 2, 1);
    }
  };

  /** Head, eyes, nose and whiskers. `hx` is the left edge, head is 10 wide. */
  const head = (hx, hy, look = 0) => {
    ears(hx, hy);

    px(hx, hy, fur, 10, 9);
    px(hx, hy, ink, 10, 1);
    px(hx, hy + 8, furD, 10, 1);
    px(hx - 1, hy + 2, fur, 1, 5);
    px(hx + 10, hy + 2, fur, 1, 5);
    // Cheek fluff.
    px(hx - 1, hy + 5, furL, 1, 2);
    px(hx + 10, hy + 5, furL, 1, 2);

    // Eyes.
    const ey = hy + 3;
    if (blink || eyesShut) {
      px(hx + 2, ey + 1, ink, 2, 1);
      px(hx + 6, ey + 1, ink, 2, 1);
    } else {
      px(hx + 2 + look, ey, ink, 2, 2);
      px(hx + 6 + look, ey, ink, 2, 2);
      px(hx + 2 + look, ey, '#8fd0ff', 1, 1);
      px(hx + 6 + look, ey, '#8fd0ff', 1, 1);
    }

    if (dog) {
      // Broad pale muzzle with a big nose.
      px(hx + 2, ey + 3, cream, 6, 3);
      px(hx + 4, ey + 3, ink, 2, 2);
      px(hx + 4, ey + 5, furD, 2, 1);
    } else {
      // Small muzzle, nose and whiskers.
      px(hx + 3, ey + 3, cream, 4, 2);
      px(hx + 4, ey + 3, '#e0708a', 2, 1);
      px(hx + 4, ey + 4, ink, 2, 1);
      px(hx, ey + 3, cream, 3, 1);
      px(hx + 7, ey + 3, cream, 3, 1);
    }
  };

  /** Seated body with front paws, used by most poses. */
  const body = (bx, by) => {
    px(bx + 1, by, fur, 8, 1);
    px(bx, by + 1, fur, 10, 6);
    px(bx + 1, by + 7, furD, 8, 1);
    // Pale chest and front paws.
    px(bx + 3, by + 2, cream, 4, 4);
    px(bx + 2, by + 6, cream, 2, 2);
    px(bx + 6, by + 6, cream, 2, 2);
  };

  // ── poses ─────────────────────────────────────────────────────────────

  const POSES = {
    /** Head down over an open book on the floor. */
    desk() {
      floor();
      shadow(15);
      tail(7, 24);
      body(8, 21);
      head(8, 12);
      px(3, 26, '#ff6b9d', 8, 3);
      px(4, 26, '#ffffff', 6, 1);
      px(12, 26, '#ffffff', 6, 1);
      px(12, 27, '#c04a72', 6, 1);
      px(11, 25, '#ffffff', 1, 1);
    },
    /** Book held up in both paws. */
    reading() {
      floor();
      shadow(14);
      tail(7, 25);
      body(8, 21);
      head(8, 12);
      px(7, 22, '#ff6b9d', 12, 4);
      px(8, 22, '#ffffff', 10, 1);
      px(12, 23, '#c04a72', 1, 3);
      px(6, 21, cream, 2, 2);
      px(18, 21, cream, 2, 2);
    },
    /** Pencil scratching at a sheet of paper. */
    notes() {
      floor();
      shadow(14);
      tail(7, 25);
      body(8, 21);
      head(9, 12);
      px(4, 27, '#ffffff', 12, 3);
      px(5, 28, '#a0a0b8', 4, 1);
      px(10, 28, '#a0a0b8', 5, 1);
      px(17, 20, '#ffb347', 1, 5);
      px(17, 25, ink, 1, 1);
    },
    /** Laptopped, with the screen glow washing over the face. */
    laptop() {
      floor();
      shadow(15);
      tail(7, 25);
      body(8, 22);
      head(8, 12);
      px(6, 22, '#2f2f45', 14, 6);
      px(7, 23, '#1d1d33', 12, 4);
      px(8, 24, '#6bffda', 5, 1);
      px(14, 25, '#7c6fff', 4, 1);
      px(8, 26, '#6bffda', 3, 1);
    },
    /** Shelf of books behind. */
    library() {
      px(0, 0, sky, W, H);
      px(1, 8, '#5a3f28', 24, 1);
      px(2, 9, '#c04a72', 3, 6);
      px(6, 9, '#4a7ac0', 3, 6);
      px(10, 9, '#6ba85a', 3, 6);
      px(14, 9, '#c07a3a', 3, 6);
      px(18, 9, '#8a5ac0', 3, 6);
      px(22, 9, '#c04a72', 2, 6);
      px(1, 15, '#5a3f28', 24, 1);
      floor();
      shadow(14);
      tail(7, 25);
      body(8, 21);
      head(8, 12);
      px(7, 22, '#e8d8a0', 12, 3);
      px(8, 23, '#8a7a50', 9, 1);
    },
    /** Face lit by a phone. */
    phone() {
      floor();
      shadow(14);
      tail(7, 25);
      body(8, 21);
      head(8, 12);
      px(17, 20, '#2f2f45', 3, 5);
      px(17, 21, '#8fd0ff', 2, 3);
      px(15, 19, '#6bffda', 2, 2);
      px(18, 24, cream, 2, 2);
    },
    /** Arched back mid-stretch. */
    stretch() {
      floor();
      shadow(15);
      px(7, 22, fur, 12, 3);
      px(8, 19, fur, 10, 3);
      px(6, 25, furD, 4, 2);
      px(16, 25, furD, 4, 2);
      tail(6, 20);
      head(14, 14);
    },
    /** Cup steaming beside a settled pet. */
    coffee() {
      floor();
      shadow(14);
      tail(7, 25);
      body(8, 21);
      head(8, 12);
      px(2, 25, '#ffffff', 5, 4);
      px(3, 26, '#6b4d1e', 3, 2);
      px(7, 26, '#ffffff', 1, 2);
      px(3, 23, '#c8c8d8', 1, 2);
      px(5, 22, '#c8c8d8', 1, 3);
    },
    /** Mid-stride, tail up. */
    walk() {
      floor();
      shadow(14);
      tail(7, 19);
      px(8, 18, fur, 10, 7);
      px(9, 25, fur, 2, 4);
      px(14, 25, fur, 2, 4);
      px(9, 28, furD, 2, 1);
      px(14, 28, furD, 2, 1);
      head(8, 10);
    },
    /** Bowl of food. */
    snack() {
      floor();
      shadow(14);
      tail(7, 25);
      body(8, 21);
      head(8, 12);
      px(1, 26, '#c04a72', 7, 3);
      px(2, 25, '#e0708a', 5, 1);
      px(3, 24, '#c07a3a', 1, 1);
      px(5, 24, '#c07a3a', 1, 1);
    },
    /** Headphones on, a note floating off. */
    music() {
      floor();
      shadow(14);
      tail(7, 25);
      body(8, 21);
      head(8, 12);
      px(6, 13, '#3a3a55', 2, 5);
      px(18, 13, '#3a3a55', 2, 5);
      px(6, 14, '#6bffda', 2, 2);
      px(18, 14, '#6bffda', 2, 2);
      px(7, 11, '#3a3a55', 12, 1);
      px(2, 6, '#6bffda', 1, 1);
      px(1, 5, '#6bffda', 3, 1);
      px(3, 4, '#6bffda', 1, 1);
    },
    /** Watching the weather through a window. */
    window() {
      px(0, 0, sky, W, H);
      px(2, 4, '#3a3a55', 22, 18);
      px(3, 5, '#2a4a7a', 20, 16);
      px(3, 5, '#5aa0e0', 20, 5);
      px(5, 7, '#ffffff', 4, 3);
      px(16, 6, '#ffffff', 3, 2);
      px(12, 4, '#3a3a55', 1, 18);
      px(2, 12, '#3a3a55', 22, 1);
      px(6, 22, '#5a3f28', 14, 2);
      shadow(14);
      tail(7, 26);
      body(8, 22);
      head(8, 13);
    },
  };

  px(0, 0, sky, W, H);
  (POSES[poseId] || POSES.desk)();
}
