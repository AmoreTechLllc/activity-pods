'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');

const backendDir = path.resolve(__dirname, '..');
const redisUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || 'redis://127.0.0.1:6379';
const namespace = process.env.ADSP_P1_NAMESPACE || `adsp-p1-launcher-${process.pid}-${Date.now()}`;
const probeNodeID = 'p1-launcher-probe';

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for launcher to exit')), timeoutMs);
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

async function stopLauncher(launcher, stderr) {
  if (launcher.exitCode !== null || launcher.signalCode !== null) return;
  const exitPromise = waitForExit(launcher);
  launcher.kill('SIGTERM');
  const exit = await exitPromise.catch(error => ({ error: error.message }));
  if (exit.error) {
    launcher.kill('SIGKILL');
    throw new Error(`${exit.error}; stderr=${stderr}`);
  }
}

async function waitForLaunchedService(caller, launcher, getOutput) {
  const serviceReady = caller.waitForServices('adsp.p1.rdfProbe', 15000).then(() => ({ kind: 'ready' }));
  const launcherExit = waitForExit(launcher, 16000)
    .then(exit => ({ kind: 'exit', exit }))
    .catch(() => ({ kind: 'still-running' }));

  let result;
  try {
    result = await Promise.race([serviceReady, launcherExit]);
  } catch (error) {
    const output = getOutput();
    throw new Error(
      `Timed out discovering launched probe: ${error.message}\nlauncher stdout:\n${output.stdout}\nlauncher stderr:\n${output.stderr}`
    );
  }

  if (result.kind === 'exit') {
    const output = getOutput();
    throw new Error(
      `Launcher exited before advertising probe (code=${result.exit.code}, signal=${result.exit.signal}).\nlauncher stdout:\n${output.stdout}\nlauncher stderr:\n${output.stderr}`
    );
  }
  if (result.kind !== 'ready') {
    const output = getOutput();
    throw new Error(
      `Launcher remained alive without advertising probe.\nlauncher stdout:\n${output.stdout}\nlauncher stderr:\n${output.stderr}`
    );
  }
}

async function main() {
  let stdout = '';
  let stderr = '';
  const launcher = spawn(process.execPath, ['scripts/run-moleculer-fabric.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SEMAPPS_MOLECULER_MODE: 'distributed',
      SEMAPPS_MOLECULER_NODE_ID: probeNodeID,
      SEMAPPS_MOLECULER_NAMESPACE: namespace,
      SEMAPPS_MOLECULER_SERVICE_GROUP: 'p1-probe',
      SEMAPPS_REDIS_TRANSPORTER_URL: redisUrl,
      SEMAPPS_MOLECULER_LOCALITY_TELEMETRY_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  launcher.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  launcher.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const caller = new ServiceBroker({
    nodeID: 'p1-launcher-caller',
    namespace,
    transporter: redisUrl,
    serializer: new RdfJSONSerializer(),
    logger: false,
    registry: { preferLocal: true }
  });

  try {
    await caller.start();
    await waitForLaunchedService(caller, launcher, () => ({ stdout, stderr }));

    const inventory = await caller.call('adsp.p1.rdfProbe.inventory', {}, { timeout: 5000 });
    if (inventory.servedBy !== probeNodeID) {
      throw new Error(`Expected inventory from ${probeNodeID}, got ${inventory.servedBy}`);
    }

    const services = inventory.services || [];
    const required = ['adsp.p1.rdfProbe', 'adsp.p1.localityProbe'];
    for (const service of required) {
      if (!services.includes(service)) {
        throw new Error(`Selected p1-probe group did not load ${service}: ${JSON.stringify(services)}`);
      }
    }

    const forbiddenPrefixes = ['api', 'ldp', 'activitypub', 'auth', 'triplestore', 'webacl', 'webid', 'solid'];
    const leaked = services.filter(service =>
      forbiddenPrefixes.some(prefix => service === prefix || service.startsWith(`${prefix}.`))
    );
    if (leaked.length > 0) {
      throw new Error(`p1-probe launcher loaded production services: ${JSON.stringify(leaked)}`);
    }

    const startupLine = stdout.split(/\r?\n/u).find(line => line.includes('"event":"moleculer_fabric_start"'));
    if (!startupLine) throw new Error(`Launcher did not emit fabric start metadata. stdout=${stdout}`);
    const startup = JSON.parse(startupLine);
    if (
      startup.mode !== 'distributed' ||
      startup.nodeID !== probeNodeID ||
      startup.namespace !== namespace ||
      startup.serviceGroup !== 'p1-probe'
    ) {
      throw new Error(`Launcher start metadata drifted: ${startupLine}`);
    }
    if (JSON.stringify(startup.servicePatterns) !== JSON.stringify(['p1-fixtures/services/*.service.js'])) {
      throw new Error(`Launcher used unexpected service patterns: ${JSON.stringify(startup.servicePatterns)}`);
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        nodeID: probeNodeID,
        namespace,
        serviceGroup: startup.serviceGroup,
        servicePatterns: startup.servicePatterns,
        loadedServices: services,
        productionServicesLoaded: leaked,
        independentGroupStart: true
      }, null, 2)}\n`
    );
  } finally {
    await caller.stop().catch(() => undefined);
    await stopLauncher(launcher, stderr);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
