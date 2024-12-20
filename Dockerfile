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

# Run the app
CMD ["node", "server.js"]