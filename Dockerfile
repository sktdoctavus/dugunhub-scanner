FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    curl \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Static fpcalc binary with bundled libav — the Debian libchromaprint-tools package
# uses the deprecated avcodec_decode_audio4 API which returns AVERROR_EOF differently
# in libavcodec60 (ffmpeg 6.x), causing fpcalc to exit 3 on every valid audio file.
# The static binary from the chromaprint project bundles its own tested libav.
# cache-bust: 2026-05-13
RUN curl -L https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz \
    | tar -xz -C /tmp \
    && mv /tmp/chromaprint-fpcalc-1.5.1-linux-x86_64/fpcalc /usr/local/bin/fpcalc \
    && chmod a+rx /usr/local/bin/fpcalc \
    && rm -rf /tmp/chromaprint-fpcalc-1.5.1-linux-x86_64

# Download yt-dlp standalone binary (no pip/python3-pip needed). yt-dlp ships
# frequent point releases to keep up with YouTube's extraction changes — an
# old pinned binary can silently lose access to higher-quality formats even
# though the URL below always points at "latest", because Docker layer
# caching reuses this RUN layer across builds until the cache-bust changes.
# Bump the date below whenever you need to force a fresh download.
# cache-bust: 2026-07-09
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
