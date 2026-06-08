#!/usr/bin/env node
'use strict';

/**
 * Interactive setup wizard for reolink-image-snapshot.
 *
 * Walks through every option, lets you navigate back, and produces:
 *   1. A ready-to-run `node reolink-image-snapshot.js ...` command line
 *   2. A `.env` block for Docker
 *
 * Usage:
 *   node setup.js
 *   node setup.js --from "node reolink-image-snapshot.js --host 192.168.1.1 ..."
 *   node setup.js --from "--host 192.168.1.1 --username admin ..."
 */

const readline = require('readline');

// ── ANSI colours ──────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
};

const w = s => process.stdout.write(s + '\n');
const hr = label => {
  const dashes = '─'.repeat(Math.max(0, 56 - (label ? label.length + 3 : 0)));
  return label
    ? `\n${C.cyan}── ${C.bold}${label} ${C.reset}${C.cyan}${dashes}${C.reset}`
    : `${C.dim}${'─'.repeat(58)}${C.reset}`;
};
const box = (title, char = '═') => {
  const line = char.repeat(58);
  w(`\n${C.bold}${line}`);
  w(`  ${title}`);
  w(`${line}${C.reset}`);
};

// ── Step definitions ──────────────────────────────────────────────────────────

const STEPS = [
  // ── Camera Connection
  {
    id: 'host', section: 'Camera Connection',
    label: 'Camera IP address or hostname',
    envVar: 'REOLINK_HOST', required: true,
    hint: 'e.g. 192.168.1.100',
  },
  {
    id: 'username', section: 'Camera Connection',
    label: 'Login username',
    envVar: 'REOLINK_USERNAME', default: 'admin',
  },
  {
    id: 'password', section: 'Camera Connection',
    label: 'Login password',
    envVar: 'REOLINK_PASSWORD', required: true, secret: true,
  },
  {
    id: 'port', section: 'Camera Connection',
    label: 'HTTPS port',
    envVar: 'REOLINK_PORT', default: '443',
  },
  {
    id: 'channel', section: 'Camera Connection',
    label: 'Camera channel index',
    envVar: 'REOLINK_CHANNEL', default: '0',
    hint: '0 = first camera; multi-camera hubs use 1, 2, …',
  },
  {
    id: 'stream', section: 'Camera Connection',
    label: 'Stream quality',
    envVar: 'REOLINK_STREAM', default: 'main',
    choices: ['main', 'sub'],
    hint: 'main = full resolution, sub = lower resolution',
  },

  // ── Snapshot Capture
  {
    id: 'outputDir', section: 'Snapshot Capture',
    label: 'Output directory for JPEG files',
    envVar: 'SNAPSHOT_OUTPUT_DIR', required: true,
    hint: 'e.g. ./snapshots  or  /mnt/nas/camera',
  },
  {
    id: 'interval', section: 'Snapshot Capture',
    label: 'Seconds between captures',
    envVar: 'REOLINK_INTERVAL', default: '120',
    hint: 'Captures align to the clock (120 = every 2 min on :00 and :02)',
  },
  {
    id: 'timeout', section: 'Snapshot Capture',
    label: 'HTTP request timeout (seconds)',
    envVar: 'REOLINK_TIMEOUT', default: '120',
  },
  {
    id: 'retries', section: 'Snapshot Capture',
    label: 'Retries on a failed snap before logging an error',
    envVar: 'REOLINK_RETRIES', default: '2',
  },
  {
    id: 'subdirByDate', section: 'Snapshot Capture',
    label: 'Organise snapshots into yyyy/mm/dd/ subdirectories?',
    envVar: 'REOLINK_SUBDIR_BY_DATE', type: 'bool', default: 'n',
    hint: 'Recommended for long-running setups. Timelapse handles both layouts.',
  },
  {
    id: 'localTime', section: 'Snapshot Capture',
    label: 'Use local system time in filenames instead of UTC?',
    envVar: 'REOLINK_LOCAL_TIME', type: 'bool', default: 'n',
    hint: 'Default: 2026-06-02-10-00-00-utc.jpg   Local: 2026-06-02-12-00-00.jpg\n       In Docker also set TZ=Europe/Oslo (or your timezone).',
  },

  // ── Display
  {
    id: 'ui', section: 'Display',
    label: 'Enable full-screen terminal UI?',
    envVar: 'REOLINK_UI', type: 'bool', default: 'n',
    hint: 'Default is plain line logging. UI requires a real TTY (not Docker).',
  },

  // ── Battery
  {
    id: 'batteryMah', section: 'Battery',
    label: 'Battery capacity in mAh',
    envVar: 'REOLINK_BATTERY_MAH', default: '5000',
    hint: '5000 = Argus 4 Pro. Used for charge-rate and time-to-full estimates.',
  },
  {
    id: 'batteryLog', section: 'Battery',
    label: 'Battery log file path',
    envVar: 'REOLINK_BATTERY_LOG', optional: true,
    hint: 'TSV file appended after every capture. Leave blank to skip.',
  },

  // ── Status JSON
  {
    id: 'statusDir', section: 'Status JSON',
    label: 'Local directory to write status.json',
    envVar: 'REOLINK_STATUS_DIR', optional: true,
    hint: 'Battery metrics written after each capture. Leave blank to skip.',
  },

  // ── S3 Upload
  {
    id: 's3Enable', section: 'S3 Upload',
    label: 'Enable S3 upload?',
    type: 'bool', default: 'n',
  },
  {
    id: 's3Bucket', section: 'S3 Upload',
    label: 'S3 bucket name',
    envVar: 'REOLINK_S3_BUCKET',
    showIf: a => a.s3Enable === 'y',
  },
  {
    id: 's3Region', section: 'S3 Upload',
    label: 'AWS region',
    envVar: 'REOLINK_S3_REGION', optional: true,
    showIf: a => a.s3Enable === 'y',
    hint: 'e.g. eu-north-1  (leave blank if using IAM role or default chain)',
  },
  {
    id: 's3Prefix', section: 'S3 Upload',
    label: 'Global S3 key prefix',
    envVar: 'REOLINK_S3_PREFIX', optional: true,
    showIf: a => a.s3Enable === 'y',
    hint: 'Applied to all uploads unless overridden below. e.g. reolink/roof',
  },
  {
    id: 's3SnapshotPrefix', section: 'S3 Upload',
    label: 'Snapshot-specific prefix (overrides global)',
    envVar: 'REOLINK_S3_SNAPSHOT_PREFIX', optional: true,
    showIf: a => a.s3Enable === 'y',
    hint: 'Leave blank to fall back to the global prefix above.',
  },
  {
    id: 's3StatusPrefix', section: 'S3 Upload',
    label: 'status.json prefix (overrides global)',
    envVar: 'REOLINK_S3_STATUS_PREFIX', optional: true,
    showIf: a => a.s3Enable === 'y',
    hint: 'Leave blank to fall back to the global prefix above.',
  },
  {
    id: 's3UploadLatest', section: 'S3 Upload',
    label: 'Upload latest.jpg? (overwritten on each capture)',
    type: 'bool', default: 'y',
    showIf: a => a.s3Enable === 'y',
  },
  {
    id: 's3UploadTimestamped', section: 'S3 Upload',
    label: 'Also upload a timestamped copy? (accumulates one per capture)',
    type: 'bool', default: 'n',
    showIf: a => a.s3Enable === 'y',
  },
  {
    id: 's3UploadStatus', section: 'S3 Upload',
    label: 'Upload status.json to S3?',
    type: 'bool', default: 'y',
    showIf: a => a.s3Enable === 'y',
  },

  // ── Timelapse
  {
    id: 'timelapseEnable', section: 'Timelapse',
    label: 'Enable timelapse video generation?',
    type: 'bool', default: 'n',
    hint: 'Runs concurrently with capture. Requires ffmpeg on PATH.',
  },
];

const TL_STEPS = [
  {
    id: 'window', label: 'Frame window',
    choices: ['today', '2d', '3d', '1w', 'daily-at'],
    hint: 'today=today only  2d=today+yesterday  3d=last 3 days  1w=this week (Mon 00:00 → now)  daily-at=one frame/day at a set time',
  },
  {
    id: 'schedule', label: 'Regeneration schedule',
    default: 'daily=00:00',
    hint: 'hourly | every=30m | every=2h | daily=HH:MM',
  },
  {
    id: 'output', label: 'Output directory for the video file',
    optional: true,
    hint: 'Leave blank to use the snapshot output dir.',
  },
  {
    id: 'name', label: 'Output filename',
    optional: true,
    hint: 'Leave blank for auto-naming, e.g. 2026-06-01_2026-06-02-2d.mp4',
  },
  {
    id: 'framerate', label: 'Playback framerate (fps)',
    default: '24',
  },
  {
    id: 's3prefix', label: 'Upload video to S3 at this prefix',
    optional: true,
    hint: 'Leave blank to skip. e.g. timelapses/roof  →  s3://BUCKET/timelapses/roof/<name>.mp4',
  },
];

// ── Tokeniser (handles single- and double-quoted tokens) ─────────────────────

function tokenize(str) {
  const tokens = [];
  let cur = '', inS = false, inD = false;
  for (const c of str) {
    if      (c === "'" && !inD) { inS = !inS; }
    else if (c === '"' && !inS) { inD = !inD; }
    else if (c === ' ' && !inS && !inD) { if (cur) { tokens.push(cur); cur = ''; } }
    else cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// ── Parse an existing command line into wizard answers ───────────────────────

function parseExistingCli(raw) {
  const str = raw.replace(/^\s*(node\s+)?reolink-image-snapshot\.js\s*/, '').trim();
  const tokens = tokenize(str);
  const answers = {};
  const timelapses = [];

  const FLAG_MAP = {
    'host': 'host', 'ip': 'host',
    'username': 'username',
    'password': 'password',
    'port': 'port',
    'channel': 'channel',
    'stream': 'stream',
    'output-dir': 'outputDir', 'd': 'outputDir',
    'interval': 'interval',
    'timeout': 'timeout',
    'retries': 'retries',
    'battery-mah': 'batteryMah',
    'battery-log': 'batteryLog',
    'status-dir': 'statusDir',
    's3-bucket': 's3Bucket',
    's3-prefix': 's3Prefix',
    's3-snapshot-prefix': 's3SnapshotPrefix',
    's3-status-prefix': 's3StatusPrefix',
    's3-region': 's3Region',
  };

  const BOOL_MAP = {
    'ui':               ['ui', 'y'],
    's3-no-latest':     ['s3UploadLatest', 'n'],
    's3-timestamped':   ['s3UploadTimestamped', 'y'],
    's3-no-status':     ['s3UploadStatus', 'n'],
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-')) continue;
    const flag = t.replace(/^--?/, '');

    if (BOOL_MAP[flag]) {
      const [key, val] = BOOL_MAP[flag];
      answers[key] = val;
      continue;
    }

    const next = tokens[i + 1];
    if (!next || next.startsWith('-')) continue;

    if (flag === 'timelapse') {
      timelapses.push(parseTlSpec(next));
      i++;
      continue;
    }

    const key = FLAG_MAP[flag];
    if (key) { answers[key] = next; i++; }
  }

  // Infer derived toggles
  if (answers.s3Bucket) {
    answers.s3Enable = 'y';
    if (!('s3UploadLatest'     in answers)) answers.s3UploadLatest      = 'y';
    if (!('s3UploadTimestamped' in answers)) answers.s3UploadTimestamped = 'n';
    if (!('s3UploadStatus'     in answers)) answers.s3UploadStatus      = 'y';
  }
  if (timelapses.length > 0) answers.timelapseEnable = 'y';

  return { answers, timelapses };
}

function parseTlSpec(str) {
  const cfg = {};
  for (const part of str.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    cfg[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cfg;
}

// ── Wizard ────────────────────────────────────────────────────────────────────

class Wizard {
  constructor(preloaded = {}) {
    this.answers    = preloaded.answers    || {};
    this.timelapses = preloaded.timelapses || [];
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  close() { this.rl.close(); }

  _prompt(str) {
    return new Promise(resolve => this.rl.question(str, a => resolve(a.trim())));
  }

  // Ask a single step. Returns the answer string, '__back__', or '__quit__'.
  async ask(step, stepLabel) {
    const cur = this.answers[step.id];
    const def = cur !== undefined ? cur : (step.default || '');

    w('');
    // label line
    let labelLine = `${C.bold}[${stepLabel}]${C.reset} ${step.label}`;
    if (step.required)        labelLine += `  ${C.red}(required)${C.reset}`;
    if (step.optional)        labelLine += `  ${C.dim}(optional)${C.reset}`;
    if (step.envVar)          labelLine += `  ${C.dim}${step.envVar}${C.reset}`;
    w(labelLine);
    if (step.hint)            w(`       ${C.dim}${step.hint}${C.reset}`);
    if (step.choices)         w(`       ${C.dim}choices: ${step.choices.join('  |  ')}${C.reset}`);

    if (step.type === 'bool') {
      const display = def === 'y' ? `${C.green}yes${C.reset}` : `${C.dim}no${C.reset}`;
      while (true) {
        const raw = await this._prompt(`       current: ${display}   Enter y/n  [b=back  q=quit] > `);
        if (raw === '')                          return def || 'n';
        if (raw === 'b')                         return '__back__';
        if (raw === 'q')                         { this.close(); process.exit(0); }
        if (/^[yn]$/i.test(raw) || raw === 'yes' || raw === 'no')
          return raw.toLowerCase().startsWith('y') ? 'y' : 'n';
        w(`       ${C.red}Please enter y or n.${C.reset}`);
      }
    }

    // Text input
    const defDisplay = step.secret && def ? '••••' : def;
    const defHint = def ? `${C.dim}(${defDisplay})${C.reset}  ` : '';
    while (true) {
      const raw = await this._prompt(`       ${defHint}[b=back  q=quit] > `);
      if (raw === 'b') return '__back__';
      if (raw === 'q') { this.close(); process.exit(0); }
      const val = raw === '' ? def : raw;
      if (!val && step.required) { w(`       ${C.red}This field is required.${C.reset}`); continue; }
      if (step.choices && val && !step.choices.includes(val)) {
        w(`       ${C.red}Must be one of: ${step.choices.join(', ')}${C.reset}`); continue;
      }
      return val;
    }
  }

  // ── Main question loop ──────────────────────────────────────────────────────

  async runMainSteps() {
    let i = 0;
    let lastSection = '';

    while (true) {
      const visible = STEPS.filter(s => !s.showIf || s.showIf(this.answers));
      if (i >= visible.length) break;
      if (i < 0) i = 0;

      const step = visible[i];

      if (step.section !== lastSection) {
        w(hr(step.section));
        lastSection = step.section;
      }

      const answer = await this.ask(step, `${i + 1}/${visible.length}`);

      if (answer === '__back__') {
        if (i === 0) { w(`  ${C.yellow}Already at the first question.${C.reset}`); continue; }
        i--;
        const prev = visible[i];
        // Force section header reprint when crossing section boundary going back
        if (prev.section !== step.section) lastSection = '';
        continue;
      }

      this.answers[step.id] = answer === '' ? undefined : answer;
      i++;
    }
  }

  // ── Timelapse loop ──────────────────────────────────────────────────────────

  async runTimelapse() {
    if (this.answers.timelapseEnable !== 'y') return;

    w(hr('Timelapse configs'));
    if (this.timelapses.length)
      w(`  ${C.dim}${this.timelapses.length} timelapse(s) loaded. You can add more or finish.${C.reset}`);

    while (true) {
      const idx = this.timelapses.length + 1;
      w(`\n  ${C.bold}Configure timelapse #${idx}${C.reset}`);

      const cfg = await this.runOneTl(idx);
      if (cfg === '__skip__') break;
      this.timelapses.push(cfg);

      w('');
      const more = await this._prompt(`  ${C.bold}Add another timelapse?${C.reset}  (${this.timelapses.length} so far)   y/n > `);
      if (!more.toLowerCase().startsWith('y')) break;
    }
  }

  async runOneTl(idx) {
    const cfg = {};
    let i = 0;

    while (i < TL_STEPS.length) {
      const step = TL_STEPS[i];

      // Skip s3prefix question if S3 is not enabled globally
      if (step.id === 's3prefix' && this.answers.s3Enable !== 'y') {
        i++; continue;
      }

      const answer = await this.ask(
        { ...step, section: `Timelapse #${idx}` },
        `T${idx}.${i + 1}/${TL_STEPS.length}`
      );

      if (answer === '__back__') {
        if (i === 0) {
          // Back from first timelapse question — abort this timelapse
          const abort = await this._prompt(`  ${C.yellow}Abort timelapse #${idx}?${C.reset}  y/n > `);
          if (abort.toLowerCase().startsWith('y')) return '__skip__';
          continue; // stay on first question
        }
        i--; continue;
      }

      // daily-at needs a follow-up time value
      if (step.id === 'window' && answer === 'daily-at') {
        while (true) {
          const time = await this._prompt(`       Time of day  HH:MM  (e.g. 12:00)  [b=back] > `);
          if (time === 'b') break; // re-ask window choice
          if (/^\d{1,2}:\d{2}$/.test(time)) { cfg.window = `daily-at=${time}`; i++; break; }
          w(`       ${C.red}Enter a time in HH:MM format.${C.reset}`);
        }
        if (!cfg.window) continue; // went back
      } else {
        cfg[step.id] = answer || undefined;
        i++;
      }
    }

    // Strip blank optional values
    for (const k of Object.keys(cfg)) if (!cfg[k]) delete cfg[k];
    return cfg;
  }

  // ── Output generation ───────────────────────────────────────────────────────

  generateOutput() {
    const a = this.answers;

    // ── CLI flags
    const flags = [];
    const add = (flag, val, skip) => { if (val && val !== skip) flags.push([flag, val]); };

    add('--host',        a.host);
    add('--username',    a.username);
    add('--password',    a.password);
    if (a.port     && a.port     !== '443')  add('--port',     a.port);
    if (a.channel  && a.channel  !== '0')    add('--channel',  a.channel);
    if (a.stream   && a.stream   !== 'main') add('--stream',   a.stream);
    add('--output-dir',  a.outputDir);
    if (a.interval && a.interval !== '120')  add('--interval', a.interval);
    if (a.timeout  && a.timeout  !== '120')  add('--timeout',  a.timeout);
    if (a.retries  && a.retries  !== '2')    add('--retries',  a.retries);
    if (a.subdirByDate === 'y')              flags.push(['--subdir-by-date', null]);
    if (a.localTime    === 'y')              flags.push(['--local-time',     null]);
    if (a.ui === 'y')                        flags.push(['--ui', null]);
    if (a.batteryMah && a.batteryMah !== '5000') add('--battery-mah', a.batteryMah);
    add('--battery-log', a.batteryLog);
    add('--status-dir',  a.statusDir);

    if (a.s3Enable === 'y') {
      add('--s3-bucket',          a.s3Bucket);
      add('--s3-region',          a.s3Region);
      add('--s3-prefix',          a.s3Prefix);
      add('--s3-snapshot-prefix', a.s3SnapshotPrefix);
      add('--s3-status-prefix',   a.s3StatusPrefix);
      if (a.s3UploadLatest      === 'n') flags.push(['--s3-no-latest',  null]);
      if (a.s3UploadTimestamped === 'y') flags.push(['--s3-timestamped',null]);
      if (a.s3UploadStatus      === 'n') flags.push(['--s3-no-status',  null]);
    }

    for (const tl of this.timelapses) {
      const parts = [];
      if (tl.window)    parts.push(`window=${tl.window}`);
      if (tl.schedule && tl.schedule !== 'daily=00:00') parts.push(`schedule=${tl.schedule}`);
      if (tl.output)    parts.push(`output=${tl.output}`);
      if (tl.name)      parts.push(`name=${tl.name}`);
      if (tl.framerate && tl.framerate !== '24') parts.push(`framerate=${tl.framerate}`);
      if (tl.s3prefix)  parts.push(`s3prefix=${tl.s3prefix}`);
      if (parts.length) flags.push(['--timelapse', parts.join(',')]);
    }

    // ── Print command
    box('COMMAND LINE');
    w('');
    if (!flags.length) {
      w(`${C.red}  No parameters configured.${C.reset}`);
    } else {
      const lines = [`${C.green}node reolink-image-snapshot.js${C.reset} \\`];
      flags.forEach(([flag, val], i) => {
        const last = i === flags.length - 1;
        const suffix = last ? '' : ' \\';
        if (val === null) {
          lines.push(`  ${C.cyan}${flag}${C.reset}${suffix}`);
        } else {
          const q = val.includes(',') || val.includes(' ') ? `"${val}"` : val;
          const masked = flag === '--password' ? `'••••'` : q;
          lines.push(`  ${C.cyan}${flag}${C.reset} ${masked}${suffix}`);
        }
      });
      w(lines.join('\n'));
    }

    // Unmasked copy for easy copy-paste (password shown)
    w('');
    w(`${C.dim}(Password shown below for copy-paste — keep this secure)${C.reset}`);
    if (flags.length) {
      const lines = ['node reolink-image-snapshot.js \\'];
      flags.forEach(([flag, val], i) => {
        const last = i === flags.length - 1;
        const suffix = last ? '' : ' \\';
        if (val === null) lines.push(`  ${flag}${suffix}`);
        else {
          const q = val.includes(',') || val.includes(' ') ? `"${val}"` : val;
          lines.push(`  ${flag} ${q}${suffix}`);
        }
      });
      w(lines.join('\n'));
    }

    // ── Print .env block
    box('DOCKER / .env VARIABLES');
    w('');

    const env = [];
    const addEnv = (k, v) => { if (v) env.push([k, v]); };

    addEnv('REOLINK_HOST',      a.host);
    addEnv('REOLINK_USERNAME',  a.username);
    addEnv('REOLINK_PASSWORD',  a.password);
    if (a.port     && a.port     !== '443')  addEnv('REOLINK_PORT',    a.port);
    if (a.channel  && a.channel  !== '0')    addEnv('REOLINK_CHANNEL', a.channel);
    if (a.stream   && a.stream   !== 'main') addEnv('REOLINK_STREAM',  a.stream);
    addEnv('SNAPSHOT_OUTPUT_DIR', a.outputDir || '/data');
    if (a.interval && a.interval !== '120')  addEnv('REOLINK_INTERVAL', a.interval);
    if (a.timeout  && a.timeout  !== '120')  addEnv('REOLINK_TIMEOUT',  a.timeout);
    if (a.retries  && a.retries  !== '2')    addEnv('REOLINK_RETRIES',  a.retries);
    if (a.subdirByDate === 'y')              addEnv('REOLINK_SUBDIR_BY_DATE', 'true');
    if (a.localTime    === 'y')              addEnv('REOLINK_LOCAL_TIME',     'true');
    if (a.ui === 'y')                        addEnv('REOLINK_UI', 'true');
    if (a.batteryMah && a.batteryMah !== '5000') addEnv('REOLINK_BATTERY_MAH', a.batteryMah);
    addEnv('REOLINK_BATTERY_LOG', a.batteryLog);
    addEnv('REOLINK_STATUS_DIR',  a.statusDir);

    if (a.s3Enable === 'y') {
      env.push(['', '# S3']);
      addEnv('REOLINK_S3_BUCKET',          a.s3Bucket);
      addEnv('REOLINK_S3_REGION',          a.s3Region);
      addEnv('REOLINK_S3_PREFIX',          a.s3Prefix);
      addEnv('REOLINK_S3_SNAPSHOT_PREFIX', a.s3SnapshotPrefix);
      addEnv('REOLINK_S3_STATUS_PREFIX',   a.s3StatusPrefix);
      if (a.s3UploadLatest      === 'n') addEnv('REOLINK_S3_NO_LATEST',   'true');
      if (a.s3UploadTimestamped === 'y') addEnv('REOLINK_S3_TIMESTAMPED', 'true');
      if (a.s3UploadStatus      === 'n') addEnv('REOLINK_S3_NO_STATUS',   'true');
      env.push(['AWS_ACCESS_KEY_ID',     '<your-access-key>']);
      env.push(['AWS_SECRET_ACCESS_KEY', '<your-secret-key>']);
    }

    if (this.timelapses.length > 0) {
      env.push(['', '# Timelapse']);
      for (let i = 0; i < this.timelapses.length; i++) {
        const tl = this.timelapses[i];
        const parts = [];
        if (tl.window)                        parts.push(`window=${tl.window}`);
        if (tl.schedule)                      parts.push(`schedule=${tl.schedule}`);
        if (tl.output)                        parts.push(`output=${tl.output}`);
        if (tl.name)                          parts.push(`name=${tl.name}`);
        if (tl.framerate && tl.framerate !== '24') parts.push(`framerate=${tl.framerate}`);
        if (tl.s3prefix)                      parts.push(`s3prefix=${tl.s3prefix}`);
        addEnv(`REOLINK_TIMELAPSE_${i + 1}`, parts.join(','));
      }
    }

    for (const [k, v] of env) {
      if (!k) { w(`${C.dim}${v}${C.reset}`); continue; }
      const masked = k === 'REOLINK_PASSWORD' ? '••••' : v;
      w(`${C.green}${k}${C.reset}=${masked}`);
    }

    w('');
    w(`${C.dim}Save the .env block above to a file named ${C.reset}${C.bold}.env${C.reset}${C.dim} (do not commit it to git).${C.reset}`);
    w(`${C.dim}For Docker: docker run --env-file .env ...${C.reset}`);
    w('');
  }

  async run() {
    box('reolink-image-snapshot  Setup Wizard', '═');
    w('');
    w(`  ${C.dim}Walk through every option and get a ready-to-run command.${C.reset}`);
    w(`  ${C.dim}Press Enter to accept the current/default value.${C.reset}`);
    w(`  ${C.dim}Type ${C.reset}${C.bold}b${C.reset}${C.dim} to go back · ${C.bold}q${C.reset}${C.dim} to quit at any time.${C.reset}`);
    if (Object.keys(this.answers).length > 0) {
      const n = Object.values(this.answers).filter(v => v !== undefined).length;
      w(`\n  ${C.yellow}${n} answer(s) pre-loaded from the provided command line.${C.reset}`);
    }

    await this.runMainSteps();
    await this.runTimelapse();

    this.generateOutput();
    this.close();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  let preloaded = {};

  const fromIdx = argv.indexOf('--from');
  if (fromIdx !== -1 && argv[fromIdx + 1]) {
    try {
      preloaded = parseExistingCli(argv[fromIdx + 1]);
      // Quick sanity output before wizard starts
    } catch (e) {
      process.stderr.write(`Warning: could not parse --from argument: ${e.message}\n`);
    }
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    w('');
    w(`${C.bold}Usage:${C.reset}`);
    w('  node setup.js');
    w('  node setup.js --from "node reolink-image-snapshot.js --host 192.168.1.1 ..."');
    w('  node setup.js --from "--host 192.168.1.1 --username admin ..."');
    w('');
    w('Walks through all options interactively and outputs a command line');
    w('plus a .env block ready to use with Docker.');
    w('');
    process.exit(0);
  }

  const wizard = new Wizard(preloaded);
  wizard.run().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}

main();
