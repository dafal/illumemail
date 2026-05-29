#!/usr/bin/env node
// Health probe for the illumemail container. Exits 0 when the service reports
// healthy (Puppeteer connected), non-zero otherwise. Used by the Docker
// HEALTHCHECK / compose healthcheck so a wedged container can be restarted.
//
// Usage: node healthcheck.js [host] [port]
//   defaults: host=127.0.0.1, port=$PORT or 5000
const http = require('http');

const host = process.argv[2] || '127.0.0.1';
const port = process.argv[3] || process.env.PORT || 5000;

const req = http.get({ host, port, path: '/health', timeout: 4000 }, (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => {
    req.destroy();
    process.exit(1);
});
