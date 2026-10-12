/* global nodeKiller */
const api = window.nodeKiller;

const SLOT_COUNT = 8;
const CHART_SERIES_MAX = 5; // plus "Other"
const CONFIRM_MS = 3000;

const ui = {
  collapsed: new Set(),
  expandedTasks: new Set(),
  confirming: new Map(), // task id -> expiry
  showIdle: false,
  showTable: false,
  snapshot: null,
  hoverIndex: null,
};

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function fmtCores(n) {
  if (n >= 10) return n.toFixed(0);
  if (n >= 0.995) return n.toFixed(1);
  if (n < 0.005) return '0';
  return n.toFixed(2);
}

function seriesColor(slot) {
  return slot != null && slot < SLOT_COUNT ? `var(--series-${slot + 1})` : 'var(--series-other)';
}

function heatClass(heat) {
  return `heat-${heat.level}`;
}

function pct(n, of) {
  return Math.min(100, (n / of) * 100);
}

// --- Hero -------------------------------------------------------------------

function renderHero(s) {
  $('#heroCores').textContent = fmtCores(s.cores);
  const share = Math.round((s.cores / s.machineCores) * 100);
  const hot = s.projects.filter((p) => p.heat.level !== 'idle');
  $('#heroSub').textContent =
    `of ${s.machineCores} cores (${share}% of your Mac) · ` +
    (hot.length ? `${hot.length} active project${hot.length === 1 ? '' : 's'}` : 'everything idle');
  const pill = $('#heroHeat');
  pill.className = `pill ${heatClass(s.heat)}`;
  pill.textContent = s.heat.label;
}

// --- Chart ------------------------------------------------------------------

function chartSeries(s) {
  // Pick the projects that used the most CPU over the window; fold the rest into Other.
  const totals = new Map();
  for (const sample of s.history) {
    for (const [key, cores] of Object.entries(sample.byProject)) totals.set(key, (totals.get(key) || 0) + cores);
  }
  const byKey = new Map(s.projects.map((p) => [p.key, p]));
  const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, CHART_SERIES_MAX).map(([key]) => key);
  const series = top
    .map((key) => ({ key, name: byKey.get(key)?.name || key.replace(/^~/, 'Other · '), slot: s.colorSlots[key] }))
    // stack in colour-slot order so a project keeps its place as well as its colour
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  if (ranked.length > top.length) series.push({ key: '__other', name: 'Other', slot: null });
  const topSet = new Set(top);
  const rows = s.history.map((sample) => {
    const values = {};
    let other = 0;
    for (const [key, cores] of Object.entries(sample.byProject)) {
      if (topSet.has(key)) values[key] = cores;
      else other += cores;
    }
    values.__other = other;
    return { t: sample.t, values };
  });
  return { series, rows };
}

function niceMax(v) {
  if (v <= 1) return 1;
  if (v <= 2) return 2;
  if (v <= 4) return 4;
  if (v <= 6) return 6;
  if (v <= 8) return 8;
  return Math.ceil(v / 2) * 2;
}

function renderChart(s) {
  const chart = $('#chart');
  const width = chart.clientWidth || 380;
  const height = 128;
  const pad = { l: 22, r: 4, t: 6, b: 16 };
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.replaceChildren();

  const { series, rows } = chartSeries(s);
  const now = s.t;
  const t0 = now - 10 * 60 * 1000;
  const totals = rows.map((r) => series.reduce((sum, ser) => sum + (r.values[ser.key] || 0), 0));
  let yMax = niceMax(Math.max(0.5, ...totals));
  const showCapacity = yMax >= s.machineCores * 0.6;
  if (showCapacity) yMax = Math.max(yMax, s.machineCores);

  const x = (t) => pad.l + ((t - t0) / (now - t0)) * (width - pad.l - pad.r);
  const y = (v) => height - pad.b - (v / yMax) * (height - pad.t - pad.b);

  // Grid + ticks
  const ticks = [0, yMax / 2, yMax];
  for (const tv of ticks) {
    chart.append(svg('line', { class: tv === 0 ? 'baseline' : 'grid', x1: pad.l, x2: width - pad.r, y1: y(tv), y2: y(tv) }));
    const label = svg('text', { class: 'tick', x: pad.l - 4, y: y(tv) + 3, 'text-anchor': 'end' });
    label.textContent = yMax >= 2 ? String(Math.round(tv)) : fmtCores(tv);
    chart.append(label);
  }
  for (const [label, t] of [['10 min ago', t0], ['5', now - 5 * 60 * 1000], ['now', now]]) {
    const anchor = t === t0 ? 'start' : t === now ? 'end' : 'middle';
    const node = svg('text', { class: 'tick', x: x(t), y: height - 3, 'text-anchor': anchor });
    node.textContent = label;
    chart.append(node);
  }
  if (showCapacity) {
    chart.append(svg('line', { class: 'capacity', x1: pad.l, x2: width - pad.r, y1: y(s.machineCores), y2: y(s.machineCores) }));
    const cap = svg('text', { class: 'capacity-label', x: width - pad.r, y: y(s.machineCores) - 3, 'text-anchor': 'end' });
    cap.textContent = `all ${s.machineCores} cores`;
    chart.append(cap);
  }

  if (rows.length >= 2 && series.length) {
    const stacked = rows.map(() => 0);
    for (const ser of series) {
      const lower = [...stacked];
      rows.forEach((r, i) => (stacked[i] += r.values[ser.key] || 0));
      const top = rows.map((r, i) => `${x(r.t).toFixed(1)},${y(stacked[i]).toFixed(1)}`);
      const bottom = rows.map((r, i) => `${x(r.t).toFixed(1)},${y(lower[i]).toFixed(1)}`).reverse();
      chart.append(svg('path', { class: 'area', d: `M${top.join('L')}L${bottom.join('L')}Z`, fill: seriesColor(ser.slot) }));
    }
  } else {
    const msg = svg('text', { class: 'tick', x: width / 2, y: height / 2, 'text-anchor': 'middle' });
    msg.textContent = 'Collecting history…';
    chart.append(msg);
  }

  if (ui.hoverIndex != null && rows[ui.hoverIndex]) {
    const hx = x(rows[ui.hoverIndex].t);
    chart.append(svg('line', { class: 'crosshair', x1: hx, x2: hx, y1: pad.t, y2: height - pad.b }));
  }

  // Hover layer: the whole plot is the hit target.
  const hit = svg('rect', { x: pad.l, y: 0, width: width - pad.l - pad.r, height, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const rect = chart.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const t = t0 + ((px - pad.l) / (width - pad.l - pad.r)) * (now - t0);
    let best = 0;
    rows.forEach((r, i) => {
      if (Math.abs(r.t - t) < Math.abs(rows[best].t - t)) best = i;
    });
    ui.hoverIndex = rows.length ? best : null;
    renderChart(ui.snapshot);
    showTooltip(series, rows[best], x(rows[best]?.t ?? now), width);
  });
  hit.addEventListener('mouseleave', () => {
    ui.hoverIndex = null;
    $('#tooltip').hidden = true;
    renderChart(ui.snapshot);
  });
  chart.append(hit);

  renderLegend(series);
  renderTable(series, rows);
}

function showTooltip(series, row, px, width) {
  const tip = $('#tooltip');
  if (!row) {
    tip.hidden = true;
    return;
  }
  const ago = Math.round((ui.snapshot.t - row.t) / 1000);
  const when = ago < 5 ? 'now' : ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ${ago % 60}s ago`;
  const items = [...series].reverse().filter((ser) => (row.values[ser.key] || 0) >= 0.01);
  const total = series.reduce((sum, ser) => sum + (row.values[ser.key] || 0), 0);
  tip.replaceChildren(
    el('div', { class: 'tt-time' }, when),
    ...items.map((ser) =>
      el('div', { class: 'tt-row' }, el('i', { class: 'sw', style: `--c:${seriesColor(ser.slot)}` }), ser.name, el('span', { class: 'v' }, fmtCores(row.values[ser.key])))
    ),
    el('div', { class: 'tt-row tt-total' }, 'Total', el('span', { class: 'v' }, `${fmtCores(total)} cores`))
  );
  tip.hidden = false;
  const tipWidth = tip.offsetWidth;
  tip.style.left = `${Math.max(0, Math.min(width - tipWidth, px > width / 2 ? px - tipWidth - 10 : px + 10))}px`;
}

function renderLegend(series) {
  $('#legend').replaceChildren(
    ...series.map((ser) => el('span', { class: 'key' }, el('i', { class: 'sw', style: `--c:${seriesColor(ser.slot)}` }), ser.name))
  );
}

function renderTable(series, rows) {
  const table = $('#dataTable');
  table.hidden = !ui.showTable;
  if (!ui.showTable) return;
  // Averages over the window: the accessible view of the chart.
  const avg = (key) => (rows.length ? rows.reduce((s, r) => s + (r.values[key] || 0), 0) / rows.length : 0);
  const peak = (key) => Math.max(0, ...rows.map((r) => r.values[key] || 0));
  const last = rows[rows.length - 1];
  table.replaceChildren(
    el('thead', {}, el('tr', {}, el('th', {}, 'Project'), el('th', { class: 'num' }, 'Now'), el('th', { class: 'num' }, 'Avg'), el('th', { class: 'num' }, 'Peak'))),
    el(
      'tbody',
      {},
      series.map((ser) =>
        el(
          'tr',
          {},
          el('td', {}, ser.name),
          el('td', { class: 'num' }, fmtCores(last?.values[ser.key] || 0)),
          el('td', { class: 'num' }, fmtCores(avg(ser.key))),
          el('td', { class: 'num' }, fmtCores(peak(ser.key)))
        )
      )
    )
  );
}

// --- Project list -----------------------------------------------------------

function loadBar(cores, heat, machineCores) {
  return el('div', { class: `loadbar ${heatClass(heat)}`, title: `${fmtCores(cores)} of ${machineCores} cores` }, el('i', { style: `width:${pct(cores, machineCores)}%` }));
}

function killButton(task) {
  const confirming = (ui.confirming.get(task.id) || 0) > Date.now();
  const label = task.processCount > 1 ? `Kill ${task.processCount}` : 'Kill';
  return el(
    'button',
    {
      class: `kill${confirming ? ' confirm' : ''}`,
      disabled: task.isSelf,
      title: task.isSelf ? 'This is Node Killer itself' : `Stop ${task.title} (${task.processCount} process${task.processCount === 1 ? '' : 'es'})`,
      onclick: async (e) => {
        e.stopPropagation();
        if (!confirming) {
          ui.confirming.set(task.id, Date.now() + CONFIRM_MS);
          render();
          setTimeout(render, CONFIRM_MS + 50);
          return;
        }
        ui.confirming.delete(task.id);
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Killing…';
        await api.killGroup(task.id);
      },
    },
    confirming ? 'Confirm?' : label
  );
}

function renderTask(task, machineCores) {
  const expanded = ui.expandedTasks.has(task.id);
  const row = el(
    'div',
    { class: 'task' },
    el(
      'div',
      {
        class: 'task-main',
        title: task.command,
        onclick: () => {
          if (expanded) ui.expandedTasks.delete(task.id);
          else ui.expandedTasks.add(task.id);
          render();
        },
      },
      el('div', { class: 'task-title' }, task.title, el('span', { class: 'app' }, task.app)),
      el('div', { class: 'task-detail' }, `${task.detail}${task.processCount > 1 ? ` · ${task.processCount} processes` : ''} · ${task.memoryMb} MB`)
    ),
    el('div', { class: 'task-load' }, el('span', { class: 'cores' }, fmtCores(task.cores), el('small', {}, ' cores')), loadBar(task.cores, task.heat, machineCores)),
    el('div', { class: 'task-actions' }, killButton(task))
  );
  if (!expanded) return row;
  const members = el(
    'div',
    { class: 'members' },
    task.members.map((m) =>
      el(
        'div',
        { class: 'm' },
        el('span', { class: 'pid' }, m.pid),
        el('span', {}, m.task),
        el('span', { class: 'num' }, `${fmtCores(m.cores)} c`),
        el('span', { class: 'num' }, `${m.memoryMb} MB`)
      )
    ),
    el(
      'div',
      { class: 'links' },
      task.folder && task.folder !== '/' ? el('button', { class: 'link-btn', onclick: () => api.reveal(task.folder) }, 'Show folder') : null,
      el('button', { class: 'link-btn', onclick: () => api.copy(task.command) }, 'Copy command'),
      el('button', { class: 'link-btn', onclick: () => api.copy(String(task.id)) }, `Copy PID ${task.id}`)
    )
  );
  return [row, members];
}

function renderProject(p, s) {
  const collapsed = ui.collapsed.has(p.key);
  const slot = s.colorSlots[p.key];
  const instances = p.instances
    .map((inst) => ({ ...inst, tasks: ui.showIdle ? inst.tasks : inst.tasks.filter((t) => t.heat.level !== 'idle') }))
    .filter((inst) => inst.tasks.length);
  const hiddenIdle = p.taskCount - instances.reduce((n, i) => n + i.tasks.length, 0);

  return el(
    'section',
    { class: `project${collapsed ? ' collapsed' : ''}` },
    el(
      'button',
      {
        class: 'project-head',
        'aria-expanded': String(!collapsed),
        onclick: () => {
          if (collapsed) ui.collapsed.delete(p.key);
          else ui.collapsed.add(p.key);
          render();
        },
      },
      el('span', { class: 'project-dot', style: `--c:${seriesColor(slot)}` }),
      el(
        'span',
        { class: 'project-name' },
        p.name,
        ' ',
        el('span', { class: 'project-meta' }, `${p.taskCount} task${p.taskCount === 1 ? '' : 's'} · ${p.instances.length} instance${p.instances.length === 1 ? '' : 's'}`)
      ),
      el('span', { class: 'cores' }, fmtCores(p.cores), el('small', {}, ' cores')),
      el('span', { class: `pill ${heatClass(p.heat)}` }, p.heat.label)
    ),
    el('div', { class: 'project-bar' }, loadBar(p.cores, p.heat, s.machineCores)),
    el(
      'div',
      { class: 'project-body' },
      instances.map((inst) =>
        el(
          'div',
          { class: 'instance' },
          el(
            'div',
            { class: 'instance-head' },
            inst.label,
            el('span', { class: 'spacer' }),
            el('span', { class: 'cores' }, `${fmtCores(inst.cores)} cores`)
          ),
          inst.tasks.map((t) => renderTask(t, s.machineCores))
        )
      ),
      hiddenIdle > 0 ? el('div', { class: 'instance-head', style: 'padding-bottom:8px' }, `${hiddenIdle} idle task${hiddenIdle === 1 ? '' : 's'} hidden`) : null
    )
  );
}

function renderProjects(s) {
  const visible = ui.showIdle ? s.projects : s.projects.filter((p) => p.heat.level !== 'idle');
  const idleCount = s.projects.length - s.projects.filter((p) => p.heat.level !== 'idle').length;
  const root = $('#projects');
  root.replaceChildren(...(visible.length ? visible.map((p) => renderProject(p, s)) : [el('div', { class: 'empty' }, 'Nothing busy right now.')]));
  $('#idleToggle').textContent = ui.showIdle ? 'Hide idle' : `Show idle (${idleCount} project${idleCount === 1 ? '' : 's'})`;
}

function render() {
  const s = ui.snapshot;
  if (!s) return;
  renderHero(s);
  renderChart(s);
  renderProjects(s);
}

$('#idleToggle').addEventListener('click', () => {
  ui.showIdle = !ui.showIdle;
  render();
});
$('#tableToggle').addEventListener('click', (e) => {
  ui.showTable = !ui.showTable;
  e.currentTarget.setAttribute('aria-pressed', String(ui.showTable));
  e.currentTarget.textContent = ui.showTable ? 'Hide table' : 'Table';
  render();
});
$('#menuBtn').addEventListener('click', () => api.openMenu());

api.onSnapshot((snapshot) => {
  ui.snapshot = snapshot;
  render();
});
api.ready();
