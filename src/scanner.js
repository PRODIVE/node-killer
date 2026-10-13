/**
 * Process scanner shared by the menubar app and the MCP server.
 *
 * Finds every Node/Bun/Deno process (listening on a port or not), labels each
 * one with the app that launched it and the project it belongs to, and groups
 * worker processes under the command that spawned them so CPU can be totalled.
 *
 * No Electron imports here: this module must run under plain Node too.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const RUNTIME_NAMES = new Set(['node', 'bun', 'deno']);
const WRAPPER_PATTERN = /^(npm|npx|pnpm|yarn|bun|bunx|turbo)(\s|$)/;
const VITE_PATTERN = /(?:^|[=\/@\s"'`])vite(?:\.js)?(?=$|[\s"'`/:@])/;
const EXEC_OPTS = { timeout: 5000, maxBuffer: 20 * 1024 * 1024 };

function looksLikeViteProcess(commandLine = '') {
  if (!commandLine) return false;
  return VITE_PATTERN.test(commandLine.toLowerCase().replace(/\\/g, '/'));
}

function runtimeOf(comm = '') {
  const base = path.basename(comm.trim());
  if (RUNTIME_NAMES.has(base)) return base;
  if (/^node\d+$/.test(base)) return 'node';
  return null;
}

// Parse `ps` output whose last column (comm/args) may contain spaces.
function parsePsColumns(stdout, fixedCols) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < fixedCols) continue;
    const fixed = parts.slice(0, fixedCols);
    const rest = trimmed.replace(new RegExp(`^(\\S+\\s+){${fixedCols}}`), '');
    rows.push({ fixed, rest: parts.length > fixedCols ? rest : '' });
  }
  return rows;
}

async function readProcessTable() {
  const [statsOut, argsOut] = await Promise.all([
    execFileAsync('ps', ['-Axo', 'pid=,ppid=,pcpu=,rss=,etime=,user=,stat=,comm='], EXEC_OPTS),
    execFileAsync('ps', ['-Axo', 'pid=,args='], EXEC_OPTS),
  ]);

  const argsByPid = new Map();
  for (const { fixed, rest } of parsePsColumns(argsOut.stdout, 1)) {
    argsByPid.set(Number(fixed[0]), rest);
  }

  const table = new Map();
  for (const { fixed, rest } of parsePsColumns(statsOut.stdout, 7)) {
    const pid = Number(fixed[0]);
    if (!Number.isFinite(pid)) continue;
    table.set(pid, {
      pid,
      ppid: Number(fixed[1]),
      cpu: Number(fixed[2]) || 0,
      rssKb: Number(fixed[3]) || 0,
      elapsed: fixed[4],
      user: fixed[5],
      stopped: fixed[6].startsWith('T'), // SIGSTOP'd (paused)
      comm: rest,
      args: argsByPid.get(pid) || rest,
      children: [],
    });
  }
  for (const proc of table.values()) {
    const parent = table.get(proc.ppid);
    if (parent && parent !== proc) parent.children.push(proc.pid);
  }
  return table;
}

// One lsof call for every pid: working directories and listening ports.
async function readCwdsAndPorts(pids) {
  const cwds = new Map();
  const ports = new Map();
  if (pids.length === 0) return { cwds, ports };
  const pidList = pids.join(',');

  const run = async (args) => {
    try {
      const { stdout } = await execFileAsync('lsof', args, EXEC_OPTS);
      return stdout;
    } catch (err) {
      // lsof exits 1 when some pids have nothing to report; output is still valid.
      return err && typeof err.stdout === 'string' ? err.stdout : '';
    }
  };

  const [cwdOut, portOut] = await Promise.all([
    run(['-a', '-p', pidList, '-d', 'cwd', '-Fpn']),
    run(['-nP', '-a', '-p', pidList, '-iTCP', '-sTCP:LISTEN', '-Fpn']),
  ]);

  let current = null;
  for (const line of cwdOut.split(/\r?\n/)) {
    if (line[0] === 'p') current = Number(line.slice(1));
    else if (line[0] === 'n' && current) cwds.set(current, line.slice(1));
  }
  current = null;
  for (const line of portOut.split(/\r?\n/)) {
    if (line[0] === 'p') current = Number(line.slice(1));
    else if (line[0] === 'n' && current) {
      const m = line.match(/:(\d+)$/);
      if (!m) continue;
      if (!ports.has(current)) ports.set(current, new Set());
      ports.get(current).add(Number(m[1]));
    }
  }
  return { cwds, ports };
}

// --- Project labelling ------------------------------------------------------

const projectCache = new Map();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function findUp(startDir, predicate) {
  let dir = startDir;
  const home = os.homedir();
  while (dir && dir !== path.dirname(dir)) {
    if (predicate(dir)) return dir;
    if (dir === home) break;
    dir = path.dirname(dir);
  }
  return null;
}

function describeProjectDir(dir) {
  if (!dir || dir === '/' || dir === os.homedir()) return null;
  if (projectCache.has(dir)) return projectCache.get(dir);

  const gitRoot = findUp(dir, (d) => fs.existsSync(path.join(d, '.git')));
  const pkgDir = findUp(dir, (d) => fs.existsSync(path.join(d, 'package.json')));
  const pkgName = pkgDir ? readJson(path.join(pkgDir, 'package.json'))?.name : null;

  let project = null;
  let worktree = null;
  let root = gitRoot || pkgDir;

  if (gitRoot) {
    project = path.basename(gitRoot);
    const dotGit = path.join(gitRoot, '.git');
    try {
      if (fs.statSync(dotGit).isFile()) {
        // Linked worktree: ".git" is a file pointing at <main>/.git/worktrees/<name>
        const m = fs.readFileSync(dotGit, 'utf8').match(/gitdir:\s*(.+)/);
        const gitdir = m ? m[1].trim() : '';
        const idx = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
        if (idx !== -1) {
          project = path.basename(gitdir.slice(0, idx));
          worktree = path.basename(gitRoot);
        }
      }
    } catch (_) {}
  } else if (pkgDir) {
    project = path.basename(pkgDir);
  }

  if (!project) {
    projectCache.set(dir, null);
    return null;
  }

  const subpath = root && dir.startsWith(root) ? path.relative(root, dir) : '';
  const info = {
    project,
    worktree,
    package: pkgName && pkgName !== project ? pkgName : null,
    subpath: subpath && !subpath.startsWith('node_modules') ? subpath : null,
    root,
  };
  projectCache.set(dir, info);
  return info;
}

// When cwd says nothing (e.g. "/" for app-launched MCP servers), fall back to
// the first absolute path in the command line that isn't the runtime itself.
function projectDirFromArgs(args) {
  const tokens = args.split(/\s+/).slice(1);
  for (const token of tokens) {
    const candidate = token.replace(/^--?[\w-]+=/, '').replace(/^["']|["']$/g, '');
    if (!candidate.startsWith('/') || candidate.startsWith('/opt/') || candidate.startsWith('/usr/')) continue;
    const dir = candidate.includes(`${path.sep}node_modules${path.sep}`)
      ? candidate.slice(0, candidate.indexOf(`${path.sep}node_modules${path.sep}`))
      : path.dirname(candidate);
    if (dir.includes(`${path.sep}_npx${path.sep}`) || dir.includes(`${path.sep}.npm${path.sep}`)) continue;
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// --- Task labelling ---------------------------------------------------------

const FLAGS_WITH_VALUE = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C', '--inspect-port', '--title']);
const LOADER_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);

function shortScript(script) {
  if (!script.startsWith('/')) return script;
  const base = path.basename(script);
  if (/^(index|main|server|cli)\.[cm]?[jt]s$/.test(base)) {
    return `${path.basename(path.dirname(script))}/${base}`;
  }
  return base;
}

function describeTask(args) {
  if (!args) return '';
  const tokens = args.split(/\s+/).filter(Boolean);
  const first = path.basename(tokens[0] || '');

  if (WRAPPER_PATTERN.test(args)) {
    return tokens.slice(0, 4).join(' ');
  }

  // Package entry points: node_modules/.bin/vitest run, node_modules/next/dist/bin/next dev
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(/node_modules\/(?:\.bin\/)?((?:@[^/\s]+\/)?[^/\s]+)/);
    if (!m) continue;
    if (i > 0 && LOADER_FLAGS.has(tokens[i - 1])) continue; // --require .../suppress-warnings.cjs
    const next = tokens[i + 1];
    const sub = next && !next.startsWith('-') && !next.includes('/') && !next.includes('=') && next.length < 24 ? ` ${next}` : '';
    return `${m[1]}${sub}`;
  }

  if (!runtimeOf(tokens[0] || '')) return first;
  if (tokens.some((t) => t === '-e' || t === '--eval' || t === '-p' || t === '--print')) return `${first} -e (inline script)`;

  // node [flags] [--import tsx] script.ts
  let loader = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (FLAGS_WITH_VALUE.has(t)) {
      const value = tokens[++i] || '';
      if (LOADER_FLAGS.has(t) && !value.includes('/')) loader = value;
      continue;
    }
    if (t.startsWith('-')) continue;
    if (t === 'run' && runtimeOf(tokens[0]) !== 'node') continue; // bun run x / deno run x
    return [loader, shortScript(t)].filter(Boolean).join(' ');
  }
  return loader || first;
}

// --- Plain-English kinds -----------------------------------------------------

// First match wins. Tested against the full command lines of every member.
const KINDS = [
  { kind: 'tests', title: 'Tests', re: /\b(vitest|jest|mocha|ava|playwright|cypress)\b|\brun test\b/ },
  { kind: 'typecheck', title: 'Type check', re: /\b(tsc|vue-tsc|tsgo)\b(?!-)|typecheck|type-check/ },
  { kind: 'mcp', title: 'MCP server', re: /\bmcp\b|mcp-server|modelcontextprotocol|server-[a-z]+-mcp/i },
  { kind: 'language-server', title: 'Language server', re: /tsserver|language-?server|languageserver|eslintServer/i },
  { kind: 'build', title: 'Build', re: /\b(next|vite|nuxt|astro|remix|turbo|tsup|rollup|webpack|esbuild|parcel)\b\S*\s+build\b|\brun build\b|\btsup\b|\brollup\b/ },
  { kind: 'dev-server', title: 'Dev server', re: /\b(next dev|next-server|vite|nuxt dev|astro dev|remix dev|webpack serve|expo start|metro|wrangler dev|storybook|run dev\b|run start\b)/ },
  { kind: 'lint', title: 'Lint', re: /\b(eslint|biome|prettier|oxlint|stylelint)\b/ },
  { kind: 'install', title: 'Installing packages', re: /\b(npm|pnpm|yarn|bun) (install|i|add|ci)\b/ },
  { kind: 'watcher', title: 'File watcher', re: /\b(nodemon|chokidar|watchman|--watch)\b/ },
  { kind: 'app', title: 'Electron app', re: /\belectron\b/ },
  { kind: 'server', title: 'App server', re: /\b(server|api|app)\.[cm]?[jt]s\b|\bstart\b/ },
];

function describeKind(rootArgs, memberArgs) {
  const haystacks = [rootArgs, ...memberArgs];
  for (const k of KINDS) {
    if (haystacks.some((a) => k.re.test(a))) return { kind: k.kind, title: k.title };
  }
  return { kind: 'script', title: 'Script' };
}

// --- App attribution --------------------------------------------------------

const APP_ALIASES = { claude: 'Claude Code' };

function appNameFromComm(comm = '') {
  const m = comm.match(/\/([^/]+)\.app\//);
  return m ? APP_ALIASES[m[1]] || m[1] : null;
}

// Nearest app wins; if it runs inside another app, say so: "Claude Code (Terminal)".
function findLaunchingApp(table, pid) {
  const names = [];
  let current = table.get(pid);
  const seen = new Set();
  let reachedLaunchd = false;
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    const name = appNameFromComm(current.comm);
    if (name && !names.includes(name)) names.push(name);
    if (current.ppid <= 1) {
      reachedLaunchd = true;
      break;
    }
    current = table.get(current.ppid);
  }
  if (names.length === 0) return reachedLaunchd ? 'background (launchd)' : 'unknown';
  if (names.length === 1) return names[0];
  return `${names[0]} (${names[names.length - 1]})`;
}

// --- Grouping ---------------------------------------------------------------

function isGroupable(proc) {
  if (!proc) return false;
  return Boolean(runtimeOf(proc.comm)) || WRAPPER_PATTERN.test(proc.args);
}

function findGroupRoot(table, proc) {
  let root = proc;
  const seen = new Set([proc.pid]);
  let parent = table.get(proc.ppid);
  while (parent && !seen.has(parent.pid) && isGroupable(parent)) {
    seen.add(parent.pid);
    root = parent;
    parent = table.get(parent.ppid);
  }
  return root;
}

function collectSubtree(table, rootPid) {
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.shift(); // breadth-first: shallow members come first
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = table.get(pid);
    if (!proc) continue;
    if (proc.ppid === process.pid) continue; // our own ps/lsof calls
    out.push(proc);
    stack.push(...proc.children);
  }
  return out;
}

function classifyType(members) {
  if (members.some((m) => runtimeOf(m.comm) === 'bun')) return 'bun';
  if (members.some((m) => looksLikeViteProcess(m.args))) return 'vite';
  return 'node';
}

function ancestorsOf(table, pid) {
  const out = new Set();
  let current = table.get(pid);
  while (current && !out.has(current.pid)) {
    out.add(current.pid);
    current = table.get(current.ppid);
  }
  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Scan and return labelled process groups, highest CPU first.
 *
 * @param {object} [options]
 * @param {boolean} [options.allUsers] include other users' processes
 * @param {{node?: boolean, vite?: boolean, bun?: boolean}} [options.types] type filter
 */
async function scan(options = {}) {
  const me = os.userInfo().username;
  const table = await readProcessTable();
  const protectedPids = ancestorsOf(table, process.pid);

  const runtimeProcs = [...table.values()].filter(
    (p) => runtimeOf(p.comm) && (options.allUsers || p.user === me)
  );

  const roots = new Map();
  for (const proc of runtimeProcs) {
    const root = findGroupRoot(table, proc);
    roots.set(root.pid, root);
  }

  const groups = [...roots.values()].map((root) => ({ root, members: collectSubtree(table, root.pid) }));
  const allPids = groups.flatMap((g) => g.members.map((m) => m.pid));
  const { cwds, ports } = await readCwdsAndPorts(allPids);

  const result = [];
  for (const { root, members } of groups) {
    const type = classifyType(members);
    if (options.types && options.types[type] === false) continue;

    // Under an npm/pnpm wrapper, the first real runtime child says what is actually running.
    const runtimeMembers = members.filter((m) => runtimeOf(m.comm));
    const busiest = [...runtimeMembers].sort((a, b) => b.cpu - a.cpu)[0] || root;
    const primary = members.find((m) => runtimeOf(m.comm) && !WRAPPER_PATTERN.test(m.args)) || root;

    const cwd = cwds.get(root.pid) || cwds.get(busiest.pid) || null;
    const projectDir =
      cwd && cwd !== '/' && cwd !== os.homedir() ? cwd : projectDirFromArgs(busiest.args) || projectDirFromArgs(root.args);
    const projectInfo = describeProjectDir(projectDir);

    const groupPorts = new Set();
    for (const m of members) for (const port of ports.get(m.pid) || []) groupPorts.add(port);

    const rootTask = describeTask(root.args);
    const workerTask = describeTask(primary.args);
    const task = WRAPPER_PATTERN.test(root.args) && workerTask && workerTask !== rootTask
      ? `${workerTask} (${rootTask})`
      : rootTask || workerTask;

    const { kind, title } = describeKind(root.args, members.map((m) => m.args));

    result.push({
      id: root.pid,
      rootPid: root.pid,
      type,
      kind,
      title,
      task,
      app: findLaunchingApp(table, root.pid),
      project: projectInfo?.project || null,
      worktree: projectInfo?.worktree || null,
      package: projectInfo?.package || null,
      subpath: projectInfo?.subpath || null,
      projectRoot: projectInfo?.root || null,
      cwd,
      cpu: round1(members.reduce((sum, m) => sum + m.cpu, 0)),
      memoryMb: Math.round(members.reduce((sum, m) => sum + m.rssKb, 0) / 1024),
      processCount: members.length,
      ports: [...groupPorts].sort((a, b) => a - b),
      elapsed: root.elapsed,
      user: root.user,
      command: root.args,
      isSelf: members.some((m) => protectedPids.has(m.pid)) || protectedPids.has(root.pid),
      paused: runtimeMembers.length > 0 && runtimeMembers.every((m) => m.stopped),
      members: members
        .map((m) => ({
          pid: m.pid,
          ppid: m.ppid,
          cpu: m.cpu,
          memoryMb: Math.round(m.rssKb / 1024),
          elapsed: m.elapsed,
          task: describeTask(m.args),
          command: m.args,
          ports: [...(ports.get(m.pid) || [])].sort((a, b) => a - b),
        }))
        .sort((a, b) => b.cpu - a.cpu),
    });
  }

  return result.sort((a, b) => b.cpu - a.cpu || b.memoryMb - a.memoryMb);
}

/** "prodiveos › mail-copy-addresses-keyboard › apps/core" */
function projectLabel(group) {
  if (!group.project) return group.cwd && group.cwd !== '/' ? path.basename(group.cwd) : 'no project';
  return [group.project, group.worktree, group.subpath].filter(Boolean).join(' › ');
}

// --- Killing ----------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

async function killPid(pid) {
  return (await killPids([pid]))[0];
}

/** SIGTERM every pid, wait, then SIGKILL any survivors. */
async function killPids(pids) {
  const results = new Map(pids.map((pid) => [pid, { pid, ok: false, step: 'SIGTERM' }]));
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code === 'ESRCH') results.set(pid, { pid, ok: true, step: 'already exited' });
      else results.set(pid, { pid, ok: false, step: 'SIGTERM', error: err.message });
    }
  }
  await sleep(700);
  const survivors = pids.filter((pid) => !results.get(pid).error && results.get(pid).step !== 'already exited' && isPidAlive(pid));
  for (const pid of pids) {
    const r = results.get(pid);
    if (!r.error && r.step === 'SIGTERM' && !survivors.includes(pid)) r.ok = true;
  }
  if (survivors.length) {
    for (const pid of survivors) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if (err.code !== 'ESRCH') results.set(pid, { pid, ok: false, step: 'SIGKILL', error: err.message });
      }
    }
    await sleep(300);
    for (const pid of survivors) {
      const r = results.get(pid);
      if (r.error) continue;
      const alive = isPidAlive(pid);
      results.set(pid, { pid, ok: !alive, step: 'SIGKILL', error: alive ? 'Still alive after SIGKILL' : undefined });
    }
  }
  return pids.map((pid) => results.get(pid));
}

function signalAll(pids, signal) {
  return pids.map((pid) => {
    try {
      process.kill(pid, signal);
      return { pid, ok: true, step: signal };
    } catch (err) {
      return { pid, ok: err.code === 'ESRCH', step: signal, error: err.code === 'ESRCH' ? undefined : err.message };
    }
  });
}

/**
 * Pause a group (SIGSTOP): it stops using CPU but keeps its memory. Whatever is waiting on it
 * (an agent's test command, a browser hitting a dev server) waits too, until it is resumed.
 * Root first so a wrapper can't react to its children stopping.
 */
function pauseGroup(group) {
  if (group.isSelf) return [{ pid: group.rootPid, ok: false, step: 'refused', error: 'Group contains the caller or its parents' }];
  return signalAll([group.rootPid, ...group.members.map((m) => m.pid).filter((p) => p !== group.rootPid)], 'SIGSTOP');
}

/** Resume a paused group (SIGCONT): workers first, then the root. */
function resumeGroup(group) {
  return signalAll([...group.members.map((m) => m.pid).filter((p) => p !== group.rootPid), group.rootPid], 'SIGCONT');
}

/** Kill a whole group: workers first, then the root, so wrappers don't respawn them. */
async function killGroup(group) {
  if (group.isSelf) {
    return [{ pid: group.rootPid, ok: false, step: 'refused', error: 'Group contains the caller or its parents' }];
  }
  // A paused process can't act on SIGTERM (or reap its dead workers); always wake the group first,
  // since the caller's snapshot may predate a pause. SIGCONT is harmless to a running process.
  resumeGroup(group);
  const pids = group.members.map((m) => m.pid).filter((pid) => pid !== group.rootPid);
  const workerResults = pids.length ? await killPids(pids) : [];
  const rootResult = await killPids([group.rootPid]);
  return [...workerResults, ...rootResult];
}

module.exports = {
  scan,
  projectLabel,
  killPid,
  killPids,
  killGroup,
  pauseGroup,
  resumeGroup,
  isPidAlive,
  // exported for tests
  describeTask,
  describeKind,
  describeProjectDir,
  looksLikeViteProcess,
};
