'use strict';

const DEFAULT_MAX_ACTIONS = 200;

function createCounterState(maxActions) {
  return {
    localExecutions: 0,
    remoteCalls: 0,
    localByAction: new Map(),
    remoteByAction: new Map(),
    maxActions
  };
}

function incrementBounded(map, key, maxActions) {
  if (map.has(key)) {
    map.set(key, map.get(key) + 1);
    return;
  }
  if (map.size < maxActions) map.set(key, 1);
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

module.exports = function AdspActionLocalityMiddleware(options = {}) {
  if (options.enabled !== true) return null;

  const maxActions = Number.isInteger(options.maxActions) && options.maxActions > 0
    ? options.maxActions
    : DEFAULT_MAX_ACTIONS;
  const state = createCounterState(maxActions);

  return {
    name: 'AdspActionLocality',

    created(broker) {
      broker.adspActionLocality = {
        snapshot() {
          return {
            nodeID: broker.nodeID,
            namespace: broker.namespace || null,
            localExecutions: state.localExecutions,
            remoteCalls: state.remoteCalls,
            localByAction: mapToObject(state.localByAction),
            remoteByAction: mapToObject(state.remoteByAction)
          };
        },
        reset() {
          state.localExecutions = 0;
          state.remoteCalls = 0;
          state.localByAction.clear();
          state.remoteByAction.clear();
        }
      };
    },

    localAction(next, action) {
      return function adspLocalityLocalAction(ctx) {
        state.localExecutions += 1;
        incrementBounded(state.localByAction, action.name, state.maxActions);
        return next(ctx);
      };
    },

    remoteAction(next, action) {
      return function adspLocalityRemoteAction(ctx) {
        state.remoteCalls += 1;
        incrementBounded(state.remoteByAction, action.name, state.maxActions);
        return next(ctx);
      };
    }
  };
};
