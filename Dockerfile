# ---- Stage 1: builder ----
# Installs production dependencies. Puppeteer downloads its bundled Chromium
# into /root/.cache/puppeteer during npm install; we copy that into the runtime
# stage so the final image doesn't carry any npm build cruft.
FROM node:22-slim AS builder

WORKDIR /usr/src/app

COPY package.json .
RUN npm install --omit=dev

# ---- Stage 2: runtime ----
FROM node:22-slim

# Install Puppeteer dependencies and necessary fonts.
# --no-install-recommends avoids pulling optional transitive packages, and
# removing /var/lib/apt/lists in the same layer keeps the layer small (plain
# `apt-get clean` leaves the ~19MB package lists behind in the image).
RUN apt-get update && apt-get install -y --no-install-recommends \
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

# Create app directory
WORKDIR /usr/src/app

# Bring in production node_modules and the bundled Chromium from the builder.
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /root/.cache/puppeteer /root/.cache/puppeteer

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
