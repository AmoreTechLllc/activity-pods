'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createMoleculerFabricConfig } = require('../config/moleculer-fabric');

function resolveMoleculerRunner() {
  // Moleculer 0.14 exports its public package entry but does not export the
  // internal `moleculer/bin/moleculer-runner.js` subpath under Node's package
  // exports rules. Resolve the public entry first, then locate the CLI shipped
  // inside that same installed package without asking Node to resolve a blocked
  // package subpath.
  const packageEntry = require.resolve('moleculer');
  const runner = path.join(path.dirname(packageEntry), 'bin', 'moleculer-runner.js');
  if (!fs.existsSync(runner)) {
    throw new Error(`Unable to locate Moleculer runner beside public package entry: ${runner}`);
  }
  return runner;
}

const fabric = createMoleculerFabricConfig();
const runner = resolveMoleculerRunner();
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

module.exports = { resolveMoleculerRunner };
