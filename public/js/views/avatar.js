import { el, toast } from '../ui.js';
import { store, saveProfile, avatar as currentAvatar } from '../store.js';
import { drawPose, poseList, POSES, GRID } from '../avatar.js';
import { PETS, isPet, petName } from '../pets.js';
import { timer } from '../timer.js';

const SKINS = ['#f5c5a3', '#d4956a', '#b06a38', '#7a3d1a', '#f0d0b0', '#e8a882'];
const HAIRS = ['#4a2c2a', '#f4c542', '#1a1a1a', '#c05030', '#8b5e83', '#a0c0ff', '#80ffcc', '#ff8888'];
const OUTFITS = ['#7c6fff', '#ff6b9d', '#6bffda', '#ffb347', '#ff5555', '#44aaff', '#aaffaa', '#ffaaff'];
const BACKDROPS = [
  { id: 'default', name: 'Night', bg: 'linear-gradient(160deg,#1b1b34,#262640)' },
  { id: 'library', name: 'Library', bg: 'linear-gradient(160deg,#2a2038,#3b2b45)' },
  { id: 'cafe', name: 'Cafe', bg: 'linear-gradient(160deg,#2e2418,#3f3020)' },
  { id: 'park', name: 'Park', bg: 'linear-gradient(160deg,#16281c,#22392a)' },
  { id: 'space', name: 'Space', bg: 'linear-gradient(160deg,#10102a,#1c1c42)' },
];

let host = null;
let panel = null;
let frame = 0;
let ticker = null;

export const avatarSection = {
  mount(container, ctx = {}) {
    host = container;
    panel = ctx.panel || null;
    render();

    // The stage animates continuously; the pose pickers redraw on demand.
    clearInterval(ticker);
    ticker = setInterval(() => {
      frame += 1;
      paintStage();
    }, 120);
  },
  unmount() { clearInterval(ticker); },
  sidePanel: avatarSidePanel,
};

const stageCanvas = el('canvas', {
  width: GRID.W * GRID.S,
  height: GRID.H * GRID.S,
  style: { width: '156px', height: `${Math.round((156 * GRID.H) / GRID.W)}px` },
});

function activePose() {
  const a = currentAvatar();
  return timer.isBreak ? (a.breakPose || 'coffee') : (a.focusPose || 'desk');
}

function paintStage() {
  drawPose(stageCanvas, currentAvatar(), activePose(), frame);
}

function render() {
  const pet = isPet(currentAvatar());
  host.innerHTML = '';
  host.append(el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: pet ? 'COMPANION' : 'AVATAR' }),
      el('div', { class: 'pane-sub', text: 'Poses switch automatically between focus and break sessions.' }),
    ]),
    el('div', { class: 'ava-layout' }, [
      el('div', { class: 'ava-stage' }, [
        stageCanvas,
        el('div', { class: 'ava-stage-label', text: timer.isBreak ? 'ON BREAK' : 'FOCUSING' }),
        el('div', { class: 'ava-stage-sub', text: pet
          ? `Your ${petName(currentAvatar()).toLowerCase()} floats over the timer.`
          : 'The same avatar floats over the timer.' }),
      ]),
      el('div', {}, [
        el('div', { class: 'sect-hd', text: 'FOCUS POSES' }),
        el('div', { class: 'pose-grid' }, poseList('focus').map((pose) => poseButton('focus', pose))),
        el('div', { class: 'sect-hd', text: 'BREAK POSES' }),
        el('div', { class: 'pose-grid' }, poseList('break').map((pose) => poseButton('break', pose))),
        el('div', { class: 'sect-hd', text: 'PRESETS' }),
        presetRow(),
      ]),
    ]),
  ]));

  // The customiser also lives in the side panel, but it cannot live only there:
  // the panel is display:none below 900px and disappears when collapsed, which
  // left a phone with no way to change anything about their avatar at all.
  host.append(el('div', { class: 'pane' }, [
    el('div', { class: 'sect-hd', text: 'CUSTOMISE' }),
    el('div', { class: 'pane-sub', style: { marginBottom: '12px' }, text: 'Everything below also appears in the panel on the right.' }),
    el('div', { class: 'ava-customiser' }, avatarCustomiser()),
  ]));

  paintStage();
}

function poseButton(kind, pose) {
  const selected = kind === 'break'
    ? (currentAvatar().breakPose === pose.id)
    : (currentAvatar().focusPose === pose.id);

  const canvas = el('canvas', { width: GRID.W * GRID.S, height: GRID.H * GRID.S });
  canvas.style.width = '42px';
  canvas.style.height = `${Math.round((42 * GRID.H) / GRID.W)}px`;
  drawPose(canvas, currentAvatar(), pose.id, 0);

  return el('button', {
    class: `pose-btn${selected ? ' active' : ''}`,
    'aria-pressed': String(selected),
    onclick: async () => {
      await saveProfile({ avatar: { ...currentAvatar(), [kind === 'break' ? 'breakPose' : 'focusPose']: pose.id } });
      render();
      renderSidePanelInto();
      toast(`${pose.name} pose selected`);
    },
  }, [canvas, el('div', { class: 'pose-btn-name', text: pose.name })]);
}

function presetRow() {
  const saved = currentAvatar().presets || [];
  return el('div', { class: 'preset-row' },
    Array.from({ length: 3 }, (_, i) => {
      const slot = el('button', {
        class: `preset-slot${saved[i] ? ' filled' : ''}`,
        title: saved[i] ? `Load preset ${i + 1}` : `Save the current look into slot ${i + 1}`,
        onclick: async () => {
          const next = [...saved];
          if (next[i]) {
            // A filled slot loads its look back.
            await saveProfile({ avatar: { ...next[i], presets: next } });
            toast(`Preset ${i + 1} loaded`);
          } else {
            // An empty slot captures the current look.
            const { presets: _drop, ...look } = currentAvatar();
            next[i] = look;
            await saveProfile({ avatar: { ...currentAvatar(), presets: next } });
            toast(`Preset ${i + 1} saved`);
          }
          render();
          renderSidePanelInto();
        },
      });
      if (saved[i]) {
        const canvas = el('canvas', { width: GRID.W * GRID.S, height: GRID.H * GRID.S });
        canvas.style.width = '38px';
        canvas.style.height = `${Math.round((38 * GRID.H) / GRID.W)}px`;
        drawPose(canvas, saved[i], saved[i].focusPose || 'desk', 0);
        slot.append(canvas);
      } else {
        slot.append(el('div', { class: 'slot-hint', text: `slot ${i + 1}` }));
      }
      return slot;
    }));
}

// ── the customiser ───────────────────────────────────────────────────────

/**
 * Builds the customiser controls.
 *
 * Returns a fresh array of nodes on every call rather than appending to one
 * container, because it is rendered in two places at once — the main pane and
 * the right panel. Nothing here may carry an `id`: the same builder runs twice
 * on the same page, and a duplicate id would break label association and
 * `#id` lookups for whichever copy mounted second.
 */
function avatarCustomiser() {
  const nodes = [];
  const push = (...items) => { nodes.push(...items); };

  const a = currentAvatar();
  const pet = isPet(a);

  const patch = async (changes, message) => {
    try {
      await saveProfile({ avatar: { ...currentAvatar(), ...changes } });
      render();
      renderSidePanelInto();
      if (message) toast(message);
    } catch (err) {
      toast(err.message || 'Could not save', 3000);
    }
  };

  push(el('div', { class: 'sect-hd', text: 'COMPANION' }));
  push(el('div', { class: 'opt-row' }, [
    el('button', {
      class: `opt-btn${!pet ? ' active' : ''}`,
      text: '🧑 Person',
      onclick: () => patch({ companion: 'none' }),
    }),
    ...PETS.map((p) => el('button', {
      class: `opt-btn${a.companion === p.id ? ' active' : ''}`,
      text: `${p.emoji} ${p.name}`,
      onclick: () => patch({ companion: p.id }, `${p.name} companion selected`),
    })),
  ]));
  push(el('div', {
    class: 'pane-sub',
    style: { marginTop: '6px' },
    text: pet
      ? `A ${petName(a).toLowerCase()} takes the avatar's place everywhere it appears. Fur colour follows the outfit swatch.`
      : 'Swap the person for a pixel pet that focuses and breaks alongside you.',
  }));

  // Everything below the companion choice only applies to a person avatar.
  if (!pet) {
    push(el('div', { class: 'sect-hd', text: 'GENDER' }));
    push(el('div', { class: 'opt-row' }, ['female', 'male'].map((g) => el('button', {
      class: `opt-btn${a.gender === g ? ' active' : ''}`,
      text: g === 'female' ? 'Female' : 'Male',
      onclick: () => patch({ gender: g }),
    }))));

    push(el('div', { class: 'sect-hd', text: 'HAT' }));
    push(el('div', { class: 'opt-row' },
      [['none', 'None'], ['cap', 'Cap'], ['beanie', 'Beanie'], ['headphones', 'Headphones']].map(([v, label]) => el('button', {
        class: `opt-btn${(a.hat || 'none') === v ? ' active' : ''}`,
        text: label,
        onclick: () => patch({ hat: v }),
      }))));

    push(el('div', { class: 'sect-hd', text: 'SKIN TONE' }));
    push(swatchRow(SKINS, a.skin, (c) => patch({ skin: c })));

    push(el('div', { class: 'sect-hd', text: 'HAIR COLOUR' }));
    push(swatchRow(HAIRS, a.hair, (c) => patch({ hair: c })));
  }  // end person-only options

  // The outfit swatch doubles as fur colour, so it stays for both subjects.
  push(el('div', { class: 'sect-hd', text: pet ? 'FUR COLOUR' : 'OUTFIT' }));
  push(swatchRow(OUTFITS, a.outfit, (c) => patch({ outfit: c })));

  push(el('div', { class: 'sect-hd', text: 'BACKDROP' }));
  push(el('div', { class: 'swatch-row' }, BACKDROPS.map((b) => el('div', {
    class: `backdrop-tile${(a.backdrop || 'default') === b.id ? ' active' : ''}`,
    style: { background: b.bg },
    title: b.name,
    role: 'button',
    tabindex: '0',
    onclick: () => patch({ backdrop: b.id }),
    onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); patch({ backdrop: b.id }); } },
  }, [document.createTextNode(b.name)]))));

  push(el('div', { class: 'sect-hd', text: 'EXTRAS' }));
  push(el('div', { class: 'opt-row' }, [
    pet ? null : el('button', {
      class: `opt-btn${a.glasses ? ' active' : ''}`,
      text: '👓 Glasses',
      onclick: () => patch({ glasses: !a.glasses }),
    }),
    el('button', {
      class: `opt-btn${a.outline === false ? ' active' : ''}`,
      text: '▢ No outline',
      onclick: () => patch({ outline: a.outline === false }),
    }),
  ].filter(Boolean)));

  push(el('div', { class: 'sect-hd', text: 'PRESET' }));
  push(el('button', {
    class: 'btn block', text: '🎲 Randomise',
    onclick: () => patch(pet ? {
      outfit: pick(OUTFITS),
      backdrop: pick(BACKDROPS).id,
    } : {
      skin: pick(SKINS),
      hair: pick(HAIRS),
      outfit: pick(OUTFITS),
      gender: Math.random() > 0.5 ? 'female' : 'male',
      backdrop: pick(BACKDROPS).id,
    }, 'New look'),
  }));

  push(el('div', {
    class: 'pane-sub',
    style: { marginTop: '12px', lineHeight: '1.7' },
    text: pet
      ? `${POSES.focus.length} focus and ${POSES.break.length} break poses, all reinterpreted for your ${petName(a).toLowerCase()}. The floating companion follows whichever you picked for the current kind of session.`
      : `${POSES.focus.length} focus and ${POSES.break.length} break poses. The floating avatar follows whichever you picked for the current kind of session.`,
  }));

  return nodes;
}

export function avatarSidePanel(body) {
  panel = body;
  renderSidePanelInto();
}

function renderSidePanelInto() {
  if (!panel) return;
  panel.innerHTML = '';
  for (const node of avatarCustomiser()) panel.append(node);
}

function swatchRow(colors, selected, onPick) {
  return el('div', { class: 'swatch-row' }, colors.map((c) => el('div', {
    class: `color-swatch${c === selected ? ' active' : ''}`,
    style: { background: c },
    role: 'button',
    tabindex: '0',
    'aria-label': `Colour ${c}`,
    onclick: () => onPick(c),
    onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPick(c); } },
  })));
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
