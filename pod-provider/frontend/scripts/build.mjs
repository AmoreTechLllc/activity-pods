import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reactScriptsBin = require.resolve('react-scripts/bin/react-scripts.js');
const nodeOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} --no-deprecation` : '--no-deprecation';

const child = spawn(process.execPath, [reactScriptsBin, 'build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    GENERATE_SOURCEMAP: 'false',
    NODE_OPTIONS: nodeOptions
  }
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
