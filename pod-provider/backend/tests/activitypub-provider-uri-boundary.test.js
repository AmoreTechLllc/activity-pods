'use strict';

const {
  createProviderUriMatcher,
  isProviderOwnedUri,
  parseProviderBaseUrl,
  partitionProviderUris
} = require('../utils/activitypub-provider-uri');

test.each([
  'https://pods.example/users/alice',
  'https://pods.example/followers',
  'https://PODS.EXAMPLE/users/alice',
  'https://pods.example:443/users/alice'
])('root provider base accepts same-origin URI %s', candidate => {
  expect(isProviderOwnedUri(candidate, 'https://pods.example')).toBe(true);
});

test.each([
  'https://pods.example.evil/users/alice',
  'https://pods.example@evil.example/users/alice',
  'https://user@pods.example/users/alice',
  'http://pods.example/users/alice',
  'https://pods.example:444/users/alice',
  'javascript:alert(1)',
  'not a URL'
])('root provider base rejects non-authoritative URI %s', candidate => {
  expect(isProviderOwnedUri(candidate, 'https://pods.example')).toBe(false);
});

test.each([
  ['https://pods.example/provider', true],
  ['https://pods.example/provider/', true],
  ['https://pods.example/provider/users/alice', true],
  ['https://pods.example/provider/followers?cursor=1', true],
  ['https://pods.example/provider#section', true],
  ['https://pods.example/provider-evil/users/alice', false],
  ['https://pods.example/provider.evil/users/alice', false],
  ['https://pods.example/providers/users/alice', false],
  ['https://pods.example/%70rovider-evil/users/alice', false],
  ['https://pods.example/provider%2Fevil/users/alice', false],
  ['https://pods.example/provider/../admin', false]
])('path-scoped provider classifies %s with segment boundaries', (candidate, expected) => {
  const matches = createProviderUriMatcher('https://pods.example/provider/');
  expect(matches(candidate)).toBe(expected);
});

test('provider matcher preserves explicit non-default port authority', () => {
  const matches = createProviderUriMatcher('https://pods.example:8443/provider');

  expect(matches('https://pods.example:8443/provider/users/alice')).toBe(true);
  expect(matches('https://pods.example/provider/users/alice')).toBe(false);
  expect(matches('https://pods.example:443/provider/users/alice')).toBe(false);
});

test('provider matcher is reusable without mutable candidate state', () => {
  const matches = createProviderUriMatcher('https://pods.example/provider');

  expect(matches('https://pods.example/provider/users/alice')).toBe(true);
  expect(matches('https://pods.example.evil/provider/users/alice')).toBe(false);
  expect(matches('https://pods.example/provider/users/bob')).toBe(true);
});

test('single-pass partition preserves order and assigns each URI to exactly one bucket', () => {
  const localA = 'https://pods.example/provider/users/alice';
  const remote = 'https://pods.example.evil/provider/users/bob';
  const localB = 'https://pods.example/provider/users/carol';

  expect(partitionProviderUris([localA, remote, localB], 'https://pods.example/provider')).toEqual({
    localUris: [localA, localB],
    remoteUris: [remote]
  });
});

test.each([
  null,
  '',
  'not a URL',
  'ftp://pods.example',
  'https://user@pods.example',
  'https://pods.example?tenant=one',
  'https://pods.example#fragment'
])('invalid provider base %p fails closed at matcher construction', baseUri => {
  expect(() => createProviderUriMatcher(baseUri)).toThrow(/ActivityPub provider/u);
});

test('provider base parsing normalizes only trailing path separators', () => {
  expect(parseProviderBaseUrl('https://pods.example/provider///')).toEqual({
    origin: 'https://pods.example',
    path: '/provider'
  });
});
