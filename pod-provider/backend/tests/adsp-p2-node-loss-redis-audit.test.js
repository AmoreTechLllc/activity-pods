'use strict';

const { auditRedisCommandstats } = require('../scripts/adsp-p2-node-loss-redis-audit');

describe('ADSP P2 node-loss Redis commandstats audit', () => {
  test('accepts additive Redis 8 fields while requiring zero failed/rejected calls', () => {
    const audit = auditRedisCommandstats(`# Commandstats\ncmdstat_get:calls=12,usec=20,usec_per_call=1.67,rejected_calls=0,failed_calls=0\ncmdstat_scan:calls=3,usec=30,usec_per_call=10.00,rejected_calls=0,failed_calls=0,extra_future_field=9\n`);
    expect(audit.passed).toBe(true);
    expect(audit.totals).toMatchObject({ calls: 15, rejectedCalls: 0, failedCalls: 0 });
    expect(audit.failures).toEqual([]);
  });

  test('fails closed on any Redis failed or rejected command', () => {
    const audit = auditRedisCommandstats(`# Commandstats\ncmdstat_get:calls=4,usec=8,usec_per_call=2.00,rejected_calls=1,failed_calls=0\ncmdstat_set:calls=5,usec=10,usec_per_call=2.00,rejected_calls=0,failed_calls=2\n`);
    expect(audit.passed).toBe(false);
    expect(audit.totals.rejectedCalls).toBe(1);
    expect(audit.totals.failedCalls).toBe(2);
    expect(audit.failures).toHaveLength(2);
  });

  test('inherits the strict authoritative parser for malformed evidence', () => {
    expect(() => auditRedisCommandstats(`# Commandstats\ncmdstat_get:calls=4,usec=8,rejected_calls=0\n`)).toThrow(/missing failed_calls/u);
    expect(() => auditRedisCommandstats(`cmdstat_get:calls=4,usec=8,rejected_calls=0,failed_calls=0\n`)).toThrow(/missing # Commandstats header/u);
  });
});
