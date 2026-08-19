'use strict';

const http = require('http');

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_BIND_PORT = 18080;
const DEFAULT_UPSTREAM_HOST = 'host.docker.internal';
const DEFAULT_UPSTREAM_PORT = 18080;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function positivePort(value, fallback, label) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${label} must be an integer from 1 to 65535`);
  return parsed;
}

function positiveBytes(value, fallback, label) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

function validateHost(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\s\0/]/u.test(value)) {
    throw new Error(`${label} must be a non-empty hostname without whitespace or path characters`);
  }
  return value;
}

function createLoopbackBridge({
  bindHost = DEFAULT_BIND_HOST,
  bindPort = DEFAULT_BIND_PORT,
  upstreamHost = DEFAULT_UPSTREAM_HOST,
  upstreamPort = DEFAULT_UPSTREAM_PORT,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES
} = {}) {
  if (bindHost !== '127.0.0.1') throw new Error('ADSP P2 W3 bridge must bind literal IPv4 loopback');
  const safeBindPort = positivePort(bindPort, DEFAULT_BIND_PORT, 'bridge bind port');
  const safeUpstreamHost = validateHost(upstreamHost, 'bridge upstream host');
  const safeUpstreamPort = positivePort(upstreamPort, DEFAULT_UPSTREAM_PORT, 'bridge upstream port');
  const safeMaxBodyBytes = positiveBytes(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 'bridge max body bytes');

  return http.createServer((request, response) => {
    let receivedBytes = 0;
    let aborted = false;
    const headers = { ...request.headers, connection: 'close' };

    const upstream = http.request(
      {
        hostname: safeUpstreamHost,
        port: safeUpstreamPort,
        method: request.method,
        path: request.url,
        headers
      },
      upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );

    upstream.on('error', error => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      if (!response.writableEnded) response.end(`ADSP P2 W3 loopback bridge upstream error: ${error.message}\n`);
    });

    request.on('data', chunk => {
      if (aborted) return;
      receivedBytes += chunk.length;
      if (receivedBytes > safeMaxBodyBytes) {
        aborted = true;
        upstream.destroy();
        response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        response.end('ADSP P2 W3 loopback bridge request body too large\n');
        return;
      }
      upstream.write(chunk);
    });
    request.on('end', () => {
      if (!aborted) upstream.end();
    });
    request.on('error', () => upstream.destroy());
  });
}

async function main() {
  const server = createLoopbackBridge({
    bindHost: process.env.ADSP_P2_W3_BRIDGE_BIND_HOST || DEFAULT_BIND_HOST,
    bindPort: process.env.ADSP_P2_W3_BRIDGE_BIND_PORT,
    upstreamHost: process.env.ADSP_P2_W3_BRIDGE_UPSTREAM_HOST || DEFAULT_UPSTREAM_HOST,
    upstreamPort: process.env.ADSP_P2_W3_BRIDGE_UPSTREAM_PORT,
    maxBodyBytes: process.env.ADSP_P2_W3_BRIDGE_MAX_BODY_BYTES
  });
  const bindPort = positivePort(process.env.ADSP_P2_W3_BRIDGE_BIND_PORT, DEFAULT_BIND_PORT, 'bridge bind port');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bindPort, DEFAULT_BIND_HOST, resolve);
  });
  process.stdout.write(`[ADSP-P2-W3] loopback bridge listening on ${DEFAULT_BIND_HOST}:${bindPort}\n`);

  const shutdown = signal => {
    server.close(() => process.exit(signal === 'SIGTERM' ? 143 : 130));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P2-W3] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_BIND_HOST,
  DEFAULT_BIND_PORT,
  createLoopbackBridge,
  positiveBytes,
  positivePort,
  validateHost
};
