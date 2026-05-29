# Use Node.js base image
FROM node:22-slim

# Install Puppeteer dependencies and necessary fonts
RUN apt-get update && apt-get install -y \
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
    && apt-get clean

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package.json .
RUN npm install

# Bundle app source
COPY server.js .

# Expose the port the app runs on
EXPOSE 5000

# Mark the container unhealthy if the browser isn't connected. /health returns
# 503 when Puppeteer is down so the orchestrator can restart the container.
# start-period gives the browser time to launch; retries avoids flapping on a
# transient disconnect that self-heals on the next request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run the app
CMD ["node", "server.js"]