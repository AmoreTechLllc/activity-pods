'use strict';

const path = require('path');

const servicePath = path.resolve(__dirname, '../services/core/fep-3b86-activity-intents');

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
  return { params, meta: {} };
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

    it('omits workflow params for intents without a workflow', () => {
      const svc = createInstance();
      const objectLink = svc
        .buildLinks('https://pod.example')
        .find(l => l.rel === 'https://w3id.org/fep/3b86/Object');
      expect(objectLink.template).toBe('https://pod.example/intents/object?object={object}');
      expect(objectLink.template).not.toContain('on-success');
      expect(objectLink.template).not.toContain('on-cancel');
    });

    it('strips a trailing slash from baseUrl', () => {
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
      expect(svc.sanitizeParams({ object: 42, 'on-cancel': null }, intent)).toEqual({});
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
      expect(svc.validateParams({ object: 'javascript:alert(1)' }, followIntent).ok).toBe(false);
    });

    it('rejects file:// and data: URLs', () => {
      expect(svc.validateParams({ object: 'file:///etc/passwd' }, followIntent).ok).toBe(false);
      expect(svc.validateParams({ object: 'data:text/html,evil' }, followIntent).ok).toBe(false);
    });

    it('accepts the (close) workflow token', () => {
      expect(
        svc.validateParams(
          { object: 'https://remote.example/users/bob', 'on-success': '(close)' },
          followIntent
        )
      ).toEqual({ ok: true });
    });

    it('rejects a relative URL in on-success', () => {
      const result = svc.validateParams(
        { object: 'https://remote.example/users/bob', 'on-success': '/somewhere' },
        followIntent
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/on-success/);
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
        evil: 'https://attacker.example'
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

    it('throws on an unknown intent type', () => {
      const svc = createInstance();
      expect(() => svc.runIntent(makeCtx({}), 'NoSuch')).toThrow(/unknown intent type/);
    });

    it('does not propagate workflow params for the Object intent', () => {
      const svc = createInstance();
      const result = svc.runIntent(
        makeCtx({
          object: 'https://remote.example/notes/1',
          'on-success': 'https://remote.example/back'
        }),
        'Object'
      );
      expect(result.redirect).toBe(
        'https://app.example/i/object?object=https%3A%2F%2Fremote.example%2Fnotes%2F1'
      );
    });
  });

  describe('hardening', () => {
    it('rejects http(s) URLs that include userinfo', () => {
      const svc = createInstance();
      const intent = { type: 'Follow', params: ['object'] };
      expect(svc.validateParams({ object: 'https://user@evil.example/' }, intent).ok).toBe(false);
      expect(svc.validateParams({ object: 'https://user:pass@evil.example/' }, intent).ok).toBe(false);
    });

    it('drops parameters whose value exceeds MAX_PARAM_LENGTH', () => {
      const svc = createInstance();
      const big = 'a'.repeat(serviceDefinition.MAX_PARAM_LENGTH + 1);
      const intent = serviceDefinition.INTENT_DEFINITIONS.find(d => d.type === 'Create');
      const out = svc.sanitizeParams({ content: big, name: 'ok' }, intent);
      expect(out.content).toBeUndefined();
      expect(out.name).toBe('ok');
    });

    it('keeps parameters exactly at MAX_PARAM_LENGTH', () => {
      const svc = createInstance();
      const exact = 'a'.repeat(serviceDefinition.MAX_PARAM_LENGTH);
      const intent = serviceDefinition.INTENT_DEFINITIONS.find(d => d.type === 'Create');
      expect(svc.sanitizeParams({ content: exact }, intent).content).toBe(exact);
    });
  });

  it('exports its stable namespace and parameter limit', () => {
    expect(serviceDefinition.REL_NS).toBe('https://w3id.org/fep/3b86/');
    expect(serviceDefinition.MAX_PARAM_LENGTH).toBe(4096);
  });
});
