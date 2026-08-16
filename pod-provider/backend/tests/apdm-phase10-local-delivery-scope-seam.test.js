'use strict';

const fs = require('fs');
const {
  PHASE10_SCOPE_MARKER,
  LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY,
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
  const success = [];
  const failures = [];
  await this.broker.call('activitypub.side-effects.processInbox', { activity: activityToPost, recipients });
  for (const recipientUri of recipients) {
    const account = await this.broker.call('auth.account.findByWebId', { webId: recipientUri });
    if (!account) throw new Error(\`No account found with webId \${recipientUri}\`);
    const dataset = this.settings.podProvider ? account.username : undefined;
    success.push(recipientUri);
  }
      return { success, failures };
    }
`;
}

describe('APDM Phase 10 pinned local-delivery scope seam', () => {
  test('installed SemApps artifact contains optional runner and legacy localPost fallback', () => {
    const source = fs.readFileSync(locateOutboxSource(findPackageRoot()), 'utf8');

    expect(source).toContain(PHASE10_SCOPE_MARKER);
    expect(source).toContain(`Symbol.for('${LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY}')`);
    expect(source).toContain('phase10LocalDeliveryScopeRunner(() => this.localPost(localRecipients, activity));');
    expect(source).toContain('else {\n            this.localPost(localRecipients, activity);\n          }');
  });

  test('patch adds the optional seam exactly once and remains idempotent', () => {
    const once = patchOutboxSource(representativeOutboxSource());
    const twice = patchOutboxSource(once.source);

    expect(once.changed).toBe(true);
    expect(once.source).toContain(PHASE10_SCOPE_MARKER);
    expect(once.source).toContain(`Symbol.for('${LOCAL_DELIVERY_SCOPE_RUNNER_SYMBOL_KEY}')`);
    expect(once.source).toContain('phase10LocalDeliveryScopeRunner(() => this.localPost(localRecipients, activity));');
    expect(once.source).toContain('this.localPost(localRecipients, activity);');
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
    expect((once.source.match(new RegExp(PHASE10_SCOPE_MARKER, 'gu')) || []).length).toBe(1);
  });
});
