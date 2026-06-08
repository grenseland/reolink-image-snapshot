#!/usr/bin/env node
'use strict';

/**
 * Capture still images from a Reolink camera or Home Hub and save them locally.
 *
 * Runs until stopped (Ctrl+C), taking a snapshot on a clock-aligned schedule.
 * Uses the Reolink HTTP Snap API over HTTPS.
 */

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT          = 443;
const DEFAULT_INTERVAL      = 120;
const DEFAULT_BATTERY_MAH   = 5000;
const DEFAULT_BATTERY_NOMINAL_V = 3.7;
const CHARGE_EFFICIENCY     = 0.85;
const S3_LATEST_FILENAME    = 'latest.jpg';
const S3_STATUS_FILENAME    = 'status.json';

const CHARGE_STATUS_LABELS = {
  charging: 'Charging', chargecomplete: 'Fully charged',
  discharging: 'Discharging', none: 'Not charging',
};

const ADAPTER_LABELS = {
  solarpanel: 'solar panel', adapter: 'DC adapter', dc: 'DC adapter',
  ac: 'AC adapter', usb: 'USB', none: 'no adapter',
  0: 'no adapter', 1: 'DC adapter', 2: 'solar panel',
};

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', underline: '\x1b[4m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  clearScreen: '\x1b[2J', home: '\x1b[H',
  hideCursor: '\x1b[?25l', showCursor: '\x1b[?25h',
};

function moveTo(row, col) { return `\x1b[${row + 1};${col + 1}H`; }
function termCols() { return process.stdout.columns || 80; }
function termRows() { return process.stdout.rows || 24; }
function clipText(text, width) {
  if (width < 1) return '';
  if (text.length <= width) return text;
  return width <= 3 ? text.slice(0, width) : text.slice(0, width - 3) + '...';
}
function hline(width, ch = '─') { return ch.repeat(Math.max(0, width)); }

// ── HTTP helpers ─────────────────────────────────────────────────────────────

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function httpsPost(host, port, params, body, timeoutMs) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const bodyBuf = Buffer.from(JSON.stringify(body));
  const options = {
    hostname: host, port,
    path: `/api.cgi?${qs}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length },
    agent: httpsAgent,
    timeout: timeoutMs,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── ReolinkClient ────────────────────────────────────────────────────────────

class SessionExpiredError extends Error {
  constructor(detail = 'please login first') {
    super(`Session expired: ${detail}`);
    this.name = 'SessionExpiredError';
    this.rspCode = -6;
  }
}

// Reolink hub sessions expire after some hours; this is normal, not a password change.
const SESSION_REFRESH_MS = 4 * 60 * 60 * 1000;

class ReolinkClient {
  constructor(host, username, password, port = DEFAULT_PORT) {
    this.host = host; this.username = username;
    this.password = password; this.port = port; this.token = null;
    this.loggedInAt = null;
  }

  async _post(cmd, body, { useToken = true, timeoutMs = 30000 } = {}) {
    const params = { cmd };
    if (useToken && this.token) params.token = this.token;
    const resp = await httpsPost(this.host, this.port, params, body, timeoutMs);
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status} from ${cmd}`);
    return resp;
  }

  async login(timeoutMs = 30000) {
    const body = [{ cmd: 'Login', action: 0,
      param: { User: { Version: '0', userName: this.username, password: this.password } } }];
    let result = JSON.parse((await this._post('Login', body, { useToken: false, timeoutMs })).body.toString());
    if (result[0]?.code === 0) {
      this.token = result[0].value.Token.name;
      this.loggedInAt = Date.now();
      return;
    }
    if (result[0]?.error?.rspCode === -5) {
      try { await this._post('Logout', [{ cmd: 'Logout', action: 0, param: {} }], { useToken: false, timeoutMs }); } catch (_) {}
      result = JSON.parse((await this._post('Login', body, { useToken: false, timeoutMs })).body.toString());
    }
    if (result[0]?.code !== 0) {
      const err = result[0]?.error || {};
      if (err.rspCode === -5) throw new Error('Login failed: max session. Too many API sessions — wait, close other Reolink clients, or reboot the hub.');
      throw new Error(`Login failed: ${JSON.stringify(result, null, 2)}`);
    }
    this.token = result[0].value.Token.name;
    this.loggedInAt = Date.now();
  }

  sessionStale() {
    return !this.loggedInAt || (Date.now() - this.loggedInAt) > SESSION_REFRESH_MS;
  }

  async logout() {
    if (!this.token) return;
    try { await this._post('Logout', [{ cmd: 'Logout', action: 0, param: {} }]); } catch (_) {}
    this.token = null;
    this.loggedInAt = null;
  }

  async snap(channel, stream, timeoutMs) {
    const body = [{ cmd: 'Snap', action: 0,
      param: { Snap: { channel, snapType: stream, times: 1, interval: 0 } } }];
    const resp = await this._post('Snap', body, { timeoutMs });
    const ct = resp.headers['content-type'] || '';
    if (ct.startsWith('image/')) return resp.body;
    const payload = JSON.parse(resp.body.toString());
    const entry = Array.isArray(payload) ? payload[0] : payload;
    const apiErr = entry?.error || {};
    if (apiErr.rspCode === -6 || /login/i.test(String(apiErr.detail || ''))) {
      throw new SessionExpiredError(apiErr.detail || 'please login first');
    }
    throw new Error(`Snap failed: ${JSON.stringify(payload, null, 2)}`);
  }

  async getBatteryInfo(channel, timeoutMs = 30000) {
    try {
      const body = [{ cmd: 'GetBatteryInfo', action: 0, param: { channel } }];
      const resp = await this._post('GetBatteryInfo', body, { timeoutMs });
      const result = JSON.parse(resp.body.toString());
      if (result[0]?.code !== 0) return null;
      const bat = result[0]?.value?.Battery;
      return bat ? { ...bat } : null;
    } catch (_) { return null; }
  }
}

// ── Argument parsing ─────────────────────────────────────────────────────────

function envStr(name, fallback = '') {
  const v = process.env[name];
  return (v !== undefined && v !== '') ? v : fallback;
}
function envInt(name, fallback) { return parseInt(envStr(name, String(fallback)), 10); }
function envBool(name) { return /^(1|true|yes)$/i.test(envStr(name)); }

// Parse a single interval rule string "PCT:SECONDS", e.g. "50:30"
function parseIntervalRule(str) {
  const m = str.trim().match(/^(\d+):(\d+)$/);
  if (!m) throw new Error(`Invalid --interval-rule "${str}" — expected format PCT:SECONDS (e.g. 50:30)`);
  const minPct = parseInt(m[1], 10), intervalSec = parseInt(m[2], 10);
  if (intervalSec < 1) throw new Error(`Interval must be at least 1 second in rule "${str}"`);
  return { minPct, intervalSec };
}

// Parse comma-separated rules string, e.g. "50:30,40:120,20:180"
// Returns array sorted descending by minPct.
function parseIntervalRules(str) {
  if (!str.trim()) return [];
  return str.split(',')
    .map(s => parseIntervalRule(s.trim()))
    .sort((a, b) => b.minPct - a.minPct);
}

// Given sorted rules and a battery percentage, return the appropriate interval.
// Falls back to defaultSec when battery is unknown or below all thresholds.
function intervalForBattery(rules, batteryPct, defaultSec) {
  if (!rules || rules.length === 0) return defaultSec;
  if (batteryPct != null) {
    for (const rule of rules) {          // sorted descending
      if (batteryPct >= rule.minPct) return rule.intervalSec;
    }
  }
  return rules[rules.length - 1].intervalSec; // below all thresholds → most conservative
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    // Connection
    host:               envStr('REOLINK_HOST') || envStr('REOLINK_IP') || null,
    username:           envStr('REOLINK_USERNAME') || null,
    password:           envStr('REOLINK_PASSWORD') || null,
    port:               envInt('REOLINK_PORT', DEFAULT_PORT),
    channel:            envInt('REOLINK_CHANNEL', 0),
    stream:             envStr('REOLINK_STREAM', 'main'),
    // Capture
    outputDir:          envStr('SNAPSHOT_OUTPUT_DIR') || envStr('REOLINK_OUTPUT_DIR') || null,
    interval:           envInt('REOLINK_INTERVAL', DEFAULT_INTERVAL),
    intervalRules:      parseIntervalRules(envStr('REOLINK_INTERVAL_RULES', '')),
    once:               envBool('REOLINK_ONCE'),
    timeout:            envInt('REOLINK_TIMEOUT', 120) * 1000,
    retries:            envInt('REOLINK_RETRIES', 2),
    subdirByDate:       envBool('REOLINK_SUBDIR_BY_DATE'),
    localTime:          envBool('REOLINK_LOCAL_TIME'),
    // Display — plain is default; opt in to GUI with --ui
    ui:                 envBool('REOLINK_UI'),
    // Battery
    batteryMah:         envInt('REOLINK_BATTERY_MAH', DEFAULT_BATTERY_MAH),
    batteryLog:         envStr('REOLINK_BATTERY_LOG') || null,
    // Status JSON — can be uploaded to S3 and/or saved locally
    statusDir:          envStr('REOLINK_STATUS_DIR') || null,
    // S3
    s3Bucket:            envStr('REOLINK_S3_BUCKET') || null,
    s3Prefix:            envStr('REOLINK_S3_PREFIX', ''),          // global fallback prefix
    s3SnapshotPrefix:    envStr('REOLINK_S3_SNAPSHOT_PREFIX') || null,  // overrides s3Prefix for snapshots
    s3StatusPrefix:      envStr('REOLINK_S3_STATUS_PREFIX') || null,    // overrides s3Prefix for status.json
    s3Region:            envStr('REOLINK_S3_REGION') || envStr('AWS_DEFAULT_REGION') || null,
    // S3 upload choices (all default true when s3Bucket is set; disable individually)
    s3UploadLatest:      !envBool('REOLINK_S3_NO_LATEST'),
    s3UploadTimestamped: envBool('REOLINK_S3_TIMESTAMPED'),
    s3UploadStatus:      !envBool('REOLINK_S3_NO_STATUS'),
    // Timelapse — array of config objects built from --timelapse flags and/or env vars
    timelapses: [],
    // Individual env-var/flag shorthands (produce one config entry at end of parsing)
    _tlWindow:    envStr('REOLINK_TIMELAPSE_WINDOW') || null,
    _tlSchedule:  envStr('REOLINK_TIMELAPSE_SCHEDULE', 'daily=00:00'),
    _tlOutput:    envStr('REOLINK_TIMELAPSE_OUTPUT') || null,
    _tlName:      envStr('REOLINK_TIMELAPSE_NAME') || null,
    _tlFramerate: envInt('REOLINK_TIMELAPSE_FRAMERATE', 24),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if      (a === '--host' || a === '--ip')    args.host = next();
    else if (a === '--username')                args.username = next();
    else if (a === '--password')                args.password = next();
    else if (a === '--port')                    args.port = parseInt(next(), 10);
    else if (a === '--channel')                 args.channel = parseInt(next(), 10);
    else if (a === '--stream')                  args.stream = next();
    else if (a === '-d' || a === '--output-dir') args.outputDir = next();
    else if (a === '--interval')                args.interval = parseInt(next(), 10);
    else if (a === '--once')                    args.once = true;
    else if (a === '--timeout')                 args.timeout = parseInt(next(), 10) * 1000;
    else if (a === '--retries')                 args.retries = parseInt(next(), 10);
    else if (a === '--subdir-by-date')          args.subdirByDate = true;
    else if (a === '--local-time')              args.localTime = true;
    else if (a === '--ui')                      args.ui = true;
    else if (a === '--battery-mah')             args.batteryMah = parseInt(next(), 10);
    else if (a === '--battery-log')             args.batteryLog = next();
    else if (a === '--interval-rule') {
      const rule = parseIntervalRule(next());
      if (rule) args.intervalRules.push(rule);
      args.intervalRules.sort((a, b) => b.minPct - a.minPct);
    }
    else if (a === '--status-dir')              args.statusDir = next();
    else if (a === '--s3-bucket')               args.s3Bucket = next();
    else if (a === '--s3-prefix')               args.s3Prefix = next();
    else if (a === '--s3-snapshot-prefix')      args.s3SnapshotPrefix = next();
    else if (a === '--s3-status-prefix')        args.s3StatusPrefix = next();
    else if (a === '--s3-region')               args.s3Region = next();
    else if (a === '--s3-no-latest')            args.s3UploadLatest = false;
    else if (a === '--s3-timestamped')          args.s3UploadTimestamped = true;
    else if (a === '--s3-no-status')            args.s3UploadStatus = false;
    else if (a === '--timelapse')               args.timelapses.push(parseTimelapseSpec(next()));
    else if (a === '--timelapse-window')        args._tlWindow = next();
    else if (a === '--timelapse-schedule')      args._tlSchedule = next();
    else if (a === '--timelapse-output')        args._tlOutput = next();
    else if (a === '--timelapse-name')          args._tlName = next();
    else if (a === '--timelapse-framerate')     args._tlFramerate = parseInt(next(), 10);
    else if (a === '--help' || a === '-h')      { printHelp(); process.exit(0); }
  }

  const errors = [];
  if (!args.host)      errors.push('--host is required (or REOLINK_HOST)');
  if (!args.username)  errors.push('--username is required (or REOLINK_USERNAME)');
  if (!args.password)  errors.push('--password is required (or REOLINK_PASSWORD)');
  if (!args.outputDir) errors.push('--output-dir is required (or SNAPSHOT_OUTPUT_DIR / REOLINK_OUTPUT_DIR)');
  if (args.interval < 1) errors.push('--interval must be at least 1 second');
  if (!['main', 'sub'].includes(args.stream)) errors.push('--stream must be main or sub');

  // Promote individual env-var/flag shorthand into the timelapses array
  if (args._tlWindow) {
    args.timelapses.push({
      window:    args._tlWindow,
      schedule:  args._tlSchedule,
      output:    args._tlOutput   || null,
      name:      args._tlName     || null,
      framerate: args._tlFramerate,
    });
  }
  delete args._tlWindow; delete args._tlSchedule;
  delete args._tlOutput; delete args._tlName; delete args._tlFramerate;

  // Numbered multi-timelapse env vars: REOLINK_TIMELAPSE_1, REOLINK_TIMELAPSE_2, …
  for (let n = 1; n <= 20; n++) {
    const val = process.env[`REOLINK_TIMELAPSE_${n}`];
    if (!val) break;
    try { args.timelapses.push(parseTimelapseSpec(val)); }
    catch (e) { process.stderr.write(`Warning: REOLINK_TIMELAPSE_${n} is invalid — ${e.message}\n`); }
  }

  for (const cfg of args.timelapses) {
    try { validateTimelapseWindow(cfg.window); }   catch (e) { errors.push(e.message); }
    try { parseTimelapseSchedule(cfg.schedule); }  catch (e) { errors.push(e.message); }
  }

  if (errors.length) { errors.forEach(e => process.stderr.write(`Error: ${e}\n`)); process.exit(1); }
  return args;
}

function printHelp() {
  console.log(`
Usage: node reolink-image-snapshot.js [options]

All options can also be set via environment variables (shown in parentheses).

CAPTURE
  --host, --ip            Camera or Home Hub IP            (REOLINK_HOST / REOLINK_IP)
  --username              Login username                   (REOLINK_USERNAME)
  --password              Login password                   (REOLINK_PASSWORD)
  --port                  HTTPS port (default: ${DEFAULT_PORT})             (REOLINK_PORT)
  --channel               Camera channel (default: 0)      (REOLINK_CHANNEL)
  --stream                main|sub (default: main)         (REOLINK_STREAM)
  -d, --output-dir        Directory for JPEG files         (SNAPSHOT_OUTPUT_DIR)
  --interval SECONDS      Seconds between captures         (REOLINK_INTERVAL, default: ${DEFAULT_INTERVAL})
  --once                  Take a single snapshot and exit  (REOLINK_ONCE)
  --timeout SECONDS       HTTP timeout (default: 120)      (REOLINK_TIMEOUT)
  --retries N             Retry failed snap N times        (REOLINK_RETRIES, default: 2)
  --subdir-by-date        Save snapshots in yyyy/mm/dd/    (REOLINK_SUBDIR_BY_DATE)
                          subdirectories inside output-dir.
                          Recommended for long-running setups.
  --local-time            Use local system time in filenames  (REOLINK_LOCAL_TIME)
                          instead of UTC. Default: UTC with
                          -utc suffix, e.g. 2026-06-02-10-00-00-utc.jpg.
                          Local time: 2026-06-02-12-00-00.jpg (no suffix).
                          Set TZ env var for the correct timezone in Docker.

DISPLAY
  --ui                    Enable full-screen terminal UI   (REOLINK_UI)
                          Default: plain line logging

BATTERY
  --battery-mah N         Battery capacity for estimates   (REOLINK_BATTERY_MAH, default: ${DEFAULT_BATTERY_MAH})
  --battery-log FILE      Append battery metrics (TSV)     (REOLINK_BATTERY_LOG)
  --interval-rule PCT:SEC Adaptive interval rule.          (REOLINK_INTERVAL_RULES=50:30,40:120,20:180)
                          Repeat for multiple tiers. When battery is at or above
                          PCT%, use SEC seconds between snapshots. Rules are
                          evaluated highest-% first; the most conservative rule
                          applies when battery is below all thresholds.
                          Supersedes --interval when battery level is known.
                          Example: --interval-rule 50:30 --interval-rule 40:120 --interval-rule 20:180

STATUS JSON
  --status-dir DIR        Write status.json to DIR locally (REOLINK_STATUS_DIR)

S3 UPLOAD
  --s3-bucket NAME           S3 bucket to upload to              (REOLINK_S3_BUCKET)
  --s3-prefix PREFIX         Global key prefix (fallback for all) (REOLINK_S3_PREFIX)
  --s3-snapshot-prefix PFX   Prefix for snapshots only           (REOLINK_S3_SNAPSHOT_PREFIX)
  --s3-status-prefix PFX     Prefix for status.json only         (REOLINK_S3_STATUS_PREFIX)
  --s3-region REGION         AWS region                          (REOLINK_S3_REGION)
  --s3-no-latest             Do NOT upload latest.jpg            (REOLINK_S3_NO_LATEST=true)
  --s3-timestamped           Also upload <timestamp>.jpg         (REOLINK_S3_TIMESTAMPED=true)
  --s3-no-status             Do NOT upload status.json           (REOLINK_S3_NO_STATUS=true)

  Prefix resolution: --s3-snapshot-prefix overrides --s3-prefix for snapshots;
  --s3-status-prefix overrides --s3-prefix for status.json. Timelapse videos use
  the per-timelapse s3prefix= key (see TIMELAPSE section).

  When --s3-bucket is set, latest.jpg and status.json are uploaded by default.
  AWS credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (standard env vars).
  S3 upload requires @aws-sdk/client-s3 (npm install @aws-sdk/client-s3).

TIMELAPSE
  --timelapse "key=value,..."   Define a timelapse video. Repeat the flag for
                                multiple independent videos. Keys:

    window=W        (required) Which snapshots become frames:
                      today          Images from today (current calendar day)
                      yesterday      Images from yesterday — use with schedule="1 0 * * *"
                                     to produce a final complete video each night
                      2d             Today and yesterday
                      3d             Today and the previous 2 days
                      1w             This calendar week (Monday 00:00:00 → now)
                      daily-at=HH:MM One frame per calendar day, closest to HH:MM
    schedule=S      When to (re)generate (default: daily=00:00).
                    Accepts a standard 5-field cron expression:
                      "MIN HOUR DOM MONTH DOW"
                    Fields support *, */n, n, n-m, n-m/s, comma lists.
                    Examples:
                      "*/15 * * * *"   Every 15 minutes
                      "0 * * * *"      Every hour (on the hour)
                      "0 23 * * *"     Daily at 23:00
                      "0 6-22 * * *"   Every hour between 06:00 and 22:00
                      "0 8 * * 1-5"    Weekdays at 08:00
                    Legacy aliases (converted to cron internally):
                      hourly           →  "0 * * * *"
                      every=Nm         →  "*/N * * * *"
                      every=Nh         →  "0 */N * * *"
                      daily=HH:MM      →  "MM HH * * *"
    output=DIR      Directory for video files (default: --output-dir)
    name=FILE       Output filename (default: auto — see below)
    framerate=N     Playback speed in fps (default: 24)

  Auto-generated filename convention:
    today          →  YYYY-MM-DD-today.mp4
    2d / 3d / 1w   →  YYYY-MM-DD_YYYY-MM-DD-<window>.mp4
    daily-at=HH:MM →  YYYY-MM-DD_YYYY-MM-DD-daily-at-HHMM.mp4
  Dates/times are taken from the actual first and last frame in the video.

  Timelapse generation runs concurrently with snapshot capture — the capture
  schedule is never delayed waiting for ffmpeg. Requires ffmpeg on PATH.

  Env-var formats:
    Single config shorthand:
      REOLINK_TIMELAPSE_WINDOW, REOLINK_TIMELAPSE_SCHEDULE,
      REOLINK_TIMELAPSE_OUTPUT, REOLINK_TIMELAPSE_NAME, REOLINK_TIMELAPSE_FRAMERATE
    Multiple configs (same key=value format as --timelapse):
      REOLINK_TIMELAPSE_1="window=today,schedule=daily=23:00,s3prefix=tl/daily"
      REOLINK_TIMELAPSE_2="window=1w,schedule=daily=00:00"
      … up to REOLINK_TIMELAPSE_20 (stops at first missing number)

  --help, -h              Show this help
`.trim());
}

// ── Scheduling ───────────────────────────────────────────────────────────────

function nextCaptureTime(interval, after = null) {
  if (after !== null) return new Date(after.getTime() + interval * 1000);
  const now = new Date();

  if (interval >= 60 && interval % 60 === 0) {
    const stepMin = interval / 60;
    let c = new Date(now); c.setSeconds(0, 0);
    if (now.getSeconds() > 0 || now.getMilliseconds() > 0) c = new Date(c.getTime() + 60000);
    const rem = c.getMinutes() % stepMin;
    if (rem !== 0) c = new Date(c.getTime() + (stepMin - rem) * 60000);
    if (c <= now) c = new Date(c.getTime() + stepMin * 60000);
    return c;
  }

  if (interval < 60 && 60 % interval === 0) {
    let c = new Date(now); c.setMilliseconds(0);
    const slot = (Math.floor(now.getSeconds() / interval) + 1) * interval;
    if (slot >= 60) { c.setSeconds(0); c = new Date(c.getTime() + 60000); }
    else c.setSeconds(slot);
    if (c <= now) c = new Date(c.getTime() + interval * 1000);
    return c;
  }

  let c = new Date(now); c.setSeconds(0, 0);
  if (now.getSeconds() > 0 || now.getMilliseconds() > 0) c = new Date(c.getTime() + 60000);
  return c;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sleepUntil(when, onTick = null) {
  while (true) {
    const delay = when - Date.now();
    if (delay <= 0) return;
    if (onTick) onTick(when, delay / 1000);
    await sleep(Math.min(1000, delay));
  }
}

// ── Snapshot helpers ─────────────────────────────────────────────────────────

// localTime=false (default): UTC time, filename ends with -utc.jpg
// localTime=true:            local system time, no suffix
function snapshotFilename(when, localTime = false) {
  const d = when || new Date();
  const p = n => String(n).padStart(2, '0');
  if (localTime) {
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.jpg`;
  }
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}-utc.jpg`;
}

function saveSnapshot(image, outputDir, when, subdirByDate = false, localTime = false) {
  const d = when || new Date();
  const p = n => String(n).padStart(2, '0');
  const filename = snapshotFilename(d, localTime);
  // Subdirectory date components must match the same timezone as the filename
  const year  = localTime ? d.getFullYear()      : d.getUTCFullYear();
  const month = localTime ? d.getMonth() + 1     : d.getUTCMonth() + 1;
  const day   = localTime ? d.getDate()          : d.getUTCDate();
  let dir = outputDir;
  let relPath = filename;
  if (subdirByDate) {
    const sub = `${year}/${p(month)}/${p(day)}`;
    dir = path.join(outputDir, sub);
    relPath = `${sub}/${filename}`;
  }
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, image);
  return { filepath, filename, relPath };
}

// ── S3 helpers ───────────────────────────────────────────────────────────────

function prefixedKey(prefix, filename) {
  const p = (prefix || '').replace(/\/$/, '');
  return p ? `${p}/${filename}` : filename;
}

// Effective prefix per upload type: specific override falls back to global s3Prefix.
function snapshotPrefix(args) { return args.s3SnapshotPrefix !== null ? args.s3SnapshotPrefix : args.s3Prefix; }
function statusPrefix(args)   { return args.s3StatusPrefix   !== null ? args.s3StatusPrefix   : args.s3Prefix; }

async function uploadToS3(body, key, contentType, args) {
  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch (_) {
    throw new Error('@aws-sdk/client-s3 is required for S3 upload — run: npm install @aws-sdk/client-s3');
  }
  const cfg = {};
  if (args.s3Region) cfg.region = args.s3Region;
  const client = new S3Client(cfg);
  await client.send(new PutObjectCommand({ Bucket: args.s3Bucket, Key: key, Body: body, ContentType: contentType }));
}

// Returns an error string if any upload fails, null on full success.
// relPath = 'yyyy/mm/dd/filename.jpg' (with subdirs) or just 'filename.jpg' (flat).
async function maybeUploadSnapshot(image, relPath, args) {
  if (!args.s3Bucket) return null;
  const pfx = snapshotPrefix(args);
  const errs = [];
  if (args.s3UploadLatest) {
    try { await uploadToS3(image, prefixedKey(pfx, S3_LATEST_FILENAME), 'image/jpeg', args); }
    catch (err) { errs.push(`${S3_LATEST_FILENAME}: ${err.message}`); }
  }
  if (args.s3UploadTimestamped) {
    // Mirror the subdir structure (or flat filename) in the S3 key
    try { await uploadToS3(image, prefixedKey(pfx, relPath), 'image/jpeg', args); }
    catch (err) { errs.push(`${relPath}: ${err.message}`); }
  }
  return errs.length ? errs.join('; ') : null;
}

async function maybeUploadStatus(record, args) {
  if (!args.s3Bucket || !args.s3UploadStatus) return null;
  const key = prefixedKey(statusPrefix(args), S3_STATUS_FILENAME);
  try {
    await uploadToS3(Buffer.from(JSON.stringify(record, null, 2)), key, 'application/json', args);
    process.stdout.write(`S3: s3://${args.s3Bucket}/${key} OK\n`);
    return null;
  } catch (err) {
    process.stderr.write(`S3: s3://${args.s3Bucket}/${key} ERROR: ${err.message}\n`);
    return err.message;
  }
}

function maybeWriteStatusLocal(record, args) {
  if (!args.statusDir) return;
  try {
    const dir = path.resolve(args.statusDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, S3_STATUS_FILENAME), JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`Status dir write error (${args.statusDir}): ${err.message}\n`);
  }
}

// ── Battery helpers ──────────────────────────────────────────────────────────

function normalizeChargeStatus(v) {
  if (typeof v === 'number') return ({ 0: 'discharging', 1: 'charging', 2: 'chargecomplete' })[v] || 'unknown';
  if (v == null) return 'unknown';
  return String(v).toLowerCase().replace(/\s/g, '');
}

function adapterLabel(v) {
  if (v == null) return null;
  const key = String(v).toLowerCase().replace(/[_\s]/g, '');
  return ADAPTER_LABELS[key] ?? String(v);
}

function chargingPowerW(voltageMv, currentMa) {
  if (voltageMv == null || currentMa == null) return null;
  return Math.abs(Number(voltageMv) * Number(currentMa)) / 1_000_000;
}

function formatDuration(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

function formatElapsed(hours) {
  if (hours < 1) return `${Math.floor(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

function formatEtaClock(when) {
  const now = new Date();
  const h = String(when.getHours()).padStart(2, '0');
  const m = String(when.getMinutes()).padStart(2, '0');
  if (when.toDateString() === now.toDateString()) return `${h}:${m}`;
  const d = String(when.getDate()).padStart(2, '0');
  const mo = String(when.getMonth() + 1).padStart(2, '0');
  return `${d}.${mo} ${h}:${m}`;
}

function fmtDatetime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function estimateChargeRate(battery, batteryMah) {
  const percent = battery.batteryPercent;
  if (percent == null) return [null, null];
  const remaining = Math.max(0, 100 - Number(percent));
  if (remaining === 0) return [0, 0];

  const capacityWh = batteryMah * DEFAULT_BATTERY_NOMINAL_V / 1000;
  const remainingWh = capacityWh * (remaining / 100);
  const remainingMah = batteryMah * (remaining / 100);

  let pctPerHour = null, hoursToFull = null;
  const current = battery.current;
  if (current != null) {
    const chargeMa = Math.abs(Number(current));
    if (chargeMa > 0) { pctPerHour = (chargeMa / batteryMah) * 100; hoursToFull = remainingMah / chargeMa; }
  }
  const power = chargingPowerW(battery.voltage, current);
  if (power != null && power > 0) {
    const whPerHour = power * CHARGE_EFFICIENCY;
    const pctFromPower = (whPerHour / capacityWh) * 100;
    const hoursFromPower = remainingWh / whPerHour;
    if (pctPerHour == null) { pctPerHour = pctFromPower; hoursToFull = hoursFromPower; }
    else { pctPerHour = (pctPerHour + pctFromPower) / 2; hoursToFull = (hoursToFull + hoursFromPower) / 2; }
  }
  return [pctPerHour, hoursToFull];
}

// ── Battery session tracker ──────────────────────────────────────────────────

class BatterySessionTracker {
  constructor(batteryMah) { this.batteryMah = batteryMah; this.samples = []; this.coulombMah = 0; }

  record(battery) {
    if (!battery) return;
    const now = new Date();
    const percent  = battery.batteryPercent != null ? Number(battery.batteryPercent) : null;
    const voltageMv = battery.voltage != null ? Number(battery.voltage) : null;
    const currentMa = battery.current != null ? Number(battery.current) : null;
    const charge   = normalizeChargeStatus(battery.chargeStatus);

    if (this.samples.length > 0) {
      const prev = this.samples[this.samples.length - 1];
      const dtH = (now - prev.at) / 3_600_000;
      if (dtH > 0 && charge === 'charging') {
        const cs = [];
        if (prev.currentMa != null) cs.push(Math.abs(prev.currentMa));
        if (currentMa != null)      cs.push(Math.abs(currentMa));
        if (cs.length) this.coulombMah += (cs.reduce((a, b) => a + b, 0) / cs.length) * dtH;
      }
    }
    this.samples.push({ at: now, percent, voltageMv, currentMa, charge });
  }

  _regressionSlope(points) {
    if (points.length < 2) return null;
    const n = points.length;
    const mx = points.reduce((s, p) => s + p[0], 0) / n;
    const my = points.reduce((s, p) => s + p[1], 0) / n;
    const vx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    if (vx < 1e-12) return null;
    return points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / vx;
  }

  stats() {
    const ps = this.samples.filter(s => s.percent != null);
    if (!ps.length) return null;
    const first = ps[0], last = ps[ps.length - 1];
    const elapsedH = Math.max(0, (last.at - first.at) / 3_600_000);
    const delta = last.percent - first.percent;
    const points = ps.map(s => [(s.at - first.at) / 3_600_000, s.percent]);
    let slope = this._regressionSlope(points);
    if (slope == null && elapsedH > 0) slope = delta / elapsedH;
    const pctCoulomb = this.batteryMah > 0 ? (this.coulombMah / this.batteryMah) * 100 : null;
    const pctPerHourCoulomb = (pctCoulomb != null && elapsedH > 0) ? pctCoulomb / elapsedH : null;
    const etaFromRate = (rate, nowPct, at) => {
      if (rate == null || rate <= 0.01) return null;
      const rem = 100 - nowPct;
      return rem <= 0 ? at : new Date(at.getTime() + (rem / rate) * 3_600_000);
    };
    const vs = this.samples.filter(s => s.voltageMv != null);
    return {
      elapsedH, sampleCount: this.samples.length,
      startPercent: first.percent, currentPercent: last.percent, delta,
      pctPerHourBms: slope, pctPerHourCoulomb, coulombMah: this.coulombMah,
      voltageStartMv: vs.length ? vs[0].voltageMv : null,
      voltageNowMv:   vs.length ? vs[vs.length - 1].voltageMv : null,
      etaBms:     etaFromRate(slope, last.percent, last.at),
      etaCoulomb: etaFromRate(pctPerHourCoulomb, last.percent, last.at),
    };
  }
}

// ── Battery display lines ────────────────────────────────────────────────────

function sessionTrackingLines(tracker) {
  const stats = tracker.stats();
  const lines = ['', '— Since script start —'];
  if (!stats) { lines.push('Collecting battery data…'); return lines; }

  lines.push(`Runtime:         ${formatElapsed(stats.elapsedH)} (${stats.sampleCount} readings)`);
  if (stats.sampleCount < 2 || stats.elapsedH < 1 / 60) {
    lines.push('Need at least 2 readings for charge rate/ETA');
    lines.push(`Start level (BMS): ${stats.startPercent} %`);
    return lines;
  }
  const sign = stats.delta >= 0 ? '+' : '';
  lines.push(`BMS %:           ${stats.startPercent} % → ${stats.currentPercent} %  (${sign}${stats.delta.toFixed(1)} % actual)`);
  if (stats.pctPerHourBms != null) {
    if      (stats.delta > 0) lines.push(`Charge rate (measured): ${stats.pctPerHourBms >= 0 ? '+' : ''}${stats.pctPerHourBms.toFixed(2)} %/h  (from BMS percent)`);
    else if (stats.delta < 0) lines.push(`Change (measured):  ${stats.pctPerHourBms.toFixed(2)} %/h  (net loss)`);
    else                      lines.push('Charge rate (measured): 0 %/h (BMS percent unchanged)');
  }
  if (stats.coulombMah > 0) {
    lines.push(`Current integral: ${stats.coulombMah.toFixed(0)} mAh ≈ ${(stats.coulombMah / tracker.batteryMah * 100).toFixed(1)} % capacity`);
    if (stats.pctPerHourCoulomb != null && stats.pctPerHourCoulomb > 0)
      lines.push(`Charge rate (current): ${stats.pctPerHourCoulomb >= 0 ? '+' : ''}${stats.pctPerHourCoulomb.toFixed(2)} %/h  (from mA over time)`);
  }
  if (stats.voltageStartMv != null && stats.voltageNowMv != null) {
    const dv = stats.voltageNowMv - stats.voltageStartMv;
    lines.push(`Voltage:         ${stats.voltageStartMv} → ${stats.voltageNowMv} mV  (${dv >= 0 ? '+' : ''}${dv} mV, rough indicator — not exact %)`);
  }
  if (stats.currentPercent >= 100) {
    lines.push('Est. full (measured): already 100 %');
  } else if (stats.pctPerHourBms != null && stats.pctPerHourBms <= 0) {
    lines.push('Est. full (measured): — (no net charging yet)');
  } else {
    if (stats.etaBms) lines.push(`Est. full (measured): ~${formatEtaClock(stats.etaBms)}  (BMS trend)`);
    if (stats.etaCoulomb && stats.etaBms && Math.abs(stats.etaCoulomb - stats.etaBms) > 900_000)
      lines.push(`Est. full (current): ~${formatEtaClock(stats.etaCoulomb)}  (current integral)`);
    else if (stats.etaCoulomb && !stats.etaBms)
      lines.push(`Est. full (measured): ~${formatEtaClock(stats.etaCoulomb)}  (current integral)`);
  }
  lines.push('Measured ETA requires several hours of net charging; solar gives variable rate');
  return lines;
}

function batteryDetailLines(battery, batteryMah, tracker = null) {
  if (!battery) {
    const lines = ['Battery: not available from API'];
    if (tracker) lines.push(...sessionTrackingLines(tracker));
    return lines;
  }
  const percent = battery.batteryPercent;
  if (percent == null) return ['Battery: no percent in API response'];

  const charge  = normalizeChargeStatus(battery.chargeStatus);
  const adapter = adapterLabel(battery.adapterStatus);
  const power   = chargingPowerW(battery.voltage, battery.current);

  let chargeText;
  if      (charge === 'charging')        chargeText = adapter ? `Charging via ${adapter}` : 'Charging';
  else if (charge === 'chargecomplete')  chargeText = 'Fully charged';
  else                                   chargeText = CHARGE_STATUS_LABELS[charge] || 'Not charging';

  const lines = [
    `Level:          ${Math.floor(Number(percent))} %`,
    `Charge status:  ${chargeText}`,
    `Charge source:  ${adapter || '—'}`,
  ];
  if      (power != null)                                      lines.push(`Input power:    ${power.toFixed(2)} W  (${battery.voltage} mV, ${battery.current} mA)`);
  else if (adapter === 'solar panel' && charge !== 'charging') lines.push('Input power:    solar panel connected, low/no current now');
  else                                                          lines.push('Input power:    —');

  const temp = battery.temperature;
  lines.push(temp != null ? `Temperature:    ${Math.floor(Number(temp))} °C` : 'Temperature:    —');
  if (battery.lowPower === 1 || battery.lowPower === true || battery.lowPower === '1')
    lines.push('Warning:        low battery');

  if (charge === 'charging') {
    const [pctPerHour, hoursToFull] = estimateChargeRate(battery, batteryMah);
    if (pctPerHour != null && pctPerHour > 0) {
      lines.push(`Charge rate:    ~${pctPerHour.toFixed(2)} %/h`);
      if (hoursToFull != null && hoursToFull > 0)
        lines.push(`Est. full:      ~${formatDuration(hoursToFull)} (at current power)`);
    } else {
      lines.push('Charge rate:    too low to estimate');
    }
  } else if (charge === 'chargecomplete') {
    lines.push('Est. full:      already full');
  }
  if (battery._updated instanceof Date)
    lines.push(`Last updated:   ${fmtDatetime(battery._updated)}`);
  if (tracker) lines.push(...sessionTrackingLines(tracker));
  return lines;
}

// ── Battery TSV log ──────────────────────────────────────────────────────────

const TSV_COLUMNS = ['timestamp', 'percent', 'power_w', 'voltage_mv', 'current_ma', 'charge_rate_pct_per_h', 'eta_hours', 'eta_datetime'];

function buildBatteryRecord(battery, batteryMah, when) {
  const rec = { timestamp: fmtDatetime(when), percent: null, power_w: null, voltage_mv: null, current_ma: null, charge_rate_pct_per_h: null, eta_hours: null, eta_datetime: null };
  if (!battery) return rec;
  if (battery.batteryPercent != null) rec.percent = Math.floor(Number(battery.batteryPercent));
  const power = chargingPowerW(battery.voltage, battery.current);
  if (power != null)           rec.power_w = Number(power.toFixed(2));
  if (battery.voltage != null) rec.voltage_mv = Number(battery.voltage);
  if (battery.current != null) rec.current_ma = Number(battery.current);
  const charge = normalizeChargeStatus(battery.chargeStatus);
  if (charge === 'charging') {
    const [pctPerHour, hoursToFull] = estimateChargeRate(battery, batteryMah);
    if (pctPerHour != null && pctPerHour > 0) {
      rec.charge_rate_pct_per_h = Number(pctPerHour.toFixed(2));
      if (hoursToFull != null && hoursToFull > 0) {
        rec.eta_hours    = Number(hoursToFull.toFixed(2));
        rec.eta_datetime = fmtDatetime(new Date(when.getTime() + hoursToFull * 3_600_000));
      }
    }
  } else if (charge === 'chargecomplete') {
    rec.charge_rate_pct_per_h = 0; rec.eta_hours = 0;
  }
  return rec;
}

function appendBatteryTsv(logPath, record) {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const isNew = !fs.existsSync(logPath) || fs.statSync(logPath).size === 0;
  const row = TSV_COLUMNS.map(c => record[c] != null ? String(record[c]).replace(/[\t\r\n]/g, ' ') : '').join('\t');
  fs.appendFileSync(logPath, (isNew ? TSV_COLUMNS.join('\t') + '\n' : '') + row + '\n', 'utf8');
}

async function persistBatteryStatus(battery, batteryMah, when, batteryLog, args) {
  const record = buildBatteryRecord(battery, batteryMah, when);
  const statusErr = await maybeUploadStatus(record, args);
  maybeWriteStatusLocal(record, args);
  if (batteryLog) {
    try { appendBatteryTsv(batteryLog, record); }
    catch (err) { process.stderr.write(`Battery log error (${batteryLog}): ${err.message}\n`); }
  }
  return statusErr;
}

function saveDetail(uploadErr, statusErr, args, filename) {
  const items = [];
  if (args.s3Bucket) {
    if (args.s3UploadLatest)      items.push(S3_LATEST_FILENAME);
    if (args.s3UploadTimestamped && filename) items.push(filename);
    if (args.s3UploadStatus)      items.push(S3_STATUS_FILENAME);
  }
  if (args.statusDir) items.push(`${S3_STATUS_FILENAME} (local)`);

  const errs = [uploadErr, statusErr].filter(Boolean);
  if (errs.length) return `saved, error: ${errs.join('; ')}`;
  return items.length ? `saved + ${items.join(', ')}` : 'saved';
}

// ── Capture with retry ───────────────────────────────────────────────────────

function isAuthError(err) {
  if (err instanceof SessionExpiredError) return true;
  const msg = err?.message || '';
  return /rspCode["\s]*:\s*-6\b/.test(msg) || /please\s+login/i.test(msg) || /session expired/i.test(msg);
}

async function relogin(client, timeoutMs) {
  client.token = null;
  client.loggedInAt = null;
  try { await client.logout(); } catch (_) {}
  await client.login(timeoutMs);
  process.stdout.write('Re-logged in to Reolink hub.\n');
}

async function ensureSession(client, timeoutMs) {
  if (client.sessionStale()) {
    process.stdout.write('API session age limit — refreshing login…\n');
    await relogin(client, timeoutMs);
  }
}

async function captureWithRetry(client, args) {
  let lastErr;
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    try {
      await ensureSession(client, args.timeout);
      return await client.snap(args.channel, args.stream, args.timeout);
    } catch (err) {
      lastErr = err;
      if (attempt < args.retries) {
        if (isAuthError(err)) {
          process.stdout.write(`Snap attempt ${attempt + 1} failed: session expired — re-logging in…\n`);
          try { await relogin(client, args.timeout); }
          catch (loginErr) {
            process.stderr.write(`Re-login failed: ${loginErr.message}\n`);
            await sleep(5000);
          }
        } else {
          process.stderr.write(`Snap attempt ${attempt + 1} failed: ${err.message}. Retrying in 2s…\n`);
          await sleep(2000);
        }
      }
    }
  }
  throw lastErr;
}

// ── Terminal dashboard ───────────────────────────────────────────────────────

class TerminalDashboard {
  constructor(args) {
    this.args = args;
    this.history = [];
    this.batteryLines = ['Fetching battery data...'];
    this.statusLine = 'Starting...';
    this._active = false;
  }

  start() {
    this._active = true;
    process.stdout.write(A.hideCursor + A.clearScreen + A.home);
    process.stdout.on('resize', () => this.draw());
  }

  stop() {
    this._active = false;
    process.stdout.write(A.showCursor + A.clearScreen + A.home);
  }

  setWaiting(nextAt, secsLeft) {
    const p = n => String(n).padStart(2, '0');
    this.statusLine = `Waiting for next snapshot: ${p(nextAt.getHours())}:${p(nextAt.getMinutes())}:${p(nextAt.getSeconds())} (${Math.floor(secsLeft)} s)`;
    this.draw();
  }

  setWorking(msg) { this.statusLine = msg; this.draw(); }
  addSnapshot(entry) { this.history.unshift(entry); this.draw(); }
  updateBattery(lines) { this.batteryLines = lines; this.draw(); }

  draw() {
    if (!this._active) return;
    const W = termCols(), H = termRows();
    if (H < 8 || W < 40) {
      process.stdout.write(A.clearScreen + A.home + 'Terminal too small (minimum 40×8).\n');
      return;
    }
    const topRows = Math.max(6, Math.floor(H * 0.55));
    const bottomStart = topRows;
    const out = [A.clearScreen + A.home];
    const put = (row, col, text, attr = '') =>
      out.push(moveTo(row, col) + attr + clipText(String(text), W - col - 1) + A.reset);

    put(0, 0, ` reolink-image-snapshot  |  ${this.args.host} ch${this.args.channel}  |  ${this.args.outputDir}  |  interval ${this.args.interval}s  |  Ctrl+C to quit`, A.bold);
    put(1, 0, hline(W - 1));
    put(2, 1, 'Snapshots', A.underline);
    put(3, 1, this.statusLine, A.dim);

    const listStart = 4, listEnd = bottomStart - 1;
    const colTime = 2, colName = 22, colSize = W - 14;
    put(listStart, colTime, 'Time', A.dim);
    put(listStart, colName, 'File', A.dim);
    put(listStart, colSize, 'Size / detail', A.dim);

    let row = listStart + 1;
    for (const entry of this.history.slice(0, Math.max(0, listEnd - row))) {
      const attr = entry.ok ? A.green : A.red;
      put(row, colTime, fmtDatetime(entry.when), attr);
      put(row, colName, clipText(entry.filename, colSize - colName - 2), attr);
      put(row, colSize, entry.ok && entry.sizeBytes != null
        ? `${Math.round(entry.sizeBytes / 1024)} KB`
        : clipText(entry.detail, W - colSize - 1), attr);
      row++;
    }
    if (!this.history.length && row <= listEnd) put(row, 2, 'No snapshots yet.', A.dim);

    put(bottomStart, 0, hline(W - 1));
    put(bottomStart + 1, 1, 'Battery', A.underline);
    let batRow = bottomStart + 2;
    for (const line of this.batteryLines) {
      if (batRow >= H - 1) break;
      put(batRow++, 2, line);
    }
    process.stdout.write(out.join(''));
  }
}

// ── Timelapse ────────────────────────────────────────────────────────────────

// Global ffmpeg lock — ensures only one ffmpeg process runs at a time across
// all timelapse configs, preventing memory exhaustion on low-resource hosts.
let _ffmpegQueue = Promise.resolve();
function withFfmpegLock(fn) {
  const next = _ffmpegQueue.then(fn, fn); // run fn even if previous failed
  _ffmpegQueue = next.then(() => {}, () => {});
  return next;
}

// Parse --timelapse "window=today,schedule=daily=23:00,output=./tl,name=out.mp4,framerate=24"
// Values may contain '=' (e.g. daily-at=12:00), so split on commas then take first '=' as separator.
function parseTimelapseSpec(str) {
  const cfg = { schedule: 'daily=00:00', framerate: 24, output: null, name: null, s3prefix: null, threads: 2 };
  for (const part of str.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) throw new Error(`Invalid --timelapse option "${part}" — expected key=value`);
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if      (key === 'window')    cfg.window    = val;
    else if (key === 'schedule')  cfg.schedule  = val;
    else if (key === 'output')    cfg.output    = val;
    else if (key === 'name')      cfg.name      = val;
    else if (key === 'framerate') cfg.framerate = parseInt(val, 10);
    else if (key === 'threads')   cfg.threads   = parseInt(val, 10);
    else if (key === 's3prefix')  cfg.s3prefix  = val;
    else throw new Error(`Unknown --timelapse key "${key}". Valid keys: window, schedule, output, name, framerate, s3prefix`);
  }
  if (!cfg.window) throw new Error('--timelapse requires window=... (e.g. --timelapse "window=today" or "window=1w")');
  return cfg;
}

function autoTimelapseName(window, frames) {
  if (!frames.length) return `timelapse-${window.replace(/[=:]/g, '-')}.mp4`;
  const first = path.basename(frames[0]);
  const last  = path.basename(frames[frames.length - 1]);

  if (window === 'today' || window === 'yesterday') {
    // e.g. 2026-06-03.mp4
    return `${first.slice(0, 10)}.mp4`;
  }
  if (window === '2d' || window === '3d' || window === '1w') {
    // e.g. 2026-06-01-2d.mp4 / 2026-06-01-3d.mp4 / 2026-06-01-1w.mp4
    return `${first.slice(0, 10)}-${window}.mp4`;
  }
  const dm = window.match(/^daily-at=(\d{1,2}):(\d{2})$/);
  if (dm) {
    // e.g. 2026-06-01-daily-at-1300.mp4
    const spec = dm[1].padStart(2, '0') + dm[2];
    return `${first.slice(0, 10)}-daily-at-${spec}.mp4`;
  }
  return `timelapse-${window.replace(/[=:]/g, '-')}.mp4`;
}

function validateTimelapseWindow(w) {
  if (['today', 'yesterday', '2d', '3d', '1w'].includes(w)) return;
  if (/^daily-at=\d{1,2}:\d{2}$/.test(w)) return;
  throw new Error(`Unknown timelapse window "${w}". Use: today, yesterday, 2d, 3d, 1w, daily-at=HH:MM`);
}

// ── Cron field parser ────────────────────────────────────────────────────────
// Supports: *  */n  n  n-m  n-m/s  and comma-separated combinations thereof.
function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const base  = stepMatch ? stepMatch[1] : part;
    let lo, hi;
    if (base === '*') {
      lo = min; hi = max;
    } else {
      const rangeMatch = base.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        lo = parseInt(rangeMatch[1], 10);
        hi = parseInt(rangeMatch[2], 10);
      } else {
        lo = hi = parseInt(base, 10);
      }
    }
    if (isNaN(lo) || isNaN(hi) || lo < min || hi > max || lo > hi)
      throw new Error(`Invalid cron field value "${part}" (range ${min}-${max})`);
    for (let i = lo; i <= hi; i += step) values.add(i);
  }
  return values;
}

// Parse a 5-field cron expression: "min hour dom month dow"
// Returns { min, hour, dom, month, dow } — each a Set of valid integers.
function parseCronExpression(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`Cron expression must have 5 fields (got ${parts.length}): "${expr}"`);
  return {
    min:   parseCronField(parts[0],  0, 59),
    hour:  parseCronField(parts[1],  0, 23),
    dom:   parseCronField(parts[2],  1, 31),
    month: parseCronField(parts[3],  1, 12),
    dow:   parseCronField(parts[4],  0,  6),
  };
}

// Find the next Date (after now) matching a parsed cron expression.
// Iterates minute-by-minute — at most ~525 000 steps (1 year), takes <10 ms.
function nextCronTime(fields) {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // start from next minute
  for (let i = 0; i < 527_040; i++) {
    if (
      fields.month.has(d.getMonth() + 1) &&
      fields.dom.has(d.getDate())        &&
      fields.dow.has(d.getDay())         &&
      fields.hour.has(d.getHours())      &&
      fields.min.has(d.getMinutes())
    ) return new Date(d);
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error('Could not find next cron time within one year — check your expression');
}

// ── Schedule parsing ─────────────────────────────────────────────────────────
// Accepts 5-field cron strings OR legacy aliases:
//   hourly          →  "0 * * * *"
//   every=Nm        →  "*/N * * * *"
//   every=Nh        →  "0 */N * * *"
//   daily=HH:MM     →  "MM HH * * *"
function parseTimelapseSchedule(spec) {
  // Legacy aliases → normalise to cron
  if (spec === 'hourly') spec = '0 * * * *';
  const em = spec.match(/^every=(\d+)(m|h)$/);
  if (em) {
    const n = parseInt(em[1], 10);
    spec = em[2] === 'h' ? `0 */${n} * * *` : `*/${n} * * * *`;
  }
  const dm = spec.match(/^daily=(\d{1,2}):(\d{2})$/);
  if (dm) spec = `${parseInt(dm[2], 10)} ${parseInt(dm[1], 10)} * * *`;

  // Must be a 5-field cron expression at this point
  try {
    return { type: 'cron', fields: parseCronExpression(spec), expr: spec };
  } catch (e) {
    throw new Error(
      `Unknown --timelapse-schedule "${spec}". ` +
      `Use a 5-field cron expression (e.g. "*/15 * * * *") ` +
      `or an alias: hourly, every=Nm, every=Nh, daily=HH:MM`
    );
  }
}

function nextTimelapseTime(schedule) {
  return nextCronTime(schedule.fields);
}

function parseFilenameDate(filename) {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(-utc)?\.jpg$/);
  if (!m) return null;
  // Use the matching constructor so that Date comparisons are timezone-correct:
  // UTC files → Date.UTC() → exact UTC moment
  // Local files → new Date(y,m,d,h,min,s) → local moment
  if (m[7]) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
  return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
}

// Recursively collect all snapshot JPEGs under outputDir, returning paths relative
// to outputDir, sorted chronologically by filename. Works for both flat directories
// and yyyy/mm/dd subdirectory layouts.
function getAllSnapshotFiles(outputDir) {
  const results = [];
  function scan(dir, relPrefix) {
    let entries;
    try { entries = fs.readdirSync(dir).sort(); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const rel  = relPrefix ? `${relPrefix}/${entry}` : entry;
      let isDir;
      try { isDir = fs.statSync(full).isDirectory(); } catch (_) { continue; }
      if (isDir) { scan(full, rel); }
      else if (/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-utc)?\.jpg$/.test(entry)) {
        results.push({ rel, base: entry });
      }
    }
  }
  scan(outputDir, '');
  results.sort((a, b) => a.base.localeCompare(b.base));
  return results.map(r => r.rel);
}

function framesForWindow(outputDir, window) {
  const allFiles = getAllSnapshotFiles(outputDir);
  const now = new Date();
  // Extract the timestamp from the basename regardless of directory depth
  const dateOf = rel => parseFilenameDate(path.basename(rel));

  if (window === 'today' || window === 'yesterday') {
    const p = n => String(n).padStart(2, '0');
    const d = new Date(now);
    if (window === 'yesterday') d.setDate(d.getDate() - 1);
    const prefix = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-`;
    return allFiles.filter(f => path.basename(f).startsWith(prefix));
  }

  if (window === '2d' || window === '3d') {
    const daysBack = window === '2d' ? 1 : 2;
    const cutoff = new Date(now); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - daysBack);
    return allFiles.filter(f => { const d = dateOf(f); return d && d >= cutoff; });
  }

  if (window === '1w') {
    const cutoff = new Date(now); cutoff.setHours(0, 0, 0, 0);
    const day = cutoff.getDay();
    cutoff.setDate(cutoff.getDate() - (day === 0 ? 6 : day - 1));
    return allFiles.filter(f => { const d = dateOf(f); return d && d >= cutoff; });
  }

  // daily-at=HH:MM — one frame per calendar day, closest to target time
  const dm = window.match(/^daily-at=(\d{1,2}):(\d{2})$/);
  if (dm) {
    const targetSec = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60;
    const byDate = new Map();
    for (const f of allFiles) {
      const date = path.basename(f).slice(0, 10); // YYYY-MM-DD from filename
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(f);
    }
    const result = [];
    for (const [, dayFiles] of [...byDate.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
      let best = dayFiles[0], bestDiff = Infinity;
      for (const f of dayFiles) {
        const tm = path.basename(f).match(/-(\d{2})-(\d{2})-(\d{2})\.jpg$/);
        if (!tm) continue;
        const fileSec = +tm[1] * 3600 + +tm[2] * 60 + +tm[3];
        const diff = Math.abs(fileSec - targetSec);
        if (diff < bestDiff) { bestDiff = diff; best = f; }
      }
      result.push(best);
    }
    return result;
  }

  return [];
}

// Resample a frame list to an even time grid so that skipped snapshots
// (e.g. from battery-saver) don't cause jarring speed changes in the video.
//
// Algorithm:
//   1. Parse timestamps from filenames.
//   2. Find the base interval = smallest gap between consecutive frames.
//   3. Build a regular grid from first to last timestamp, step = base interval.
//   4. For each grid slot, pick the closest actual frame (may repeat frames
//      where a snapshot was skipped — keeping playback speed constant).
//
// Returns the original list unchanged if timestamps can't be parsed or if
// frames are already evenly spaced (no duplicates needed).
function evenlySpacedFrames(frames) {
  if (frames.length < 2) return frames;

  // Attach parsed timestamps
  const timed = frames
    .map(f => ({ f, t: parseFilenameDate(path.basename(f)) }))
    .filter(x => x.t !== null);
  if (timed.length < 2) return frames;
  timed.sort((a, b) => a.t - b.t);

  // Base interval = smallest positive gap between consecutive frames
  let baseMs = Infinity;
  for (let i = 1; i < timed.length; i++) {
    const gap = timed[i].t - timed[i - 1].t;
    if (gap > 0 && gap < baseMs) baseMs = gap;
  }
  if (!isFinite(baseMs)) return frames;

  // Build evenly spaced grid using binary search to find nearest frame per slot
  const first = timed[0].t.getTime();
  const last  = timed[timed.length - 1].t.getTime();
  const result = [];

  for (let slot = first; slot <= last + baseMs * 0.5; slot += baseMs) {
    // Binary search: find index of frame closest to slot
    let lo = 0, hi = timed.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timed[mid].t.getTime() < slot) lo = mid + 1;
      else hi = mid;
    }
    const best = (lo > 0 && Math.abs(timed[lo - 1].t - slot) < Math.abs(timed[lo].t - slot))
      ? timed[lo - 1] : timed[lo];
    result.push(best.f);
  }

  return result.length >= 2 ? result : frames;
}

// cfg = { window, schedule, output, name, framerate, s3prefix }
// args = full parsed args (for S3 bucket/region credentials)
async function generateTimelapse(outputDir, cfg, args) {
  const tag    = `timelapse:${cfg.window}`;
  const outDir = path.resolve(cfg.output || outputDir);
  fs.mkdirSync(outDir, { recursive: true });

  const rawFrames = framesForWindow(outputDir, cfg.window);
  process.stdout.write(`[${tag}] ${rawFrames.length} frame(s) found in ${path.resolve(outputDir)} for window="${cfg.window}"\n`);
  if (rawFrames.length < 2) {
    process.stdout.write(`[${tag}] Skipping — need at least 2 frames.\n`);
    return;
  }

  // Resample to even time grid so skipped snapshots don't cause speed jumps.
  const frames = evenlySpacedFrames(rawFrames);
  const duplicated = frames.length - rawFrames.length;
  if (duplicated > 0) {
    process.stdout.write(`[${tag}] Resampled to even time grid: ${frames.length} slots (${duplicated} frame(s) duplicated to fill gaps)\n`);
  }

  const outName = cfg.name || autoTimelapseName(cfg.window, frames);
  const outFile = path.join(outDir, outName);

  // ffmpeg concat list — unambiguous filenames, guaranteed frame order
  const tmpList = path.join(outDir, `.tl-list-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmpList,
    frames.map(f => `file '${path.join(outputDir, f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );

  process.stdout.write(`[${tag}] ${frames.length} frames → ${outFile}\n`);

  let genStart;
  const ffmpegOk = await withFfmpegLock(() => {
    genStart = Date.now();
    return new Promise(resolve => {
    const threads = String(cfg.threads || 2);
    const proc = spawn('ffmpeg', [
      '-y',
      '-f', 'concat', '-safe', '0', '-i', tmpList,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-threads', threads,
      '-r', String(cfg.framerate),
      outFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    proc.stderr.on('data', d => {
      process.stderr.write(`[${tag}][ffmpeg] ${d.toString()}`);
    });
    proc.on('close', code => {
      try { fs.unlinkSync(tmpList); } catch (_) {}
      if (code !== 0) {
        process.stderr.write(`[${tag}] ffmpeg exited with code ${code}\n`);
      }
      resolve(code === 0);
    });
    proc.on('error', err => {
      try { fs.unlinkSync(tmpList); } catch (_) {}
      process.stderr.write(
        err.code === 'ENOENT'
          ? '[timelapse] ffmpeg not found — install ffmpeg and ensure it is on your PATH.\n'
          : `[timelapse] spawn error: ${err.message}\n`
      );
      resolve(false);
    });
  });
  });

  if (!ffmpegOk) return;

  let stat;
  try { stat = fs.statSync(outFile); } catch (_) {
    process.stderr.write(`[${tag}] ffmpeg exited 0 but output file was not created: ${outFile}\n`);
    return;
  }
  const mb  = (stat.size / 1_048_576).toFixed(1);
  const sec = ((Date.now() - genStart) / 1000).toFixed(1);
  process.stdout.write(`[${tag}] Done — ${outFile} (${mb} MB, ${sec}s)\n`);

  // Upload to S3 if s3prefix is configured for this timelapse
  if (cfg.s3prefix !== null && args.s3Bucket) {
    const key = prefixedKey(cfg.s3prefix, outName);
    process.stdout.write(`[${tag}] Uploading to s3://${args.s3Bucket}/${key}…\n`);
    try {
      await uploadToS3(fs.readFileSync(outFile), key, 'video/mp4', args);
      process.stdout.write(`[${tag}] S3 upload OK: s3://${args.s3Bucket}/${key}\n`);
    } catch (err) {
      process.stderr.write(`[${tag}] S3 upload error: ${err.message}\n`);
    }
  }
}

async function timelapseLoop(outputDir, cfg, args) {
  const schedule = parseTimelapseSchedule(cfg.schedule);
  const tag = `timelapse:${cfg.window}`;

  // Clean up stale temp list files left by crashed previous runs
  const outDir = path.resolve(cfg.output || outputDir);
  const staleAge = 60 * 60 * 1000; // 1 hour
  try {
    for (const f of fs.readdirSync(outDir)) {
      if (!f.startsWith('.tl-list-')) continue;
      const fp = path.join(outDir, f);
      const age = Date.now() - fs.statSync(fp).mtimeMs;
      if (age > staleAge) {
        fs.unlinkSync(fp);
        process.stdout.write(`[${tag}] Removed stale temp file: ${f}\n`);
      }
    }
  } catch (_) {}

  // Generate once immediately on startup, then on schedule
  try { await generateTimelapse(outputDir, cfg, args); } catch (err) {
    process.stderr.write(`[${tag}] Generation error: ${err.message}\n`);
  }

  while (true) {
    const nextAt = nextTimelapseTime(schedule);
    process.stdout.write(`[${tag}] Next generation: ${fmtDatetime(nextAt)}\n`);
    await sleepUntil(nextAt);
    process.stdout.write(`[${tag}] Scheduled generation starting…\n`);
    try { await generateTimelapse(outputDir, cfg, args); } catch (err) {
      process.stderr.write(`[${tag}] Generation error: ${err.message}\n`);
    }
  }
}

// ── Main capture loop ────────────────────────────────────────────────────────

async function runLoop(client, args, outputDir, ui = null) {
  const tracker    = new BatterySessionTracker(args.batteryMah);
  const batteryLog = args.batteryLog || null;
  const hasRules   = args.intervalRules.length > 0;

  // Initial interval: if rules defined, use most conservative until first battery read
  let currentInterval = hasRules
    ? args.intervalRules[args.intervalRules.length - 1].intervalSec
    : args.interval;
  let nextAt = nextCaptureTime(currentInterval);

  if (!ui) {
    if (hasRules) {
      const ruleStr = args.intervalRules.map(r => `≥${r.minPct}%→${r.intervalSec}s`).join(', ');
      process.stdout.write(
        `Starting continuous capture to ${path.resolve(outputDir)} ` +
        `(adaptive interval: ${ruleStr}). ` +
        `First capture: ${fmtDatetime(nextAt)}. Press Ctrl+C to stop.\n`
      );
    } else {
      process.stdout.write(
        `Starting continuous capture to ${path.resolve(outputDir)} ` +
        `(snapshot every ${currentInterval} s, clock-aligned). ` +
        `First capture: ${fmtDatetime(nextAt)}. Press Ctrl+C to stop.\n`
      );
    }
  } else {
    const bat = await client.getBatteryInfo(args.channel, args.timeout);
    if (bat) { bat._updated = new Date(); tracker.record(bat); }
    ui.updateBattery(batteryDetailLines(bat, args.batteryMah, tracker));
  }

  while (true) {
    await sleepUntil(nextAt, ui ? (w, s) => ui.setWaiting(w, s) : null);

    const when = nextAt;
    const filename = snapshotFilename(when);
    let image = null, savedFilename = null, savedRelPath = null, snapshotOk = false;

    if (ui) ui.setWorking(`Capturing snapshot ${fmtDatetime(when)}...`);

    try {
      image = await captureWithRetry(client, args);
      const { filename: fn, relPath: rp } = saveSnapshot(image, outputDir, when, args.subdirByDate, args.localTime);
      savedFilename = fn;
      savedRelPath  = rp;
      snapshotOk = true;
    } catch (err) {
      if (ui) ui.addSnapshot({ when, filename, sizeBytes: null, ok: false, detail: err.message });
      else    process.stderr.write(`${fmtDatetime(when)}  Error: ${err.message}\n`);
    }

    const uploadErr = snapshotOk ? await maybeUploadSnapshot(image, savedRelPath, args) : null;

    const statusAt = new Date();
    let battery = null;
    try { battery = await client.getBatteryInfo(args.channel, args.timeout); } catch (_) {}
    if (battery) { battery._updated = statusAt; tracker.record(battery); }

    const statusErr = await persistBatteryStatus(battery, args.batteryMah, statusAt, batteryLog, args);

    if (snapshotOk && image) {
      const detail = saveDetail(uploadErr, statusErr, args, savedRelPath);
      if (ui) {
        ui.addSnapshot({ when, filename: savedRelPath, sizeBytes: image.length, ok: true, detail });
      } else {
        const hasMeta = args.s3Bucket || args.statusDir || uploadErr || statusErr;
        process.stdout.write(`${fmtDatetime(when)}  Saved ${image.length} bytes → ${savedRelPath}${hasMeta ? ` (${detail})` : ''}\n`);
      }
    }

    if (ui) {
      ui.updateBattery(batteryDetailLines(battery, args.batteryMah, tracker));
    } else {
      const batLine = battery
        ? batteryDetailLines(battery, args.batteryMah, tracker).join(' | ')
        : 'Battery: not available';
      const extra = statusErr ? ` | S3 status.json error: ${statusErr}` : '';
      process.stdout.write(`${fmtDatetime(statusAt)}  ${batLine}${extra}\n`);
    }

    // Determine interval for next capture based on current battery level
    const batteryPct = battery && battery.batteryPercent != null
      ? Math.floor(Number(battery.batteryPercent)) : null;
    const newInterval = intervalForBattery(args.intervalRules, batteryPct, args.interval);
    if (hasRules && newInterval !== currentInterval) {
      process.stdout.write(
        `[battery-saver] Battery ${batteryPct != null ? batteryPct + '%' : 'unknown'} — ` +
        `interval changed ${currentInterval}s → ${newInterval}s\n`
      );
      currentInterval = newInterval;
    }

    nextAt = new Date(nextAt.getTime() + currentInterval * 1000);
    while (nextAt <= new Date()) nextAt = new Date(nextAt.getTime() + currentInterval * 1000);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  if (args.batteryLog) fs.mkdirSync(path.dirname(path.resolve(args.batteryLog)), { recursive: true });

  if (args.s3Bucket) {
    const uploads = [];
    const sPfx = snapshotPrefix(args), stPfx = statusPrefix(args);
    if (args.s3UploadLatest)       uploads.push(prefixedKey(sPfx, S3_LATEST_FILENAME));
    if (args.s3UploadTimestamped)  uploads.push(prefixedKey(sPfx, '<timestamp>.jpg'));
    if (args.s3UploadStatus)       uploads.push(prefixedKey(stPfx, S3_STATUS_FILENAME));
    process.stdout.write(`S3 enabled: bucket=${args.s3Bucket} → ${uploads.join(', ') || '(nothing — check flags)'}\n`);
    for (const cfg of args.timelapses) {
      if (cfg.s3prefix !== null)
        process.stdout.write(`S3 timelapse (${cfg.window}): → ${prefixedKey(cfg.s3prefix, '<video>.mp4')}\n`);
    }
  }
  if (args.statusDir)
    process.stdout.write(`Status JSON: writing to ${path.resolve(args.statusDir)}/${S3_STATUS_FILENAME}\n`);

  const client = new ReolinkClient(args.host, args.username, args.password, args.port);
  let ui = null;
  let stopping = false;

  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    if (ui) ui.stop();
    else if (!args.once) process.stdout.write('\nStopping.\n');
    try { await client.logout(); } catch (_) {}
    process.exit(code);
  };

  process.on('SIGINT',  () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // Start timelapse loops immediately — independent of camera connectivity.
  // Stagger startup by 30 s per loop to avoid concurrent ffmpeg at boot.
  args.timelapses.forEach((cfg, i) => {
    setTimeout(() => {
      timelapseLoop(outputDir, cfg, args).catch(err => {
        process.stderr.write(`[timelapse:${cfg.window}] Fatal: ${err.message}\n`);
      });
    }, i * 30_000);
  });

  try {
    await client.login(args.timeout);

    if (args.once) {
      const nextAt = nextCaptureTime(args.interval);
      process.stdout.write(`Snapshot scheduled: ${fmtDatetime(nextAt)}\n`);
      await sleepUntil(nextAt);
      const image    = await captureWithRetry(client, args);
      const { filepath, relPath } = saveSnapshot(image, outputDir, nextAt, args.subdirByDate, args.localTime);
      const uploadErr  = await maybeUploadSnapshot(image, relPath, args);
      const tracker    = new BatterySessionTracker(args.batteryMah);
      const statusAt   = new Date();
      const battery    = await client.getBatteryInfo(args.channel, args.timeout);
      if (battery) tracker.record(battery);
      const statusErr  = await persistBatteryStatus(battery, args.batteryMah, statusAt, args.batteryLog, args);
      const detail     = saveDetail(uploadErr, statusErr, args, relPath);
      process.stdout.write(`Saved ${image.length} bytes → ${filepath} (${detail})\n`);
      process.stdout.write((battery ? batteryDetailLines(battery, args.batteryMah, tracker).join(' | ') : 'Battery: not available') + '\n');
      await shutdown(0);
      return;
    }

    const useUi = args.ui && process.stdout.isTTY;
    if (useUi) { ui = new TerminalDashboard(args); ui.start(); }

    // Launch capture loop — timelapse loops are already running (started above).
    // Each loop runs indefinitely; errors in timelapse don't kill the capture loop.
    const capturePromise = runLoop(client, args, outputDir, ui).catch(err => {
      if (!stopping) { if (ui) ui.stop(); process.stderr.write(`Error: ${err.message}\n`); shutdown(1); }
    });

    await capturePromise;
  } catch (err) {
    if (ui) ui.stop();
    process.stderr.write(`Error: ${err.message}\n`);
    try { await client.logout(); } catch (_) {}
    process.exit(1);
  }
}

main();
