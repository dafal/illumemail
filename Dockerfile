# ---- Stage 1: builder ----
# Installs production dependencies. We skip Puppeteer's bundled Chromium download
# (PUPPETEER_SKIP_DOWNLOAD): the bundled build is x86_64-only on this Puppeteer
# version and won't run on arm64. The runtime stage installs Debian's native
# `chromium` package instead, which works on both amd64 and arm64.
FROM node:22-slim AS builder

ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /usr/src/app

COPY package.json .
RUN npm install --omit=dev

# ---- Stage 2: runtime ----
FROM node:22-slim

# Install Chromium (Debian package works on amd64 and arm64), Puppeteer's shared
# library dependencies, and necessary fonts.
# --no-install-recommends avoids pulling optional transitive packages, and
# removing /var/lib/apt/lists in the same layer keeps the layer small (plain
# `apt-get clean` leaves the ~19MB package lists behind in the image).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libxss1 \
    libasound2 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    libgbm1 \
    dbus \
    libdbus-1-dev \
    fonts-dejavu \
    fonts-noto \
    fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

# Point Puppeteer at the system Chromium installed above instead of its bundled
# (x86_64-only) build. server.js reads this via PUPPETEER_LAUNCH_OPTIONS.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create app directory
WORKDIR /usr/src/app

# Bring in production node_modules from the builder (no bundled Chromium cache;
# we use the system chromium installed via apt above).
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Bundle app source
COPY package.json server.js healthcheck.js ./

# Expose the port the app runs on
EXPOSE 5000

# Mark the container unhealthy if the browser isn't connected. /health returns
# 503 when Puppeteer is down so the orchestrator can restart the container.
# start-period gives the browser time to launch; retries avoids flapping on a
# transient disconnect that self-heals on the next request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "healthcheck.js"]

# Chrome stores shared memory in /dev/shm and crashes ("Connection closed")
# when it fills. Docker defaults /dev/shm to 64MB, which is too small under
# load. docker-compose.yml sets shm_size; for a plain docker run pass:
#   docker run --shm-size=1g ...
# Run the app
CMD ["node", "server.js"]
