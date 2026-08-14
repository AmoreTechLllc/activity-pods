'use strict';

const fs = require('fs');
const path = require('path');
const {
  assertUsableRecord,
  boundedMap,
  createBenchmarkUsername,
  isUsernameNotAllowed,
  normalizeRunId,
  positiveInteger,
  signupWithCandidateRetries
} = require('../scripts/apdm-phase8-real-measure');

const RUNNER_SOURCE = fs.readFileSync(path.join(__dirname, '../scripts/apdm-phase8-real-measure.js'), 'utf8');

describe('APDM Phase 8 real measurement runner', () => {
  test('normalizes run IDs into bounded signup-safe prefixes', () => {
    expect(normalizeRunId('31834711667-2')).toMatch(/^p8[a-z0-9]+$/u);
    expect(normalizeRunId('31834711667-2').length).toBeLessThanOrEqual(12);
  });

  test('generates bounded distinct benchmark username candidates', () => {
    const first = createBenchmarkUsername({ runId: '31834711667-2', role: 'recipient', index: 7, attempt: 0 });
    const second = createBenchmarkUsername({ runId: '31834711667-2', role: 'recipient', index: 7, attempt: 1 });
    const otherRecipient = createBenchmarkUsername({ runId: '31834711667-2', role: 'recipient', index: 8, attempt: 0 });
    const sender = createBenchmarkUsername({ runId: '31834711667-2', role: 'sender' });

    expect(first).toMatch(/^p8mr[a-f0-9]{16}$/u);
    expect(sender).toMatch(/^p8ms[a-f0-9]{16}$/u);
    expect(first).not.toBe(second);
    expect(first).not.toBe(otherRecipient);
  });

  test('recognizes only the normal username-moderation rejection as candidate-regenerable', () => {
    const moderationError = Object.assign(new Error('username is not available'), {
      status: 422,
      body: { type: 'USERNAME_NOT_ALLOWED' }
    });
    const other422 = Object.assign(new Error('other validation'), { status: 422, body: { type: 'OTHER' } });

    expect(isUsernameNotAllowed(moderationError)).toBe(true);
    expect(isUsernameNotAllowed(other422)).toBe(false);
  });

  test('regenerates a fresh username after deterministic pre-commit moderation rejection', async () => {
    const attempted = [];
    const signupFn = async (_baseUrl, username) => {
      attempted.push(username);
      if (attempted.length === 1) {
        throw Object.assign(new Error('This username is not available.'), {
          status: 422,
          body: { type: 'USERNAME_NOT_ALLOWED' }
        });
      }
      return { username, webId: `http://localhost:3000/${username}` };
    };

    await expect(
      signupWithCandidateRetries({
        baseUrl: 'http://localhost:3000',
        password: 'unused',
        runId: 'run-1',
        role: 'recipient',
        index: 7,
        maxAttempts: 3,
        signupFn
      })
    ).resolves.toMatchObject({ webId: expect.stringContaining('http://localhost:3000/') });

    expect(attempted).toHaveLength(2);
    expect(attempted[0]).not.toBe(attempted[1]);
  });

  test('does not regenerate after an ambiguous non-idempotent signup result', async () => {
    const signupFn = jest.fn(async () => {
      throw Object.assign(new Error('socket timed out after account may have committed'), { ambiguous: true });
    });

    await expect(
      signupWithCandidateRetries({
        baseUrl: 'http://localhost:3000',
        password: 'unused',
        runId: 'run-1',
        role: 'recipient',
        index: 7,
        maxAttempts: 3,
        signupFn
      })
    ).rejects.toThrow('socket timed out');
    expect(signupFn).toHaveBeenCalledTimes(1);
  });

  test('signup implementation uses a single non-replayable request path', () => {
    expect(RUNNER_SOURCE).toContain('async function requestJsonOnce');
    expect(RUNNER_SOURCE).toContain('const body = await requestJsonOnce');
    expect(RUNNER_SOURCE).not.toContain('requestJsonWithRetry');
    expect(RUNNER_SOURCE).toContain('Never replay 5xx/408/429');
  });

  test('does not regenerate on unrelated signup failures', async () => {
    const signupFn = jest.fn(async () => {
      throw Object.assign(new Error('email rejected'), { status: 422, body: { type: 'EMAIL_INVALID' } });
    });

    await expect(
      signupWithCandidateRetries({
        baseUrl: 'http://localhost:3000',
        password: 'unused',
        runId: 'run-1',
        role: 'recipient',
        index: 7,
        maxAttempts: 3,
        signupFn
      })
    ).rejects.toThrow('email rejected');
    expect(signupFn).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid positive-integer settings', () => {
    expect(positiveInteger('3', 1, 'samples')).toBe(3);
    expect(() => positiveInteger('0', 1, 'samples')).toThrow('samples must be a positive integer');
    expect(() => positiveInteger('1.5', 1, 'samples')).toThrow('samples must be a positive integer');
  });

  test('boundedMap preserves input ordering while limiting active workers', async () => {
    let active = 0;
    let peak = 0;
    const results = await boundedMap([1, 2, 3, 4, 5], 2, async value => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('refuses mislabeled or partial-failure measurement records', () => {
    expect(() => assertUsableRecord({ phase: 'APDM-P8-A', recipientCount: 10, errors: [] }, 10)).not.toThrow();
    expect(() => assertUsableRecord({ phase: 'APDM-P8-A', recipientCount: 1, errors: [] }, 10)).toThrow('does not match');
    expect(() =>
      assertUsableRecord(
        {
          phase: 'APDM-P8-A',
          recipientCount: 10,
          errors: [{ source: 'detached-local-delivery-count-mismatch', expectedRecipientCount: 10, successfulRecipientCount: 9 }]
        },
        10
      )
    ).toThrow('contains delivery/instrumentation errors');
  });
});
