import { store } from '../store.js';

/**
 * Nature and focus sounds, generated entirely with the Web Audio API.
 *
 * There are no audio files anywhere in this project — every sound is filtered
 * noise and oscillators, which means zero download weight, no licensing
 * questions, and it works offline forever.
 *
 * Each sound is a factory that takes (ctx, destination, intensity) and returns
 * a handle with stop() and setIntensity(). Only one sound plays at a time,
 * crossfaded through the master gain.
 */

let ctx = null;
let masterGain = null;
const active = new Map();     // id -> { node, stop, intensity }

export const SOUNDS = [
  { id: 'rain', group: 'Nature', name: 'Rain', icon: '🌧️', build: buildRain },
  { id: 'wind', group: 'Nature', name: 'Wind', icon: '🌬️', build: buildWind },
  { id: 'waves', group: 'Nature', name: 'Ocean', icon: '🌊', build: buildWaves },
  { id: 'fire', group: 'Nature', name: 'Campfire', icon: '🔥', build: buildFire },
  { id: 'birds', group: 'Nature', name: 'Birds', icon: '🐦', build: buildBirds },
  { id: 'crickets', group: 'Nature', name: 'Night', icon: '🦗', build: buildCrickets },
  { id: 'stream', group: 'Nature', name: 'Stream', icon: '🏞️', build: buildStream },

  { id: 'brown', group: 'Focus', name: 'Brown noise', icon: '🟤', build: buildBrownNoise },
  { id: 'white', group: 'Focus', name: 'White noise', icon: '⚪', build: buildWhiteNoise },
  { id: 'cafe', group: 'Focus', name: 'Cafe', icon: '☕', build: buildCafe },
  { id: 'hum', group: 'Focus', name: '40 Hz hum', icon: '〰️', build: buildHum },
  { id: 'tick', group: 'Focus', name: 'Clock', icon: '🕰️', build: buildTick },
  { id: 'fan', group: 'Focus', name: 'Fan', icon: '🌀', build: buildFan },
];

export const soundById = (id) => SOUNDS.find((s) => s.id === id);

// ── context lifecycle ────────────────────────────────────────────────────

/**
 * Creates the AudioContext lazily and resumes it.
 *
 * Browsers block audio until a real user gesture, so this must be called from
 * a click handler the first time, and the promise is awaited before anything
 * is scheduled.
 */
export async function ensureContext() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('This browser does not support the Web Audio API.');
    ctx = new AudioCtx();
    masterGain = ctx.createGain();
    masterGain.gain.value = store.sounds.master;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

export function setMasterVolume(value) {
  store.sounds.master = Math.max(0, Math.min(1, value));
  if (masterGain) masterGain.gain.setTargetAtTime(store.sounds.master, ctx.currentTime, 0.05);
}

export const currentSoundId = () => [...active.keys()][0] || null;

// ── playback ─────────────────────────────────────────────────────────────

const CROSSFADE = 0.4;

/** Starts a sound, stopping whatever was playing before it. */
export async function playSound(id, intensity = store.sounds.intensity) {
  const sound = soundById(id);
  if (!sound) return;
  await ensureContext();
  stopAll();

  const level = Math.max(0, Math.min(1, intensity));
  const gain = ctx.createGain();
  // Fade in so switching sounds is not a click.
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), ctx.currentTime + CROSSFADE);
  gain.connect(masterGain);

  const handle = sound.build(ctx, gain, level);
  active.set(id, {
    gain,
    ...handle,
    setIntensity: (next) => {
      const v = Math.max(0, Math.min(1, next));
      gain.gain.setTargetAtTime(Math.max(0.0002, v), ctx.currentTime, 0.08);
      handle.setIntensity?.(v);
    },
  });
  store.sounds.current = id;
  store.sounds.intensity = level;
  return active.get(id);
}

export function setIntensity(id, value) {
  active.get(id)?.setIntensity(value);
  if (id === currentSoundId()) store.sounds.intensity = value;
}

export function stopAll() {
  for (const [id, handle] of active) {
    try {
      const now = ctx.currentTime;
      handle.gain.gain.cancelScheduledValues(now);
      handle.gain.gain.setTargetAtTime(0.0001, now, CROSSFADE / 3);
      // Tear the source graph down a moment later, once the fade is done.
      setTimeout(() => handle.stop?.(), CROSSFADE * 1000 + 120);
    } catch { /* already stopped */ }
    active.delete(id);
  }
  store.sounds.current = null;
}

// ── building blocks ──────────────────────────────────────────────────────

/** A reusable looping noise buffer. */
function noiseBuffer(context, seconds = 4, kind = 'white') {
  const length = context.sampleRate * seconds;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);

  if (kind === 'brown') {
    // Integrated white noise: a simple low-pass with a leaky integrator.
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  } else if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
  } else {
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

/** Wraps a filter with an LFO on its cutoff so the texture never sits still. */
function lfo(context, target, rate, depth, base) {
  const osc = context.createOscillator();
  const amp = context.createGain();
  osc.type = 'sine';
  osc.frequency.value = rate;
  amp.gain.value = depth;
  osc.connect(amp);
  amp.connect(target);
  if (base !== undefined) target.value = base;
  osc.start();
  return { osc, amp };
}

// ── nature ───────────────────────────────────────────────────────────────

/** Rain: hissy high band plus a soft low bed, with slow level drift. */
function buildRain(context, out, level) {
  const hiss = noiseBuffer(context, 4, 'white');
  const band = context.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1400;
  band.Q.value = 0.5;
  const hissGain = context.createGain();
  hissGain.gain.value = 0.55;

  const body = noiseBuffer(context, 4, 'pink');
  const low = context.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 480;
  const bodyGain = context.createGain();
  bodyGain.gain.value = 0.5;

  hiss.connect(band); band.connect(hissGain); hissGain.connect(out);
  body.connect(low); low.connect(bodyGain); bodyGain.connect(out);
  hiss.start(); body.start();

  const drift = lfo(context, hissGain.gain, 0.08, 0.18, 0.55);
  return {
    stop: () => { hiss.stop(); body.stop(); drift.osc.stop(); },
    setIntensity: (v) => { low.frequency.value = 320 + v * 420; },
  };
}

/** Wind: a resonant lowpass on noise with a slow, wide sweep. */
function buildWind(context, out, level) {
  const src = noiseBuffer(context, 6, 'pink');
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 520;
  filter.Q.value = 3.5;
  const gain = context.createGain();
  gain.gain.value = 0.75;

  src.connect(filter); filter.connect(gain); gain.connect(out);
  src.start();

  const sweep = lfo(context, filter.frequency, 0.055, 380, 520);
  const amp = lfo(context, gain.gain, 0.09, 0.3, 0.75);
  return {
    stop: () => { src.stop(); sweep.osc.stop(); amp.osc.stop(); },
    setIntensity: (v) => { filter.Q.value = 2 + v * 4; },
  };
}

/** Ocean: noise gated by a slow swell, with a brighter crest on each wave. */
function buildWaves(context, out, level) {
  const src = noiseBuffer(context, 6, 'brown');
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 900;
  const gain = context.createGain();
  gain.gain.value = 0.5;

  src.connect(filter); filter.connect(gain); gain.connect(out);
  src.start();

  // Two out-of-phase LFOs give an irregular swell rather than a metronome.
  const swell = lfo(context, gain.gain, 0.11, 0.34, 0.5);
  const crest = lfo(context, filter.frequency, 0.07, 620, 900);
  return {
    stop: () => { src.stop(); swell.osc.stop(); crest.osc.stop(); },
    setIntensity: (v) => { filter.frequency.value = 500 + v * 900; },
  };
}

/** Campfire: filtered brown noise plus randomly scheduled crackle pops. */
function buildFire(context, out, level) {
  const bed = noiseBuffer(context, 4, 'brown');
  const low = context.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 700;
  const bedGain = context.createGain();
  bedGain.gain.value = 0.42;
  bed.connect(low); low.connect(bedGain); bedGain.connect(out);
  bed.start();

  let stopped = false;
  const crackle = () => {
    if (stopped) return;
    // A short, fast-decaying noise burst reads as a pop.
    const burst = noiseBuffer(context, 0.06, 'white');
    const burstGain = context.createGain();
    const now = context.currentTime;
    burstGain.gain.setValueAtTime(0.5 + Math.random() * 0.5, now);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    const bp = context.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200 + Math.random() * 2600;
    bp.Q.value = 2;
    burst.connect(bp); bp.connect(burstGain); burstGain.connect(out);
    burst.start(now);
    burst.stop(now + 0.09);
    setTimeout(crackle, 90 + Math.random() * 420);
  };
  crackle();

  const flicker = lfo(context, bedGain.gain, 0.6, 0.1, 0.42);
  return {
    stop: () => { stopped = true; bed.stop(); flicker.osc.stop(); },
    setIntensity: (v) => { low.frequency.value = 400 + v * 700; },
  };
}

/** Birds: sparse scheduled sine chirps over a quiet outdoor bed. */
function buildBirds(context, out, level) {
  const air = noiseBuffer(context, 4, 'pink');
  const airFilter = context.createBiquadFilter();
  airFilter.type = 'lowpass';
  airFilter.frequency.value = 320;
  const airGain = context.createGain();
  airGain.gain.value = 0.16;
  air.connect(airFilter); airFilter.connect(airGain); airGain.connect(out);
  air.start();

  let stopped = false;
  const chirp = () => {
    if (stopped) return;
    const now = context.currentTime;
    // A chirp is a fast frequency ramp on a short sine, repeated a few times.
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i += 1) {
      const t = now + i * 0.11;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      const base = 1800 + Math.random() * 1600;
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * (0.7 + Math.random() * 0.7), t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      osc.connect(gain); gain.connect(out);
      osc.start(t);
      osc.stop(t + 0.12);
    }
    setTimeout(chirp, 700 + Math.random() * 2600);
  };
  setTimeout(chirp, 400);

  return {
    stop: () => { stopped = true; air.stop(); },
    setIntensity: () => {},
  };
}

/** Night: crickets — repeating high pulses plus a very quiet air bed. */
function buildCrickets(context, out, level) {
  const air = noiseBuffer(context, 4, 'brown');
  const airFilter = context.createBiquadFilter();
  airFilter.type = 'lowpass';
  airFilter.frequency.value = 220;
  const airGain = context.createGain();
  airGain.gain.value = 0.2;
  air.connect(airFilter); airFilter.connect(airGain); airGain.connect(out);
  air.start();

  let stopped = false;
  const pulse = () => {
    if (stopped) return;
    const now = context.currentTime;
    // Three rapid chirps, which is the shape a cricket actually makes.
    for (let i = 0; i < 3; i += 1) {
      const t = now + i * 0.07;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'square';
      osc.frequency.value = 4200 + Math.random() * 600;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.07, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      osc.connect(gain); gain.connect(out);
      osc.start(t);
      osc.stop(t + 0.05);
    }
    setTimeout(pulse, 400 + Math.random() * 900);
  };
  setTimeout(pulse, 200);

  return {
    stop: () => { stopped = true; air.stop(); },
    setIntensity: (v) => { airGain.gain.value = 0.1 + v * 0.2; },
  };
}

/** Stream: bright bandpassed noise with a fast shimmer on top. */
function buildStream(context, out, level) {
  const base = noiseBuffer(context, 4, 'white');
  const band = context.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2400;
  band.Q.value = 0.8;
  const gain = context.createGain();
  gain.gain.value = 0.4;
  base.connect(band); band.connect(gain); gain.connect(out);
  base.start();

  const trickle = noiseBuffer(context, 4, 'white');
  const tFilter = context.createBiquadFilter();
  tFilter.type = 'bandpass';
  tFilter.frequency.value = 5200;
  tFilter.Q.value = 1.4;
  const tGain = context.createGain();
  tGain.gain.value = 0.14;
  trickle.connect(tFilter); tFilter.connect(tGain); tGain.connect(out);
  trickle.start();

  const shimmer = lfo(context, tGain.gain, 0.35, 0.07, 0.14);
  return {
    stop: () => { base.stop(); trickle.stop(); shimmer.osc.stop(); },
    setIntensity: (v) => { band.frequency.value = 1600 + v * 1800; },
  };
}

// ── focus ────────────────────────────────────────────────────────────────

function buildBrownNoise(context, out) {
  const src = noiseBuffer(context, 6, 'brown');
  const gain = context.createGain();
  gain.gain.value = 0.8;
  src.connect(gain); gain.connect(out);
  src.start();
  return { stop: () => src.stop() };
}

function buildWhiteNoise(context, out) {
  const src = noiseBuffer(context, 6, 'white');
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 6000;
  const gain = context.createGain();
  gain.gain.value = 0.35;
  src.connect(filter); filter.connect(gain); gain.connect(out);
  src.start();
  return { stop: () => src.stop(), setIntensity: (v) => { filter.frequency.value = 3000 + v * 5000; } };
}

/** Cafe: bandpassed noise bed plus low, irregular "murmur" chatter. */
function buildCafe(context, out, level) {
  const room = noiseBuffer(context, 5, 'pink');
  const roomFilter = context.createBiquadFilter();
  roomFilter.type = 'bandpass';
  roomFilter.frequency.value = 700;
  roomFilter.Q.value = 0.6;
  const roomGain = context.createGain();
  roomGain.gain.value = 0.32;
  room.connect(roomFilter); roomFilter.connect(roomGain); roomGain.connect(out);
  room.start();

  let stopped = false;
  const chatter = () => {
    if (stopped) return;
    const now = context.currentTime;
    // A short band of moving formant-ish noise reads as indistinct speech.
    const dur = 0.25 + Math.random() * 0.6;
    const voice = noiseBuffer(context, dur, 'pink');
    const formant = context.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = 300 + Math.random() * 900;
    formant.Q.value = 4 + Math.random() * 6;
    const voiceGain = context.createGain();
    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.exponentialRampToValueAtTime(0.1 + Math.random() * 0.07, now + 0.08);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    voice.connect(formant); formant.connect(voiceGain); voiceGain.connect(out);
    voice.start(now);
    voice.stop(now + dur + 0.02);
    setTimeout(chatter, 250 + Math.random() * 900);
  };
  setTimeout(chatter, 300);

  return {
    stop: () => { stopped = true; room.stop(); },
    setIntensity: (v) => { roomFilter.frequency.value = 400 + v * 800; },
  };
}

/** 40 Hz hum with its octave, the classic deep-focus drone. */
function buildHum(context, out, level) {
  const gain = context.createGain();
  gain.gain.value = 0.3;
  gain.connect(out);

  const osc40 = context.createOscillator();
  const osc80 = context.createOscillator();
  const g40 = context.createGain();
  const g80 = context.createGain();
  g40.gain.value = 0.6;
  g80.gain.value = 0.22;
  osc40.type = 'sine';
  osc80.type = 'sine';
  osc40.frequency.value = 40;
  osc80.frequency.value = 80;
  osc40.connect(g40); g40.connect(gain);
  osc80.connect(g80); g80.connect(gain);
  osc40.start(); osc80.start();

  const swell = lfo(context, gain.gain, 0.07, 0.08, 0.3);
  return {
    stop: () => { osc40.stop(); osc80.stop(); swell.osc.stop(); },
    setIntensity: (v) => { g80.gain.value = 0.1 + v * 0.2; },
  };
}

/** Clock: a filtered noise tick on a steady one-second beat. */
function buildTick(context, out, level) {
  let stopped = false;
  const click = () => {
    if (stopped) return;
    const now = context.currentTime;
    const src = noiseBuffer(context, 0.03, 'white');
    const bp = context.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 8;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    src.connect(bp); bp.connect(gain); gain.connect(out);
    src.start(now);
    src.stop(now + 0.06);
    setTimeout(click, 1000);
  };
  setTimeout(click, 120);
  return { stop: () => { stopped = true; } };
}

/** Fan: a low hum plus broadband air, the classic steady room tone. */
function buildFan(context, out, level) {
  const air = noiseBuffer(context, 5, 'pink');
  const airFilter = context.createBiquadFilter();
  airFilter.type = 'lowpass';
  airFilter.frequency.value = 900;
  const airGain = context.createGain();
  airGain.gain.value = 0.4;
  air.connect(airFilter); airFilter.connect(airGain); airGain.connect(out);
  air.start();

  const motor = context.createOscillator();
  const motorGain = context.createGain();
  motor.type = 'triangle';
  motor.frequency.value = 118;
  motorGain.gain.value = 0.06;
  motor.connect(motorGain); motorGain.connect(out);
  motor.start();

  const wobble = lfo(context, motorGain.gain, 0.4, 0.02, 0.06);
  return {
    stop: () => { air.stop(); motor.stop(); wobble.osc.stop(); },
    setIntensity: (v) => { airFilter.frequency.value = 500 + v * 1100; },
  };
}
