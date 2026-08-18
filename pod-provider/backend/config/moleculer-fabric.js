'use strict';

const RdfJSONSerializer = require('../RdfJSONSerializer');

const MODE_SINGLE = 'single';
const MODE_DISTRIBUTED = 'distributed';
const GROUP_POD_CELL = 'pod-cell';
const GROUP_P1_PROBE = 'p1-probe';

const VALID_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VALID_REDIS_PROTOCOLS = new Set(['redis:', 'rediss:']);

function optionalString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateIdentifier(value, label) {
  if (!VALID_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} must be 1-128 characters and contain only letters, numbers, dot, underscore or hyphen`
    );
  }
  return value;
}

function validateRedisTransporterUrl(value) {
  const explicit = optionalString(value);
  if (!explicit) return undefined;

  let parsed;
  try {
    parsed = new URL(explicit);
  } catch {
    throw new Error('SEMAPPS_REDIS_TRANSPORTER_URL must be a valid redis:// or rediss:// URL');
  }

  if (!VALID_REDIS_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
    throw new Error('SEMAPPS_REDIS_TRANSPORTER_URL must be a valid redis:// or rediss:// URL');
  }

  return explicit;
}

function parseMode(value) {
  const mode = optionalString(value) || MODE_SINGLE;
  if (mode !== MODE_SINGLE && mode !== MODE_DISTRIBUTED) {
    throw new Error(`Unsupported Moleculer fabric mode: ${mode}`);
  }
  return mode;
}

function parseServiceGroup(value) {
  const group = optionalString(value) || GROUP_POD_CELL;
  if (group !== GROUP_POD_CELL && group !== GROUP_P1_PROBE) {
    throw new Error(`Unsupported Moleculer service group: ${group}`);
  }
  return group;
}

function resolveNodeId(mode, value) {
  const explicit = optionalString(value);
  if (mode === MODE_SINGLE) {
    return explicit ? validateIdentifier(explicit, 'Moleculer node ID') : 'pod-provider';
  }
  if (!explicit) {
    throw new Error('Distributed Moleculer mode requires SEMAPPS_MOLECULER_NODE_ID');
  }
  const nodeId = validateIdentifier(explicit, 'Moleculer node ID');
  if (nodeId === 'pod-provider') {
    throw new Error('Distributed Moleculer mode requires a unique node ID, not the single-node default');
  }
  return nodeId;
}

function resolveNamespace(mode, value) {
  const explicit = optionalString(value);
  if (mode === MODE_SINGLE) {
    return explicit ? validateIdentifier(explicit, 'Moleculer namespace') : undefined;
  }
  if (!explicit) {
    throw new Error('Distributed Moleculer mode requires SEMAPPS_MOLECULER_NAMESPACE');
  }
  return validateIdentifier(explicit, 'Moleculer namespace');
}

function resolveServicePatterns(group) {
  if (group === GROUP_POD_CELL) {
    return ['services/*.js', 'services/**/*.js'];
  }
  return ['p1-fixtures/services/*.service.js'];
}

function createMoleculerFabricConfig(env = process.env) {
  const mode = parseMode(env.SEMAPPS_MOLECULER_MODE);
  const serviceGroup = parseServiceGroup(env.SEMAPPS_MOLECULER_SERVICE_GROUP);
  const nodeID = resolveNodeId(mode, env.SEMAPPS_MOLECULER_NODE_ID);
  const namespace = resolveNamespace(mode, env.SEMAPPS_MOLECULER_NAMESPACE);
  const transporterUrl = validateRedisTransporterUrl(env.SEMAPPS_REDIS_TRANSPORTER_URL);

  if (mode === MODE_DISTRIBUTED && !transporterUrl) {
    throw new Error('Distributed Moleculer mode requires SEMAPPS_REDIS_TRANSPORTER_URL in ADSP Phase 1');
  }

  return {
    mode,
    serviceGroup,
    nodeID,
    namespace,
    transporter: transporterUrl,
    // Pin Moleculer's local-first routing contract explicitly. Tightly coupled
    // services that exist inside the same Pod/SemApps cell must never take a
    // remote hop merely because another cell advertises the same action.
    registry: {
      preferLocal: true
    },
    // Keep RDF/JSON-LD serialization semantics identical regardless of whether
    // this broker currently has a transporter. Phase 1 must not couple semantic
    // behavior to the selected transporter technology.
    serializer: new RdfJSONSerializer(),
    servicePatterns: resolveServicePatterns(serviceGroup)
  };
}

module.exports = {
  MODE_SINGLE,
  MODE_DISTRIBUTED,
  GROUP_POD_CELL,
  GROUP_P1_PROBE,
  createMoleculerFabricConfig,
  resolveServicePatterns,
  validateRedisTransporterUrl
};
