'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

const ACTOR = 'https://pods.example/alice';
const DATASET = 'alice';
const FOLLOWERS = `${ACTOR}/followers`;

test('sender follower membership query preserves actor authority and exact local dataset', async () => {
  const call = jest.fn(async (action, params) => {
    expect(action).toBe('triplestore.query');
    expect(params.dataset).toBe(DATASET);
    expect(params.webId).toBe(ACTOR);
    expect(params.accept).toBe('application/sparql-results+json');
    expect(params.query).toContain(`<${FOLLOWERS}> a as:Collection`);
    expect(params.query).toContain(`OPTIONAL { <${FOLLOWERS}> as:items ?itemUri . }`);
    return [{ itemUri: { value: 'https://remote.example/users/bob' } }];
  });

  await expect(service.methods.listSenderFollowerUris({ call }, ACTOR, DATASET)).resolves.toEqual([
    'https://remote.example/users/bob'
  ]);
  expect(call).toHaveBeenCalledTimes(1);
});

test('sender follower membership query canonicalizes only the known followers suffix', async () => {
  const call = jest.fn(async (_action, params) => {
    expect(params.query).toContain(`<${FOLLOWERS}> as:items ?itemUri`);
    return [{}];
  });

  await expect(service.methods.listSenderFollowerUris({ call }, `${ACTOR}/`, DATASET)).resolves.toEqual([]);
  expect(call).toHaveBeenCalledTimes(1);
});

test('sender follower membership lookup never falls back to a different dataset on a missing collection', async () => {
  const call = jest.fn(async (_action, params) => {
    expect(params.dataset).toBe(DATASET);
    return [];
  });

  await expect(service.methods.listSenderFollowerUris({ call }, ACTOR, DATASET)).rejects.toThrow(
    /Unable to resolve sender followers collection/u
  );
  expect(call).toHaveBeenCalledTimes(1);
});