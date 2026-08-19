'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const {
  CORRELATION_SCHEMA,
  createW3RunnerBroker,
  validateNamespace,
  validateReplicaCount,
  waitForExactRootEndpoints,
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

function endpointSequenceBroker(sequence) {
  let index = 0;
  const count = jest.fn(() => {
    const value = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return value;
  });
  return {
    broker: {
      registry: {
        getActionEndpoints: jest.fn(() => ({ count }))
      }
    },
    count
  };
}

function deterministicReadinessClock() {
  let current = 0;
  return {
    now: () => current,
    sleepFn: async ms => {
      current += ms;
    }
  };
}

describe('ADSP P2 W3 ActivityPods companion', () => {
  test('requires an explicit safe namespace, exact topology, and P2 RDF wire serializer', () => {
    expect(validateNamespace('adsp-p2-w3-run-123')).toBe('adsp-p2-w3-run-123');
    for (const value of [undefined, '', ' bad', 'bad ', 'bad\nname', 'bad\0name']) {
      expect(() => validateNamespace(value)).toThrow(/namespace/u);
    }
    for (const value of [1, 2, 4, '4']) expect(validateReplicaCount(value)).toBe(Number(value));
    for (const value of [undefined, 0, 3, 5, '2.0']) expect(() => validateReplicaCount(value)).toThrow(/replicas/u);

    const broker = createW3RunnerBroker('redis://127.0.0.1:6379/12', 'test-run', 'adsp-p2-w3-run-123');
    expect(broker.options.namespace).toBe('adsp-p2-w3-run-123');
    expect(broker.options.retryPolicy.enabled).toBe(false);
    expect(broker.options.registry.preferLocal).toBe(true);
    expect(broker.serializer).toBeInstanceOf(RdfJSONSerializer);
    expect(broker.options.nodeID).toMatch(/^adsp-p2-w3-remote-origin-p8testrun-[0-9]+$/u);
  });

  test('requires exact endpoint cardinality to remain stable before declaring replicas ready', async () => {
    const { broker, count } = endpointSequenceBroker([0, 2, 1, 2, 2, 2]);
    const clock = deterministicReadinessClock();

    await expect(
      waitForExactRootEndpoints(broker, 2, 100, {
        stabilityMs: 20,
        pollMs: 10,
        ...clock
      })
    ).resolves.toBe(2);

    // The first transient observation of two endpoints must not be accepted;
    // readiness is reached only after the later exact topology stays stable.
    expect(count.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  test('fails closed when the exact endpoint cardinality never remains stable', async () => {
    const { broker } = endpointSequenceBroker([2, 1, 2, 1, 2, 1]);
    const clock = deterministicReadinessClock();

    await expect(
      waitForExactRootEndpoints(broker, 2, 40, {
        stabilityMs: 20,
        pollMs: 10,
        ...clock
      })
    ).rejects.toThrow(/stable for 20ms/u);
  });

  test('rejects invalid readiness timing and injected clock primitives', async () => {
    const { broker } = endpointSequenceBroker([1]);
    await expect(waitForExactRootEndpoints(broker, 1, 0)).rejects.toThrow(/timeout must be a positive integer/u);
    await expect(
      waitForExactRootEndpoints(broker, 1, 100, { stabilityMs: 0 })
    ).rejects.toThrow(/stability window must be a positive integer/u);
    await expect(
      waitForExactRootEndpoints(broker, 1, 100, { now: null })
    ).rejects.toThrow(/clock and sleeper must be functions/u);
  });

  test('writes request correlation separately from strict P0-compatible origin evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-w3-correlation-'));
    try {
      const output = path.join(root, 'correlation.json');
      writeCorrelationEvidence(output, {
        requestId: 'request-1',
        activityId: 'https://pods.example/alice/as/activity/1',
        moleculerNamespace: 'adsp-p2-w3-run-123',
        expectedReplicas: 4
      });
      const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(parsed).toEqual({
        schema: CORRELATION_SCHEMA,
        requestId: 'request-1',
        activityId: 'https://pods.example/alice/as/activity/1',
        moleculerNamespace: 'adsp-p2-w3-run-123',
        expectedReplicas: 4
      });
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      expect(() => writeCorrelationEvidence(' bad', parsed)).toThrow(/output path/u);
      expect(() => writeCorrelationEvidence(output, { ...parsed, expectedReplicas: 3 })).toThrow(/replicas/u);
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

  test('W3 overlay launches the bridge in all four cells and leaves W1 native', () => {
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
    expect(source).toMatch(/SEMAPPS_MOLECULER_LOCALITY_TELEMETRY_ENABLED: 'true'/u);
    expect(source).toMatch(/node scripts\/adsp-p2-w3-loopback-bridge\.js & exec pm2-runtime ecosystem\.config\.js/u);
    expect((source.match(/command: \*adsp-p2-w3-command/gu) || []).length).toBe(4);
    for (const replica of [1, 2, 3, 4]) {
      expect(source).toMatch(new RegExp(`locality-r${replica}\\.json`, 'u'));
    }

    const w1Path = path.resolve(__dirname, '../../docker-compose-adsp-p2-horizontal.yml');
    const w1 = fs.readFileSync(w1Path, 'utf8');
    expect(w1).toMatch(/SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE: native/u);
    expect(w1).not.toMatch(/adsp-p2-w3-loopback-bridge/u);
  });
});
