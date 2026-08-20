'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Redis = require('ioredis');

function resolveBullCommandsDir(resolveImpl = require.resolve) {
  const packagePath = resolveImpl('bull/package.json');
  return path.join(path.dirname(packagePath), 'lib', 'commands');
}

function readBullScripts(commandsDir) {
  const entries = fs
    .readdirSync(commandsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.lua'))
    .map(entry => entry.name)
    .sort();

  if (entries.length === 0) {
    throw new Error(`No Bull Lua command scripts found in ${commandsDir}`);
  }

  return entries.map(name => {
    const source = fs.readFileSync(path.join(commandsDir, name), 'utf8');
    if (!source.trim()) throw new Error(`Bull Lua command script is empty: ${name}`);
    return { name, source };
  });
}

async function preloadBullScripts({ redisUrl, commandsDir = resolveBullCommandsDir(), RedisImpl = Redis }) {
  if (!redisUrl) throw new Error('Bull Redis script preload requires a Redis URL');
  const scripts = readBullScripts(commandsDir);
  const client = new RedisImpl(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: null
  });

  const loaded = [];
  try {
    await client.ping();
    for (const script of scripts) {
      const sha = await client.script('LOAD', script.source);
      if (!/^[0-9a-f]{40}$/u.test(String(sha))) {
        throw new Error(`Redis returned an invalid SCRIPT LOAD digest for ${script.name}`);
      }
      loaded.push({ name: script.name, sha: String(sha) });
    }
  } finally {
    if (client.status !== 'end') await client.quit().catch(() => client.disconnect());
  }

  return {
    scriptCount: loaded.length,
    scripts: loaded
  };
}

async function main() {
  const redisUrl = process.env.ADSP_P2_BULL_REDIS_URL || process.env.SEMAPPS_QUEUE_SERVICE_URL;
  const result = await preloadBullScripts({ redisUrl });
  process.stdout.write(`${JSON.stringify({ ok: true, scriptCount: result.scriptCount, scripts: result.scripts })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P2-BULL-SCRIPT-PRELOAD] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  preloadBullScripts,
  readBullScripts,
  resolveBullCommandsDir
};
