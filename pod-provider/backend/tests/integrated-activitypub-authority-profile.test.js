'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../../scripts/start-local-services.sh'),
  'utf8'
);

function sourceIndex(fragment) {
  const index = source.indexOf(fragment);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function expectExported(variable) {
  const exportLines = source
    .split(/\r?\n/u)
    .filter(line => /^\s*export\s+/u.test(line));
  expect(exportLines.some(line => line.split(/\s+/u).includes(variable))).toBe(true);
}

describe('integrated ActivityPods federation authority launcher', () => {
  test('selects explicit sidecar external preview authority for integrated development', () => {
    expect(source).toContain('NODE_ENV=development');
    expect(source).toContain('SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=external');
    expect(source).toContain('SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=true');
    expect(source).toContain('SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER=false');
    expect(source).toContain('SIDECAR_DELIVERY_HANDOFF_URL=http://127.0.0.1:8080/webhook/outbox');
  });

  test('exports authority inputs before starting ActivityPods', () => {
    for (const variable of [
      'NODE_ENV',
      'SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE',
      'SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW',
      'SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER',
      'SIDECAR_DELIVERY_HANDOFF_URL',
      'SIDECAR_TOKEN'
    ]) {
      expectExported(variable);
    }
  });

  test('starts the sidecar before the backend', () => {
    expect(sourceIndex('start_bg_if_needed "Fedify sidecar"')).toBeLessThan(
      sourceIndex('start_bg_if_needed "ActivityPods backend"')
    );
  });

  test('restarts a managed backend when its authority profile changes', () => {
    expect(source).toContain('DESIRED_AUTHORITY_PROFILE="external-preview"');
    expect(source).toContain('current_profile=$(cat "$AUTHORITY_PROFILE_FILE"');
    expect(source).toContain('kill_pidfile "$PID_DIR/backend.pid" "ActivityPods backend"');
    expect(source).toContain('printf \'%s\\n\' "$DESIRED_AUTHORITY_PROFILE" >"$AUTHORITY_PROFILE_FILE"');
  });

  test('fails closed when an unmanaged backend already owns the ActivityPods port', () => {
    expect(source).toContain(
      'fail "ActivityPods backend already listens on :3000 outside this launcher\'s managed pidfile; cannot verify or change its federation authority profile"'
    );
  });
});
