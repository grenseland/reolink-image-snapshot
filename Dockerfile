FROM node:22-slim

LABEL org.opencontainers.image.title="reolink-image-snapshot" \
      org.opencontainers.image.description="Scheduled still-image capture from Reolink cameras and Home Hubs" \
      org.opencontainers.image.source="https://github.com/YOUR_USERNAME/reolink-image-snapshot" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data

COPY package*.json ./
# npm ci installs optional deps (includes @aws-sdk/client-s3 for S3 upload support)
RUN npm ci

COPY reolink-image-snapshot.js docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV SNAPSHOT_OUTPUT_DIR=/data

VOLUME ["/data"]

HEALTHCHECK --interval=5m --timeout=15s --start-period=3m --retries=3 \
    CMD find /data -name '*.jpg' -mmin -30 | grep -q . || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
