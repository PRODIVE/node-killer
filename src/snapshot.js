/**
 * Turns scanner groups into what people actually want to read:
 * project → instance (checkout/worktree) → task, measured in cores, with a heat level.
 * Also keeps a short CPU history per project for the chart.
 *
 * Pure Node (no Electron) so it can be tested and reused by the MCP server.
 */
const os = require('os');
const scanner = require('./scanner');

const CORES = os.cpus().length;
const HISTORY_MS = 10 * 60 * 1000;

// Cores in use → heat level. Thresholds are absolute so "hot" means the same thing on any project.
const HEAT_LEVELS = [
  { level: 'idle', label: 'Idle', max: 0.05 },
  { level: 'light', label: 'Light', max: 0.5 },
  { level: 'busy', label: 'Busy', max: 1.5 },
  { level: 'heavy', label: 'Heavy', max: 3 },
  { level: 'hot', label: 'Hot', max: Infinity },
];

function heatOf(cores) {
  const h = HEAT_LEVELS.find((l) => cores < l.max) || HEAT_LEVELS[HEAT_LEVELS.length - 1];
  return { level: h.level, label: h.label };
}

function toCores(cpuPercent) {
  return Math.round((cpuPercent / 100) * 100) / 100;
}

function projectKeyOf(group) {
  if (group.project) return group.project;
  return `~${group.app}`; // no project: bucket by launching app
}

function projectNameOf(group) {
  if (group.project) return group.project;
  return `Other · ${group.app}`;
}

function instanceKeyOf(group) {
  return group.worktree || '(main)';
}

function instanceLabelOf(group) {
  if (!group.project) return group.app;
  return group.worktree ? `Worktree: ${group.worktree}` : 'Main checkout';
}

function taskDetail(group) {
  const bits = [group.task];
  if (group.subpath) bits.push(group.subpath);
  if (group.ports.length) bits.push(`port ${group.ports.join(', ')}`);
  return bits.join(' · ');
}

function sum(items, fn) {
  return items.reduce((s, x) => s + fn(x), 0);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Build the project → instance → task tree from scanner groups. */
function buildTree(groups) {
  const projects = new Map();
  for (const g of groups) {
    const pKey = projectKeyOf(g);
    if (!projects.has(pKey)) {
      projects.set(pKey, { key: pKey, name: projectNameOf(g), hasProject: Boolean(g.project), instances: new Map() });
    }
    const project = projects.get(pKey);
    const iKey = instanceKeyOf(g);
    if (!project.instances.has(iKey)) {
      project.instances.set(iKey, { key: `${pKey}/${iKey}`, label: instanceLabelOf(g), folder: g.projectRoot, tasks: [] });
    }
    const cores = toCores(g.cpu);
    project.instances.get(iKey).tasks.push({
      id: g.rootPid,
      title: g.title,
      kind: g.kind,
      detail: taskDetail(g),
      app: g.app,
      cores,
      heat: heatOf(cores),
      memoryMb: g.memoryMb,
      processCount: g.processCount,
      ports: g.ports,
      elapsed: g.elapsed,
      command: g.command,
      folder: g.projectRoot || g.cwd,
      isSelf: g.isSelf,
      members: g.members.map((m) => ({ pid: m.pid, task: m.task, cores: toCores(m.cpu), memoryMb: m.memoryMb })),
    });
  }

  const list = [...projects.values()].map((p) => {
    const instances = [...p.instances.values()].map((i) => {
      i.tasks.sort((a, b) => b.cores - a.cores);
      const cores = round2(sum(i.tasks, (t) => t.cores));
      return { ...i, cores, heat: heatOf(cores), memoryMb: sum(i.tasks, (t) => t.memoryMb) };
    });
    instances.sort((a, b) => b.cores - a.cores);
    const cores = round2(sum(instances, (i) => i.cores));
    return {
      key: p.key,
      name: p.name,
      hasProject: p.hasProject,
      cores,
      heat: heatOf(cores),
      memoryMb: sum(instances, (i) => i.memoryMb),
      taskCount: sum(instances, (i) => i.tasks.length),
      instances,
    };
  });
  // Real projects first by load; the "Other · app" buckets after them.
  list.sort((a, b) => (b.hasProject - a.hasProject) || b.cores - a.cores);
  return list;
}

/** Keeps a rolling window of per-project cores for the chart. */
class History {
  constructor(windowMs = HISTORY_MS) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  add(projects, t = Date.now(), memory = null) {
    const byProject = {};
    const memByProject = {};
    for (const p of projects) {
      byProject[p.key] = p.cores;
      memByProject[p.key] = Math.round((p.memoryMb / 1024) * 100) / 100;
    }
    this.samples.push({ t, byProject, memByProject, swapOut: memory ? memory.swapOutMbPerSec : 0 });
    const cutoff = t - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
  }

  toJSON() {
    return this.samples;
  }
}

function buildSnapshot(groups, history, memory = null) {
  const projects = buildTree(groups);
  if (history) history.add(projects, Date.now(), memory);
  const cores = round2(sum(projects, (p) => p.cores));
  return {
    t: Date.now(),
    machineCores: CORES,
    cores,
    heat: heatOf(cores),
    memory,
    nodeMemoryGb: Math.round((sum(projects, (p) => p.memoryMb) / 1024) * 10) / 10,
    projects,
    history: history ? history.toJSON() : [],
  };
}

module.exports = { buildSnapshot, buildTree, heatOf, toCores, History, HEAT_LEVELS, CORES, scanner };
