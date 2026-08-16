'use strict';

const createMiddleware = require('../middlewares/apdm-local-delivery-dataset-exist-memo');
const {
  DATASET_EXIST_ACTION,
  LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY
} = require('../middlewares/apdm-local-delivery-dataset-exist-memo');

function action(name) {
  return { name };
}

function ctx(dataset) {
  return { params: dataset === undefined ? {} : { dataset } };
}

describe('APDM Phase 10 localPost scope isolation', () => {
  test('nested localPost scopes are independent and restore the outer scope afterwards', async () => {
    const middleware = createMiddleware({ enabled: true });
    const runner = globalThis[Symbol.for(LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY)];
    const actualExist = jest.fn(async () => true);
    const exist = middleware.localAction(actualExist, action(DATASET_EXIST_ACTION));

    try {
      await runner(async () => {
        await exist(ctx('alice'));
        await exist(ctx('alice'));

        await runner(async () => {
          await exist(ctx('alice'));
          await exist(ctx('alice'));
        });

        // AsyncLocalStorage restores the outer localPost scope after the nested
        // scope resolves, so this remains an outer-scope memo hit.
        await exist(ctx('alice'));
      });

      expect(actualExist).toHaveBeenCalledTimes(2);
    } finally {
      middleware.dispose();
    }
  });

  test('unrelated outbox descendants are not scoped unless the localPost seam invokes the runner', async () => {
    const middleware = createMiddleware({ enabled: true });
    const actualExist = jest.fn(async () => true);
    const exist = middleware.localAction(actualExist, action(DATASET_EXIST_ACTION));

    try {
      await exist(ctx('alice'));
      await exist(ctx('alice'));
      expect(actualExist).toHaveBeenCalledTimes(2);
    } finally {
      middleware.dispose();
    }
  });
});
