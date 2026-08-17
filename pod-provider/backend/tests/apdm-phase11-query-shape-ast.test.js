'use strict';

const {
  fingerprintQueryShape,
  normalizeQueryObjectShape
} = require('../lib/apdm-phase11-query-attribution');

describe('APDM Phase 11 object-query structural fingerprints', () => {
  const named = value => ({ termType: 'NamedNode', value });
  const variable = value => ({ termType: 'Variable', value });

  test('preserves triple roles while removing RDF values', () => {
    const variableSubject = {
      type: 'query',
      queryType: 'ASK',
      where: [{
        type: 'bgp',
        triples: [{
          subject: variable('subject-private-name'),
          predicate: named('https://schema.example/knows'),
          object: named('https://private.example/bob')
        }]
      }]
    };
    const variableObject = {
      type: 'query',
      queryType: 'ASK',
      where: [{
        type: 'bgp',
        triples: [{
          subject: named('https://private.example/alice'),
          predicate: named('https://schema.example/knows'),
          object: variable('object-private-name')
        }]
      }]
    };

    expect(fingerprintQueryShape(variableSubject)).not.toBe(fingerprintQueryShape(variableObject));
    const shape = normalizeQueryObjectShape(variableSubject);
    expect(shape).toContain('subject:{termType:Variable');
    expect(shape).toContain('predicate:{termType:NamedNode');
    expect(shape).toContain('object:{termType:NamedNode');
    expect(shape).not.toContain('private.example');
    expect(shape).not.toContain('schema.example');
    expect(shape).not.toContain('private-name');
  });

  test('preserves RDF term equality relationships using opaque per-query slots', () => {
    const sameVariable = {
      type: 'query',
      queryType: 'ASK',
      where: [{
        type: 'bgp',
        triples: [{
          subject: variable('private-a'),
          predicate: named('https://schema.example/knows'),
          object: variable('private-a')
        }]
      }]
    };
    const differentVariables = {
      type: 'query',
      queryType: 'ASK',
      where: [{
        type: 'bgp',
        triples: [{
          subject: variable('private-a'),
          predicate: named('https://schema.example/knows'),
          object: variable('private-b')
        }]
      }]
    };
    const renamedSameVariable = {
      type: 'query',
      queryType: 'ASK',
      where: [{
        type: 'bgp',
        triples: [{
          subject: variable('another-private-name'),
          predicate: named('https://other.example/relation'),
          object: variable('another-private-name')
        }]
      }]
    };

    expect(fingerprintQueryShape(sameVariable)).not.toBe(fingerprintQueryShape(differentVariables));
    expect(fingerprintQueryShape(sameVariable)).toBe(fingerprintQueryShape(renamedSameVariable));
    const shape = normalizeQueryObjectShape(sameVariable);
    expect(shape).toContain('value:VAR1');
    expect(shape).toContain('value:IRI1');
    expect(shape).not.toContain('private-a');
    expect(shape).not.toContain('schema.example');
  });

  test('preserves allowlisted filter operators without retaining operands', () => {
    const withOperator = operator => ({
      type: 'query',
      queryType: 'SELECT',
      where: [{
        type: 'filter',
        expression: {
          type: 'operation',
          operator,
          args: [variable('private-count'), { termType: 'Literal', value: '42' }]
        }
      }]
    });

    const lessThan = withOperator('<');
    const greaterThan = withOperator('>');
    expect(fingerprintQueryShape(lessThan)).not.toBe(fingerprintQueryShape(greaterThan));
    expect(normalizeQueryObjectShape(lessThan)).toContain('operator:<');
    expect(normalizeQueryObjectShape(greaterThan)).toContain('operator:>');
    expect(normalizeQueryObjectShape(lessThan)).not.toContain('private-count');
    expect(normalizeQueryObjectShape(lessThan)).not.toContain('42');
  });

  test('collapses unapproved field names and unapproved operator strings', () => {
    const shape = normalizeQueryObjectShape({
      type: 'query',
      queryType: 'SELECT',
      secretUserField: 'https://private.example/alice',
      expression: { type: 'operation', operator: 'private-user-operator', args: [] }
    });
    expect(shape).toContain('FIELD:STRING');
    expect(shape).toContain('operator:OPERATOR');
    expect(shape).not.toContain('secretUserField');
    expect(shape).not.toContain('private-user-operator');
    expect(shape).not.toContain('private.example');
  });
});
