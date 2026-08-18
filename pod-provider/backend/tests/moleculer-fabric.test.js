const {
  createMoleculerFabricConfig,
  resolveServicePatterns,
  validateRedisTransporterUrl
} = require('../config/moleculer-fabric');
const { childExitCode } = require('../scripts/run-moleculer-fabric');
const RdfJSONSerializer = require('../RdfJSONSerializer');

describe('ADSP P1 Moleculer fabric configuration', () => {
  test('single-process defaults preserve the native pod-provider identity and full service cell', () => {
    const config = createMoleculerFabricConfig({});

    expect(config.mode).toBe('single');
    expect(config.nodeID).toBe('pod-provider');
    expect(config.namespace).toBeUndefined();
    expect(config.transporter).toBeUndefined();
    expect(config.registry).toEqual({ preferLocal: true });
    expect(config.serializer).toBeInstanceOf(RdfJSONSerializer);
    expect(config.serviceGroup).toBe('pod-cell');
    expect(config.servicePatterns).toEqual(['services/*.js', 'services/**/*.js']);
  });

  test('serializer and local-first registry policy are transport-independent', () => {
    const withoutTransport = createMoleculerFabricConfig({});
    const withTransport = createMoleculerFabricConfig({
      SEMAPPS_REDIS_TRANSPORTER_URL: 'redis://127.0.0.1:6379'
    });

    expect(withoutTransport.serializer).toBeInstanceOf(RdfJSONSerializer);
    expect(withTransport.serializer).toBeInstanceOf(RdfJSONSerializer);
    expect(withoutTransport.registry.preferLocal).toBe(true);
    expect(withTransport.registry.preferLocal).toBe(true);
  });

  test('Redis transporter URLs accept only explicit Redis schemes', () => {
    expect(validateRedisTransporterUrl('redis://127.0.0.1:6379/12')).toBe('redis://127.0.0.1:6379/12');
    expect(validateRedisTransporterUrl('rediss://redis.example.test:6380/12')).toBe(
      'rediss://redis.example.test:6380/12'
    );
    expect(validateRedisTransporterUrl('  redis://redis:6379  ')).toBe('redis://redis:6379');
    expect(validateRedisTransporterUrl('')).toBeUndefined();

    for (const value of ['Redis', 'not-a-url', 'nats://127.0.0.1:4222', 'http://redis:6379', 'redis:///12']) {
      expect(() => validateRedisTransporterUrl(value)).toThrow(/redis:\/\/ or rediss:\/\//);
    }
  });

  test('distributed mode requires an explicit unique node ID', () => {
    expect(() =>
      createMoleculerFabricConfig({
        SEMAPPS_MOLECULER_MODE: 'distributed',
        SEMAPPS_MOLECULER_NAMESPACE: 'prod-fabric',
        SEMAPPS_REDIS_TRANSPORTER_URL: 'redis://127.0.0.1:6379'
      })
    ).toThrow(/requires SEMAPPS_MOLECULER_NODE_ID/);

    expect(() =>
      createMoleculerFabricConfig({
        SEMAPPS_MOLECULER_MODE: 'distributed',
        SEMAPPS_MOLECULER_NODE_ID: 'pod-provider',
        SEMAPPS_MOLECULER_NAMESPACE: 'prod-fabric',
        SEMAPPS_REDIS_TRANSPORTER_URL: 'redis://127.0.0.1:6379'
      })
    ).toThrow(/requires a unique node ID/);
  });

  test('distributed mode requires an explicit namespace and transporter', () => {
    expect(() =>
      createMoleculerFabricConfig({
        SEMAPPS_MOLECULER_MODE: 'distributed',
        SEMAPPS_MOLECULER_NODE_ID: 'pod-provider-a',
        SEMAPPS_REDIS_TRANSPORTER_URL: 'redis://127.0.0.1:6379'
      })
    ).toThrow(/requires SEMAPPS_MOLECULER_NAMESPACE/);

    expect(() =>
      createMoleculerFabricConfig({
        SEMAPPS_MOLECULER_MODE: 'distributed',
        SEMAPPS_MOLECULER_NODE_ID: 'pod-provider-a',
        SEMAPPS_MOLECULER_NAMESPACE: 'prod-fabric'
      })
    ).toThrow(/requires SEMAPPS_REDIS_TRANSPORTER_URL/);
  });

  test('distributed mode rejects a non-Redis transporter before broker startup', () => {
    expect(() =>
      createMoleculerFabricConfig({
        SEMAPPS_MOLECULER_MODE: 'distributed',
        SEMAPPS_MOLECULER_NODE_ID: 'pod-provider-a',
        SEMAPPS_MOLECULER_NAMESPACE: 'prod-fabric',
        SEMAPPS_REDIS_TRANSPORTER_URL: 'nats://127.0.0.1:4222'
      })
    ).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  test('two distinct distributed node identities are accepted in the same namespace', () => {
    const common = {
      SEMAPPS_MOLECULER_MODE: 'distributed',
      SEMAPPS_MOLECULER_NAMESPACE: 'prod-fabric',
      SEMAPPS_REDIS_TRANSPORTER_URL: 'redis://127.0.0.1:6379'
    };
    const a = createMoleculerFabricConfig({ ...common, SEMAPPS_MOLECULER_NODE_ID: 'pod-provider-a' });
    const b = createMoleculerFabricConfig({ ...common, SEMAPPS_MOLECULER_NODE_ID: 'pod-provider-b' });

    expect(a.nodeID).not.toBe(b.nodeID);
    expect(a.namespace).toBe(b.namespace);
    expect(a.registry.preferLocal).toBe(true);
    expect(b.registry.preferLocal).toBe(true);
  });

  test('invalid fabric identifiers and unknown service groups fail closed', () => {
    expect(() => createMoleculerFabricConfig({ SEMAPPS_MOLECULER_NODE_ID: 'bad id' })).toThrow(
      /Moleculer node ID/
    );
    expect(() =>
      createMoleculerFabricConfig({ SEMAPPS_MOLECULER_NAMESPACE: 'bad namespace!' })
    ).toThrow(/Moleculer namespace/);
    expect(() =>
      createMoleculerFabricConfig({ SEMAPPS_MOLECULER_SERVICE_GROUP: 'unknown' })
    ).toThrow(/Unsupported Moleculer service group/);
  });

  test('the P1 probe group is isolated from the production service tree', () => {
    expect(resolveServicePatterns('p1-probe')).toEqual(['p1-fixtures/services/*.service.js']);
  });

  test('launcher maps child signal termination to conventional process exit status without self-signalling', () => {
    expect(childExitCode(0, null)).toBe(0);
    expect(childExitCode(null, 'SIGINT')).toBe(130);
    expect(childExitCode(null, 'SIGTERM')).toBe(143);
    expect(childExitCode(null, 'SIGKILL')).toBe(137);
    expect(childExitCode(null, 'UNKNOWN_SIGNAL')).toBe(1);
  });
});
