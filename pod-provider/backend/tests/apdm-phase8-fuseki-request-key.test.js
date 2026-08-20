'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  createPhase8Tier1Instrumentation,
  getRequestMethod
} = require('../lib/apdm-phase8-tier1-instrumentation');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

function request(url, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, response => {
      response.resume();
      response.once('end', resolve);
    });
    req.once('error', reject);
    req.end();
  });
}

describe('APDM Phase 8 correlated Fuseki request evidence', () => {
  test('extracts an explicit method from later options when the first argument is an object URL descriptor', () => {
    const legacyUrlDescriptor = {
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: 3030,
      path: '/$/datasets/alice'
    };

    expect(getRequestMethod([legacyUrlDescriptor, { method: 'DELETE' }])).toBe('DELETE');
    expect(getRequestMethod([legacyUrlDescriptor, { headers: { accept: 'application/json' } }])).toBe('GET');
    expect(getRequestMethod([new URL('http://127.0.0.1:3030/$/datasets/alice'), { method: 'post' }])).toBe('POST');
  });

  test('records method and privacy-safe route shape together so GET and DELETE cannot be conflated', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-request-key-'));
    const outputPath = path.join(outputDirectory, 'measurement.jsonl');
    const server = http.createServer((_incoming, response) => {
      response.writeHead(204);
      response.end();
    });
    const address = await listen(server);
    const fusekiBase = `http://${address.address}:${address.port}`;
    const instrumentation = createPhase8Tier1Instrumentation({ enabled: true, outputPath, fusekiBase });

    try {
      const root = instrumentation.middleware.localAction(async () => {
        await request(`${fusekiBase}/$/datasets/alice`, 'GET');
        await request(`${fusekiBase}/$/datasets/alice`, 'DELETE');
      }, { name: 'activitypub.outbox.post' });

      await root({ id: 'root-request-key' });
      const artifact = fs.readFileSync(outputPath, 'utf8');
      const [record] = artifact.trim().split('\n').map(line => JSON.parse(line));

      expect(record.fuseki.pathCounts['/$/datasets/:dataset']).toBe(2);
      expect(record.fuseki.requestKeyCounts['GET /$/datasets/:dataset']).toBe(1);
      expect(record.fuseki.requestKeyCounts['DELETE /$/datasets/:dataset']).toBe(1);
      expect(artifact).not.toContain('/$/datasets/alice');
    } finally {
      instrumentation.dispose();
      await close(server);
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
