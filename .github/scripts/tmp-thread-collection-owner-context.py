from pathlib import Path


def replace_exact(path, old, new, label, count=1):
    text = path.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{label}: expected {count} matches, found {actual}")
    path.write_text(text.replace(old, new))


blocked = Path("pod-provider/backend/services/activitypub-blocked-collection.service.js")
muted = Path("pod-provider/backend/services/activitypub-muted-collection.service.js")
regression = Path("pod-provider/backend/tests/activitypub-collection-dataset-context.test.js")
blocked_test = Path("pod-provider/backend/tests/activitypub-blocked-collection.test.js")
muted_test = Path("pod-provider/backend/tests/activitypub-muted-collection.test.js")

# Registry bootstrap must enter SemApps with the owning dataset in ctx.meta so
# createAndAttachCollection's nested exist/post/LDP calls cannot select another pod.
replace_exact(
    blocked,
    """      await ctx.call('activitypub.collections-registry.createAndAttachCollection', {
        objectUri: actorUri,
        collection: this.settings.blockedCollectionOptions
      });
      await ctx.call('activitypub.collections-registry.createAndAttachCollection', {
        objectUri: actorUri,
        collection: this.settings.blocksCollectionOptions
      });""",
    """      await ctx.call(
        'activitypub.collections-registry.createAndAttachCollection',
        {
          objectUri: actorUri,
          collection: this.settings.blockedCollectionOptions
        },
        { meta: { dataset } }
      );
      await ctx.call(
        'activitypub.collections-registry.createAndAttachCollection',
        {
          objectUri: actorUri,
          collection: this.settings.blocksCollectionOptions
        },
        { meta: { dataset } }
      );""",
    "blocked registry bootstrap context",
)
replace_exact(
    muted,
    """      await ctx.call('activitypub.collections-registry.createAndAttachCollection', {
        objectUri: actorUri,
        collection: this.settings.mutedCollectionOptions
      });""",
    """      await ctx.call(
        'activitypub.collections-registry.createAndAttachCollection',
        {
          objectUri: actorUri,
          collection: this.settings.mutedCollectionOptions
        },
        { meta: { dataset } }
      );""",
    "muted registry bootstrap context",
)

# Reuse the top-level bootstrap dataset in the public branch.
replace_exact(
    blocked,
    """        await this.ensureBlockedFollowersCollection(ctx, blockedCollectionUri, actorUri);
        await this.ensurePublicReadOnBlockedCollection(ctx, blockedCollectionUri, actorUri, true);""",
    """        await this.ensureBlockedFollowersCollection(ctx, blockedCollectionUri, actorUri, dataset);
        await this.ensurePublicReadOnBlockedCollection(ctx, blockedCollectionUri, actorUri, true, dataset);""",
    "blocked public bootstrap context",
)
replace_exact(
    muted,
    """        await this.ensureMutedFollowersCollection(ctx, mutedCollectionUri, actorUri);
        await this.ensurePublicReadOnMutedCollection(ctx, mutedCollectionUri, actorUri, true);""",
    """        await this.ensureMutedFollowersCollection(ctx, mutedCollectionUri, actorUri, dataset);
        await this.ensurePublicReadOnMutedCollection(ctx, mutedCollectionUri, actorUri, true, dataset);""",
    "muted public bootstrap context",
)

# Followers helpers are safe both from bootstrap (dataset supplied) and normal actions
# (dataset resolved fail-closed from actor owner).
replace_exact(
    blocked,
    """    async ensureBlockedFollowersCollection(ctx, blockedCollectionUri, actorUri) {
      const existingState = await this.getBlockedCollectionSharingStateByCollectionUri(ctx, blockedCollectionUri);""",
    """    async ensureBlockedFollowersCollection(ctx, blockedCollectionUri, actorUri, dataset) {
      const resolvedDataset = dataset || (await this.resolveActorDataset(ctx, actorUri));
      const existingState = await this.getBlockedCollectionSharingStateByCollectionUri(
        ctx,
        blockedCollectionUri,
        resolvedDataset
      );""",
    "blocked followers helper context",
)
replace_exact(
    muted,
    """    async ensureMutedFollowersCollection(ctx, mutedCollectionUri, actorUri) {
      const existingState = await this.getMutedCollectionSharingStateByCollectionUri(ctx, mutedCollectionUri);""",
    """    async ensureMutedFollowersCollection(ctx, mutedCollectionUri, actorUri, dataset) {
      const resolvedDataset = dataset || (await this.resolveActorDataset(ctx, actorUri));
      const existingState = await this.getMutedCollectionSharingStateByCollectionUri(
        ctx,
        mutedCollectionUri,
        resolvedDataset
      );""",
    "muted followers helper context",
)

for path, label in ((blocked, "blocked"), (muted, "muted")):
    replace_exact(
        path,
        """      const exists = await ctx.call('activitypub.collection.exist', {
        resourceUri: followersCollectionUri,
        webId: 'system'
      });""",
        """      const exists = await ctx.call(
        'activitypub.collection.exist',
        {
          resourceUri: followersCollectionUri,
          webId: 'system'
        },
        { meta: { dataset: resolvedDataset } }
      );""",
        f"{label} followers exist dataset",
    )
    replace_exact(
        path,
        """          meta: {
              forcedResourceUri: followersCollectionUri
            }""",
        """          meta: {
              dataset: resolvedDataset,
              forcedResourceUri: followersCollectionUri
            }""",
        f"{label} followers post dataset",
    )

replace_exact(
    blocked,
    """        {
          resourceUri: blockedCollectionUri,
          triplesToAdd: [
            quad(namedNode(blockedCollectionUri), namedNode(AS_FOLLOWERS_PREDICATE), namedNode(followersCollectionUri))
          ]
        },
        {
          meta: {
            skipObjectsWatcher: true
          }
        }
      );

      return followersCollectionUri;""",
    """        {
          resourceUri: blockedCollectionUri,
          webId: actorUri,
          triplesToAdd: [
            quad(namedNode(blockedCollectionUri), namedNode(AS_FOLLOWERS_PREDICATE), namedNode(followersCollectionUri))
          ]
        },
        {
          meta: {
            dataset: resolvedDataset,
            skipObjectsWatcher: true
          }
        }
      );

      return followersCollectionUri;""",
    "blocked followers attachment patch context",
)
replace_exact(
    muted,
    """        {
          resourceUri: mutedCollectionUri,
          triplesToAdd: [
            quad(namedNode(mutedCollectionUri), namedNode(AS_FOLLOWERS_PREDICATE), namedNode(followersCollectionUri))
          ]
        },
        {
          meta: {
            skipObjectsWatcher: true
          }
        }
      );

      return followersCollectionUri;""",
    """        {
          resourceUri: mutedCollectionUri,
          webId: actorUri,
          triplesToAdd: [
            quad(namedNode(mutedCollectionUri), namedNode(AS_FOLLOWERS_PREDICATE), namedNode(followersCollectionUri))
          ]
        },
        {
          meta: {
            dataset: resolvedDataset,
            skipObjectsWatcher: true
          }
        }
      );

      return followersCollectionUri;""",
    "muted followers attachment patch context",
)

# Public ACL changes also execute under the owning dataset. The optional argument
# preserves existing callers while still failing closed if no owner can be resolved.
replace_exact(
    blocked,
    """    async ensurePublicReadOnBlockedCollection(ctx, blockedCollectionUri, actorUri, isPublic) {
      if (isPublic) {""",
    """    async ensurePublicReadOnBlockedCollection(ctx, blockedCollectionUri, actorUri, isPublic, dataset) {
      const resolvedDataset = dataset || (await this.resolveActorDataset(ctx, actorUri));
      if (isPublic) {""",
    "blocked public ACL helper signature",
)
replace_exact(
    muted,
    """    async ensurePublicReadOnMutedCollection(ctx, mutedCollectionUri, actorUri, isPublic) {
      const collectionUri = normalizeResourceUri(mutedCollectionUri);""",
    """    async ensurePublicReadOnMutedCollection(ctx, mutedCollectionUri, actorUri, isPublic, dataset) {
      const resolvedDataset = dataset || (await this.resolveActorDataset(ctx, actorUri));
      const collectionUri = normalizeResourceUri(mutedCollectionUri);""",
    "muted public ACL helper signature",
)

replace_exact(
    blocked,
    """        await ctx.call('webacl.resource.addRights', {
          resourceUri: blockedCollectionUri,
          additionalRights: {
            anon: {
              read: true
            }
          },
          webId: actorUri
        });""",
    """        await ctx.call(
          'webacl.resource.addRights',
          {
            resourceUri: blockedCollectionUri,
            additionalRights: {
              anon: {
                read: true
              }
            },
            webId: actorUri
          },
          { meta: { dataset: resolvedDataset } }
        );""",
    "blocked public ACL add dataset",
)
replace_exact(
    muted,
    """        await ctx.call('webacl.resource.addRights', {
          resourceUri: collectionUri,
          additionalRights: {
            anon: {
              read: true
            }
          },
          webId: actorUri
        });""",
    """        await ctx.call(
          'webacl.resource.addRights',
          {
            resourceUri: collectionUri,
            additionalRights: {
              anon: {
                read: true
              }
            },
            webId: actorUri
          },
          { meta: { dataset: resolvedDataset } }
        );""",
    "muted public ACL add dataset",
)
replace_exact(
    blocked,
    """      await ctx.call('webacl.resource.removeRights', {
        resourceUri: blockedCollectionUri,
        rights: {
          anon: {
            read: true
          }
        },
        webId: actorUri
      });""",
    """      await ctx.call(
        'webacl.resource.removeRights',
        {
          resourceUri: blockedCollectionUri,
          rights: {
            anon: {
              read: true
            }
          },
          webId: actorUri
        },
        { meta: { dataset: resolvedDataset } }
      );""",
    "blocked public ACL remove dataset",
)
replace_exact(
    muted,
    """      await ctx.call('webacl.resource.removeRights', {
        resourceUri: collectionUri,
        rights: {
          anon: {
            read: true
          }
        },
        webId: actorUri
      });""",
    """      await ctx.call(
        'webacl.resource.removeRights',
        {
          resourceUri: collectionUri,
          rights: {
            anon: {
              read: true
            }
          },
          webId: actorUri
        },
        { meta: { dataset: resolvedDataset } }
      );""",
    "muted public ACL remove dataset",
)

# Extend the regression suite so the P1 cannot recur while the narrower actor/query
# assertions continue to protect the original Phase 8 failure.
text = regression.read_text()
anchor = """  test.each([
    [
      'blocked',
      blockedService,
      'getBlockedCollectionSharingStateByCollectionUri',"""
extra = """  test.each([
    ['blocked', blockedService, 2],
    ['muted', mutedService, 1]
  ])('%s bootstrap scopes registry collection creation to the owner dataset', async (_name, service, expectedCalls) => {
    const { ctx, calls } = makeContext();
    const methods = bindMethods(service);

    await methods.ensureCollectionsForActor(ctx, ACTOR_URI, DATASET);

    const registryCalls = calls.filter(
      call => call.action === 'activitypub.collections-registry.createAndAttachCollection'
    );
    expect(registryCalls).toHaveLength(expectedCalls);
    for (const call of registryCalls) {
      expect(call.options).toEqual({ meta: { dataset: DATASET } });
    }
  });

  test.each([
    ['blocked', blockedService, 'ensureBlockedFollowersCollection', `${ACTOR_URI}/blocked`],
    ['muted', mutedService, 'ensureMutedFollowersCollection', `${ACTOR_URI}/muted`]
  ])('%s follower bootstrap carries owner context through nested operations', async (_name, service, methodName, collectionUri) => {
    const { ctx, calls } = makeContext();
    const methods = bindMethods(service);

    await methods[methodName](ctx, collectionUri, ACTOR_URI, DATASET);

    expect(calls).toContainEqual(
      expect.objectContaining({
        action: 'activitypub.collection.exist',
        options: { meta: { dataset: DATASET } }
      })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        action: 'activitypub.collection.post',
        params: expect.objectContaining({ webId: ACTOR_URI }),
        options: { meta: expect.objectContaining({ dataset: DATASET }) }
      })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        action: 'ldp.resource.patch',
        params: expect.objectContaining({ webId: ACTOR_URI }),
        options: { meta: expect.objectContaining({ dataset: DATASET, skipObjectsWatcher: true }) }
      })
    );
  });

"""
if text.count(anchor) != 1:
    raise SystemExit(f"regression insertion anchor: expected 1, found {text.count(anchor)}")
regression.write_text(text.replace(anchor, extra + anchor))

# Existing startup tests now assert the dataset-bearing parent context explicitly.
for path, collection_expressions in (
    (blocked_test, ("service.settings.blockedCollectionOptions", "service.settings.blocksCollectionOptions")),
    (muted_test, ("service.settings.mutedCollectionOptions",)),
):
    text = path.read_text()
    for expr in collection_expressions:
        old = f"""    expect(broker.call).toHaveBeenCalledWith('activitypub.collections-registry.createAndAttachCollection', {{
      objectUri: 'https://fed.example.com/users/alice',
      collection: {expr}
    }});"""
        new = f"""    expect(broker.call).toHaveBeenCalledWith(
      'activitypub.collections-registry.createAndAttachCollection',
      {{
        objectUri: 'https://fed.example.com/users/alice',
        collection: {expr}
      }},
      {{ meta: {{ dataset: 'alice' }} }}
    );"""
        if text.count(old) != 1:
            raise SystemExit(f"startup expectation {path} {expr}: expected 1, found {text.count(old)}")
        text = text.replace(old, new)
    path.write_text(text)
