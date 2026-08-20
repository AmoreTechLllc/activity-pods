'use strict';

const {
  ACTIVITYSTREAMS_CONTEXT_URI,
  ACTIVITYSTREAMS_NAMESPACE,
  ACTIVITYSTREAMS_REQUIRED_TYPES,
  containsActivityStreamsUri,
  containsActivityStreamsTerm,
  containsNoteTerm,
  expectedExpandedTypes,
  summarizeOntologies,
  summarizeContext,
  summarizeCachedDocument,
  summarizeExpandedTypes,
  semanticProbePasses,
  stopBrokerWithin
} = require('../scripts/adsp-p2-semantic-probe');

describe('ADSP P2 semantic readiness probe', () => {
  test('detects the preserved ActivityStreams URI in nested context values', () => {
    expect(containsActivityStreamsUri([{}, ACTIVITYSTREAMS_CONTEXT_URI])).toBe(true);
    expect(containsActivityStreamsUri({ '@context': [ACTIVITYSTREAMS_CONTEXT_URI] })).toBe(true);
    expect(containsActivityStreamsUri({ '@context': ['https://example.test/context'] })).toBe(false);
  });

  test('detects ActivityStreams terms generically, including Note and Article', () => {
    const document = { '@context': { Note: 'as:Note', Article: 'as:Article' } };
    expect(containsActivityStreamsTerm(document, 'Note')).toBe(true);
    expect(containsActivityStreamsTerm(document, 'Article')).toBe(true);
    expect(containsNoteTerm(document)).toBe(true);
    expect(containsActivityStreamsTerm(document, 'Video')).toBe(false);
  });

  test('required semantic vocabulary includes content, actor, collection, and activity classes', () => {
    expect(ACTIVITYSTREAMS_REQUIRED_TYPES).toEqual(expect.arrayContaining([
      'Article',
      'Audio',
      'Document',
      'Event',
      'Image',
      'Note',
      'Page',
      'Video',
      'Person',
      'Service',
      'Collection',
      'OrderedCollection',
      'Create',
      'Update',
      'Delete',
      'Announce',
      'Like',
      'Follow',
      'Block',
      'Flag',
      'Move',
      'Undo'
    ]));
    expect(expectedExpandedTypes()).toContain(`${ACTIVITYSTREAMS_NAMESPACE}Article`);
  });

  test('summarizes ontology state without dumping unrelated ontology bodies', () => {
    const summary = summarizeOntologies([
      { prefix: 'foaf', namespace: 'http://xmlns.com/foaf/0.1/' },
      {
        prefix: 'as',
        namespace: ACTIVITYSTREAMS_NAMESPACE,
        jsonldContext: ACTIVITYSTREAMS_CONTEXT_URI,
        preserveContextUri: true,
        huge: { ignored: true }
      }
    ]);
    expect(summary.prefixes).toEqual(['as', 'foaf']);
    expect(summary.hasActivityStreamsOntology).toBe(true);
    expect(summary.activityStreamsOntology).toEqual({
      prefix: 'as',
      namespace: ACTIVITYSTREAMS_NAMESPACE,
      jsonldContext: ACTIVITYSTREAMS_CONTEXT_URI,
      preserveContextUri: true
    });
    expect(summary.activityStreamsOntology.huge).toBeUndefined();
  });

  test('summarizes computed context state', () => {
    expect(summarizeContext([ACTIVITYSTREAMS_CONTEXT_URI])).toEqual({
      present: true,
      includesActivityStreamsContextUri: true,
      topLevelKind: 'array',
      topLevelLength: 1
    });
  });

  test('cached ActivityStreams context must contain every required type', () => {
    const completeContext = Object.fromEntries(ACTIVITYSTREAMS_REQUIRED_TYPES.map(type => [type, `as:${type}`]));
    const healthy = summarizeCachedDocument({ '@context': completeContext });
    expect(healthy.containsAllRequiredTypes).toBe(true);
    expect(healthy.missingRequiredTypes).toEqual([]);
    expect(healthy.containsNoteTerm).toBe(true);
    expect(healthy.containsArticleTerm).toBe(true);

    delete completeContext.Article;
    const missingArticle = summarizeCachedDocument({ '@context': completeContext });
    expect(missingArticle.containsAllRequiredTypes).toBe(false);
    expect(missingArticle.missingRequiredTypes).toContain('Article');
  });

  test('expanded ActivityStreams types must exactly preserve every required class', () => {
    const expanded = summarizeExpandedTypes(expectedExpandedTypes());
    expect(expanded.expandsAllRequiredTypes).toBe(true);
    expect(expanded.expandsToActivityStreamsNote).toBe(true);
    expect(expanded.expandsToActivityStreamsArticle).toBe(true);

    const wrong = expectedExpandedTypes();
    wrong[ACTIVITYSTREAMS_REQUIRED_TYPES.indexOf('Article')] = 'https://example.test/Article';
    const broken = summarizeExpandedTypes(wrong);
    expect(broken.expandsAllRequiredTypes).toBe(false);
    expect(broken.mismatches).toContain('Article');
  });

  test('passes only when every semantic layer and required ActivityStreams type is present', () => {
    const healthy = {
      ontologies: { ok: true, hasActivityStreamsOntology: true },
      context: { ok: true, includesActivityStreamsContextUri: true },
      localContext: { ok: true, includesActivityStreamsContextUri: false },
      activityStreamsCache: {
        ok: true,
        present: true,
        containsAllRequiredTypes: true,
        containsNoteTerm: true,
        containsArticleTerm: true
      },
      expandActivityStreamsTypes: {
        ok: true,
        expandsAllRequiredTypes: true,
        expandsToActivityStreamsNote: true,
        expandsToActivityStreamsArticle: true
      }
    };
    expect(semanticProbePasses(healthy)).toBe(true);
    expect(semanticProbePasses({
      ...healthy,
      expandActivityStreamsTypes: { ...healthy.expandActivityStreamsTypes, expandsToActivityStreamsArticle: false }
    })).toBe(false);
    expect(semanticProbePasses({
      ...healthy,
      activityStreamsCache: { ...healthy.activityStreamsCache, containsAllRequiredTypes: false }
    })).toBe(false);
  });

  test('bounds broker cleanup when stop never resolves', async () => {
    const broker = { stop: jest.fn(() => new Promise(() => {})) };
    await expect(stopBrokerWithin(broker, 10)).rejects.toThrow(
      /Timed out stopping semantic-probe broker after 10ms/u
    );
    expect(broker.stop).toHaveBeenCalledTimes(1);
  });
});
