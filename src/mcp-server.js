#!/usr/bin/env node
/**
 * Node Killer MCP server (stdio).
 *
 * Lets an agent answer "what's eating my CPU?" with processes labelled by the
 * app that launched them and the project they belong to, and kill them.
 *
 *   claude mcp add --scope user node-killer -- node /path/to/node-killer/src/mcp-server.js
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const scanner = require('./scanner');
const { heatOf, toCores, CORES } = require('./snapshot');
const { readMemory } = require('./memory');
const pkg = require('../package.json');

const server = new McpServer({ name: 'node-killer', version: pkg.version });

function summarise(group, { includeMembers = false } = {}) {
  const out = {
    pid: group.rootPid,
    what: group.title,
    cores: toCores(group.cpu),
    heat: heatOf(toCores(group.cpu)).label,
    cpu_percent: group.cpu,
    memory_mb: group.memoryMb,
    processes: group.processCount,
    task: group.task,
    project: scanner.projectLabel(group),
    app: group.app,
    type: group.type,
    ports: group.ports,
    running_for: group.elapsed,
    cwd: group.cwd,
    command: group.command.length > 300 ? `${group.command.slice(0, 300)}…` : group.command,
  };
  if (group.package) out.package = group.package;
  if (group.isSelf) out.note = 'Contains this MCP server or the agent calling it; cannot be killed from here.';
  if (includeMembers) out.members = group.members;
  return out;
}

function matches(group, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [group.task, group.app, group.project, group.worktree, group.package, group.cwd, group.command]
    .filter(Boolean)
    .some((field) => field.toLowerCase().includes(q));
}

function findGroupForPid(groups, pid) {
  return groups.find((g) => g.rootPid === pid || g.members.some((m) => m.pid === pid));
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

server.registerTool(
  'list_processes',
  {
    title: 'List Node/Bun/Deno processes',
    description:
      'List running Node.js, Bun and Deno processes grouped by the command that started them (e.g. one vitest run with 9 workers is one group), ' +
      'sorted by total CPU (also reports whole-Mac memory and swap; high memory, not CPU, is the usual cause of a frozen UI). Each group is labelled with the launching app (Terminal, VS Code, Claude, T3 Code, launchd…), ' +
      'the project/worktree it belongs to, listening ports, and memory. `cores` is how many CPU cores the group is keeping busy (cpu_percent / 100); compare with machine_cores. Heat: Idle <0.05, Light <0.5, Busy <1.5, Heavy <3, Hot 3+ cores.',
    inputSchema: {
      min_cpu: z.number().optional().describe('Only groups using at least this much CPU (percent of one core).'),
      query: z.string().optional().describe('Filter by text in the task, app, project, worktree, folder or command.'),
      limit: z.number().int().positive().optional().describe('Max groups to return (default 25).'),
      all_users: z.boolean().optional().describe("Include other users' processes (default false)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ min_cpu, query, limit = 25, all_users = false }) => {
    const [groups, memory] = await Promise.all([scanner.scan({ allUsers: all_users }), readMemory().catch(() => null)]);
    const filtered = groups.filter((g) => (min_cpu == null || g.cpu >= min_cpu) && matches(g, query));
    const totalCpu = Math.round(groups.reduce((s, g) => s + g.cpu, 0) * 10) / 10;
    return jsonResult({
      machine_cores: CORES,
      memory: memory && {
        used_gb: memory.usedGb,
        total_gb: memory.totalGb,
        node_gb: Math.round((groups.reduce((s, g) => s + g.memoryMb, 0) / 1024) * 10) / 10,
        swap_used_gb: memory.swapUsedGb,
        pressure: memory.pressure,
        note: 'Swap used stays high after a crunch; pressure "warn"/"critical" means the Mac is struggling now.',
      },
      cores_busy: toCores(totalCpu),
      total_cpu_percent: totalCpu,
      total_groups: groups.length,
      shown: Math.min(filtered.length, limit),
      groups: filtered.slice(0, limit).map((g) => summarise(g)),
    });
  }
);

server.registerTool(
  'get_process_group',
  {
    title: 'Inspect a process group',
    description: 'Full detail for the group containing a pid, including every member process with its own CPU, memory and command line.',
    inputSchema: { pid: z.number().int().describe('Any pid in the group (root or worker).') },
    annotations: { readOnlyHint: true },
  },
  async ({ pid }) => {
    const groups = await scanner.scan({ allUsers: true });
    const group = findGroupForPid(groups, pid);
    if (!group) return { ...jsonResult({ error: `No Node/Bun/Deno group contains pid ${pid}.` }), isError: true };
    return jsonResult(summarise(group, { includeMembers: true }));
  }
);

server.registerTool(
  'kill_process_group',
  {
    title: 'Kill a process group',
    description:
      'Terminate the whole group containing a pid (workers first, then the root): SIGTERM, then SIGKILL after ~1s for survivors. ' +
      'Set only_this_pid to kill just that one process instead. Confirm with the user before calling this unless they already asked for it.',
    inputSchema: {
      pid: z.number().int().describe('Any pid in the group to kill.'),
      only_this_pid: z.boolean().optional().describe('Kill only this pid, not its whole group.'),
    },
    annotations: { destructiveHint: true },
  },
  async ({ pid, only_this_pid = false }) => {
    const groups = await scanner.scan({ allUsers: false });
    const group = findGroupForPid(groups, pid);
    if (!group) {
      return { ...jsonResult({ error: `pid ${pid} is not one of your Node/Bun/Deno processes (or already exited).` }), isError: true };
    }
    if (group.isSelf) {
      return { ...jsonResult({ error: 'Refusing: that group contains this MCP server or the agent calling it.' }), isError: true };
    }
    const results = only_this_pid ? await scanner.killPids([pid]) : await scanner.killGroup(group);
    const failed = results.filter((r) => !r.ok);
    return {
      ...jsonResult({
        killed: summarise(group),
        scope: only_this_pid ? 'single process' : 'whole group',
        ok: results.length - failed.length,
        failed,
      }),
      isError: failed.length > 0,
    };
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('node-killer MCP server failed:', err);
  process.exit(1);
});
