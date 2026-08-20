'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  preloadBullScripts,
  readBullScripts,
  resolveBullCommandsDir
} = require('../scripts/adsp-p2-preload-bull-scripts');
const preloadService = require('../services/adsp-p2-redis-script-preload.service');

describe('ADSP P2 Bull Redis script preload', () => {
  let tempDir;
  const originalEnabled = process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS;
  const originalQueueUrl = process.env.SEMAPPS_QUEUE_SERVICE_URL;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-bull-scripts-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalEnabled === undefined) delete process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS;
    else process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS = originalEnabled;
    if (originalQueueUrl === undefined) delete process.env.SEMAPPS_QUEUE_SERVICE_URL;
    else process.env.SEMAPPS_QUEUE_SERVICE_URL = originalQueueUrl;
  });

  test('resolves the installed Bull command directory from package metadata', () => {
    const resolved = resolveBullCommandsDir(request => {
      expect(request).toBe('bull/package.json');
      return '/app/node_modules/bull/package.json';
    });
    expect(resolved).toBe('/app/node_modules/bull/lib/commands');
  });

  test('reads only non-empty Lua command scripts in deterministic order', () => {
    fs.writeFileSync(path.join(tempDir, 'z.lua'), 'return 2\n');
    fs.writeFileSync(path.join(tempDir, 'a.lua'), 'return 1\n');
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'ignored\n');

    expect(readBullScripts(tempDir)).toEqual([
      { name: 'a.lua', source: 'return 1\n' },
      { name: 'z.lua', source: 'return 2\n' }
    ]);
  });

  test('fails closed when the Bull command directory has no usable scripts', () => {
    expect(() => readBullScripts(tempDir)).toThrow(/No Bull Lua command scripts/u);
    fs.writeFileSync(path.join(tempDir, 'empty.lua'), '   \n');
    expect(() => readBullScripts(tempDir)).toThrow(/script is empty/u);
  });

  test('connects explicitly and SCRIPT LOADs every Bull command before closing Redis', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.lua'), 'return 1\n');
    fs.writeFileSync(path.join(tempDir, 'b.lua'), 'return 2\n');
    const calls = [];

    class FakeRedis {
      constructor(url, options) {
        calls.push(['constructor', url, options]);
        this.status = 'wait';
      }

      async connect() {
        calls.push(['connect']);
        this.status = 'ready';
      }

      async ping() {
        calls.push(['ping']);
        return 'PONG';
      }

      async script(command, source) {
        calls.push(['script', command, source]);
        return source.includes('1')
          ? '1111111111111111111111111111111111111111'
          : '2222222222222222222222222222222222222222';
      }

      async quit() {
        calls.push(['quit']);
        this.status = 'end';
      }
    }

    const result = await preloadBullScripts({
      redisUrl: 'redis://redis:6379/11',
      commandsDir: tempDir,
      RedisImpl: FakeRedis
    });

    expect(result).toEqual({
      scriptCount: 2,
      scripts: [
        { name: 'a.lua', sha: '1111111111111111111111111111111111111111' },
        { name: 'b.lua', sha: '2222222222222222222222222222222222222222' }
      ]
    });
    expect(calls.map(call => call[0])).toEqual(['constructor', 'connect', 'ping', 'script', 'script', 'quit']);
  });

  test('rejects invalid Redis script digests instead of claiming preload success', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.lua'), 'return 1\n');

    class FakeRedis {
      constructor() {
        this.status = 'wait';
      }
      async connect() {
        this.status = 'ready';
      }
      async ping() {}
      async script() {
        return 'not-a-sha';
      }
      async quit() {
        this.status = 'end';
      }
    }

    await expect(
      preloadBullScripts({ redisUrl: 'redis://redis:6379/11', commandsDir: tempDir, RedisImpl: FakeRedis })
    ).rejects.toThrow(/invalid SCRIPT LOAD digest/u);
  });

  test('requires an explicit Redis URL', async () => {
    await expect(preloadBullScripts({ redisUrl: '', commandsDir: tempDir })).rejects.toThrow(/requires a Redis URL/u);
  });

  test('lifecycle preload service is inert unless explicitly enabled', async () => {
    delete process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS;
    expect(preloadService.name).toBe('adspP2RedisScriptPreload');
    await expect(preloadService.started.call({ logger: { info: jest.fn() } })).resolves.toBeUndefined();
  });

  test('lifecycle preload service fails closed when enabled without queue Redis URL', async () => {
    process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS = 'true';
    delete process.env.SEMAPPS_QUEUE_SERVICE_URL;
    await expect(preloadService.started.call({ logger: { info: jest.fn() } })).rejects.toThrow(
      /requires SEMAPPS_QUEUE_SERVICE_URL/u
    );
  });
});
