'use strict';

const http = require('node:http');
const { fetchRemoteActivityPubActor } = require('../utils/activitypub-remote-actor-fetch');

describe('APDM Phase 3 pinned remote actor fetch integration', () => {
  test('node-fetch connects through the validated pinned lookup and never needs a second DNS resolution', async () => {
    const server = http.createServer((request, response) => {
      const actorUri = `http://localhost:${server.address().port}/actor`;
      response.writeHead(200, { 'content-type': 'application/activity+json' });
      response.end(JSON.stringify({ id: actorUri, inbox: `${actorUri}/inbox` }));
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const port = server.address().port;
    const actorUri = `http://localhost:${port}/actor`;
    const lookup = jest.fn(async hostname => {
      expect(hostname).toBe('localhost');
      return [{ address: '127.0.0.1', family: 4 }];
    });

    try {
      await expect(fetchRemoteActivityPubActor(actorUri, {
        lookup,
        allowLoopbackHttp: true,
        timeoutMs: 2000
      })).resolves.toEqual({ id: actorUri, inbox: `${actorUri}/inbox` });
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
