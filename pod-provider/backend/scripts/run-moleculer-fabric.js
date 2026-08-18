'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { createMoleculerFabricConfig } = require('../config/moleculer-fabric');

const fabric = createMoleculerFabricConfig();
const runner = require.resolve('moleculer/bin/moleculer-runner.js');
const args = [runner];

if (process.argv.includes('--repl')) args.push('--repl');
if (process.argv.includes('--hot')) args.push('--hot');
args.push(...fabric.servicePatterns);

process.stdout.write(
  `${JSON.stringify({
    event: 'moleculer_fabric_start',
    mode: fabric.mode,
    nodeID: fabric.nodeID,
    namespace: fabric.namespace || null,
    serviceGroup: fabric.serviceGroup,
    servicePatterns: fabric.servicePatterns
  })}\n`
);

const child = spawn(process.execPath, args, {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('error', error => {
  console.error('Failed to start Moleculer fabric runner', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
