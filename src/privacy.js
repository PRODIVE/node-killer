/**
 * Which process is behind a macOS permission prompt ("“node” would like to access…").
 *
 * macOS names the binary, and every Node process is the same binary, so the prompt alone can't say
 * which project asked. tccd (the privacy daemon) logs the pid it holds responsible for each request,
 * so we stream those log lines and match the pid against the labelled process groups.
 *
 * Cloud drives (Google Drive, Dropbox) are the exception: those requests come through sandboxd
 * without an attribution line. For them we take the runtime that tccd most recently attributed a
 * request to, and mark the match as likely rather than certain.
 *
 * Pure Node (no Electron), so the MCP server can read the saved history too.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const HISTORY_FILE = path.join(os.homedir(), '.node-killer', 'privacy-requests.json');
const HISTORY_MAX = 100;
const RUNTIME_PATH = /\/(node|bun|deno)(\d+)?$/;

const SERVICES = {
  kTCCServiceSystemPolicyDesktopFolder: 'Desktop folder',
  kTCCServiceSystemPolicyDocumentsFolder: 'Documents folder',
  kTCCServiceSystemPolicyDownloadsFolder: 'Downloads folder',
  kTCCServiceSystemPolicyNetworkVolumes: 'Network drives',
  kTCCServiceSystemPolicyRemovableVolumes: 'Removable drives',
  kTCCServiceSystemPolicyAppData: "Other apps' data",
  kTCCServiceSystemPolicyAppBundles: 'Apps folder',
  kTCCServiceSystemPolicyAllFiles: 'Full Disk Access',
  kTCCServiceFileProviderDomain: 'Cloud drives (Google Drive, Dropbox…)',
  kTCCServiceMediaLibrary: 'Music and media library',
  kTCCServicePhotos: 'Photos',
  kTCCServicePhotosAdd: 'Add to Photos',
  kTCCServiceAddressBook: 'Contacts',
  kTCCServiceCalendar: 'Calendar',
  kTCCServiceReminders: 'Reminders',
  kTCCServiceCamera: 'Camera',
  kTCCServiceMicrophone: 'Microphone',
  kTCCServiceScreenCapture: 'Screen recording',
  kTCCServiceListenEvent: 'Input monitoring',
  kTCCServiceAccessibility: 'Accessibility',
  kTCCServiceAppleEvents: 'Control other apps',
  kTCCServiceUbiquity: 'iCloud Drive',
  kTCCServiceBluetoothAlways: 'Bluetooth',
  kTCCServiceLocation: 'Location',
};

const KNOWN_ACCESSORS = {
  'com.anthropic.claude-code': 'a Claude agent',
  'com.apple.git': 'git',
};

function serviceLabel(service) {
  return SERVICES[service] || service.replace(/^kTCCService(SystemPolicy)?/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function parseProcess(text) {
  if (!text) return null;
  const pick = (key) => {
    const m = text.match(new RegExp(`${key}=([^,}]+)`));
    return m ? m[1].trim() : null;
  };
  const pid = Number(pick('pid'));
  return {
    identifier: pick('identifier'),
    pid: Number.isFinite(pid) ? pid : null,
    responsiblePath: pick('responsible_path'),
    binaryPath: pick('binary_path'),
  };
}

/** Parse one tccd message. Exported for tests. */
function parseMessage(message) {
  let m = message.match(/^AUTHREQ_CTX: msgID=([\d.]+), function=\w+, service=(\w+)/);
  if (m) return { kind: 'ctx', msgId: m[1], service: m[2] };

  m = message.match(/^AUTHREQ_ATTRIBUTION: msgID=([\d.]+), attribution=\{(.*)\}/);
  if (m) {
    const body = m[2];
    const section = (name) => {
      const s = body.match(new RegExp(`${name}=\\{TCCDProcess: ([^}]*)\\}`));
      return s ? parseProcess(s[1]) : null;
    };
    return { kind: 'attribution', msgId: m[1], responsible: section('responsible'), accessing: section('accessing') };
  }

  m = message.match(/^AUTHREQ_PROMPTING: msgID=([\d.]+), service=(\w+), subject=.*?Resp:\{TCCDProcess: ([^}]*)\}/);
  if (m) return { kind: 'prompting', msgId: m[1], service: m[2], responsible: parseProcess(m[3]) };

  m = message.match(/^AUTHREQ_RESULT: msgID=([\d.]+), authValue=(\d+)/);
  if (m) return { kind: 'result', msgId: m[1], authValue: Number(m[2]) };

  m = message.match(/TCCDEvent: type=(\w+), service=(kTCCServiceFileProviderDomain), identifier_type=Path, identifier=([^>]+)>/);
  if (m) return { kind: 'fileprovider', change: m[1], service: m[2], path: m[3].trim() };

  return null;
}

// authValue: 0 denied, 2 allowed, 3 limited.
function outcomeOf(authValue) {
  return { 0: 'denied', 2: 'allowed', 3: 'limited' }[authValue] || 'answered';
}

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function writeHistory(entries) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries.slice(0, HISTORY_MAX), null, 2));
  } catch (_) {}
}

class PrivacyWatcher extends EventEmitter {
  /**
   * @param {(pid: number) => object|null} labelFor  pid → { label, project, title, app } from the scanner
   */
  constructor(labelFor) {
    super();
    this.labelFor = labelFor;
    this.ctx = new Map(); // msgId → service (recent only)
    this.attribution = new Map(); // msgId → attribution
    this.entries = readHistory();
    this.lastRuntime = null; // most recent runtime that tccd attributed a request to
    this.child = null;
  }

  start() {
    if (this.child || process.platform !== 'darwin') return;
    const predicate =
      'process == "tccd" AND (eventMessage BEGINSWITH "AUTHREQ_CTX" OR eventMessage BEGINSWITH "AUTHREQ_ATTRIBUTION" ' +
      'OR eventMessage BEGINSWITH "AUTHREQ_PROMPTING" OR eventMessage BEGINSWITH "AUTHREQ_RESULT" ' +
      'OR eventMessage CONTAINS "kTCCServiceFileProviderDomain")';
    this.child = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', predicate], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) this.handleLine(line);
    });
    this.child.on('exit', () => {
      this.child = null;
      if (!this.stopped) setTimeout(() => this.start(), 5000); // log stream died: try again
    });
  }

  stop() {
    this.stopped = true;
    if (this.child) this.child.kill();
  }

  handleLine(line) {
    if (!line.startsWith('{')) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      return;
    }
    const parsed = parseMessage(event.eventMessage || '');
    if (!parsed) return;
    this.handle(parsed, event.timestamp ? new Date(event.timestamp.replace(' ', 'T')) : new Date());
  }

  remember(map, key, value) {
    map.set(key, value);
    if (map.size > 2000) map.delete(map.keys().next().value);
  }

  describe(pid, accessing) {
    const label = pid ? this.labelFor(pid) : null;
    const via = accessing && accessing.pid !== pid ? KNOWN_ACCESSORS[accessing.identifier] || accessing.identifier : null;
    return { pid, ...(label || { label: `pid ${pid} (already exited)` }), via };
  }

  handle(p, time) {
    if (p.kind === 'ctx') {
      this.remember(this.ctx, p.msgId, p.service);
      return;
    }
    if (p.kind === 'attribution') {
      this.remember(this.attribution, p.msgId, p);
      const resp = p.responsible;
      if (resp && RUNTIME_PATH.test(resp.responsiblePath || resp.binaryPath || '')) {
        this.lastRuntime = { pid: resp.pid, path: resp.responsiblePath || resp.binaryPath, accessing: p.accessing, time };
      }
      return;
    }
    if (p.kind === 'prompting') {
      const resp = p.responsible || {};
      const respPath = resp.responsiblePath || resp.binaryPath || '';
      if (!RUNTIME_PATH.test(respPath)) return; // only Node/Bun/Deno prompts
      if (this.entries.some((e) => e.msgId === p.msgId && e.outcome === 'waiting')) return; // re-shown prompt
      const attribution = this.attribution.get(p.msgId);
      const entry = {
        msgId: p.msgId,
        time: time.toISOString(),
        service: p.service,
        what: serviceLabel(p.service),
        binary: path.basename(respPath),
        certain: true,
        outcome: 'waiting',
        ...this.describe(resp.pid, attribution && attribution.accessing),
      };
      this.add(entry);
      this.emit('prompt', entry);
      return;
    }
    if (p.kind === 'result') {
      const entry = this.entries.find((e) => e.msgId === p.msgId);
      if (entry && entry.outcome === 'waiting') {
        entry.outcome = outcomeOf(p.authValue);
        this.save();
        this.emit('change', entry);
      }
      return;
    }
    if (p.kind === 'fileprovider') {
      if (!RUNTIME_PATH.test(p.path)) return;
      // Cloud-drive answers arrive without a pid. Several land together (one per account); keep one.
      const recent = this.entries.find((e) => e.service === p.service && Math.abs(time - Date.parse(e.time)) < 60_000);
      if (recent) return;
      const guess = this.lastRuntime && time - this.lastRuntime.time < 120_000 ? this.lastRuntime : null;
      const entry = {
        msgId: `fp-${time.getTime()}`,
        time: time.toISOString(),
        service: p.service,
        what: serviceLabel(p.service),
        binary: path.basename(p.path),
        certain: false,
        outcome: 'answered',
        ...(guess ? this.describe(guess.pid, guess.accessing) : { pid: null, label: 'unknown', via: null }),
      };
      this.add(entry);
      this.emit('prompt', entry);
    }
  }

  add(entry) {
    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, HISTORY_MAX);
    this.save();
  }

  save() {
    writeHistory(this.entries);
  }

  recent(ms = 24 * 3600 * 1000) {
    return this.entries.filter((e) => Date.now() - Date.parse(e.time) < ms);
  }
}

module.exports = { PrivacyWatcher, parseMessage, serviceLabel, readHistory, HISTORY_FILE };
