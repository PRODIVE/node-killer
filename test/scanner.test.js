const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const scanner = require('../src/scanner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('describeTask labels common dev commands', () => {
  const cases = {
    '/opt/homebrew/opt/node/bin/node --env-file=/x/.env --import tsx src/server.ts': 'tsx src/server.ts',
    'node /w/node_modules/.bin/vitest run': 'vitest run',
    'node --require /w/node_modules/vitest/suppress-warnings.cjs /w/node_modules/vitest/dist/workers/forks.js': 'vitest',
    'node /p/node_modules/next/dist/bin/next dev --turbo': 'next dev',
    'npm run test': 'npm run test',
    'node /srv/app/server.js': 'app/server.js',
  };
  for (const [args, expected] of Object.entries(cases)) {
    assert.strictEqual(scanner.describeTask(args), expected, args);
  }
});

test('describeProjectDir finds the repo and subpath', () => {
  const info = scanner.describeProjectDir(path.join(__dirname, '..', 'src'));
  assert.strictEqual(info.project, 'node-killer');
  assert.strictEqual(info.subpath, 'src');
});

test('scan groups workers under their parent, labels it, and killGroup kills them all', async () => {
  // Launch via a shell that exits, so the fixture is orphaned rather than grouped under this test runner.
  const fixture = path.join(__dirname, 'fixture-group.js');
  const pid = Number(
    execFileSync('/bin/sh', ['-c', `"${process.execPath}" "${fixture}" >/dev/null 2>&1 & echo $!`], { cwd: path.join(__dirname, '..') })
      .toString()
      .trim()
  );
  const child = { pid, kill: (sig) => process.kill(pid, sig) };
  try {
    await sleep(1500);
    const groups = await scanner.scan();
    const group = groups.find((g) => g.rootPid === child.pid);
    assert.ok(group, 'fixture group found');
    assert.strictEqual(group.processCount, 3);
    assert.strictEqual(group.project, 'node-killer');
    assert.match(group.task, /fixture-group\.js/);
    assert.ok(group.cpu > 0);
    assert.strictEqual(group.isSelf, false);

    scanner.pauseGroup(group);
    await sleep(400);
    const paused = (await scanner.scan()).find((g) => g.rootPid === pid);
    assert.strictEqual(paused.paused, true, 'group reported as paused');
    scanner.resumeGroup(group);
    await sleep(400);
    assert.strictEqual((await scanner.scan()).find((g) => g.rootPid === pid).paused, false, 'resumed');
    scanner.pauseGroup(group); // killGroup must still work on a paused group

    const results = await scanner.killGroup(group);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    for (const m of group.members) assert.strictEqual(scanner.isPidAlive(m.pid), false, `pid ${m.pid} dead`);
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
});

test('scan marks its own process tree as self', async () => {
  const groups = await scanner.scan();
  const self = groups.find((g) => g.members.some((m) => m.pid === process.pid));
  assert.ok(self && self.isSelf);
  const res = await scanner.killGroup(self);
  assert.strictEqual(res[0].step, 'refused');
});

test('buildTree groups by project then instance, in cores, with heat', () => {
  const { buildTree, heatOf } = require('../src/snapshot');
  const g = (rootPid, project, worktree, cpu, extra = {}) => ({
    rootPid, project, worktree, cpu, title: 'Tests', kind: 'tests', task: 'vitest run', subpath: null, ports: [],
    app: 'T3 Code', memoryMb: 100, processCount: 1, elapsed: '01:00', command: 'x', projectRoot: '/p', cwd: '/p', isSelf: false, members: [], ...extra,
  });
  const tree = buildTree([g(1, 'prodiveos', 'wt-a', 420), g(2, 'prodiveos', null, 30), g(3, 'benos', null, 2), g(4, null, null, 50, { app: 'Claude' })]);
  assert.deepStrictEqual(tree.map((p) => p.name), ['prodiveos', 'benos', 'Other · Claude']);
  assert.strictEqual(tree[0].cores, 4.5);
  assert.strictEqual(tree[0].heat.level, 'hot');
  assert.deepStrictEqual(tree[0].instances.map((i) => i.label), ['Worktree: wt-a', 'Main checkout']);
  assert.strictEqual(heatOf(0.02).level, 'idle');
  assert.strictEqual(heatOf(1).level, 'busy');
  assert.strictEqual(heatOf(2).level, 'heavy');
});

test('memory parsers read vm_stat and swapusage', () => {
  const { parseVmStat, parseSwapUsage } = require('../src/memory');
  const vm = parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active:   100.\nPages wired down:  50.\nPages occupied by compressor:  25.\nSwapouts:  7.\n');
  assert.deepStrictEqual([vm.pageSize, vm.active, vm.wired, vm.compressor, vm.swapouts], [16384, 100, 50, 25, 7]);
  assert.deepStrictEqual(parseSwapUsage('total = 10240.00M  used = 9333.19M  free = 906.81M  (encrypted)'), { totalGb: 10, usedGb: 9333.19 / 1024 });
});
