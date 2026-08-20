'use strict';

const {
  PATCH_MARKER,
  LOCAL_READY_TIMEOUT_MS,
  LOCAL_READY_POLL_MS,
  isActivityPubRootCandidate,
  findBootstrapCalls,
  patchActivityPubOntologyBootstrapSource
} = require('../scripts/patch-semapps-activitypub-local-ontology-bootstrap');

function fixture() {
  return `
const ActivityPubService = {
  name: 'activitypub',
  dependencies: ['api', 'ontologies'],
  async started() {
    await this.broker.call('ontologies.register', ontologies_1.as);
    await this.broker.call('ontologies.register', ontologies_1.sec);
  }
};
`;
}

describe('ADSP P2 local ActivityPub ontology bootstrap patch', () => {
  test('recognizes the pinned ActivityPub root bootstrap contract', () => {
    expect(isActivityPubRootCandidate(fixture())).toBe(true);
    expect(findBootstrapCalls(fixture())).toHaveLength(2);
  });

  test('binds as/sec registration to the local ontology service only in distributed mode', () => {
    const result = patchActivityPubOntologyBootstrapSource(fixture());
    expect(result.changed).toBe(true);
    expect(result.source).toContain(PATCH_MARKER);
    expect(result.source).toContain("process.env.SEMAPPS_MOLECULER_MODE === 'distributed'");
    expect(result.source).toContain("this.broker.getLocalService('ontologies')");
    expect(result.source).toContain('await adspP2LocalOntologies.actions.register(ontologies_1.as);');
    expect(result.source).toContain('await adspP2LocalOntologies.actions.register(ontologies_1.sec);');
    expect(result.source).toContain("await this.broker.call('ontologies.register', ontologies_1.as);");
    expect(result.source).toContain("await this.broker.call('ontologies.register', ontologies_1.sec);");
    expect(result.source).toContain(`Date.now() + ${LOCAL_READY_TIMEOUT_MS}`);
    expect(result.source).toContain(`setTimeout(resolve, ${LOCAL_READY_POLL_MS})`);
  });

  test('is idempotent', () => {
    const first = patchActivityPubOntologyBootstrapSource(fixture());
    const second = patchActivityPubOntologyBootstrapSource(first.source);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
  });

  test('fails closed when the upstream root no longer has exactly two ontology registrations', () => {
    const drifted = fixture().replace("    await this.broker.call('ontologies.register', ontologies_1.sec);\n", '');
    expect(() => patchActivityPubOntologyBootstrapSource(drifted)).toThrow(/no longer matches the expected v1\.1\.4 ontology-bootstrap contract/u);
  });

  test('fails closed on a marker without the local lookup', () => {
    expect(() => patchActivityPubOntologyBootstrapSource(`${fixture()}\n// ${PATCH_MARKER}`)).toThrow(/patch marker without local ontology lookup/u);
  });
});
