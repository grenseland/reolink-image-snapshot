#!/bin/sh
set -eu

# Required
: "${REOLINK_HOST:?Set REOLINK_HOST (hub/camera IP)}"
: "${REOLINK_USERNAME:?Set REOLINK_USERNAME}"
: "${REOLINK_PASSWORD:?Set REOLINK_PASSWORD}"

export REOLINK_HOST REOLINK_USERNAME REOLINK_PASSWORD
export REOLINK_PORT="${REOLINK_PORT:-443}"
export REOLINK_CHANNEL="${REOLINK_CHANNEL:-0}"
export REOLINK_STREAM="${REOLINK_STREAM:-main}"
export REOLINK_INTERVAL="${REOLINK_INTERVAL:-120}"
export REOLINK_BATTERY_MAH="${REOLINK_BATTERY_MAH:-5000}"
export REOLINK_TIMEOUT="${REOLINK_TIMEOUT:-120}"
export REOLINK_RETRIES="${REOLINK_RETRIES:-2}"

OUTPUT_DIR="${SNAPSHOT_OUTPUT_DIR:-${REOLINK_OUTPUT_DIR:-/data}}"
mkdir -p "$OUTPUT_DIR"

# ── Optional feature flags passed as CLI args ─────────────────────────────────

EXTRA_ARGS=""

# One-shot mode
case "${REOLINK_ONCE:-}"         in 1|true|TRUE|yes|YES) EXTRA_ARGS="$EXTRA_ARGS --once"           ;; esac
case "${REOLINK_SUBDIR_BY_DATE:-}" in 1|true|TRUE|yes|YES) EXTRA_ARGS="$EXTRA_ARGS --subdir-by-date" ;; esac
case "${REOLINK_LOCAL_TIME:-}"    in 1|true|TRUE|yes|YES) EXTRA_ARGS="$EXTRA_ARGS --local-time"     ;; esac

# Full-screen UI (off by default in containers)
case "${REOLINK_UI:-}" in 1|true|TRUE|yes|YES) EXTRA_ARGS="$EXTRA_ARGS --ui" ;; esac

# Battery log
if [ -n "${REOLINK_BATTERY_LOG:-}" ]; then
  mkdir -p "$(dirname "$REOLINK_BATTERY_LOG")"
  EXTRA_ARGS="$EXTRA_ARGS --battery-log $REOLINK_BATTERY_LOG"
fi

# Local status.json directory
if [ -n "${REOLINK_STATUS_DIR:-}" ]; then
  mkdir -p "$REOLINK_STATUS_DIR"
  EXTRA_ARGS="$EXTRA_ARGS --status-dir $REOLINK_STATUS_DIR"
fi

# S3
if [ -n "${REOLINK_S3_BUCKET:-}" ]; then
  EXTRA_ARGS="$EXTRA_ARGS --s3-bucket $REOLINK_S3_BUCKET"
  [ -n "${REOLINK_S3_PREFIX:-}" ]          && EXTRA_ARGS="$EXTRA_ARGS --s3-prefix $REOLINK_S3_PREFIX"
  [ -n "${REOLINK_S3_SNAPSHOT_PREFIX:-}" ] && EXTRA_ARGS="$EXTRA_ARGS --s3-snapshot-prefix $REOLINK_S3_SNAPSHOT_PREFIX"
  [ -n "${REOLINK_S3_STATUS_PREFIX:-}" ]   && EXTRA_ARGS="$EXTRA_ARGS --s3-status-prefix $REOLINK_S3_STATUS_PREFIX"
  [ -n "${REOLINK_S3_REGION:-}" ]          && EXTRA_ARGS="$EXTRA_ARGS --s3-region $REOLINK_S3_REGION"
  case "${REOLINK_S3_NO_LATEST:-}"   in 1|true|TRUE|yes|YES) EXTRA_ARGS="$EXTRA_ARGS --s3-no-latest"   ;; esac
  case "${REOLINK_S3_TIMESTAMPED:-}" in 1|true|TRUE|yes|YES) EXTRA_ARGS="$EXTRA_ARGS --s3-timestamped" ;; esac
  case "${REOLINK_S3_NO_STATUS:-}"   in 1|true|TRUE|yes|YES) EXTRA_ARGS="$EXTRA_ARGS --s3-no-status"   ;; esac
fi

# Timelapse
if [ -n "${REOLINK_TIMELAPSE_WINDOW:-}" ]; then
  EXTRA_ARGS="$EXTRA_ARGS --timelapse-window $REOLINK_TIMELAPSE_WINDOW"
  EXTRA_ARGS="$EXTRA_ARGS --timelapse-schedule ${REOLINK_TIMELAPSE_SCHEDULE:-daily=00:00}"
  EXTRA_ARGS="$EXTRA_ARGS --timelapse-framerate ${REOLINK_TIMELAPSE_FRAMERATE:-24}"
  if [ -n "${REOLINK_TIMELAPSE_OUTPUT:-}" ]; then
    mkdir -p "$REOLINK_TIMELAPSE_OUTPUT"
    EXTRA_ARGS="$EXTRA_ARGS --timelapse-output $REOLINK_TIMELAPSE_OUTPUT"
  fi
  [ -n "${REOLINK_TIMELAPSE_NAME:-}" ] && EXTRA_ARGS="$EXTRA_ARGS --timelapse-name $REOLINK_TIMELAPSE_NAME"
fi

run_capture() {
  exec node /app/reolink-image-snapshot.js \
    --output-dir "$OUTPUT_DIR" \
    --retries "$REOLINK_RETRIES" \
    $EXTRA_ARGS \
    "$@"
}

if case "${REOLINK_RESTART_LOOP:-}" in 1|true|TRUE|yes|YES) true ;; *) false ;; esac; then
  DELAY="${REOLINK_RESTART_DELAY:-30}"
  while true; do
    # shellcheck disable=SC2086
    if node /app/reolink-image-snapshot.js --output-dir "$OUTPUT_DIR" --retries "$REOLINK_RETRIES" $EXTRA_ARGS "$@"; then
      exit 0
    fi
    echo "reolink-image-snapshot.js exited with error; retrying in ${DELAY}s..." >&2
    sleep "$DELAY"
  done
else
  run_capture
fi
