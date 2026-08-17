'use strict';

const createMiddleware = require('../middlewares/apdm-local-delivery-dataset-exist-memo');
const {
  DATASET_EXIST_ACTION,
  LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY,
  getDataset,
  isDatasetMutation
} = require('../middlewares/apdm-local-delivery-dataset-exist-memo');

function action(name) {
  return { name };
}

function ctx(dataset) {
  return { params: dataset === undefined ? {} : { dataset } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const createdMiddlewares = [];
function createEnabledMiddleware() {
  const middleware = createMiddleware({ enabled: true });
  createdMiddlewares.push(middleware);
  return middleware;
}

function runLocalDelivery(callback) {
  const runner = globalThis[Symbol.for(LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY)];
  if (typeof runner !== 'function') throw new Error('Phase 10 local-delivery scope runner is not installed');
  return runner(callback);
}

afterEach(() => {
  while (createdMiddlewares.length > 0) createdMiddlewares.pop().dispose();
});

describe('APDM Phase 10 delivery-scoped dataset existence memo', () => {
  test('recognizes only concrete dataset names', () => {
    expect(getDataset(ctx('alice'))).toBe('alice');
    expect(getDataset(ctx('*'))).toBeUndefined();
    expect(getDataset(ctx(''))).toBeUndefined();
    expect(getDataset(ctx())).toBeUndefined();
  });

  test('treats real dataset management actions as invalidating mutations', () => {
    expect(isDatasetMutation('triplestore.dataset.create')).toBe(true);
    expect(isDatasetMutation('triplestore.dataset.delete')).toBe(true);
    expect(isDatasetMutation(DATASET_EXIST_ACTION)).toBe(false);
    expect(isDatasetMutation('triplestore.dataset.list')).toBe(false);
    expect(isDatasetMutation('triplestore.query')).toBe(false);
  });

  test('memoizes only a positive result inside one localPost lineage, including detached descendants', async () => {
    const middleware = createEnabledMiddleware();
    const actualExist = jest.fn(async () => true);
    const exist = middleware.localAction(actualExist, action(DATASET_EXIST_ACTION));

    let detached;
    await runLocalDelivery(async () => {
      await exist(ctx('alice'));
      await exist(ctx('alice'));
      detached = new Promise((resolve, reject) => {
        setImmediate(async () => {
          try {
            await exist(ctx('alice'));
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    });
    await detached;

    expect(actualExist).toHaveBeenCalledTimes(1);
  });

  test('never shares a positive memo across separate localPost invocations', async () => {
    const middleware = createEnabledMiddleware();
    const actualExist = jest.fn(async () => true);
    const exist = middleware.localAction(actualExist, action(DATASET_EXIST_ACTION));

    const delivery = async () => {
      await exist(ctx('alice'));
      await exist(ctx('alice'));
    };
    await runLocalDelivery(delivery);
    await runLocalDelivery(delivery);

    expect(actualExist).toHaveBeenCalledTimes(2);
  });

  test('does not memoize false results or errors', async () => {
    const middleware = createEnabledMiddleware();
    const falseExist = jest.fn(async () => false);
    const falseHandler = middleware.localAction(falseExist, action(DATASET_EXIST_ACTION));

    await runLocalDelivery(async () => {
      expect(await falseHandler(ctx('missing'))).toBe(false);
      expect(await falseHandler(ctx('missing'))).toBe(false);
    });
    expect(falseExist).toHaveBeenCalledTimes(2);

    const error = new Error('Fuseki unavailable');
    const errorExist = jest.fn(async () => {
      throw error;
    });
    const errorHandler = middleware.localAction(errorExist, action(DATASET_EXIST_ACTION));

    await runLocalDelivery(async () => {
      await expect(errorHandler(ctx('alice'))).rejects.toBe(error);
      await expect(errorHandler(ctx('alice'))).rejects.toBe(error);
    });
    expect(errorExist).toHaveBeenCalledTimes(2);
  });

  test('invalidates a memo before and after dataset-management actions', async () => {
    const middleware = createEnabledMiddleware();
    const actualExist = jest.fn(async () => true);
    const exist = middleware.localAction(actualExist, action(DATASET_EXIST_ACTION));
    const mutate = middleware.localAction(jest.fn(async () => 'changed'), action('triplestore.dataset.create'));

    await runLocalDelivery(async () => {
      await exist(ctx('alice'));
      await exist(ctx('alice'));
      await mutate(ctx('alice'));
      await exist(ctx('alice'));
    });
    expect(actualExist).toHaveBeenCalledTimes(2);
  });

  test('does not let an older in-flight existence probe repopulate after a mutation', async () => {
    const middleware = createEnabledMiddleware();
    const firstProbe = deferred();
    let callCount = 0;
    const actualExist = jest.fn(async () => {
      callCount += 1;
      if (callCount === 1) return firstProbe.promise;
      return true;
    });
    const exist = middleware.localAction(actualExist, action(DATASET_EXIST_ACTION));
    const mutate = middleware.localAction(jest.fn(async () => 'deleted'), action('triplestore.dataset.delete'));

    await runLocalDelivery(async () => {
      const staleProbe = exist(ctx('alice'));
      await mutate(ctx('alice'));
      firstProbe.resolve(true);
      await expect(staleProbe).resolves.toBe(true);
      await expect(exist(ctx('alice'))).resolves.toBe(true);
      await expect(exist(ctx('alice'))).resolves.toBe(true);
    });

    expect(actualExist).toHaveBeenCalledTimes(2);
  });

  test('keeps the memo invalidated when a dataset mutation throws', async () => {
    const middleware = createEnabledMiddleware();
    const actualExist = jest.fn(async () => true);
    const exist = middleware.localAction(actualExist, action(DATASET_EXIST_ACTION));
    const mutationError = new Error('dataset create failed');
    const mutate = middleware.localAction(
      jest.fn(async () => {
        throw mutationError;
      }),
      action('triplestore.dataset.create')
    );

    await runLocalDelivery(async () => {
      await exist(ctx('alice'));
      await expect(mutate(ctx('alice'))).rejects.toBe(mutationError);
      await exist(ctx('alice'));
    });
    expect(actualExist).toHaveBeenCalledTimes(2);
  });

  test('clears all verified datasets for an unscoped dataset-management mutation', async () => {
    const middleware = createEnabledMiddleware();
    const actualExist = jest.fn(async () => true);
    const exist = middleware.localAction(actualExist, action(DATASET_EXIST_ACTION));
    const mutateAll = middleware.localAction(jest.fn(async () => 'changed'), action('triplestore.dataset.delete'));

    await runLocalDelivery(async () => {
      await exist(ctx('alice'));
      await exist(ctx('bob'));
      await exist(ctx('alice'));
      await exist(ctx('bob'));
      await mutateAll(ctx());
      await exist(ctx('alice'));
      await exist(ctx('bob'));
    });
    expect(actualExist).toHaveBeenCalledTimes(4);
  });

  test('is inert by default and outside an enabled localPost lineage', async () => {
    const defaultActualExist = jest.fn(async () => true);
    const defaultMiddleware = createMiddleware();
    const defaultExist = defaultMiddleware.localAction(defaultActualExist, action(DATASET_EXIST_ACTION));
    await defaultExist(ctx('alice'));
    await defaultExist(ctx('alice'));
    expect(defaultActualExist).toHaveBeenCalledTimes(2);

    const enabled = createEnabledMiddleware();
    const outsideActualExist = jest.fn(async () => true);
    const outsideExist = enabled.localAction(outsideActualExist, action(DATASET_EXIST_ACTION));
    await outsideExist(ctx('alice'));
    await outsideExist(ctx('alice'));
    expect(outsideActualExist).toHaveBeenCalledTimes(2);
  });
});
