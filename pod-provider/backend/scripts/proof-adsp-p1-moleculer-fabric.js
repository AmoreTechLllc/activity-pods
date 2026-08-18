'use strict';

const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const AdspActionLocalityMiddleware = require('../middlewares/adsp-action-locality');
const probeService = require('../p1-fixtures/services/rdf-probe.service');

const redisUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || 'redis://127.0.0.1:6379';
const namespace = process.env.ADSP_P1_NAMESPACE || `adsp-p1-${process.pid}-${Date.now()}`;
const ACTION = 'adsp.p1.rdfProbe.echo';

function rdfNamedNode(value) {
  const term = Object.create({ termType: 'NamedNode' });
  term.value = value;
  return term;
}

function rdfLiteral(value, language = '') {
  const term = Object.create({ termType: 'Literal' });
  term.value = value;
  term.language = language;
  term.datatype = rdfNamedNode(
    language
      ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'
      : 'http://www.w3.org/2001/XMLSchema#string'
  );
  return term;
}

function brokerOptions(nodeID, brokerNamespace = namespace) {
  return {
    nodeID,
    namespace: brokerNamespace,
    transporter: redisUrl,
    serializer: new RdfJSONSerializer(),
    middlewares: [AdspActionLocalityMiddleware({ enabled: true, maxActions: 20 })],
    logger: false,
    heartbeatInterval: 1,
    heartbeatTimeout: 3,
    registry: { strategy: 'RoundRobin' }
  };
}

async function waitForService(broker, name, timeout = 10000) {
  await broker.waitForServices(name, timeout);
}

function actionEndpointCount(broker) {
  const endpoints = broker.registry.getActionEndpoints(ACTION);
  return endpoints?.count?.() ?? 0;
}

async function waitForEndpointCount(broker, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = actionEndpointCount(broker);
    if (count === expected) return count;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${expected} ${ACTION} endpoints; observed ${actionEndpointCount(broker)}`
  );
}

async function expectServiceUnavailable(broker) {
  try {
    await broker.call(ACTION, { payload: { value: 'should-not-route' } }, { timeout: 1000 });
  } catch (error) {
    return { unavailable: true, code: error?.code || error?.name || 'UNKNOWN' };
  }
  throw new Error('Expected remote probe service to be unavailable');
}

function localitySnapshot(broker) {
  if (!broker.adspActionLocality?.snapshot) {
    throw new Error(`Missing ADSP locality telemetry on ${broker.nodeID}`);
  }
  return broker.adspActionLocality.snapshot();
}

async function main() {
  const caller = new ServiceBroker(brokerOptions('p1-caller-a'));
  const probeA = new ServiceBroker(brokerOptions('p1-probe-a'));
  probeA.createService(probeService);
  const isolated = new ServiceBroker(brokerOptions('p1-isolated', `${namespace}-isolated`));
  const brokers = [caller, probeA, isolated];

  try {
    await Promise.all(brokers.map(broker => broker.start()));
    await waitForService(caller, 'adsp.p1.rdfProbe');
    await waitForEndpointCount(caller, 1);
    await waitForEndpointCount(isolated, 0);

    const payload = {
      subject: rdfNamedNode('https://example.test/resources/1'),
      predicate: rdfNamedNode('https://schema.org/name'),
      object: rdfLiteral('ActivityPods', 'en'),
      jsonld: {
        '@id': 'https://example.test/resources/1',
        '@type': 'https://schema.org/Thing',
        'https://schema.org/name': [{ '@value': 'ActivityPods', '@language': 'en' }]
      }
    };

    const echoed = await caller.call(ACTION, { payload }, { timeout: 5000 });
    if (echoed.servedBy !== 'p1-probe-a') {
      throw new Error(`Expected genuine remote call to p1-probe-a, got ${echoed.servedBy}`);
    }
    if (echoed.payload?.subject?.termType !== 'NamedNode' || echoed.payload.subject.value !== payload.subject.value) {
      throw new Error('NamedNode semantic shape changed across remote call');
    }
    if (
      echoed.payload?.object?.termType !== 'Literal' ||
      echoed.payload.object.value !== payload.object.value ||
      echoed.payload.object.language !== 'en' ||
      echoed.payload.object.datatype?.termType !== 'NamedNode'
    ) {
      throw new Error('Literal semantic shape changed across remote call');
    }
    if (JSON.stringify(echoed.payload.jsonld) !== JSON.stringify(payload.jsonld)) {
      throw new Error('JSON-LD payload changed across remote call');
    }

    let remoteError;
    try {
      await caller.call('adsp.p1.rdfProbe.fail', {}, { timeout: 5000 });
    } catch (error) {
      remoteError = error;
    }
    if (!remoteError || !String(remoteError.message).includes('ADSP P1 remote probe failure')) {
      throw new Error('Remote error propagation parity failed');
    }

    const firstCallerTelemetry = localitySnapshot(caller);
    const firstProbeTelemetry = localitySnapshot(probeA);
    if ((firstCallerTelemetry.remoteByAction[ACTION] || 0) < 1) {
      throw new Error('Caller did not record the genuine remote action');
    }
    if ((firstProbeTelemetry.localByAction[ACTION] || 0) < 1) {
      throw new Error('Probe node did not record local execution of the remotely requested action');
    }

    const isolatedResult = await expectServiceUnavailable(isolated);

    await probeA.stop();
    await waitForEndpointCount(caller, 0);
    const unavailableAfterLeave = await expectServiceUnavailable(caller);

    const probeB = new ServiceBroker(brokerOptions('p1-probe-b'));
    probeB.createService(probeService);
    brokers.push(probeB);
    await probeB.start();
    await waitForService(caller, 'adsp.p1.rdfProbe');
    await waitForEndpointCount(caller, 1);

    const afterRejoin = await caller.call(ACTION, { payload: { marker: 'rejoined' } }, { timeout: 5000 });
    if (afterRejoin.servedBy !== 'p1-probe-b' || afterRejoin.payload?.marker !== 'rejoined') {
      throw new Error('Registry did not converge to the rejoined service node');
    }

    const finalCallerTelemetry = localitySnapshot(caller);
    const replacementTelemetry = localitySnapshot(probeB);
    if ((finalCallerTelemetry.remoteByAction[ACTION] || 0) < 2) {
      throw new Error('Caller telemetry did not include the rejoined remote action');
    }
    if ((replacementTelemetry.localByAction[ACTION] || 0) < 1) {
      throw new Error('Replacement node telemetry did not include local execution');
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          namespace,
          nodes: {
            caller: 'p1-caller-a',
            firstProbe: 'p1-probe-a',
            replacementProbe: 'p1-probe-b'
          },
          remoteRdfParity: true,
          remoteJsonLdParity: true,
          remoteErrorParity: true,
          localityTelemetry: {
            caller: finalCallerTelemetry,
            replacementProbe: replacementTelemetry
          },
          namespaceIsolation: isolatedResult,
          leaveRegistryEndpointCount: 0,
          leaveRemovesRoute: unavailableAfterLeave,
          rejoinRegistryEndpointCount: 1,
          rejoinServedBy: afterRejoin.servedBy
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.allSettled(brokers.map(broker => broker.stop()));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
