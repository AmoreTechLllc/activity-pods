'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertUsableRecord,
  createMeasurementRequestId,
  postMeasuredActivity,
  waitForRecordByRequestId
} = require('../scripts/apdm-phase8-real-measure');

describe('APDM Phase 8 exact request correlation', () => {
  test('measured posts supply a unique Moleculer requestID that instrumentation records', async () => {
    const broker = {
      call: jest.fn(async () => ({ id: 'https://example.test/activities/1' }))
    };
    const manifest = {
      runId: 'run-123',
      sender: {
        outbox: 'https://example.test/users/sender/outbox',
        webId: 'https://example.test/users/sender',
        username: 'sender'
      }
    };
    const recipients = [{ webId: 'https://example.test/users/recipient' }];

    const first = await postMeasuredActivity(broker, manifest, recipients, 'sample-1-1');
    const second = await postMeasuredActivity(broker, manifest, recipients, 'sample-1-1');

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId).toMatch(/^apdm-p8-/u);
    expect(broker.call).toHaveBeenNthCalledWith(
      1,
      'activitypub.outbox.post',
      expect.objectContaining({
        collectionUri: manifest.sender.outbox,
        to: [recipients[0].webId]
      }),
      expect.objectContaining({
        requestID: first.requestId,
        meta: { webId: manifest.sender.webId, dataset: manifest.sender.username }
      })
    );
  });

  test('request IDs contain run/label identity plus fresh entropy', () => {
    const requestId = createMeasurementRequestId({ runId: '31898032541-1' }, 'warmup-100-1');
    expect(requestId).toMatch(/^apdm-p8-p8[0-9a-z]+-warmup-100-1-[0-9a-f]{16}$/u);
  });

  test('waits for the exact request record rather than accepting another root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-correlation-'));
    const outputPath = path.join(dir, 'trace.jsonl');
    fs.writeFileSync(
      outputPath,
      `${JSON.stringify({ phase: 'APDM-P8-A', requestId: 'unrelated-root', recipientCount: 1, errors: [] })}\n`,
      'utf8'
    );

    setTimeout(() => {
      fs.appendFileSync(
        outputPath,
        `${JSON.stringify({ phase: 'APDM-P8-A', requestId: 'benchmark-root', recipientCount: 1, errors: [] })}\n`,
        'utf8'
      );
    }, 10);

    const record = await waitForRecordByRequestId(outputPath, 'benchmark-root', 1000);
    expect(record.requestId).toBe('benchmark-root');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('usable-record validation rejects a trace from the wrong request', () => {
    expect(() =>
      assertUsableRecord(
        { phase: 'APDM-P8-A', requestId: 'other-root', recipientCount: 10, errors: [] },
        10,
        'benchmark-root'
      )
    ).toThrow(/does not match benchmark-root/u);
  });
});