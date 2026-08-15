'use strict';

const fs = require('fs');
const path = require('path');

const AUTH_SOURCE = fs.readFileSync(path.join(__dirname, '../services/core/auth.js'), 'utf8');
const PHASE8_COMPOSE = fs.readFileSync(path.join(__dirname, '../../docker-compose-phase8.yml'), 'utf8');

describe('APDM Phase 8 signup bootstrap contract', () => {
  test('ATProto opt-out gates only ATProto after Tier 1 key and ActivityPub provisioning', () => {
    const keyWait = AUTH_SOURCE.indexOf('await this._waitForKeyContainerWithTimeout(ctx, webId);');
    const activityPubProvision = AUTH_SOURCE.indexOf("activitypub-provisioning.provisionForAccount");
    const atprotoGate = AUTH_SOURCE.indexOf('if (this.settings.atproto.autoProvisionOnSignup)');
    const atprotoProvision = AUTH_SOURCE.indexOf("atproto-provisioning.provisionForAccount");

    expect(keyWait).toBeGreaterThan(-1);
    expect(activityPubProvision).toBeGreaterThan(keyWait);
    expect(atprotoGate).toBeGreaterThan(activityPubProvision);
    expect(atprotoProvision).toBeGreaterThan(atprotoGate);
  });

  test('non-production benchmark can explicitly require production-equivalent local bootstrap completion', () => {
    expect(AUTH_SOURCE).toContain("process.env.APODS_FORCE_COMPLETE_SIGNUP_BOOTSTRAP === 'true'");
    expect(AUTH_SOURCE).toContain("process.env.NODE_ENV !== 'production' && !forceCompleteSignupBootstrap");
    expect(AUTH_SOURCE).toContain("callBootstrapReadiness('auth-agent.waitForResourceCreation', { webId })");
    expect(AUTH_SOURCE).toContain("callBootstrapReadiness('data-registry.awaitCreateComplete', { webId })");
    expect(AUTH_SOURCE).toContain("callBootstrapReadiness('type-indexes.awaitCreateComplete', { webId })");
  });

  test('forced benchmark retries only timeout-shaped readiness failures', () => {
    expect(AUTH_SOURCE).toContain('APODS_FORCE_COMPLETE_SIGNUP_BOOTSTRAP_ATTEMPTS');
    expect(AUTH_SOURCE).toContain('isRetryableBootstrapTimeout');
    expect(AUTH_SOURCE).toContain('!isRetryableBootstrapTimeout(error)');
    expect(AUTH_SOURCE).toContain('attempt >= forcedBootstrapReadinessAttempts');
  });

  test('Phase 8 overlay disables only ATProto and forces full local signup bootstrap', () => {
    expect(PHASE8_COMPOSE).toContain("APODS_AUTO_PROVISION_ATPROTO_ON_SIGNUP: 'false'");
    expect(PHASE8_COMPOSE).toContain("APODS_FORCE_COMPLETE_SIGNUP_BOOTSTRAP: 'true'");
    expect(PHASE8_COMPOSE).toContain("APODS_KEY_CONTAINER_WAIT_TIMEOUT_MS: '90000'");
    expect(PHASE8_COMPOSE).toContain("APODS_FORCE_COMPLETE_SIGNUP_BOOTSTRAP_ATTEMPTS: '3'");
  });
});
