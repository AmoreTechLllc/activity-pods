'use strict';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_READINESS_ACTIONS = Object.freeze(['activitypub.outbox.post']);

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

async function waitForBrokerStarted(broker, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (broker?.started !== true) {
    if (broker?.stopping === true) {
      throw new Error('[ADSP-P2] Local Pod-cell broker began stopping before semantic readiness');
    }
    if (Date.now() >= deadline) {
      throw new Error('[ADSP-P2] Local Pod-cell broker did not become ready before distributed action deadline');
    }
    await delay(pollMs);
  }
}

function AdspLocalOntologyRegistrationMiddleware({
  enabled = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  readinessActions = DEFAULT_READINESS_ACTIONS
} = {}) {
  if (!enabled) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('ADSP ontology registration timeout must be positive');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('ADSP ontology registration poll interval must be positive');
  if (!Array.isArray(readinessActions) || readinessActions.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error('ADSP readiness actions must be an array of non-empty action names');
  }
  const guardedActions = new Set(readinessActions);

  // Moleculer broker-method wrapper hooks do not bind `this` to the broker.
  // Capture the authoritative local broker through the documented middleware
  // lifecycle hook instead, then close over it from broker.call/localAction.
  let broker;

  function requireBroker() {
    if (!broker) {
      throw new Error('[ADSP-P2] Local ontology registration middleware broker is not initialized');
    }
    return broker;
  }

  return {
    created(localBroker) {
      if (!localBroker || typeof localBroker.getLocalService !== 'function') {
        throw new Error('[ADSP-P2] Local ontology registration middleware requires a Moleculer broker');
      }
      broker = localBroker;
    },

    call(next) {
      return async (actionName, params, opts) => {
        if (actionName !== 'ontologies.register') return next(actionName, params, opts);
        const localBroker = requireBroker();

        const deadline = Date.now() + timeoutMs;
        let local;
        do {
          local = localBroker.getLocalService('ontologies');
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
    },

    localAction(next, action) {
      if (!guardedActions.has(action?.name)) return next;
      return async ctx => {
        const localBroker = requireBroker();
        // Moleculer connects the transporter before all local service started()
        // hooks complete. A restarted Pod cell can therefore be discoverable by
        // siblings while its broker-local semantic state is still being built.
        // Hold only externally dispatchable root work until Moleculer's own
        // lifecycle confirms every local service finished starting. This keeps
        // ontology bootstrap calls unblocked and avoids a startup deadlock.
        await waitForBrokerStarted(localBroker, timeoutMs, pollMs);
        return next(ctx);
      };
    }
  };
}

module.exports = AdspLocalOntologyRegistrationMiddleware;
module.exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
module.exports.DEFAULT_POLL_MS = DEFAULT_POLL_MS;
module.exports.DEFAULT_READINESS_ACTIONS = DEFAULT_READINESS_ACTIONS;
module.exports.baselinePrefixes = baselinePrefixes;
module.exports.isLocalOntologyBaselineReady = isLocalOntologyBaselineReady;
module.exports.waitForBrokerStarted = waitForBrokerStarted;
