'use strict';

const fs = require('fs');
const {
  PATCH_MARKER,
  EXPECTED_VERSION,
  findPackageRoot,
  locateOutboxSource,
  patchOutboxSource
} = require('../scripts/patch-semapps-activitypub-local-delivery');

function representativeOutboxSource() {
  return `
const localRecipients = [];
const remoteRecipients = [];
for (const recipientUri of recipients) {
  if (this.isLocalActor(recipientUri)) {
    const account = await ctx.call('auth.account.findByWebId', { webId: recipientUri });
    if (account) {
      localRecipients.push(recipientUri);
    }
  }
}
if (localRecipients.length > 0) {
  this.localPost(localRecipients, activity);
}
async localPost(recipients, activityToPost) {
  await this.broker.call('activitypub.side-effects.processInbox', { activity: activityToPost, recipients });
  for (const recipientUri of recipients) {
    const account = await this.broker.call('auth.account.findByWebId', { webId: recipientUri });
    if (!account) throw new Error(\`No account found with webId \${recipientUri}\`);
    const dataset = this.settings.podProvider ? account.username : undefined;
  }
}
`;
}

describe('APDM Phase 7 SemApps local delivery patch', () => {
  test('published dependency is pinned to the version the patch was reviewed against', () => {
    const packageRoot = findPackageRoot();
    const packageJson = JSON.parse(fs.readFileSync(`${packageRoot}/package.json`, 'utf8'));
    expect(packageJson.version).toBe(EXPECTED_VERSION);
  });

  test('installed outbox artifact is patched during dependency installation', () => {
    const packageRoot = findPackageRoot();
    const outboxFile = locateOutboxSource(packageRoot);
    const source = fs.readFileSync(outboxFile, 'utf8');

    expect(source).toContain(PATCH_MARKER);
    expect(source).toContain('this.localPost(localRecipients, activity, localRecipientContexts);');
    expect(source).toContain('localRecipientContexts.has(recipientUri)');
    expect(source).toContain("ctx.call('auth.account.findByWebId', { webId: recipientUri })");
    expect(source).toContain("this.broker.call('auth.account.findByWebId', { webId: recipientUri })");
  });

  test('normal post-to-localPost path carries dataset context and preserves a legacy fallback', () => {
    const result = patchOutboxSource(representativeOutboxSource());

    expect(result.changed).toBe(true);
    expect(result.source).toContain(PATCH_MARKER);
    expect(result.source).toContain(
      'dataset: this.settings.podProvider ? account.username : undefined'
    );
    expect(result.source).toContain(
      'this.localPost(localRecipients, activity, localRecipientContexts);'
    );
    expect(result.source).toContain('localRecipientContexts.has(recipientUri)');
    expect(result.source).toContain(
      ": await this.broker.call('auth.account.findByWebId', { webId: recipientUri });"
    );

    // The first lookup still validates that the local actor has a real account. The second lookup
    // remains only as a backward-compatible fallback for direct localPost callers without context.
    expect((result.source.match(/auth\.account\.findByWebId/gu) || []).length).toBe(2);
  });

  test('patch is idempotent', () => {
    const once = patchOutboxSource(representativeOutboxSource());
    const twice = patchOutboxSource(once.source);

    expect(once.changed).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
  });

  test('fails closed when the SemApps outbox contract drifts', () => {
    expect(() => patchOutboxSource('export default {};')).toThrow(
      'SemApps outbox artifact no longer matches the expected v1.1.4 contract'
    );
  });
});
