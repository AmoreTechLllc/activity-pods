'use strict';

const fs = require('fs');
const path = require('path');
const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const {
  awaitActorBootstrap,
  boundedMap,
  chunk,
  normalizeRunId,
  positiveInteger,
  signupWithCandidateRetries
} = require('./apdm-phase8-real-measure');

const DEFAULT_TRANSPORTER_URL = 'redis://redis:6379/12';
const DEFAULT_BASE_URL = 'http://localhost:3000';

async function provision({ manifestPath, recipientCount, namespace, transporterUrl, baseUrl, runId }) {
  if (!namespace) throw new Error('ADSP P2 provisioning requires SEMAPPS_MOLECULER_NAMESPACE or ADSP_P2_NAMESPACE');
  const concurrency = positiveInteger(process.env.APDM_P8_PROVISION_CONCURRENCY, 4, 'provision concurrency');
  const batchSize = positiveInteger(process.env.APDM_P8_PROVISION_BATCH_SIZE, 24, 'provision batch size');
  const bootstrapConcurrency = positiveInteger(process.env.APDM_P8_BOOTSTRAP_CONCURRENCY, 8, 'bootstrap concurrency');
  const readyTimeoutMs = positiveInteger(process.env.APDM_P8_READY_TIMEOUT_MS, 120000, 'ready timeout');
  const broker = new ServiceBroker({
    nodeID: `adsp-p2-provision-${process.pid}-${Date.now()}`,
    namespace,
    logger: false,
    transporter: transporterUrl,
    serializer: new RdfJSONSerializer(),
    requestTimeout: readyTimeoutMs * 4,
    retryPolicy: { enabled: false },
    registry: { preferLocal: true }
  });

  await broker.start();
  try {
    await broker.waitForServices(['auth', 'activitypub.outbox', 'activitypub.actor'], readyTimeoutMs);
    const normalizedRunId = normalizeRunId(runId);
    const password = process.env.APDM_P8_SIGNUP_PASSWORD || 'Phase8MeasurePass123!';
    const sender = await signupWithCandidateRetries({
      baseUrl,
      password,
      runId: normalizedRunId,
      role: 'sender'
    });
    await awaitActorBootstrap(broker, sender, 'outbox', readyTimeoutMs);

    const indexes = Array.from({ length: recipientCount }, (_, index) => index + 1);
    const recipients = [];
    for (const indexBatch of chunk(indexes, batchSize)) {
      const signedUp = await boundedMap(indexBatch, concurrency, index =>
        signupWithCandidateRetries({
          baseUrl,
          password,
          runId: normalizedRunId,
          role: 'recipient',
          index
        })
      );
      recipients.push(
        ...(await boundedMap(signedUp, bootstrapConcurrency, actor =>
          awaitActorBootstrap(broker, actor, 'inbox', readyTimeoutMs)
        ))
      );
      process.stdout.write(`[ADSP-P2] provisioned ${recipients.length}/${recipientCount} recipients\n`);
    }

    const manifest = {
      version: 1,
      phase: 'ADSP-P2-A',
      fixture: 'tier1-horizontal-local-fanout',
      createdAt: new Date().toISOString(),
      runId: normalizedRunId,
      namespace,
      sender,
      recipients
    };
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  } finally {
    await broker.stop().catch(() => undefined);
  }
}

async function main(argv = process.argv.slice(2)) {
  const manifestPath = path.resolve(argv[0] || '');
  const recipientCount = positiveInteger(argv[1], undefined, 'recipient count');
  if (!argv[0]) throw new Error('Usage: adsp-p2-provision.js <manifest> <maxRecipients>');
  const namespace = process.env.SEMAPPS_MOLECULER_NAMESPACE || process.env.ADSP_P2_NAMESPACE;
  const manifest = await provision({
    manifestPath,
    recipientCount,
    namespace,
    transporterUrl: process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL,
    baseUrl: process.env.APDM_P8_BACKEND_BASE_URL || DEFAULT_BASE_URL,
    runId: process.env.APDM_P8_RUN_ID || `adsp-p2-${Date.now()}`
  });
  process.stdout.write(`${JSON.stringify({ ok: true, manifestPath, recipients: manifest.recipients.length, sender: manifest.sender.webId })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P2] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = { provision };
