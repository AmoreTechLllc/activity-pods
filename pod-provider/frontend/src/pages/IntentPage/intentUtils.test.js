import { buildIntentActivity, getWorkflowAction, parseIntentSearch, PUBLIC_URI } from './intentUtils';

const params = values => new URLSearchParams(values);

describe('Activity Intent utilities', () => {
  test('rejects missing object on object-targeting intents', () => {
    expect(parseIntentSearch('Follow', params({}))).toMatchObject({ ok: false });
  });

  test('rejects unsafe object and workflow URLs', () => {
    expect(parseIntentSearch('Announce', params({ object: 'javascript:alert(1)' }))).toMatchObject({ ok: false });
    expect(
      parseIntentSearch('Announce', params({ object: 'https://example.test/post', 'on-success': 'data:text/html,evil' }))
    ).toMatchObject({ ok: false });
  });

  test('accepts constrained Create fields and ignores unsupported thread and unknown parameters', () => {
    const result = parseIntentSearch(
      'Create',
      params({
        type: 'Note',
        content: 'Hello',
        inReplyTo: 'https://example.test/thread/parent',
        audience: 'https://www.w3.org/ns/activitystreams#Public',
        context: 'https://example.test/thread/1',
        attacker: 'drop-me'
      })
    );
    expect(result.ok).toBe(true);
    expect(result.params).toEqual({
      type: 'Note',
      content: 'Hello'
    });
  });

  test('rejects intent types that are not advertised as executable', () => {
    expect(parseIntentSearch('Like', params({ object: 'https://example.test/post/1' }))).toEqual({
      ok: false,
      error: 'Unsupported Activity Intent'
    });
    expect(parseIntentSearch('Flag', params({ object: 'https://example.test/post/1' }))).toMatchObject({ ok: false });
    expect(parseIntentSearch('Block', params({ object: 'https://example.test/users/bob' }))).toMatchObject({ ok: false });
  });

  test('preserves an actor target as Follow object while addressing its resolved delivery actor', () => {
    expect(
      buildIntentActivity(
        'Follow',
        { object: 'https://remote.test/users/bob' },
        'https://pod.test/alice',
        { followRecipient: 'https://remote.test/users/bob' }
      )
    ).toEqual({
      type: 'Follow',
      actor: 'https://pod.test/alice',
      object: 'https://remote.test/users/bob',
      to: 'https://remote.test/users/bob'
    });
  });

  test('preserves a followable Note as Follow object while addressing its attributedTo actor', () => {
    expect(
      buildIntentActivity(
        'Follow',
        { object: 'https://remote.test/notes/1' },
        'https://pod.test/alice',
        { followRecipient: 'https://remote.test/users/bob' }
      )
    ).toEqual({
      type: 'Follow',
      actor: 'https://pod.test/alice',
      object: 'https://remote.test/notes/1',
      to: 'https://remote.test/users/bob'
    });
  });

  test('fails closed if Follow has not been resolved to a delivery actor', () => {
    expect(() =>
      buildIntentActivity('Follow', { object: 'https://remote.test/notes/1' }, 'https://pod.test/alice')
    ).toThrow(/resolved to a deliverable actor/);
  });

  test('addresses Announce publicly and to the authenticated actor followers collection', () => {
    expect(
      buildIntentActivity('Announce', { object: 'https://example.test/post/1' }, 'https://pod.test/alice')
    ).toEqual({
      type: 'Announce',
      actor: 'https://pod.test/alice',
      object: 'https://example.test/post/1',
      to: PUBLIC_URI,
      cc: ['https://pod.test/alice/followers']
    });
  });

  test('builds Create with an embedded object and public follower addressing', () => {
    expect(
      buildIntentActivity('Create', { content: 'Hello', summary: 'CW' }, 'https://pod.test/alice/')
    ).toEqual({
      type: 'Create',
      actor: 'https://pod.test/alice/',
      object: { type: 'Note', content: 'Hello', summary: 'CW' },
      to: PUBLIC_URI,
      cc: ['https://pod.test/alice/followers']
    });
  });

  test('does not create an Activity for Object intents', () => {
    expect(buildIntentActivity('Object', { object: 'https://example.test/post/1' }, 'https://pod.test/alice')).toBeNull();
  });

  test('never automatically follows external workflow URLs', () => {
    expect(getWorkflowAction({ 'on-success': 'https://requester.test/done' }, 'success')).toEqual({
      kind: 'confirm-navigation',
      target: 'https://requester.test/done'
    });
    expect(getWorkflowAction({ 'on-cancel': '(close)' }, 'cancel')).toEqual({ kind: 'close' });
  });
});
