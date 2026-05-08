'use strict';

const path = require('path');

const servicePath = path.resolve(__dirname, '../services/core/fep-3b86-activity-intents');

// Load the service module, but bypass the CONFIG side-effects that depend on
// dotenv-flow. We re-require with overridden settings instead of relying on
// process.env.
jest.mock('../config/config', () => ({
  BASE_URL: 'https://pod.example',
  FRONTEND_URL: 'https://app.example'
}));

const serviceDefinition = require(servicePath);

function createInstance(overrides = {}) {
  return {
    settings: {
      baseUrl: 'https://pod.example',
      frontendUrl: 'https://app.example',
      intents: serviceDefinition.INTENT_DEFINITIONS,
      ...overrides
    },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...serviceDefinition.methods
  };
}

function makeCtx(params) {
  return {
    params,
    meta: {}
  };
}

describe('fep-3b86-activity-intents', () => {
  describe('buildLinks', () => {
    it('emits a link template per registered intent rooted at baseUrl', () => {
      const svc = createInstance();
      const links = svc.buildLinks('https://pod.example/');

      expect(links).toHaveLength(serviceDefinition.INTENT_DEFINITIONS.length);
      const follow = links.find(l => l.rel === 'https://w3id.org/fep/3b86/Follow');
      expect(follow.template).toBe(
        'https://pod.example/intents/follow?object={object}&on-success={on-success}&on-cancel={on-cancel}'
      );

      const createIntent = links.find(l => l.rel === 'https://w3id.org/fep/3b86/Create');
      expect(createIntent.template).toContain('content={content}');
      expect(createIntent.template).toContain('inReplyTo={inReplyTo}');
    });

    it('omits workflow params for intents without a workflow (Object intent)', () => {
      const svc = createInstance();
      const links = svc.buildLinks('https://pod.example');
      const objectLink = links.find(l => l.rel === 'https://w3id.org/fep/3b86/Object');
      expect(objectLink.template).toBe('https://pod.example/intents/object?object={object}');
      expect(objectLink.template).not.toContain('on-success');
      expect(objectLink.template).not.toContain('on-cancel');
    });

    it('strips a trailing slash from baseUrl so paths concatenate cleanly', () => {
      const svc = createInstance();
      const links = svc.buildLinks('https://pod.example/');
      for (const link of links) {
        expect(link.template.startsWith('https://pod.example/intents/')).toBe(true);
        expect(link.template).not.toContain('https://pod.example//');
      }
    });
  });

  describe('sanitizeParams', () => {
    it('drops parameters that are not in the intent definition', () => {
      const svc = createInstance();
      const intent = serviceDefinition.INTENT_DEFINITIONS.find(d => d.type === 'Follow');
      const out = svc.sanitizeParams(
        {
          object: 'https://remote.example/users/bob',
          attacker: 'https://evil.example',
          __proto__: 'oops',
          'on-success': 'https://app.example/done'
        },
        intent
      );
      expect(out).toEqual({
        object: 'https://remote.example/users/bob',
        'on-success': 'https://app.example/done'
      });
      expect(out.attacker).toBeUndefined();
    });

    it('drops non-string values', () => {
      const svc = createInstance();
      const intent = serviceDefinition.INTENT_DEFINITIONS.find(d => d.type === 'Follow');
      const out = svc.sanitizeParams({ object: 42, 'on-cancel': null }, intent);
      expect(out).toEqual({});
    });
  });

  describe('validateParams', () => {
    const svc = createInstance();
    const followIntent = serviceDefinition.INTENT_DEFINITIONS.find(d => d.type === 'Follow');
    const createIntent = serviceDefinition.INTENT_DEFINITIONS.find(d => d.type === 'Create');

    it('requires object for Follow', () => {
      expect(svc.validateParams({}, followIntent)).toMatchObject({ ok: false });
    });

    it('does not require object for Create', () => {
      expect(svc.validateParams({ content: 'hello' }, createIntent)).toEqual({ ok: true });
    });

    it('rejects non-http URLs in object', () => {
      const r = svc.validateParams({ object: 'javascript:alert(1)' }, followIntent);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Invalid URL/);
    });

    it('rejects file:// and data: URLs', () => {
      expect(
        svc.validateParams({ object: 'file:///etc/passwd' }, followIntent).ok
      ).toBe(false);
      expect(
        svc.validateParams({ object: 'data:text/html,evil' }, followIntent).ok
      ).toBe(false);
    });

    it('accepts the (close) workflow token', () => {
      expect(
        svc.validateParams(
          { object: 'https://remote.example/users/bob', 'on-success': '(close)' },
          followIntent
        )
      ).toEqual({ ok: true });
    });

    it('rejects a relative URL in on-success (open-redirect guard)', () => {
      const r = svc.validateParams(
        { object: 'https://remote.example/users/bob', 'on-success': '/somewhere' },
        followIntent
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/on-success/);
    });

    it('accepts an absolute URL in on-cancel', () => {
      expect(
        svc.validateParams(
          { object: 'https://remote.example/users/bob', 'on-cancel': 'https://remote.example/cancel' },
          followIntent
        )
      ).toEqual({ ok: true });
    });
  });

  describe('runIntent', () => {
    it('redirects to the frontend with sanitized query string and 302 status', () => {
      const svc = createInstance();
      const ctx = makeCtx({
        object: 'https://remote.example/users/bob',
        'on-success': 'https://remote.example/back',
        evil: 'https://attacker.example' // dropped by sanitize
      });

      const result = svc.runIntent(ctx, 'Follow');

      expect(ctx.meta.$statusCode).toBe(302);
      expect(ctx.meta.$responseHeaders.Location).toBe(
        'https://app.example/i/follow?object=https%3A%2F%2Fremote.example%2Fusers%2Fbob&on-success=https%3A%2F%2Fremote.example%2Fback'
      );
      expect(result.redirect).toBe(ctx.meta.$responseHeaders.Location);
    });

    it('returns 400 when validation fails', () => {
      const svc = createInstance();
      const ctx = makeCtx({ object: 'not-a-url' });
      const result = svc.runIntent(ctx, 'Follow');
      expect(ctx.meta.$statusCode).toBe(400);
      expect(result.error).toMatch(/Invalid URL/);
    });

    it('throws on an unknown intent type (defensive)', () => {
      const svc = createInstance();
      expect(() => svc.runIntent(makeCtx({}), 'NoSuch')).toThrow(/unknown intent type/);
    });

    it('does not propagate workflow params for the Object intent', () => {
      const svc = createInstance();
      const ctx = makeCtx({
        object: 'https://remote.example/notes/1',
        'on-success': 'https://remote.example/back'
      });
      const result = svc.runIntent(ctx, 'Object');
      // 'on-success' is not in the Object intent's allowed list, so it is
      // dropped during sanitize and never appears in the redirect URL.
      expect(result.redirect).toBe(
        'https://app.example/i/object?object=https%3A%2F%2Fremote.example%2Fnotes%2F1'
      );
    });
  });

  describe('hardening', () => {
    it('rejects http(s) URLs that include userinfo (phishing guard)', () => {
      const svc = createInstance();
      // Both username and password forms must be rejected.
      const r1 = svc.validateParams({ object: 'https://user@evil.example/' }, { type: 'Follow', params: ['object'] });
      expect(r1.ok).toBe(false);
      const r2 = svc.validateParams({ object: 'https://user:pass@evil.example/' }, { type: 'Follow', params: ['object'] });
      expect(r2.ok).toBe(false);
    });

    it('drops parameters whose value exceeds MAX_PARAM_LENGTH', () => {
      const svc = createInstance();
      const big = 'a'.repeat(serviceDefinition.MAX_PARAM_LENGTH + 1);
      const intent = serviceDefinition.INTENT_DEFINITIONS.find(d => d.type === 'Create');
      const out = svc.sanitizeParams({ content: big, name: 'ok' }, intent);
      expect(out.content).toBeUndefined();
      expect(out.name).toBe('ok');
    });

    it('keeps parameters whose value is exactly MAX_PARAM_LENGTH', () => {
      const svc = createInstance();
      const exact = 'a'.repeat(serviceDefinition.MAX_PARAM_LENGTH);
      const intent = serviceDefinition.INTENT_DEFINITIONS.find(d => d.type === 'Create');
      const out = svc.sanitizeParams({ content: exact }, intent);
      expect(out.content).toBe(exact);
    });
  });

  describe('exports', () => {
    it('exports REL_NS for cross-module use', () => {
      expect(serviceDefinition.REL_NS).toBe('https://w3id.org/fep/3b86/');
    });

    it('exports MAX_PARAM_LENGTH', () => {
      expect(typeof serviceDefinition.MAX_PARAM_LENGTH).toBe('number');
      expect(serviceDefinition.MAX_PARAM_LENGTH).toBeGreaterThan(0);
    });
  });
});
