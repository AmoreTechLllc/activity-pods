'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { ServiceBroker } = require('moleculer');

const REQUIRED_RECIPIENT_COUNTS = [1, 10, 100, 200, 1000];
const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_TRANSPORTER_URL = 'redis://redis:6379/12';
const DEFAULT_PROVISION_CONCURRENCY = 4;
const DEFAULT_PROVISION_BATCH_SIZE = 24;
const DEFAULT_BOOTSTRAP_CONCURRENCY = 8;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_SIGNUP_TIMEOUT_MS = 900_000;
const DEFAULT_SAMPLE_TIMEOUT_MS = 900_000;
const DEFAULT_SAMPLES = 3;
const DEFAULT_WARMUPS = 1;
const DEFAULT_USERNAME_CANDIDATE_ATTEMPTS = 12;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInteger(value, fallback, label) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function normalizeRunId(value) {
  const cleaned = String(value || `${Date.now()}`)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(-10);
  return `p8${cleaned || 'local'}`;
}

function createBenchmarkUsername({ runId, role, index = 0, attempt = 0 }) {
  const roleToken = role === 'sender' ? 's' : 'r';
  const seed = `${normalizeRunId(runId)}:${roleToken}:${index}:${attempt}`;
  const digest = crypto.createHash('sha256').update(seed).digest('hex');
  // Numeric-only entropy avoids accidentally forming moderation dictionary
  // words while still traversing the normal moderation action on every signup.
  const numeric = (BigInt(`0x${digest.slice(0, 16)}`) % 10_000_000_000_000_000n).toString().padStart(16, '0');
  return `p8m${roleToken}${numeric}`;
}

function isUsernameNotAllowed(error) {
  return Boolean(
    error &&
      Number(error.status) === 422 &&
      (error.body?.type === 'USERNAME_NOT_ALLOWED' || /USERNAME_NOT_ALLOWED|username is not available/iu.test(error.message || ''))
  );
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function boundedMap(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function requestJsonOnce(url, options, { timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, timeout: timeoutMs });
  } catch (error) {
    const ambiguous = new Error(`Non-replayable request failed with an ambiguous result: ${error.message || String(error)}`);
    ambiguous.cause = error;
    ambiguous.ambiguous = true;
    throw ambiguous;
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_error) {
    body = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    error.status = response.status;
    error.body = body;
    if (response.status >= 500 || response.status === 408 || response.status === 429) error.ambiguous = true;
    throw error;
  }

  return body;
}

async function signup(baseUrl, username, password) {
  const signupTimeoutMs = positiveInteger(
    process.env.APDM_P8_SIGNUP_TIMEOUT_MS,
    DEFAULT_SIGNUP_TIMEOUT_MS,
    'signup timeout'
  );
  const body = await requestJsonOnce(
    `${baseUrl.replace(/\/$/u, '')}/auth/signup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email: `${username}@example.invalid`, password })
    },
    { timeoutMs: signupTimeoutMs }
  );

  if (!body.webId) throw new Error(`Signup for ${username} did not return webId`);
  return { username, webId: body.webId };
}

async function signupWithCandidateRetries({
  baseUrl,
  password,
  runId,
  role,
  index = 0,
  maxAttempts = DEFAULT_USERNAME_CANDIDATE_ATTEMPTS,
  signupFn = signup
}) {
  let lastModerationError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const username = createBenchmarkUsername({ runId, role, index, attempt });
    try {
      return await signupFn(baseUrl, username, password);
    } catch (error) {
      if (!isUsernameNotAllowed(error)) throw error;
      lastModerationError = error;
      process.stderr.write(
        `[APDM-P8] benchmark username candidate rejected by normal moderation; regenerating role=${role} index=${index} attempt=${attempt + 1}/${maxAttempts}\n`
      );
    }
  }

  throw new Error(
    `Unable to obtain an allowed benchmark username after ${maxAttempts} candidates for role=${role} index=${index}: ${
      lastModerationError?.message || 'all candidates rejected'
    }`
  );
}

function createRemoteBroker(transporterUrl) {
  return new ServiceBroker({
    nodeID: `apdm-p8-runner-${process.pid}-${Date.now()}`,
    logger: false,
    transporter: transporterUrl,
    requestTimeout: 120_000,
    retryPolicy: { enabled: false }
  });
}

async function waitForCollection(broker, actor, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const collectionUri = await broker.call(
        'activitypub.actor.getCollectionUri',
        { actorUri: actor.webId, predicate, webId: 'system' },
        { meta: { dataset: actor.username } }
      );
      if (collectionUri) return collectionUri;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${predicate} of ${actor.webId}${lastError ? `: ${lastError.message}` : ''}`);
}

async function awaitActorBootstrap(broker, actor, predicate, readyTimeoutMs) {
  await broker.call(
    'auth.awaitBootstrapComplete',
    { webId: actor.webId },
    { meta: { dataset: actor.username, webId: actor.webId }, timeout: readyTimeoutMs * 4 }
  );
  actor[predicate] = await waitForCollection(broker, actor, predicate, readyTimeoutMs);
  return actor;
}

async function provisionActors({
  manifestPath,
  recipientCount,
  baseUrl,
  transporterUrl,
  concurrency,
  batchSize,
  bootstrapConcurrency,
  readyTimeoutMs,
  runId
}) {
  const broker = createRemoteBroker(transporterUrl);
  await broker.start();
  try {
    await broker.waitForServices(['auth', 'activitypub.outbox', 'activitypub.actor'], readyTimeoutMs);
    const prefix = normalizeRunId(runId);
    const password = process.env.APDM_P8_SIGNUP_PASSWORD || 'Phase8MeasurePass123!';
    const startedAt = Date.now();

    const sender = await signupWithCandidateRetries({ baseUrl, password, runId: prefix, role: 'sender' });
    await awaitActorBootstrap(broker, sender, 'outbox', readyTimeoutMs);

    const indexes = Array.from({ length: recipientCount }, (_, index) => index + 1);
    const recipients = [];
    let completed = 0;

    for (const indexBatch of chunk(indexes, batchSize)) {
      // Signup releases after Tier-1 key + ActivityPub provisioning in the
      // benchmark overlay. Event-created Pod resources then overlap only within
      // this bounded window, preventing an unbounded Fuseki/LDP backlog.
      const signedUp = await boundedMap(indexBatch, concurrency, index =>
        signupWithCandidateRetries({ baseUrl, password, runId: prefix, role: 'recipient', index })
      );

      const completedBatch = await boundedMap(signedUp, bootstrapConcurrency, actor =>
        awaitActorBootstrap(broker, actor, 'inbox', readyTimeoutMs)
      );
      recipients.push(...completedBatch);
      completed += completedBatch.length;

      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const rate = completed / elapsedSeconds;
      process.stdout.write(
        `[APDM-P8] provisioned ${completed}/${recipientCount} recipients elapsed=${elapsedSeconds.toFixed(1)}s rate=${rate.toFixed(2)}/s\n`
      );
    }

    const manifest = {
      version: 1,
      phase: 'APDM-P8-A',
      createdAt: new Date().toISOString(),
      runId: prefix,
      sender,
      recipients
    };
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  } finally {
    await broker.stop();
  }
}

async function waitForRecordCount(outputPath, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = readJsonLines(outputPath);
    if (records.length >= expectedCount) return records;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expectedCount} measurement record(s) in ${outputPath}`);
}

function assertUsableRecord(record, recipientCount) {
  if (!record || record.phase !== 'APDM-P8-A') throw new Error('Missing APDM-P8-A measurement record');
  if (Number(record.recipientCount) !== recipientCount) {
    throw new Error(`Measurement record recipientCount=${record.recipientCount} does not match ${recipientCount}`);
  }
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    throw new Error(`Measurement trace contains delivery/instrumentation errors: ${JSON.stringify(record.errors)}`);
  }
}

async function postMeasuredActivity(broker, manifest, recipients, label) {
  const result = await broker.call(
    'activitypub.outbox.post',
    {
      collectionUri: manifest.sender.outbox,
      type: 'Create',
      actor: manifest.sender.webId,
      to: recipients.map(recipient => recipient.webId),
      object: { type: 'Note', content: `APDM Phase 8 local fan-out measurement ${label}` }
    },
    { meta: { webId: manifest.sender.webId, dataset: manifest.sender.username } }
  );
  if (!result || !result.id) throw new Error(`Outbox post ${label} did not return a persisted Activity`);
  return result;
}

async function measure({ manifestPath, recipientCount, samples, warmups, outputPath, transporterUrl, readyTimeoutMs, sampleTimeoutMs }) {
  if (!REQUIRED_RECIPIENT_COUNTS.includes(recipientCount)) {
    throw new Error(`recipientCount must be one of ${REQUIRED_RECIPIENT_COUNTS.join(', ')}`);
  }
  if (process.env.SEMAPPS_APDM_PHASE8_INSTRUMENTATION_ENABLED !== 'true') {
    throw new Error('SEMAPPS_APDM_PHASE8_INSTRUMENTATION_ENABLED must be true for measurement');
  }
  const configuredCount = Number(process.env.SEMAPPS_APDM_PHASE8_RECIPIENT_COUNT);
  if (configuredCount !== recipientCount) {
    throw new Error(`Configured instrumentation recipient count ${configuredCount} does not match runner count ${recipientCount}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.sender || !Array.isArray(manifest.recipients) || manifest.recipients.length < recipientCount) {
    throw new Error(`Actor manifest does not contain ${recipientCount} recipients`);
  }
  const recipients = manifest.recipients.slice(0, recipientCount);

  const broker = createRemoteBroker(transporterUrl);
  await broker.start();
  try {
    await broker.waitForServices(['activitypub.outbox', 'activitypub.actor'], readyTimeoutMs);
    fs.rmSync(outputPath, { force: true });
    for (let index = 0; index < warmups; index += 1) {
      await postMeasuredActivity(broker, manifest, recipients, `warmup-${recipientCount}-${index + 1}`);
      const records = await waitForRecordCount(outputPath, index + 1, sampleTimeoutMs);
      assertUsableRecord(records[index], recipientCount);
    }
    fs.rmSync(outputPath, { force: true });
    for (let index = 0; index < samples; index += 1) {
      await postMeasuredActivity(broker, manifest, recipients, `sample-${recipientCount}-${index + 1}`);
      const records = await waitForRecordCount(outputPath, index + 1, sampleTimeoutMs);
      assertUsableRecord(records[index], recipientCount);
      process.stdout.write(`[APDM-P8] completed sample ${index + 1}/${samples} at N=${recipientCount}\n`);
    }
    const records = readJsonLines(outputPath);
    if (records.length !== samples) {
      throw new Error(`Expected exactly ${samples} measured records at N=${recipientCount}, found ${records.length}`);
    }
    records.forEach(record => assertUsableRecord(record, recipientCount));
    return records;
  } finally {
    await broker.stop();
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const baseUrl = process.env.APDM_P8_BACKEND_BASE_URL || DEFAULT_BASE_URL;
  const transporterUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL;
  const readyTimeoutMs = positiveInteger(process.env.APDM_P8_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS, 'ready timeout');

  if (command === 'provision') {
    const manifestPath = path.resolve(argv[1] || './measurements/apdm-p8-actors.json');
    const recipientCount = positiveInteger(argv[2], 1000, 'recipient count');
    const concurrency = positiveInteger(
      process.env.APDM_P8_PROVISION_CONCURRENCY,
      DEFAULT_PROVISION_CONCURRENCY,
      'provision concurrency'
    );
    const batchSize = positiveInteger(
      process.env.APDM_P8_PROVISION_BATCH_SIZE,
      DEFAULT_PROVISION_BATCH_SIZE,
      'provision batch size'
    );
    const bootstrapConcurrency = positiveInteger(
      process.env.APDM_P8_BOOTSTRAP_CONCURRENCY,
      DEFAULT_BOOTSTRAP_CONCURRENCY,
      'bootstrap concurrency'
    );
    const manifest = await provisionActors({
      manifestPath,
      recipientCount,
      baseUrl,
      transporterUrl,
      concurrency,
      batchSize,
      bootstrapConcurrency,
      readyTimeoutMs,
      runId: process.env.APDM_P8_RUN_ID
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, command, manifestPath, recipients: manifest.recipients.length, sender: manifest.sender.webId })}\n`
    );
    return;
  }

  if (command === 'measure') {
    const manifestPath = path.resolve(argv[1] || './measurements/apdm-p8-actors.json');
    const recipientCount = positiveInteger(argv[2], undefined, 'recipient count');
    const samples = positiveInteger(process.env.APDM_P8_SAMPLES, DEFAULT_SAMPLES, 'samples');
    const warmups = positiveInteger(process.env.APDM_P8_WARMUPS, DEFAULT_WARMUPS, 'warmups');
    const sampleTimeoutMs = positiveInteger(
      process.env.APDM_P8_SAMPLE_TIMEOUT_MS,
      DEFAULT_SAMPLE_TIMEOUT_MS,
      'sample timeout'
    );
    const outputPath = path.resolve(
      process.env.SEMAPPS_APDM_PHASE8_INSTRUMENTATION_OUTPUT || `./measurements/apdm-p8-${recipientCount}.jsonl`
    );
    const records = await measure({
      manifestPath,
      recipientCount,
      samples,
      warmups,
      outputPath,
      transporterUrl,
      readyTimeoutMs,
      sampleTimeoutMs
    });
    process.stdout.write(`${JSON.stringify({ ok: true, command, recipientCount, samples: records.length, outputPath })}\n`);
    return;
  }

  throw new Error('Usage: node scripts/apdm-phase8-real-measure.js provision <manifest> [maxRecipients] | measure <manifest> <recipientCount>');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[APDM-P8] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_RECIPIENT_COUNTS,
  assertUsableRecord,
  awaitActorBootstrap,
  boundedMap,
  chunk,
  createBenchmarkUsername,
  isUsernameNotAllowed,
  normalizeRunId,
  positiveInteger,
  readJsonLines,
  requestJsonOnce,
  signupWithCandidateRetries,
  waitForRecordCount
};
