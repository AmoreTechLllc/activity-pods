const {
  createMoleculerFabricConfig,
  resolveServicePatterns
} = require('../config/moleculer-fabric');
const RdfJSONSerializer = require('../RdfJSONSerializer');

describe('ADSP P1 Moleculer fabric configuration', () => {
  test('single-process defaults preserve the native pod-provider identity and full service cell', () => {
    const config = createMoleculerFabricConfig({});

    expect(config.mode).toBe('single');
    expect(config.nodeID).toBe('pod-provider');
    expect(config.namespace).toBeUndefined();
    expect(config.transporter).toBeUndefined();
    expect(config.serializer).toBeInstanceOf(RdfJSONSerializer);
    expect(config.serviceGroup).toBe('pod-cell');
    expect(config.servicePatterns).toEqual(['services/*.js', 'services/**/*.js']);
  });

  test('serializer is transport-independent', () => {
    const withoutTransport = createMoleculerFabricConfig({});
    const withTransport = createMoleculerFabricConfig({
      SEMAPPS_REDIS_TRANSPORTER_URL: 'redis://127.0.0.1:6379'
    });

    expect(withoutTransport.serializer).toBeInstanceOf(RdfJSONSerializer);
    expect(withTransport.serializer).toBeInstanceOf(RdfJSONSerializer);
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
});
