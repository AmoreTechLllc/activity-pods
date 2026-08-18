'use strict';

const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const probeService = require('../p1-fixtures/services/rdf-probe.service');

const redisUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || 'redis://127.0.0.1:6379';
const namespace = process.env.ADSP_P1_NAMESPACE || `adsp-p1-${process.pid}-${Date.now()}`;

function rdfNamedNode(value) {
  const term = Object.create({ termType: 'NamedNode' });
  term.value = value;
  return term;
}

function rdfLiteral(value, language = '') {
  const term = Object.create({ termType: 'Literal' });
  term.value = value;
  term.language = language;
  term.datatype = rdfNamedNode(language ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString' : 'http://www.w3.org/2001/XMLSchema#string');
  return term;
}

function brokerOptions(nodeID, brokerNamespace = namespace) {
  return {
    nodeID,
    namespace: brokerNamespace,
    transporter: redisUrl,
    serializer: new RdfJSONSerializer(),
    logger: false,
    heartbeatInterval: 1,
    heartbeatTimeout: 3,
    registry: {
      strategy: 'RoundRobin'
    }
  };
}

async function waitForService(broker, name, timeout = 10000) {
  await broker.waitForServices(name, timeout);
}

async function expectServiceUnavailable(broker) {
  try {
    await broker.call('adsp.p1.rdfProbe.echo', { payload: { value: 'should-not-route' } }, { timeout: 1000 });
  } catch (error) {
    return {
      unavailable: true,
      code: error?.code || error?.name || 'UNKNOWN'
    };
  }
  throw new Error('Expected remote probe service to be unavailable');
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

    const echoed = await caller.call('adsp.p1.rdfProbe.echo', { payload }, { timeout: 5000 });
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

    const isolatedResult = await expectServiceUnavailable(isolated);

    await probeA.stop();
    const unavailableAfterLeave = await expectServiceUnavailable(caller);

    const probeB = new ServiceBroker(brokerOptions('p1-probe-b'));
    probeB.createService(probeService);
    brokers.push(probeB);
    await probeB.start();
    await waitForService(caller, 'adsp.p1.rdfProbe');

    const afterRejoin = await caller.call(
      'adsp.p1.rdfProbe.echo',
      { payload: { marker: 'rejoined' } },
      { timeout: 5000 }
    );
    if (afterRejoin.servedBy !== 'p1-probe-b' || afterRejoin.payload?.marker !== 'rejoined') {
      throw new Error('Registry did not converge to the rejoined service node');
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
          namespaceIsolation: isolatedResult,
          leaveRemovesRoute: unavailableAfterLeave,
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
