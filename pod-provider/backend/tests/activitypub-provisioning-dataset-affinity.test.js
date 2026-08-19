'use strict';

const service = require('../services/activitypub-provisioning');

describe('activitypub-provisioning dataset affinity', () => {
  test('polls actor bootstrap through the authoritative account dataset', async () => {
    const webId = 'http://localhost:3000/alice';
    const actor = {
      id: webId,
      preferredUsername: 'alice',
      inbox: `${webId}/inbox`,
      outbox: `${webId}/outbox`,
      followers: `${webId}/followers`,
      following: `${webId}/following`
    };
    const call = jest.fn(async (actionName, params, options) => {
      expect(actionName).toBe('activitypub.actor.awaitCreateComplete');
      expect(params).toEqual({
        actorUri: webId,
        additionalKeys: ['preferredUsername', 'inbox', 'outbox', 'followers', 'following']
      });
      expect(options).toEqual({ meta: { dataset: 'alice' } });
      return actor;
    });

    const result = await service.actions.provisionForAccount.handler({
      params: {
        canonicalAccountId: webId,
        webId,
        username: 'alice',
        profile: { displayName: 'Alice' }
      },
      call
    });

    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      actorId: webId,
      handle: '@alice@localhost',
      inbox: `${webId}/inbox`,
      outbox: `${webId}/outbox`,
      followers: `${webId}/followers`,
      following: `${webId}/following`
    });
  });
});
