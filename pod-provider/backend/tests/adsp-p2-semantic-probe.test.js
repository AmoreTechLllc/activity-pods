'use strict';

const {
  ACTIVITYSTREAMS_CONTEXT_URI,
  containsActivityStreamsUri,
  containsNoteTerm,
  summarizeOntologies,
  summarizeContext,
  summarizeCachedDocument,
  semanticProbePasses
} = require('../scripts/adsp-p2-semantic-probe');

describe('ADSP P2 semantic readiness probe', () => {
  test('detects the preserved ActivityStreams URI in nested context values', () => {
    expect(containsActivityStreamsUri([{}, ACTIVITYSTREAMS_CONTEXT_URI])).toBe(true);
    expect(containsActivityStreamsUri({ '@context': [ACTIVITYSTREAMS_CONTEXT_URI] })).toBe(true);
    expect(containsActivityStreamsUri({ '@context': ['https://example.test/context'] })).toBe(false);
  });

  test('detects a Note term in an ActivityStreams context document', () => {
    expect(containsNoteTerm({ '@context': { Note: 'as:Note' } })).toBe(true);
    expect(containsNoteTerm({ '@context': { Create: 'as:Create' } })).toBe(false);
  });

  test('summarizes ontology state without dumping unrelated ontology bodies', () => {
    const summary = summarizeOntologies([
      { prefix: 'foaf', namespace: 'http://xmlns.com/foaf/0.1/' },
      {
        prefix: 'as',
        namespace: 'https://www.w3.org/ns/activitystreams#',
        jsonldContext: ACTIVITYSTREAMS_CONTEXT_URI,
        preserveContextUri: true,
        huge: { ignored: true }
      }
    ]);
    expect(summary.prefixes).toEqual(['as', 'foaf']);
    expect(summary.hasActivityStreamsOntology).toBe(true);
    expect(summary.activityStreamsOntology).toEqual({
      prefix: 'as',
      namespace: 'https://www.w3.org/ns/activitystreams#',
      jsonldContext: ACTIVITYSTREAMS_CONTEXT_URI,
      preserveContextUri: true
    });
    expect(summary.activityStreamsOntology.huge).toBeUndefined();
  });

  test('summarizes computed and cached context state', () => {
    expect(summarizeContext([ACTIVITYSTREAMS_CONTEXT_URI])).toEqual({
      present: true,
      includesActivityStreamsContextUri: true,
      topLevelKind: 'array',
      topLevelLength: 1
    });
    expect(summarizeCachedDocument({ '@context': { Note: 'as:Note' } })).toEqual({
      present: true,
      topLevelKind: 'object',
      topLevelKeys: ['@context'],
      hasContextKey: true,
      containsNoteTerm: true
    });
  });

  test('passes only when every semantic layer required for Note expansion is present', () => {
    const healthy = {
      ontologies: { ok: true, hasActivityStreamsOntology: true },
      context: { ok: true, includesActivityStreamsContextUri: true },
      activityStreamsCache: { ok: true, present: true, containsNoteTerm: true },
      expandNote: { ok: true, expandsToActivityStreamsNote: true }
    };
    expect(semanticProbePasses(healthy)).toBe(true);
    expect(semanticProbePasses({ ...healthy, expandNote: { ok: false } })).toBe(false);
    expect(semanticProbePasses({ ...healthy, activityStreamsCache: { ok: true, present: false, containsNoteTerm: false } })).toBe(false);
  });
});
