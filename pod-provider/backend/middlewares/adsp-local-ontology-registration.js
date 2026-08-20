'use strict';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 25;

function baselinePrefixes(service) {
  const configured = service?.settings?.ontologies;
  if (!Array.isArray(configured)) return [];
  return configured
    .map(ontology => ontology && ontology.prefix)
    .filter(prefix => typeof prefix === 'string' && prefix.length > 0);
}

function isLocalOntologyBaselineReady(service) {
  if (!service?.actions || typeof service.actions.register !== 'function') return false;
  if (!service.ontologies || typeof service.ontologies !== 'object') return false;
  return baselinePrefixes(service).every(prefix => Boolean(service.ontologies[prefix]));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function AdspLocalOntologyRegistrationMiddleware({
  enabled = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS
} = {}) {
  if (!enabled) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('ADSP ontology registration timeout must be positive');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('ADSP ontology registration poll interval must be positive');

  return {
    call(next) {
      const broker = this;
      return async (actionName, params, opts) => {
        if (actionName !== 'ontologies.register') return next(actionName, params, opts);

        const deadline = Date.now() + timeoutMs;
        let local;
        do {
          local = broker.getLocalService('ontologies');
          if (isLocalOntologyBaselineReady(local)) break;
          if (Date.now() >= deadline) {
            throw new Error(
              '[ADSP-P2] Local ontologies baseline did not become ready before distributed registration deadline'
            );
          }
          await delay(pollMs);
        } while (true);

        const localOpts = opts ? { ...opts } : {};
        // A caller may have supplied an explicit endpoint for ordinary broker
        // routing. This middleware's contract is stronger: ontology mutation is
        // broker-local in a replicated Pod cell, so never carry a remote nodeID
        // into the direct local action invocation.
        delete localOpts.nodeID;
        return local.actions.register(params, localOpts);
      };
    }
  };
}

module.exports = AdspLocalOntologyRegistrationMiddleware;
module.exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
module.exports.DEFAULT_POLL_MS = DEFAULT_POLL_MS;
module.exports.baselinePrefixes = baselinePrefixes;
module.exports.isLocalOntologyBaselineReady = isLocalOntologyBaselineReady;
