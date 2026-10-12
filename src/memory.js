/**
 * Whole-Mac memory: how much is in use, the kernel's pressure level, and whether
 * it is actively swapping right now. Swap *used* alone is misleading on macOS
 * (it stays high long after the crunch), so the live signal is swap-outs per second.
 */
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const GB = 1024 ** 3;

let lastSwap = null; // { t, swapouts, swapins }

function parseVmStat(stdout) {
  const pageSize = Number((stdout.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const field = (name) => {
    const m = stdout.match(new RegExp(`${name}:\\s+(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  return {
    pageSize,
    active: field('Pages active'),
    wired: field('Pages wired down'),
    compressor: field('Pages occupied by compressor'),
    swapins: field('Swapins'),
    swapouts: field('Swapouts'),
  };
}

function parseSwapUsage(text) {
  const num = (label) => {
    const m = text.match(new RegExp(`${label} = ([\\d.]+)M`));
    return m ? Number(m[1]) / 1024 : 0;
  };
  return { totalGb: num('total'), usedGb: num('used') };
}

const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };

async function sysctl(name) {
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', name], { timeout: 2000 });
    return stdout.trim();
  } catch (_) {
    return '';
  }
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * status: 'ok' | 'swapping' | 'critical'
 *  - critical: kernel says critical pressure
 *  - swapping: kernel warns, or the Mac pushed >2 MB/s to swap since the last reading
 */
async function readMemory(now = Date.now()) {
  const [vmOut, swapOut, levelOut] = await Promise.all([
    execFileAsync('vm_stat', [], { timeout: 2000 }).then((r) => r.stdout).catch(() => ''),
    sysctl('vm.swapusage'),
    sysctl('kern.memorystatus_vm_pressure_level'),
  ]);
  const vm = parseVmStat(vmOut);
  const swap = parseSwapUsage(swapOut);
  const totalGb = os.totalmem() / GB;
  const usedGb = ((vm.active + vm.wired + vm.compressor) * vm.pageSize) / GB;

  let swapOutMbPerSec = 0;
  let swapInMbPerSec = 0;
  if (lastSwap && now > lastSwap.t) {
    const secs = (now - lastSwap.t) / 1000;
    swapOutMbPerSec = Math.max(0, ((vm.swapouts - lastSwap.swapouts) * vm.pageSize) / (1024 * 1024) / secs);
    swapInMbPerSec = Math.max(0, ((vm.swapins - lastSwap.swapins) * vm.pageSize) / (1024 * 1024) / secs);
  }
  lastSwap = { t: now, swapouts: vm.swapouts, swapins: vm.swapins };

  const pressure = PRESSURE[Number(levelOut)] || 'normal';
  let status = 'ok';
  if (pressure === 'critical') status = 'critical';
  else if (pressure === 'warn' || swapOutMbPerSec > 2) status = 'swapping';

  return {
    totalGb: round1(totalGb),
    usedGb: round1(Math.min(usedGb, totalGb)),
    swapUsedGb: round1(swap.usedGb),
    swapTotalGb: round1(swap.totalGb),
    swapOutMbPerSec: round1(swapOutMbPerSec),
    swapInMbPerSec: round1(swapInMbPerSec),
    pressure,
    status,
    label: { ok: 'OK', swapping: 'Swapping', critical: 'Critical' }[status],
  };
}

module.exports = { readMemory, parseVmStat, parseSwapUsage };
