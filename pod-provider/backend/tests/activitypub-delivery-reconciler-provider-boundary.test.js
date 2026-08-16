'use strict';

process.env.SEMAPPS_AVAILABLE_LOCALES ||= 'en';
process.env.SEMAPPS_AUTH_RESERVED_USER_NAMES ||= 'admin';

const service = require('../services/activitypub-delivery-reconciler.service');

const ACTOR = 'https://pods.example/alice';
const LOOKALIKE = 'https://pods.example.evil/users/bob';

function reconciliationContext(baseUri = 'https://pods.example') {
  return {
    settings: { baseUri, accountsDataset: 'settings' },
    logger: { debug: jest.fn(), warn: jest.fn() },
    expandConcreteRecipients: service.methods.expandConcreteRecipients,
    findLocalAccountsByWebIds: service.methods.findLocalAccountsByWebIds,
    listSenderFollowerUris: service.methods.listSenderFollowerUris
  };
}

test('lookalike provider host is classified as remote and never queried as a local account', async () => {
  const accountQuery = jest.fn();
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'activitypub.activity.getRecipients') return [LOOKALIKE];
      if (action === 'triplestore.query') return accountQuery(params);
      if (action === 'activitypub.actor.get') {
        expect(params.actorUri).toBe(LOOKALIKE);
        return { id: LOOKALIKE, inbox: `${LOOKALIKE}/inbox` };
      }
      throw new Error(`Unexpected call ${action}`);
    })
  };

  const plan = await service.methods.reconcileActivity.call(
    reconciliationContext(),
    ctx,
    {
      id: `${ACTOR}/activities/1`,
      type: 'Create',
      actor: ACTOR,
      to: [LOOKALIKE],
      object: { id: `${ACTOR}/objects/1`, type: 'Note', attributedTo: ACTOR }
    },
    'alice'
  );

  expect(accountQuery).not.toHaveBeenCalled();
  expect(plan.localRecipients).toEqual([]);
  expect(plan.remoteRecipients).toEqual([
    expect.objectContaining({ actorUri: LOOKALIKE, targetDomain: 'pods.example.evil' })
  ]);
});

test('lookalike provider followers collection is rejected before local collection access', async () => {
  const ctx = { call: jest.fn() };

  await expect(
    service.methods.expandConcreteRecipients.call(
      reconciliationContext(),
      ctx,
      { actor: ACTOR },
      [`${LOOKALIKE}/followers`],
      'alice',
      { actorUri: ACTOR, items: null }
    )
  ).rejects.toThrow(/Cannot safely reconcile unresolved remote followers collection/u);

  expect(ctx.call).not.toHaveBeenCalled();
});

test('path-prefix lookalike is remote when provider is mounted below a path', async () => {
  const baseUri = 'https://pods.example/provider';
  const lookalikePath = 'https://pods.example/provider-evil/users/bob';
  const ctx = {
    call: jest.fn(async (action, params) => {
      if (action === 'activitypub.activity.getRecipients') return [lookalikePath];
      if (action === 'activitypub.actor.get') {
        return { id: params.actorUri, inbox: `${params.actorUri}/inbox` };
      }
      if (action === 'triplestore.query') throw new Error('path lookalike must not be queried as local');
      throw new Error(`Unexpected call ${action}`);
    })
  };

  const plan = await service.methods.reconcileActivity.call(
    reconciliationContext(baseUri),
    ctx,
    {
      id: 'https://pods.example/provider/alice/activities/1',
      type: 'Create',
      actor: 'https://pods.example/provider/alice',
      to: [lookalikePath],
      object: {
        id: 'https://pods.example/provider/alice/objects/1',
        type: 'Note',
        attributedTo: 'https://pods.example/provider/alice'
      }
    },
    'alice'
  );

  expect(plan.localRecipients).toEqual([]);
  expect(plan.remoteRecipients[0].actorUri).toBe(lookalikePath);
});
