'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readEpochMarker,
  runRemovalClock,
  waitForEndpointCountUntil
} = require('../scripts/adsp-p2-node-loss-removal-clock');

function makeBroker(counts) {
  let index = 0;
  return {
    registry: {
      getActionEndpoints() {
        const value = counts[Math.min(index, counts.length - 1)];
        index += 1;
        return { count: () => value };
      }
    }
  };
}

describe('ADSP P2 node-loss removal clock', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-removal-clock-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('reads positive integer epoch markers and rejects malformed evidence', () => {
    fs.writeFileSync(path.join(tempDir, 'ok'), '12345\n');
    expect(readEpochMarker(tempDir, 'ok')).toBe(12345);
    fs.writeFileSync(path.join(tempDir, 'bad'), 'not-a-time\n');
    expect(() => readEpochMarker(tempDir, 'bad')).toThrow(/positive integer epoch/u);
  });

  test('waits for endpoint convergence against an absolute deadline', async () => {
    const observed = await waitForEndpointCountUntil(makeBroker([4, 4, 3]), 3, Date.now() + 1000, 1);
    expect(observed).toBeGreaterThan(0);
  });

  test('fails closed when endpoint convergence misses the absolute deadline', async () => {
    await expect(waitForEndpointCountUntil(makeBroker([4]), 3, Date.now() + 5, 1)).rejects.toThrow(
      /absolute deadline/u
    );
  });

  test('measures from the pre-SIGKILL fault epoch rather than observation time', async () => {
    const barrierDir = path.join(tempDir, 'barrier');
    fs.mkdirSync(barrierDir, { recursive: true });
    const outputPath = path.join(tempDir, 'result.json');
    const faultStartEpochMs = Date.now() - 25;
    fs.writeFileSync(path.join(barrierDir, 'fault-start'), `${faultStartEpochMs}\n`);

    const broker = makeBroker([4, 3]);
    const result = await runRemovalClock({
      broker,
      barrierDir,
      outputPath,
      recoveryBoundMs: 1000,
      readyTimeoutMs: 1000
    });

    expect(result.complete).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.faultStartEpochMs).toBe(faultStartEpochMs);
    expect(result.endpointRemovalMs).toBeGreaterThanOrEqual(25);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).clockScope).toBe(
      'pre-sigkill-fault-start-to-moleculer-endpoint-removal'
    );
  });
});
