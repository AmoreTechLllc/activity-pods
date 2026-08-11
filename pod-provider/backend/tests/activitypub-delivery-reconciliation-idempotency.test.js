'use strict';

const { createDeliveryIntentId } = require('../utils/activitypub-delivery-planner');

function shuffled(values, seed) {
  const copy = [...values];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

test('APDM recovery intent ID is stable across many recipient permutations and duplicates', () => {
  const local = ['https://pods.example/a', 'https://pods.example/b', 'https://pods.example/c'];
  const remote = ['https://one.example/u/a', 'https://two.example/u/b', 'https://three.example/u/c'];
  const expected = createDeliveryIntentId({
    activityId: 'https://pods.example/alice/activities/property',
    actorUri: 'https://pods.example/alice',
    localRecipientUris: local,
    remoteRecipientUris: remote
  });

  for (let seed = 1; seed <= 50; seed += 1) {
    expect(createDeliveryIntentId({
      activityId: 'https://pods.example/alice/activities/property',
      actorUri: 'https://pods.example/alice',
      localRecipientUris: [...shuffled(local, seed), local[0]],
      remoteRecipientUris: [...shuffled(remote, seed * 17), remote[1]]
    })).toBe(expected);
  }
});
