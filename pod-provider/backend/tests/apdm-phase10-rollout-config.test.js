'use strict';

const fs = require('fs');
const path = require('path');

describe('APDM Phase 10 rollout configuration', () => {
  test('keeps dataset-existence memoization opt-in until the evidence gate is closed', () => {
    const configSource = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8');

    expect(configSource).toContain(
      "process.env.APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED === 'true'"
    );
    expect(configSource).not.toContain(
      "process.env.APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED !== 'false'"
    );
  });
});
