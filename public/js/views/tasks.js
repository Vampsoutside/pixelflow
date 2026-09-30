import { el, toast } from '../ui.js';
import { api } from '../api.js';

const COLORS = ['#7c6fff', '#ff6b9d', '#6bffda', '#ffb347', '#ff5555', '#44aaff', '#aaffaa', '#ffaaff'];

let data = { tags: [], tasks: [] };
const filter = { selected: new Set(), mode: 'AND' };   // AND = task must have all
let host = null;
let panel = null;
let onChange = () => {};

async function load() {
  data = await api.get('/api/tasks');
  render();
  if (panel) tasksSidePanel(panel);
}

/** AND = a task must carry every selected tag; OR = any one of them. */
function visibleTasks() {
  if (filter.selected.size === 0) return data.tasks;
  const ids = [...filter.selected];
  return data.tasks.filter((task) => {
    const own = task.tags.map((t) => t.id);
    return filter.mode === 'AND'
      ? ids.every((id) => own.includes(id))
      : ids.some((id) => own.includes(id));
  });
}

export const tasksSection = {
  async mount(container, ctx = {}) {
    host = container;
    onChange = ctx.onChange || (() => {});
    await load();
    // navigate() paints the side panel before mount() has any data, so the
    // tag manager is refreshed here once the tags have actually loaded.
    if (panel) tasksSidePanel(panel);
  },
  unmount() { panel = null; },
  reload: load,
  sidePanel: tasksSidePanel,
  COLORS,
};

// ── main pane ─────────────────────────────────────────────────────────────

function render() {
  host.innerHTML = '';

  const input = el('input', {
    class: 'inp',
    placeholder: 'Add a task, then press Enter…',
    maxlength: '240',
    onkeydown: async (event) => {
      if (event.key !== 'Enter') return;
      const text = event.currentTarget.value.trim();
      if (!text) return;
      event.currentTarget.value = '';
      try {
        await api.post('/api/tasks', { text });
        await load();
        onChange();
      } catch (err) {
        toast(err.message || 'Could not add that task', 3000);
      }
    },
  });

  host.append(el('div', { class: 'pane' }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'TASKS' }),
      el('div', { class: 'pane-sub', text: `${data.tasks.filter((t) => !t.done).length} open · ${data.tasks.filter((t) => t.done).length} done` }),
    ]),
    el('div', { class: 'task-add-row' }, [
      input,
      el('button', {
        class: 't-add', text: '+', 'aria-label': 'Add task',
        onclick: () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })),
      }),
    ]),
    renderTagBar(),
    el('div', {}, visibleTasks().map(taskCard)),
    visibleTasks().length === 0
      ? el('div', {
        class: 'empty',
        text: data.tasks.length === 0
          ? 'No tasks yet. Add one above and give it a tag.'
          : 'No tasks match these tags.',
      })
      : null,
  ]));
}

function renderTagBar() {
  if (data.tags.length === 0) return null;
  return el('div', { class: 'tag-bar' }, [
    el('span', { class: 'tag-bar-label', text: 'Tags' }),
    ...data.tags.map((tag) => {
      const selected = filter.selected.has(tag.id);
      return el('button', {
        class: 'tag-pill',
        'aria-pressed': String(selected),
        style: selected ? { background: tag.color, borderColor: tag.color, color: '#12121f' } : {},
        onclick: () => {
          if (filter.selected.has(tag.id)) filter.selected.delete(tag.id);
          else filter.selected.add(tag.id);
          render();
        },
      }, [
        el('i', { class: 'dot', style: { background: tag.color } }),
        document.createTextNode(tag.name),
        el('span', { class: 'count', text: `${tag.done}/${tag.total}` }),
      ]);
    }),
    el('div', { class: 'match-toggle', title: 'Match tasks that have all selected tags, or any of them' }, [
      el('button', {
        class: filter.mode === 'AND' ? 'active' : '',
        text: 'ALL',
        onclick: () => { filter.mode = 'AND'; render(); },
      }),
      el('button', {
        class: filter.mode === 'OR' ? 'active' : '',
        text: 'ANY',
        onclick: () => { filter.mode = 'OR'; render(); },
      }),
    ]),
  ]);
}

function taskCard(task) {
  const chk = el('div', { class: 'task-chk', text: task.done ? '✓' : '', role: 'checkbox', 'aria-checked': String(task.done) });
  chk.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await api.put(`/api/tasks/${task.id}`, { done: !task.done });
      await load();
      onChange();
    } catch (err) {
      toast(err.message || 'Could not update that task', 3000);
    }
  });

  // Clicking a tag on the card toggles it in the filter, which is quicker than
  // hunting for it in the bar above.
  const tagNodes = task.tags.map((tag) => el('span', {
    class: 'task-tag',
    style: { color: tag.color },
    title: `Filter by ${tag.name}`,
    onclick: (event) => {
      event.stopPropagation();
      if (filter.selected.has(tag.id)) filter.selected.delete(tag.id);
      else filter.selected.add(tag.id);
      render();
    },
  }, [el('i', { class: 'dot', style: { background: tag.color } }), document.createTextNode(tag.name)]));

  const card = el('div', { class: `task-card${task.done ? ' done' : ''}` }, [
    chk,
    el('div', { class: 'task-main' }, [
      el('div', { class: 'task-txt', text: task.text }),
      tagNodes.length ? el('div', { class: 'task-tags' }, tagNodes) : null,
    ]),
    el('button', {
      class: 'task-x', text: '×', 'aria-label': `Delete ${task.text}`,
      onclick: async (event) => {
        event.stopPropagation();
        try {
          await api.del(`/api/tasks/${task.id}`);
          await load();
          onChange();
        } catch (err) {
          toast(err.message || 'Could not delete that task', 3000);
        }
      },
    }),
  ]);

  // The card body (not the checkbox or the delete button) opens the tag editor.
  card.querySelector('.task-main').addEventListener('click', () => openTagPicker(task));
  return card;
}

/** A small inline panel for choosing which tags apply to one task. */
function openTagPicker(task) {
  const existing = host.querySelector('.tag-editor');
  if (existing) existing.remove();

  const chosen = new Set(task.tags.map((t) => t.id));
  const editor = el('div', { class: 'pane tag-editor', style: { borderColor: 'rgba(124,111,255,.4)' } }, [
    el('div', { class: 'pane-hd' }, [
      el('div', { class: 'pane-title', text: 'TAGS FOR THIS TASK' }),
      el('button', { class: 'btn small ghost', text: 'Done', onclick: () => editor.remove() }),
    ]),
    el('div', { class: 'pane-sub', style: { marginBottom: '10px' }, text: task.text }),
    el('div', { class: 'chip-row' }, [
      ...data.tags.map((tag) => {
        const chip = el('button', {
          class: `chip${chosen.has(tag.id) ? ' active' : ''}`,
          style: chosen.has(tag.id) ? { background: tag.color, color: '#12121f', borderColor: tag.color } : {},
          onclick: () => {
            if (chosen.has(tag.id)) chosen.delete(tag.id);
            else chosen.add(tag.id);
            chip.className = `chip${chosen.has(tag.id) ? ' active' : ''}`;
            if (chosen.has(tag.id)) {
              chip.style.background = tag.color;
              chip.style.color = '#12121f';
              chip.style.borderColor = tag.color;
            } else {
              chip.style.background = '';
              chip.style.color = '';
              chip.style.borderColor = '';
            }
          },
        }, [
          el('i', { class: 'dot', style: { width: '7px', height: '7px', borderRadius: '50%', background: tag.color, display: 'inline-block' } }),
          document.createTextNode(tag.name),
        ]);
        return chip;
      }),
      data.tags.length === 0 ? el('span', { class: 'pane-sub', text: 'Create tags in the panel on the right first.' }) : null,
    ]),
    el('button', {
      class: 'btn primary block', text: 'Apply', style: { marginTop: '12px' },
      onclick: async () => {
        try {
          await api.put(`/api/tasks/${task.id}`, { tagIds: [...chosen] });
          await load();
          onChange();
          editor.remove();
        } catch (err) {
          toast(err.message || 'Could not update tags', 3000);
        }
      },
    }),
  ]);

  host.append(editor);
  editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── right panel: the tag manager ──────────────────────────────────────────

export function tasksSidePanel(body) {
  panel = body;
  body.innerHTML = '';
  const newInput = el('input', {
    class: 'inp',
    placeholder: 'New tag name…',
    maxlength: '32',
    onkeydown: async (event) => {
      if (event.key !== 'Enter') submit();
    },
  });

  let newColor = COLORS[0];
  const colorRow = el('div', { class: 'color-grid', style: { marginBottom: '8px' } },
    COLORS.map((c) => el('div', {
      class: `color-dot${c === newColor ? ' active' : ''}`,
      style: { background: c },
      role: 'button', tabindex: '0', 'aria-label': `Colour ${c}`,
      onclick: () => {
        newColor = c;
        [...colorRow.children].forEach((n) => n.classList.remove('active'));
        colorRow.querySelector(`[aria-label="Colour ${c}"]`).classList.add('active');
      },
    })));

  async function submit() {
    const name = newInput.value.trim();
    if (!name) return;
    try {
      await api.post('/api/tags', { name, color: newColor });
      newInput.value = '';
      await load();
      onChange();
    } catch (err) {
      toast(err.message || 'Could not create that tag', 3000);
    }
  }

  body.append(el('div', { class: 'tag-create' }, [
    newInput,
    el('button', { class: 'btn primary', text: 'Add', onclick: submit }),
  ]));
  body.append(colorRow);

  if (data.tags.length === 0) {
    body.append(el('div', { class: 'empty', text: 'No tags yet. Create a few to group your tasks.' }));
    return;
  }

  body.append(el('div', { class: 'sect-hd', text: 'YOUR TAGS' }));
  for (const tag of data.tags) {
    const pct = tag.total > 0 ? tag.done / tag.total : 0;
    body.append(el('div', { class: 'tag-manager-item' }, [
      el('div', {
        class: 'tag-swatch',
        style: { background: tag.color },
        title: 'Change colour',
        onclick: () => {
          const next = COLORS[(COLORS.indexOf(tag.color) + 1) % COLORS.length];
          api.put(`/api/tags/${tag.id}`, { color: next })
            .then(load)
            .catch((err) => toast(err.message || 'Could not change the colour', 3000));
        },
      }),
      el('div', { class: 'tag-manager-body' }, [
        el('div', { class: 'tag-manager-name', text: tag.name }),
        el('div', { class: 'bar tag-manager-bar' }, [
          el('div', {
            class: `bar-fill${pct >= 1 ? ' met' : ''}`,
            style: { width: `${pct * 100}%` },
          }),
        ]),
        el('div', { class: 'tag-manager-nums' }, [
          el('span', { text: `${tag.done} of ${tag.total} done` }),
          el('span', { text: `${Math.round(pct * 100)}%` }),
        ]),
      ]),
      el('button', {
        class: 'task-x', style: { opacity: '1' }, text: '×', 'aria-label': `Delete tag ${tag.name}`,
        onclick: async () => {
          try {
            await api.del(`/api/tags/${tag.id}`);
            await load();
            onChange();
          } catch (err) {
            toast(err.message || 'Could not delete that tag', 3000);
          }
        },
      }),
    ]));
  }
}
