'use strict';

const fs = require('node:fs');
const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');

const nodeID = process.env.ADSP_P1_WORKER_NODE_ID;
const namespace = process.env.ADSP_P1_NAMESPACE;
const redisUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL;
const mutationPath = process.env.ADSP_P1_MUTATION_PATH;

for (const [name, value] of Object.entries({ nodeID, namespace, redisUrl, mutationPath })) {
  if (!value) throw new Error(`Missing required P1 authority worker setting: ${name}`);
}

function commitMutation(token, action) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200) {
    throw new Error('Authority probe token must be a non-empty string up to 200 characters');
  }

  const record = `${JSON.stringify({ token, nodeID, action, pid: process.pid })}\n`;
  const fd = fs.openSync(mutationPath, 'a', 0o600);
  try {
    fs.writeSync(fd, record, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const broker = new ServiceBroker({
  nodeID,
  namespace,
  transporter: redisUrl,
  serializer: new RdfJSONSerializer(),
  logger: false,
  heartbeatInterval: 1,
  heartbeatTimeout: 3,
  registry: { preferLocal: true }
});

broker.createService({
  name: 'adsp.p1.authorityProbe',
  actions: {
    commitThenBlock: {
      params: {
        token: { type: 'string', min: 1, max: 200 }
      },
      async handler(ctx) {
        commitMutation(ctx.params.token, 'commitThenBlock');
        await new Promise(() => {});
      }
    },
    commit: {
      params: {
        token: { type: 'string', min: 1, max: 200 }
      },
      handler(ctx) {
        commitMutation(ctx.params.token, 'commit');
        return { ok: true, token: ctx.params.token, servedBy: broker.nodeID };
      }
    }
  }
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  try {
    await broker.stop();
  } finally {
    process.exit(signal ? 0 : process.exitCode || 0);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(signal).catch(error => {
      console.error(error);
      process.exit(1);
    });
  });
}

broker
  .start()
  .then(() => {
    process.stdout.write(`${JSON.stringify({ event: 'adsp_p1_authority_worker_ready', nodeID, namespace })}\n`);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
