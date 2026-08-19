module.exports = {
  apps: [
    {
      name: 'backend',
      // Keep container startup on the same validated fabric path as yarn
      // start/dev/test. Service groups, node IDs, namespaces, transporter
      // requirements and fail-closed validation must not be bypassed by PM2.
      script: './scripts/run-moleculer-fabric.js',
      args: '--repl',
      interpreter: 'node',
      error_file: './logs/err.log',
      out_file: './logs/out.log'
    }
  ]
};
