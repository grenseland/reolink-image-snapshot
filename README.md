# reolink-image-snapshot

> Capture still images from Reolink cameras on a fixed schedule.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

> **Disclaimer:** This project is not affiliated with, endorsed by, or in any way connected to Reolink. It is an independent, community-built tool that uses Reolink's official HTTP API to provide functionality that Reolink's own software does not currently offer.

Capture still images from a Reolink camera or Home Hub on a fixed schedule, with optional battery monitoring, S3 upload, and automated timelapse video generation.

Built for battery cameras (e.g. Argus 4 Pro on a Home Hub) where Reolink's built-in timelapse gallery is hard to automate.

## What it does

- Logs in to the hub/camera over HTTPS and calls the **Snap** API on a clock-aligned schedule.
- Saves JPEG files as `yyyy-mm-dd-hh-mm-ss.jpg` in a directory you choose.
- Optionally uploads each snapshot to **S3** (or any S3-compatible store) as `latest.jpg` and/or with its timestamped filename.
- Writes a `status.json` battery metrics file to S3 and/or a local directory after each capture.
- Logs battery metrics to a **TSV file**.
- Pushes battery metrics to **Grafana Cloud** (or any OpenTelemetry/OTLP backend).
- Generates **timelapse videos** via ffmpeg on a schedule, concurrently with capture.
- Shows a **full-screen terminal dashboard** (opt-in with `--ui`).

Reolink does not expose stored timelapse files via API; this script builds your own image sequence instead.

## Requirements

- **Node.js 18+** — no Python, no build tools needed.
- Network access to the Reolink Home Hub or camera (HTTPS, usually port 443).
- **ffmpeg** on `PATH` — only needed for timelapse generation.

## Setup

```bash
npm install
```

### Interactive setup wizard

Not sure which flags you need? Run the wizard — it asks you questions about your camera and setup, then prints a ready-to-run command and a Docker `.env` block:

```bash
node setup.js
```

To tweak an existing command line, pass it with `--from` and the wizard pre-fills every answer:

```bash
node setup.js --from "node reolink-image-snapshot.js --host 192.168.1.100 --username admin ..."
```

Navigate with **Enter** (accept), **b** (back to previous question), **q** (quit).

`@aws-sdk/client-s3` (the optional S3 dependency) is installed by `npm install`. To skip it:

```bash
npm install --omit=optional
```

Copy `.env.example` to `.env` for optional defaults (do not commit `.env`).

## Usage

```bash
node reolink-image-snapshot.js \
  --host x.x.x.x \
  --username admin \
  --password your-password \
  --output-dir ./snapshots \
  --interval 60
```

Stop with **Ctrl+C**. Or set credentials via environment variables and run `npm start`.

---

## Parameter reference

All CLI flags have an equivalent environment variable. Environment variables are read first; CLI flags override them.

### Connection

| Flag | Env var | Required | Default | Description |
|------|---------|----------|---------|-------------|
| `--host` / `--ip` | `REOLINK_HOST` or `REOLINK_IP` | **Yes** | — | IP address of the camera or Home Hub |
| `--username` | `REOLINK_USERNAME` | **Yes** | — | Login username |
| `--password` | `REOLINK_PASSWORD` | **Yes** | — | Login password |
| `--port` | `REOLINK_PORT` | No | `443` | HTTPS port |
| `--channel N` | `REOLINK_CHANNEL` | No | `0` | Camera channel index on the hub |
| `--stream` | `REOLINK_STREAM` | No | `main` | Stream to snapshot: `main` or `sub` |

### Capture

| Flag | Env var | Required | Default | Description |
|------|---------|----------|---------|-------------|
| `-d` / `--output-dir DIR` | `SNAPSHOT_OUTPUT_DIR` or `REOLINK_OUTPUT_DIR` | **Yes** | — | Directory where JPEG files are saved (created if missing) |
| `--interval SECONDS` | `REOLINK_INTERVAL` | No | `120` | Seconds between each Snap API call. Captures are clock-aligned (e.g. `--interval 60` fires at each whole minute) |
| `--once` | `REOLINK_ONCE=true` | No | off | Take a single snapshot then exit (still waits for the next clock-aligned slot) |
| `--timeout SECONDS` | `REOLINK_TIMEOUT` | No | `120` | HTTP request timeout in seconds |
| `--retries N` | `REOLINK_RETRIES` | No | `2` | Number of times to retry a failed Snap before logging an error |
| `--subdir-by-date` | `REOLINK_SUBDIR_BY_DATE=true` | No | off | Save snapshots in `yyyy/mm/dd/` subdirectories inside `--output-dir`. Recommended for long-running setups to avoid large flat directories. The timelapse scanner handles both layouts, so old flat files and new subdir files can coexist. |
| `--local-time` | `REOLINK_LOCAL_TIME=true` | No | off | Use local system time in filenames instead of UTC. **Default (UTC):** `2026-06-02-10-00-00-utc.jpg`. **Local time:** `2026-06-02-12-00-00.jpg` (no suffix). In Docker, also set `TZ=Europe/Oslo` (or your timezone) so the system clock is correct. The `-utc` suffix on default filenames makes the timezone unambiguous when browsing the NAS. |

### Display

| Flag | Env var | Required | Default | Description |
|------|---------|----------|---------|-------------|
| `--ui` | `REOLINK_UI=true` | No | off | Enable the full-screen ANSI terminal dashboard. Default is plain line-by-line logging. The dashboard requires a TTY (no effect in Docker/pipes) |

### Battery

| Flag | Env var | Required | Default | Description |
|------|---------|----------|---------|-------------|
| `--battery-mah N` | `REOLINK_BATTERY_MAH` | No | `5000` | Battery capacity in mAh, used for charge-rate and time-to-full estimates. `5000` matches the Argus 4 Pro |
| `--battery-log FILE` | `REOLINK_BATTERY_LOG` | No | — | Append battery metrics to a tab-separated file after each capture. A header row is written automatically on first use. Columns: `timestamp`, `percent`, `power_w`, `voltage_mv`, `current_ma`, `charge_rate_pct_per_h`, `eta_hours`, `eta_datetime` |

### Status JSON

After each capture, a `status.json` is produced containing the latest battery metrics. It can be written locally, uploaded to S3, or both.

| Flag | Env var | Required | Default | Description |
|------|---------|----------|---------|-------------|
| `--status-dir DIR` | `REOLINK_STATUS_DIR` | No | — | Write `status.json` to this local directory after each capture |

### Metrics (OpenTelemetry / Grafana Cloud)

After each capture, battery readings are pushed as OTLP/HTTP JSON gauges, with no extra npm dependencies. Configuration uses the standard OpenTelemetry environment variables, so the same setup works with Grafana Cloud, an OpenTelemetry Collector, or Grafana Alloy.

| Flag | Env var | Required | Default | Description |
|------|---------|----------|---------|-------------|
| `--otlp-endpoint URL` | `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP/HTTP base URL; `/v1/metrics` is appended. Set `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` instead to give the full URL |
| `--otlp-header K=V` | `OTEL_EXPORTER_OTLP_HEADERS` | No | — | Request headers, e.g. `Authorization=Basic%20…`. Env var takes a comma-separated list; the flag can be repeated. Values may be URL-encoded |
| `--otlp-service-name NAME` | `OTEL_SERVICE_NAME` | No | `reolink-image-snapshot` | `service.name` resource attribute |

Metrics (attributes: `service.name`, `host.name` = camera host, `channel`):

| OTLP name | Unit | Source |
|-----------|------|--------|
| `reolink.battery.level` | `%` | Battery percent |
| `reolink.battery.voltage` | `mV` | Battery voltage |
| `reolink.battery.current` | `mA` | Charge current |
| `reolink.battery.power` | `W` | Input power (voltage × current) |
| `reolink.battery.temperature` | `Cel` | Battery temperature |

Grafana converts names to Prometheus style (dots → underscores, usually with a unit suffix), so battery percent typically appears as `reolink_battery_level_percent`. Search Explore for `reolink_battery` to see the exact names.

**Grafana Cloud setup:** in the Cloud portal open your stack → **OpenTelemetry → Configure**, create a token, and copy the generated endpoint and header:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-2.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64 of instanceId:token>
```

Points are only sent when a capture happens. If your interval is longer than 5 minutes, Prometheus marks the series stale between points. Use `last_over_time(reolink_battery_level_percent[1h])` in panels, or enable *Connect null values*.

### S3 upload

Requires `@aws-sdk/client-s3` (`npm install @aws-sdk/client-s3`) and AWS credentials via the standard environment variables `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

When `--s3-bucket` is set, `latest.jpg` and `status.json` are uploaded by default. Use the flags below to change that behaviour.

| Flag | Env var | Required | Default | Description |
|------|---------|----------|---------|-------------|
| `--s3-bucket NAME` | `REOLINK_S3_BUCKET` | No | — | S3 bucket to upload to. Enables all S3 upload |
| `--s3-prefix PREFIX` | `REOLINK_S3_PREFIX` | No | — | Global key prefix, used for all upload types that don't have a specific prefix set |
| `--s3-snapshot-prefix PFX` | `REOLINK_S3_SNAPSHOT_PREFIX` | No | `--s3-prefix` | S3 key prefix for snapshots (`latest.jpg` and timestamped files). Overrides `--s3-prefix` for snapshots only |
| `--s3-status-prefix PFX` | `REOLINK_S3_STATUS_PREFIX` | No | `--s3-prefix` | S3 key prefix for `status.json`. Overrides `--s3-prefix` for status only |
| `--s3-region REGION` | `REOLINK_S3_REGION` or `AWS_DEFAULT_REGION` | No | — | AWS region |
| `--s3-no-latest` | `REOLINK_S3_NO_LATEST=true` | No | off | **Do not** upload `latest.jpg` |
| `--s3-timestamped` | `REOLINK_S3_TIMESTAMPED=true` | No | off | Also upload a copy of the snapshot under its timestamped filename — accumulates one object per capture |
| `--s3-no-status` | `REOLINK_S3_NO_STATUS=true` | No | off | **Do not** upload `status.json` to S3 |

Timelapse videos are uploaded to S3 using the per-timelapse `s3prefix=` key in `--timelapse` — see the Timelapse section.

**IAM note:** the bucket policy must allow `s3:PutObject` on `arn:aws:s3:::BUCKET/*`. Restricting to `*.jpg` blocks `status.json` and video uploads.

### Timelapse

Timelapse generation runs in a **separate concurrent loop** — ffmpeg never delays a scheduled capture. Use `--timelapse` once per video you want to generate; the flag can be repeated for as many independent videos as you like.

```
--timelapse "key=value,key=value,..."
```

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `window=W` | **Yes** | — | Which snapshots become frames. See window modes below |
| `schedule=S` | No | `daily=00:00` | When to regenerate. See schedule formats below |
| `output=DIR` | No | `--output-dir` | Local directory where the video file is written |
| `name=FILE` | No | auto | Output filename. If omitted, a name is derived from the actual first and last frame (see naming convention below) |
| `framerate=N` | No | `24` | Playback speed in frames per second. A 1-hour session at `--interval 120` produces 30 frames; at 24 fps that is ~1.25 s of video |
| `s3prefix=PFX` | No | — | S3 key prefix for uploading this video. Requires `--s3-bucket`. E.g. `s3prefix=timelapses/roof` uploads to `s3://BUCKET/timelapses/roof/<name>.mp4` |

**Window modes** (`window=`):

All multi-day windows are **calendar-day based** (midnight boundaries), not rolling hours.

| Value | Frames included |
|-------|----------------|
| `today` | All snapshots from today |
| `2d` | Today and yesterday |
| `3d` | Today and the previous 2 days |
| `1w` | This calendar week — Monday 00:00:00 through now |
| `daily-at=HH:MM` | One frame per calendar day — the snapshot closest to `HH:MM` on each day. Good for a "same time every day" summary |

**Schedule formats** (`schedule=`):

| Value | Meaning |
|-------|---------|
| `hourly` | Every 60 minutes |
| `every=Nm` | Every N minutes, e.g. `every=30m` |
| `every=Nh` | Every N hours, e.g. `every=2h` |
| `daily=HH:MM` | Once a day at HH:MM, e.g. `daily=23:00` |

A video is generated **once immediately on startup**, then again on the chosen schedule.

**Auto filename naming convention** (when `name=` is omitted):

| Window | Example filename |
|--------|----------------|
| `today` | `2026-06-02-today.mp4` |
| `2d` | `2026-06-01_2026-06-02-2d.mp4` |
| `3d` | `2026-05-31_2026-06-02-3d.mp4` |
| `1w` | `2026-05-27_2026-06-02-1w.mp4` |
| `daily-at=12:00` | `2026-01-01_2026-06-02-daily-at-1200.mp4` |

Dates and times are taken from the actual first and last frame in the video.

**Env-var configuration** (Docker-friendly, no CLI flags needed):

*Single timelapse shorthand:*

| Env var | Description |
|---------|-------------|
| `REOLINK_TIMELAPSE_WINDOW` | Window mode — enables timelapse |
| `REOLINK_TIMELAPSE_SCHEDULE` | Schedule (default: `daily=00:00`) |
| `REOLINK_TIMELAPSE_OUTPUT` | Output directory |
| `REOLINK_TIMELAPSE_NAME` | Output filename |
| `REOLINK_TIMELAPSE_FRAMERATE` | Frames per second (default: `24`) |

*Multiple timelapse configs — numbered env vars using the same `key=value` format as `--timelapse`:*

```
REOLINK_TIMELAPSE_1=window=today,schedule=daily=23:00,output=/data/tl,s3prefix=tl/daily
REOLINK_TIMELAPSE_2=window=1w,schedule=daily=00:00,output=/data/tl,s3prefix=tl/weekly
REOLINK_TIMELAPSE_3=window=daily-at=12:00,schedule=hourly,name=noon.mp4
```

The script scans `REOLINK_TIMELAPSE_1` through `REOLINK_TIMELAPSE_20` and stops at the first missing number. The single shorthand and the numbered vars can be combined — each produces an independent loop.

### Container / restart (Docker only)

| Env var | Default | Description |
|---------|---------|-------------|
| `REOLINK_ONCE=true` | off | Take one snapshot and exit |
| `REOLINK_RESTART_LOOP=true` | off | Restart the script inside the container if it exits with an error |
| `REOLINK_RESTART_DELAY` | `30` | Seconds to wait between inner restarts (used with `REOLINK_RESTART_LOOP`) |

---

## Examples

### One test shot

```bash
node reolink-image-snapshot.js \
  --host 192.168.1.100 --username admin --password 'secret' \
  --output-dir ./snapshots \
  --once
```

### Upload latest.jpg to S3, keep timestamped copies too

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

node reolink-image-snapshot.js \
  --host 192.168.1.100 --username admin --password 'secret' \
  --output-dir ./snapshots \
  --s3-bucket my-bucket --s3-prefix reolink/roof \
  --s3-timestamped
```

### Separate S3 directories for snapshots, status, and timelapse

```bash
node reolink-image-snapshot.js \
  --host 192.168.1.100 --username admin --password 'secret' \
  --output-dir ./snapshots \
  --s3-bucket my-bucket \
  --s3-snapshot-prefix camera/roof/snapshots \
  --s3-status-prefix   camera/roof/status \
  --timelapse "window=today,schedule=daily=23:00,s3prefix=camera/roof/timelapses"
```

### Daily timelapse of today's images, regenerated every night at 23:00

```bash
node reolink-image-snapshot.js \
  --host 192.168.1.100 --username admin --password 'secret' \
  --output-dir ./snapshots \
  --timelapse "window=today,schedule=daily=23:00,output=./timelapses"
```

### Multiple timelapse videos at once, with S3 upload

```bash
node reolink-image-snapshot.js \
  --host 192.168.1.100 --username admin --password 'secret' \
  --output-dir ./snapshots \
  --s3-bucket my-bucket \
  --timelapse "window=today,schedule=daily=23:00,output=./timelapses,s3prefix=timelapses/daily" \
  --timelapse "window=1w,schedule=daily=00:00,output=./timelapses,s3prefix=timelapses/weekly" \
  --timelapse "window=daily-at=12:00,schedule=hourly,name=noon-summary.mp4,s3prefix=timelapses/noon"
```

### Full-screen terminal UI

```bash
node reolink-image-snapshot.js \
  --host 192.168.1.100 --username admin --password 'secret' \
  --output-dir ./snapshots \
  --ui
```

---

## Output

```
snapshots/
  2026-06-01-09-17-10.jpg
  2026-06-01-09-19-10.jpg
  ...
timelapses/
  timelapse-today.mp4
```

---

## Docker

Run the capture loop in a container. Snapshots are written to `/data` inside the container — mount a host directory there.

### Build the image

```bash
docker build -t reolink-image-snapshot .
```

Or pull the published image:

```bash
docker pull YOUR_USERNAME/reolink-image-snapshot
```

### Build for Synology NAS (fix `exec format error`)

If the container log shows `exec format error`, the image was built for the wrong CPU. Rebuild for the NAS architecture:

```bash
# Most Synology models (Intel/AMD)
docker build --platform linux/amd64 -t reolink-image-snapshot .
docker save -o reolink-image-snapshot.tar reolink-image-snapshot:latest
```

On ARM-based Synology units, use `linux/arm64`. To check: SSH in and run `uname -m` (`x86_64` → `linux/amd64`, `aarch64` → `linux/arm64`).

### Configure

Copy `.env.example` to `.env` and fill in at least `REOLINK_HOST`, `REOLINK_USERNAME`, and `REOLINK_PASSWORD`.

### Run with `docker run`

```bash
docker run -d \
  --name reolink-image-snapshot \
  --restart unless-stopped \
  -v /path/on/host/snapshots:/data \
  --env-file .env \
  reolink-image-snapshot
```

Override settings without editing `.env`:

```bash
docker run -d \
  --name reolink-image-snapshot \
  --restart unless-stopped \
  -v /path/on/host/snapshots:/data \
  -e REOLINK_HOST=192.168.1.100 \
  -e REOLINK_USERNAME=admin \
  -e REOLINK_PASSWORD='your-password' \
  -e REOLINK_INTERVAL=60 \
  reolink-image-snapshot
```

View logs:

```bash
docker logs -f reolink-image-snapshot
```

### Run with Docker Compose

Edit `.env`, then:

```bash
docker compose up -d
```

### Restart behaviour

1. **Recommended:** `--restart unless-stopped` on `docker run`, or `restart: unless-stopped` in Compose. Docker restarts the container if the process exits.
2. **Optional inner retry:** `REOLINK_RESTART_LOOP=true` restarts the script inside the container after a non-zero exit, waiting `REOLINK_RESTART_DELAY` seconds between attempts.

---

## Battery and power notes

- Each Snap **wakes** a battery camera briefly; frequent intervals drain more power than hub-side timelapse.
- There is **no API** to force the camera back to sleep after a capture; it returns to standby on its own schedule.
- If login fails with **max session**, wait a few minutes, close other Reolink API clients, or reboot the hub.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| `rcv failed` / code -17 on Snap | Camera asleep or busy — increase `--interval`, reduce hub load, reboot hub |
| `please login first` / `rspCode: -6` | **Expired API session** (normal after hours/days) — restart the container, or deploy a build that auto re-logins; not a password change |
| `max session` on login | Too many open sessions — wait ~1 hour or reboot hub |
| Connection refused | Check hub IP and that HTTPS port 443 is reachable from the host |
| UI not showing (`--ui` flag) | Must run in a real TTY; not available in Docker or piped output |
| S3 `status.json` not appearing | Ensure IAM policy allows `s3:PutObject` on `arn:aws:s3:::BUCKET/*` (not just `*.jpg`) |
| No metrics in Grafana Cloud | Look for `OTLP 401`/`OTLP 4xx` in the output. Check that the token has `metrics:write` and that the endpoint ends in `/otlp` (not `/v1/metrics` when using `OTEL_EXPORTER_OTLP_ENDPOINT`). Search Explore for `reolink_battery` |
| Timelapse not generated | Check ffmpeg is installed and on `PATH`; look for `[timelapse:…]` lines in output |
| `exec format error` in Docker | Image built for wrong CPU architecture — see Synology section above |

---

## Project layout

```
reolink-image-snapshot.js   # Main capture script (zero required npm dependencies)
setup.js                    # Interactive setup wizard
package.json
.env.example
Dockerfile
docker-entrypoint.sh
docker-compose.yml
LICENSE
README.md
snapshots/                  # Captured JPEGs — created at runtime, not tracked by git
```

## Contributing

Bug reports and pull requests are welcome. Please open an issue first for major changes.

## License

[MIT](LICENSE)
