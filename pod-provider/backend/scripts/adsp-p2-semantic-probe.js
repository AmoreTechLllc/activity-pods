'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const {
  DEFAULT_DISTRIBUTED_HEARTBEAT_INTERVAL,
  DEFAULT_DISTRIBUTED_HEARTBEAT_TIMEOUT
} = require('../config/moleculer-fabric');

const DEFAULT_TRANSPORTER_URL = 'redis://redis:6379/12';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const ACTIVITYSTREAMS_CONTEXT_URI = 'https://www.w3.org/ns/activitystreams';
const ACTIVITYSTREAMS_NAMESPACE = 'https://www.w3.org/ns/activitystreams#';
const ACTIVITYSTREAMS_REQUIRED_TYPES = [
  'Activity',
  'Application',
  'Article',
  'Audio',
  'Collection',
  'CollectionPage',
  'Relationship',
  'Document',
  'Event',
  'Group',
  'Image',
  'IntransitiveActivity',
  'Note',
  'Object',
  'OrderedCollection',
  'OrderedCollectionPage',
  'Organization',
  'Page',
  'Person',
  'Place',
  'Profile',
  'Question',
  'Service',
  'Tombstone',
  'Video',
  'Accept',
  'Add',
  'Announce',
  'Arrive',
  'Block',
  'Create',
  'Delete',
  'Dislike',
  'Follow',
  'Flag',
  'Ignore',
  'Invite',
  'Join',
  'Leave',
  'Like',
  'Listen',
  'Move',
  'Offer',
  'Read',
  'Reject',
  'Remove',
  'TentativeAccept',
  'TentativeReject',
  'Travel',
  'Undo',
  'Update',
  'View',
  'Link',
  'Mention',
  'IsFollowing',
  'IsFollowedBy',
  'IsContact',
  'IsMember'
];
const EXPECTED_NODES = [
  'adsp-p2-pod-cell-1',
  'adsp-p2-pod-cell-2',
  'adsp-p2-pod-cell-3',
  'adsp-p2-pod-cell-4'
];
const REQUIRED_ACTIONS = [
  'ontologies.list',
  'jsonld.context.get',
  'jsonld.context.getLocal',
  'jsonld.document-loader.getCache',
  'jsonld.parser.expandTypes'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function errorRecord(error) {
  return {
    name: error?.name || null,
    type: error?.type || null,
    code: error?.code || null,
    message: error?.message || String(error)
  };
}

function endpointNodes(broker, actionName) {
  const endpoints = broker.registry.getActionEndpoints(actionName);
  if (!endpoints) return [];
  const nodes = new Set();
  for (const endpoint of endpoints.endpoints || []) {
    const nodeID = endpoint?.id || endpoint?.node?.id || endpoint?.nodeID;
    if (nodeID) nodes.add(nodeID);
  }
  return [...nodes].sort();
}

async function waitForExactActionNodes(broker, actionName, expectedNodes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const expected = [...expectedNodes].sort();
  while (Date.now() < deadline) {
    const actual = endpointNodes(broker, actionName);
    if (actual.length === expected.length && actual.every((node, index) => node === expected[index])) return actual;
    await sleep(50);
  }
  throw new Error(
    `Timed out waiting for ${actionName} on exact nodes ${expected.join(', ')}; observed ${endpointNodes(broker, actionName).join(', ')}`
  );
}

function containsActivityStreamsUri(value) {
  if (value === ACTIVITYSTREAMS_CONTEXT_URI) return true;
  if (Array.isArray(value)) return value.some(containsActivityStreamsUri);
  if (value && typeof value === 'object') return Object.values(value).some(containsActivityStreamsUri);
  return false;
}

function containsActivityStreamsTerm(value, term) {
  const expanded = `${ACTIVITYSTREAMS_NAMESPACE}${term}`;
  if (value === term || value === `as:${term}` || value === expanded) return true;
  if (Array.isArray(value)) return value.some(entry => containsActivityStreamsTerm(entry, term));
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, term)) return true;
    return Object.entries(value).some(([key, entry]) => key === term || containsActivityStreamsTerm(entry, term));
  }
  return false;
}

function containsNoteTerm(value) {
  return containsActivityStreamsTerm(value, 'Note');
}

function expectedExpandedTypes(types = ACTIVITYSTREAMS_REQUIRED_TYPES) {
  return types.map(type => `${ACTIVITYSTREAMS_NAMESPACE}${type}`);
}

function summarizeOntologies(ontologies) {
  const list = Array.isArray(ontologies) ? ontologies : [];
  const prefixes = list.map(item => item?.prefix).filter(Boolean).sort();
  const activityStreams = list.find(item => item?.prefix === 'as') || null;
  return {
    count: list.length,
    prefixes,
    hasActivityStreamsOntology: Boolean(activityStreams),
    activityStreamsOntology: activityStreams
      ? {
          prefix: activityStreams.prefix || null,
          namespace: activityStreams.namespace || null,
          jsonldContext: activityStreams.jsonldContext || null,
          preserveContextUri: activityStreams.preserveContextUri === true
        }
      : null
  };
}

function summarizeContext(context) {
  return {
    present: context !== undefined && context !== null,
    includesActivityStreamsContextUri: containsActivityStreamsUri(context),
    topLevelKind: Array.isArray(context) ? 'array' : typeof context,
    topLevelLength: Array.isArray(context) ? context.length : null
  };
}

function summarizeCachedDocument(document) {
  const missingRequiredTypes = ACTIVITYSTREAMS_REQUIRED_TYPES.filter(
    type => !containsActivityStreamsTerm(document, type)
  );
  return {
    present: document !== undefined && document !== null,
    topLevelKind: Array.isArray(document) ? 'array' : typeof document,
    topLevelKeys: document && typeof document === 'object' && !Array.isArray(document)
      ? Object.keys(document).sort().slice(0, 50)
      : [],
    hasContextKey: Boolean(document && typeof document === 'object' && Object.prototype.hasOwnProperty.call(document, '@context')),
    requiredTypeCount: ACTIVITYSTREAMS_REQUIRED_TYPES.length,
    missingRequiredTypes,
    containsAllRequiredTypes: missingRequiredTypes.length === 0,
    containsNoteTerm: containsActivityStreamsTerm(document, 'Note'),
    containsArticleTerm: containsActivityStreamsTerm(document, 'Article')
  };
}

function summarizeExpandedTypes(value) {
  const expected = expectedExpandedTypes();
  const actual = Array.isArray(value) ? value : [];
  const mismatches = ACTIVITYSTREAMS_REQUIRED_TYPES.filter((type, index) => actual[index] !== expected[index]);
  return {
    ok: true,
    value: actual,
    expected,
    requiredTypeCount: ACTIVITYSTREAMS_REQUIRED_TYPES.length,
    expandsAllRequiredTypes: actual.length === expected.length && mismatches.length === 0,
    mismatches,
    expandsToActivityStreamsNote:
      actual[ACTIVITYSTREAMS_REQUIRED_TYPES.indexOf('Note')] === `${ACTIVITYSTREAMS_NAMESPACE}Note`,
    expandsToActivityStreamsArticle:
      actual[ACTIVITYSTREAMS_REQUIRED_TYPES.indexOf('Article')] === `${ACTIVITYSTREAMS_NAMESPACE}Article`
  };
}

async function pinnedCall(broker, nodeID, actionName, params, timeoutMs) {
  try {
    const value = await broker.call(actionName, params || {}, { nodeID, timeout: timeoutMs });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorRecord(error) };
  }
}

async function probeNode(broker, nodeID, timeoutMs) {
  const ontologyCall = await pinnedCall(broker, nodeID, 'ontologies.list', {}, timeoutMs);
  const contextCall = await pinnedCall(broker, nodeID, 'jsonld.context.get', {}, timeoutMs);
  const localContextCall = await pinnedCall(broker, nodeID, 'jsonld.context.getLocal', {}, timeoutMs);
  const cacheCall = await pinnedCall(
    broker,
    nodeID,
    'jsonld.document-loader.getCache',
    { uri: ACTIVITYSTREAMS_CONTEXT_URI },
    timeoutMs
  );
  const expandCall = await pinnedCall(
    broker,
    nodeID,
    'jsonld.parser.expandTypes',
    { types: ACTIVITYSTREAMS_REQUIRED_TYPES },
    timeoutMs
  );

  return {
    nodeID,
    observedAt: new Date().toISOString(),
    ontologies: ontologyCall.ok ? { ok: true, ...summarizeOntologies(ontologyCall.value) } : ontologyCall,
    context: contextCall.ok ? { ok: true, ...summarizeContext(contextCall.value) } : contextCall,
    localContext: localContextCall.ok ? { ok: true, ...summarizeContext(localContextCall.value) } : localContextCall,
    activityStreamsCache: cacheCall.ok ? { ok: true, ...summarizeCachedDocument(cacheCall.value) } : cacheCall,
    expandActivityStreamsTypes: expandCall.ok ? summarizeExpandedTypes(expandCall.value) : expandCall
  };
}

function semanticProbePasses(node) {
  return Boolean(
    node.ontologies?.ok &&
      node.ontologies.hasActivityStreamsOntology &&
      node.context?.ok &&
      node.context.includesActivityStreamsContextUri &&
      node.localContext?.ok &&
      node.activityStreamsCache?.ok &&
      node.activityStreamsCache.present &&
      node.activityStreamsCache.containsAllRequiredTypes &&
      node.expandActivityStreamsTypes?.ok &&
      node.expandActivityStreamsTypes.expandsAllRequiredTypes &&
      node.expandActivityStreamsTypes.expandsToActivityStreamsNote &&
      node.expandActivityStreamsTypes.expandsToActivityStreamsArticle
  );
}

async function startBrokerWithin(broker, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      broker.start(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out starting semantic-probe broker after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopBrokerWithin(broker, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  let timer;
  try {
    await Promise.race([
      broker.stop(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out stopping semantic-probe broker after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runProbe({ namespace, transporterUrl, timeoutMs = DEFAULT_TIMEOUT_MS, nodes = EXPECTED_NODES }) {
  const broker = new ServiceBroker({
    nodeID: `adsp-p2-semantic-probe-${process.pid}-${Date.now()}`,
    namespace,
    transporter: transporterUrl || DEFAULT_TRANSPORTER_URL,
    serializer: new RdfJSONSerializer(),
    logger: false,
    requestTimeout: timeoutMs,
    retryPolicy: { enabled: false },
    heartbeatInterval: DEFAULT_DISTRIBUTED_HEARTBEAT_INTERVAL,
    heartbeatTimeout: DEFAULT_DISTRIBUTED_HEARTBEAT_TIMEOUT,
    registry: { preferLocal: true }
  });

  let startAttempted = false;
  try {
    startAttempted = true;
    await startBrokerWithin(broker, timeoutMs);
    for (const actionName of REQUIRED_ACTIONS) {
      await waitForExactActionNodes(broker, actionName, nodes, timeoutMs);
    }
    const nodeResults = [];
    for (const nodeID of nodes) nodeResults.push(await probeNode(broker, nodeID, timeoutMs));
    return {
      version: 2,
      phase: 'ADSP-P2-SEMANTIC-PROBE',
      complete: true,
      passed: nodeResults.every(semanticProbePasses),
      activityStreamsContextUri: ACTIVITYSTREAMS_CONTEXT_URI,
      activityStreamsRequiredTypes: ACTIVITYSTREAMS_REQUIRED_TYPES,
      nodes: nodeResults
    };
  } finally {
    if (startAttempted) {
      try {
        await stopBrokerWithin(broker);
      } catch {
        // The primary probe/start error remains authoritative, and cleanup is bounded.
      }
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const outputPath = path.resolve(argv[0] || '');
  if (!argv[0]) throw new Error('Usage: adsp-p2-semantic-probe.js <output.json>');
  const namespace = process.env.SEMAPPS_MOLECULER_NAMESPACE || process.env.ADSP_P2_NAMESPACE;
  if (!namespace) throw new Error('ADSP P2 semantic probe requires an explicit Moleculer namespace');
  const timeoutMs = positiveInteger(process.env.ADSP_P2_SEMANTIC_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 'semantic probe timeout');
  const result = await runProbe({
    namespace,
    transporterUrl: process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL,
    timeoutMs
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_STOP_TIMEOUT_MS,
  ACTIVITYSTREAMS_CONTEXT_URI,
  ACTIVITYSTREAMS_NAMESPACE,
  ACTIVITYSTREAMS_REQUIRED_TYPES,
  EXPECTED_NODES,
  REQUIRED_ACTIONS,
  containsActivityStreamsUri,
  containsActivityStreamsTerm,
  containsNoteTerm,
  expectedExpandedTypes,
  summarizeOntologies,
  summarizeContext,
  summarizeCachedDocument,
  summarizeExpandedTypes,
  semanticProbePasses,
  startBrokerWithin,
  stopBrokerWithin,
  runProbe
};
