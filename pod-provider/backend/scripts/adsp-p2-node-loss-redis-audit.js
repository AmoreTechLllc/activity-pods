'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseRedisCommandstats } = require('./adsp-p2-horizontal-resources');

function auditRedisCommandstats(text) {
  const commands = parseRedisCommandstats(text);
  const records = Object.entries(commands).map(([command, stats]) => ({
    command,
    calls: stats.calls,
    usec: stats.usec,
    rejectedCalls: stats.rejectedCalls,
    failedCalls: stats.failedCalls
  }));
  const totals = records.reduce(
    (acc, record) => ({
      calls: acc.calls + record.calls,
      usec: acc.usec + record.usec,
      rejectedCalls: acc.rejectedCalls + record.rejectedCalls,
      failedCalls: acc.failedCalls + record.failedCalls
    }),
    { calls: 0, usec: 0, rejectedCalls: 0, failedCalls: 0 }
  );
  const failures = records.filter(record => record.rejectedCalls > 0 || record.failedCalls > 0);
  return {
    version: 1,
    phase: 'ADSP-P2-A',
    fixture: 'horizontal-redis-node-loss-commandstats',
    statsBaseline: 'redis CONFIG RESETSTAT immediately before four-cell fault scenario',
    commandCount: records.length,
    totals,
    failures,
    commands: records,
    complete: true,
    passed: failures.length === 0 && totals.rejectedCalls === 0 && totals.failedCalls === 0
  };
}

function main(argv = process.argv.slice(2)) {
  const commandstatsPath = path.resolve(argv[0] || '');
  const outputPath = path.resolve(argv[1] || '');
  if (!argv[0] || !argv[1]) {
    throw new Error('Usage: adsp-p2-node-loss-redis-audit.js <redis-commandstats.txt> <output.json>');
  }
  const audit = auditRedisCommandstats(fs.readFileSync(commandstatsPath, 'utf8'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: audit.passed,
    commandCount: audit.commandCount,
    rejectedCalls: audit.totals.rejectedCalls,
    failedCalls: audit.totals.failedCalls,
    outputPath
  })}\n`);
  if (!audit.passed) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[ADSP-P2-LOSS-REDIS] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  }
}

module.exports = { auditRedisCommandstats };
