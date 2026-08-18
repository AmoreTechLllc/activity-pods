'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');

const redisUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || 'redis://127.0.0.1:6379';
const namespace = process.env.ADSP_P1_NAMESPACE || `adsp-p1-authority-${process.pid}-${Date.now()}`;
const ACTION_BLOCK = 'adsp.p1.authorityProbe.commitThenBlock';
const ACTION_COMMIT = 'adsp.p1.authorityProbe.commit';
const VICTIM_NODE = 'p1-authority-victim';
const SURVIVOR_NODE = 'p1-authority-survivor';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for worker ${child.pid} to exit`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function readMutations(mutationPath) {
  if (!fs.existsSync(mutationPath)) return [];
  return fs
    .readFileSync(mutationPath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function waitForMutationCount(mutationPath, token, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = readMutations(mutationPath).filter(record => record.token === token);
    if (matches.length >= expected) return matches;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${expected} durable mutation(s) for ${token}`);
}

function endpointCount(broker) {
  const endpoints = broker.registry.getActionEndpoints(ACTION_BLOCK);
  return endpoints?.count?.() ?? 0;
}

async function waitForEndpointCount(broker, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = endpointCount(broker);
    if (count === expected) return count;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expected} authority endpoints; observed ${endpointCount(broker)}`);
}

function spawnWorker(nodeID, mutationPath) {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['scripts/adsp-p1-authority-probe-worker.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ADSP_P1_WORKER_NODE_ID: nodeID,
      ADSP_P1_NAMESPACE: namespace,
      ADSP_P1_MUTATION_PATH: mutationPath,
      SEMAPPS_REDIS_TRANSPORTER_URL: redisUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    }
  };
}

async function stopWorker(worker) {
  if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = waitForExit(worker.child);
  worker.child.kill('SIGTERM');
  try {
    await exited;
  } catch (error) {
    worker.child.kill('SIGKILL');
    throw new Error(`${error.message}; stdout=${worker.stdout}; stderr=${worker.stderr}`);
  }
}

async function main() {
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p1-authority-'));
  const mutationPath = path.join(evidenceDir, 'mutations.jsonl');
  const originalToken = `ambiguous-${process.pid}-${Date.now()}`;
  const rejoinToken = `rejoin-${process.pid}-${Date.now()}`;

  const caller = new ServiceBroker({
    nodeID: 'p1-authority-caller',
    namespace,
    transporter: redisUrl,
    serializer: new RdfJSONSerializer(),
    logger: false,
    heartbeatInterval: 1,
    heartbeatTimeout: 3,
    registry: { preferLocal: true }
  });

  let victim;
  let survivor;
  let rejoined;

  try {
    await caller.start();

    victim = spawnWorker(VICTIM_NODE, mutationPath);
    await caller.waitForServices('adsp.p1.authorityProbe', 10000);
    await waitForEndpointCount(caller, 1);

    const pending = caller.call(ACTION_BLOCK, { token: originalToken }, { timeout: 7000 }).then(
      value => ({ resolved: true, value }),
      error => ({ resolved: false, error })
    );

    const committed = await waitForMutationCount(mutationPath, originalToken, 1);
    if (committed.length !== 1 || committed[0].nodeID !== VICTIM_NODE) {
      throw new Error(`Initial authoritative mutation did not commit exactly once on victim: ${JSON.stringify(committed)}`);
    }

    survivor = spawnWorker(SURVIVOR_NODE, mutationPath);
    await waitForEndpointCount(caller, 2);

    const victimExit = waitForExit(victim.child);
    victim.child.kill('SIGKILL');
    const killed = await victimExit;
    if (killed.signal !== 'SIGKILL') {
      throw new Error(`Victim did not terminate via SIGKILL: ${JSON.stringify(killed)}`);
    }

    const outcome = await pending;
    if (outcome.resolved) {
      throw new Error(`Ambiguous request unexpectedly resolved after serving node loss: ${JSON.stringify(outcome.value)}`);
    }

    await waitForEndpointCount(caller, 1);
    await sleep(750);

    const afterLoss = readMutations(mutationPath).filter(record => record.token === originalToken);
    if (afterLoss.length !== 1) {
      throw new Error(`Authoritative mutation was silently duplicated after node loss: ${JSON.stringify(afterLoss)}`);
    }
    if (afterLoss[0].nodeID !== VICTIM_NODE) {
      throw new Error(`Original mutation moved to an unexpected node: ${JSON.stringify(afterLoss)}`);
    }

    rejoined = spawnWorker(VICTIM_NODE, mutationPath);
    await waitForEndpointCount(caller, 2);

    const rejoinResult = await caller.call(
      ACTION_COMMIT,
      { token: rejoinToken },
      { nodeID: VICTIM_NODE, timeout: 5000 }
    );
    if (!rejoinResult?.ok || rejoinResult.servedBy !== VICTIM_NODE || rejoinResult.token !== rejoinToken) {
      throw new Error(`Rejoined node did not serve the clean follow-up mutation: ${JSON.stringify(rejoinResult)}`);
    }

    const finalMutations = readMutations(mutationPath);
    const originalRecords = finalMutations.filter(record => record.token === originalToken);
    const rejoinRecords = finalMutations.filter(record => record.token === rejoinToken);
    if (originalRecords.length !== 1 || rejoinRecords.length !== 1) {
      throw new Error(`Mutation cardinality drifted across loss/rejoin: ${JSON.stringify(finalMutations)}`);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          namespace,
          ambiguousRequest: {
            token: originalToken,
            committedOn: originalRecords[0].nodeID,
            callerObservedFailure: true,
            errorCode: outcome.error?.code || null,
            errorType: outcome.error?.type || outcome.error?.name || null,
            durableMutationCount: originalRecords.length,
            silentReplayObserved: false
          },
          loss: {
            victimNode: VICTIM_NODE,
            killSignal: killed.signal,
            survivingEndpointCount: 1
          },
          rejoin: {
            nodeID: VICTIM_NODE,
            endpointCount: 2,
            cleanMutationToken: rejoinToken,
            cleanMutationCount: rejoinRecords.length,
            servedBy: rejoinResult.servedBy
          },
          finalMutationCount: finalMutations.length
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.allSettled([stopWorker(victim), stopWorker(survivor), stopWorker(rejoined)]);
    await caller.stop().catch(() => undefined);
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
