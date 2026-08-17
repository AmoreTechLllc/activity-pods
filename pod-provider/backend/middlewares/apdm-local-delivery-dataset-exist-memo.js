'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const DATASET_EXIST_ACTION = 'triplestore.dataset.exist';
const DATASET_ACTION_PREFIX = 'triplestore.dataset.';
const LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY = 'semapps-atproto.apdm-p10.local-delivery-scope-runner';

function getDataset(ctx) {
  const dataset = ctx && ctx.params && ctx.params.dataset;
  return typeof dataset === 'string' && dataset.length > 0 && dataset !== '*' ? dataset : undefined;
}

function isDatasetMutation(actionName) {
  return Boolean(
    actionName &&
      actionName.startsWith(DATASET_ACTION_PREFIX) &&
      actionName !== DATASET_EXIST_ACTION &&
      actionName !== 'triplestore.dataset.list'
  );
}

function invalidate(state, dataset) {
  // Advancing the epoch prevents an existence request that began before this
  // mutation from repopulating the memo after the mutation has invalidated it.
  // A single delivery-scoped epoch is intentionally conservative: a mutation
  // to dataset A may stop an in-flight positive probe for dataset B from being
  // memoized, but it can never make B incorrect and the next B check simply
  // reaches Fuseki again.
  state.mutationEpoch += 1;
  if (dataset) state.verifiedDatasets.delete(dataset);
  else state.verifiedDatasets.clear();
}

/**
 * APDM Phase 10 metadata-round-trip reduction.
 *
 * Scope is deliberately created only by the pinned SemApps localPost dispatch
 * seam. Rooting AsyncLocalStorage at activitypub.outbox.post would also leak the
 * memo into unrelated detached work spawned by the outbox action. The optional
 * global runner therefore wraps exactly one localPost invocation and its async
 * descendants; code outside that local-delivery lineage sees no memo state.
 *
 * Rollout is fail-closed. Callers must pass { enabled: true }; omission keeps
 * both the middleware actions and the global scope seam behaviorally inert.
 */
module.exports = ({ enabled = false } = {}) => {
  const storage = new AsyncLocalStorage();
  const runnerKey = Symbol.for(LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY);
  const previousRunner = globalThis[runnerKey];

  // The runner is process-global only because the pinned SemApps localPost seam
  // needs a dependency-free handoff into this middleware. Two owners would make
  // it ambiguous which AsyncLocalStorage scope is authoritative. Refuse that
  // state instead of silently replacing another runner and producing evidence or
  // delivery behavior whose scope cannot be proven.
  if (enabled && previousRunner !== undefined) {
    storage.disable();
    throw new Error('[APDM-P10] Local-delivery scope runner is already installed; refusing ambiguous ownership');
  }

  const scopeRunner = callback => {
    if (typeof callback !== 'function') {
      throw new TypeError('[APDM-P10] Local-delivery scope runner requires a callback');
    }
    return storage.run({ verifiedDatasets: new Set(), mutationEpoch: 0 }, callback);
  };

  if (enabled) globalThis[runnerKey] = scopeRunner;

  return {
    name: 'ApdmLocalDeliveryDatasetExistMemoMiddleware',

    localAction(next, action) {
      if (!enabled) return next;

      if (action.name === DATASET_EXIST_ACTION) {
        return async ctx => {
          const state = storage.getStore();
          const dataset = getDataset(ctx);
          if (!state || !dataset) return next(ctx);

          if (state.verifiedDatasets.has(dataset)) return true;

          const epochAtStart = state.mutationEpoch;
          const exists = await next(ctx);
          if (exists === true && state.mutationEpoch === epochAtStart) state.verifiedDatasets.add(dataset);
          return exists;
        };
      }

      if (isDatasetMutation(action.name)) {
        return async ctx => {
          const state = storage.getStore();
          if (!state) return next(ctx);

          const dataset = getDataset(ctx);
          invalidate(state, dataset);

          try {
            return await next(ctx);
          } finally {
            invalidate(state, dataset);
          }
        };
      }

      return next;
    },

    // Used by focused tests and safe module teardown. Production has one broker
    // middleware instance for the process lifetime, so normal operation never
    // needs to call this explicitly.
    dispose() {
      if (!enabled || globalThis[runnerKey] !== scopeRunner) return;
      delete globalThis[runnerKey];
      storage.disable();
    }
  };
};

module.exports.DATASET_EXIST_ACTION = DATASET_EXIST_ACTION;
module.exports.LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY = LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY;
module.exports.getDataset = getDataset;
module.exports.invalidate = invalidate;
module.exports.isDatasetMutation = isDatasetMutation;
