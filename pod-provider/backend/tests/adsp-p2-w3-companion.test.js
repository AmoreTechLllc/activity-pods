'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  CORRELATION_SCHEMA,
  createW3RunnerBroker,
  validateNamespace,
  writeCorrelationEvidence
} = require('../scripts/adsp-p2-w3-remote-origin-fixture');
const {
  createLoopbackBridge,
  validateHost
} = require('../scripts/adsp-p2-w3-loopback-bridge');

function listen(server, host = '127.0.0.1', port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('ADSP P2 W3 ActivityPods companion', () => {
  test('requires an explicit safe namespace and applies it to the independent runner broker', () => {
    expect(validateNamespace('adsp-p2-w3-run-123')).toBe('adsp-p2-w3-run-123');
    for (const value of [undefined, '', ' bad', 'bad ', 'bad\nname', 'bad\0name']) {
      expect(() => validateNamespace(value)).toThrow(/namespace/u);
    }

    const broker = createW3RunnerBroker('redis://127.0.0.1:6379/12', 'test-run', 'adsp-p2-w3-run-123');
    expect(broker.options.namespace).toBe('adsp-p2-w3-run-123');
    expect(broker.options.retryPolicy.enabled).toBe(false);
    expect(broker.options.nodeID).toMatch(/^adsp-p2-w3-remote-origin-test-run-/u);
  });

  test('writes request correlation separately from strict P0-compatible origin evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-w3-correlation-'));
    try {
      const output = path.join(root, 'correlation.json');
      writeCorrelationEvidence(output, {
        requestId: 'request-1',
        activityId: 'https://pods.example/alice/as/activity/1',
        moleculerNamespace: 'adsp-p2-w3-run-123'
      });
      const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(parsed).toEqual({
        schema: CORRELATION_SCHEMA,
        requestId: 'request-1',
        activityId: 'https://pods.example/alice/as/activity/1',
        moleculerNamespace: 'adsp-p2-w3-run-123'
      });
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      expect(() => writeCorrelationEvidence(' bad', parsed)).toThrow(/output path/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the bridge loopback-only and preserves the literal loopback Host authority upstream', async () => {
    const observed = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        observed.push({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(202, { 'content-type': 'application/activity+json' });
        res.end('{"ok":true}');
      });
    });
    const upstreamAddress = await listen(upstream);
    const bridge = createLoopbackBridge({
      upstreamHost: '127.0.0.1',
      upstreamPort: upstreamAddress.port,
      maxBodyBytes: 1024
    });
    const bridgeAddress = await listen(bridge);

    try {
      const result = await request(`http://127.0.0.1:${bridgeAddress.port}/actor/success`, {
        method: 'POST',
        headers: { host: '127.0.0.1:18080', 'content-type': 'application/activity+json' },
        body: '{"type":"Create"}'
      });
      expect(result.statusCode).toBe(202);
      expect(result.body).toBe('{"ok":true}');
      expect(observed).toEqual([{
        method: 'POST',
        url: '/actor/success',
        host: '127.0.0.1:18080',
        body: '{"type":"Create"}'
      }]);
    } finally {
      await close(bridge);
      await close(upstream);
    }
  });

  test('fails closed for unsafe bridge configuration', () => {
    expect(() => createLoopbackBridge({ bindHost: '0.0.0.0' })).toThrow(/literal IPv4 loopback/u);
    for (const value of ['', ' host', 'host/path', 'host name']) {
      expect(() => validateHost(value, 'host')).toThrow(/hostname/u);
    }
  });

  test('W3 overlay flips all four pod cells to external authority without modifying the W1 overlay', () => {
    const overlayPath = path.resolve(__dirname, '../../docker-compose-adsp-p2-w3-external.yml');
    const source = fs.readFileSync(overlayPath, 'utf8');
    for (const service of ['backend', 'backend_p2_2', 'backend_p2_3', 'backend_p2_4']) {
      expect(source).toMatch(new RegExp(`^  ${service}:$`, 'mu'));
    }
    expect((source.match(/SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE: external/gu) || []).length).toBe(1);
    expect(source).toMatch(/SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW: 'true'/u);
    expect(source).toMatch(/SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER: 'false'/u);
    expect(source).toMatch(/SIDECAR_DELIVERY_HANDOFF_URL:.*host\.docker\.internal:8080\/webhook\/outbox/u);
    expect(source).toMatch(/host\.docker\.internal:host-gateway/u);

    const w1Path = path.resolve(__dirname, '../../docker-compose-adsp-p2-horizontal.yml');
    const w1 = fs.readFileSync(w1Path, 'utf8');
    expect(w1).toMatch(/SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE: native/u);
  });
});
