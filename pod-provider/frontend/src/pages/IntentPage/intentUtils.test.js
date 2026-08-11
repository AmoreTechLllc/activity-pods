import { buildIntentActivity, getWorkflowAction, parseIntentSearch } from './intentUtils';

const params = values => new URLSearchParams(values);

describe('Activity Intent utilities', () => {
  test('rejects missing object on object-targeting intents', () => {
    expect(parseIntentSearch('Follow', params({}))).toMatchObject({ ok: false });
  });

  test('rejects unsafe object and workflow URLs', () => {
    expect(parseIntentSearch('Like', params({ object: 'javascript:alert(1)' }))).toMatchObject({ ok: false });
    expect(
      parseIntentSearch('Like', params({ object: 'https://example.test/post', 'on-success': 'data:text/html,evil' }))
    ).toMatchObject({ ok: false });
  });

  test('accepts constrained Create fields and ignores unknown parameters', () => {
    const result = parseIntentSearch(
      'Create',
      params({
        type: 'Note',
        content: 'Hello',
        audience: 'https://www.w3.org/ns/activitystreams#Public',
        context: 'https://example.test/thread/1',
        attacker: 'drop-me'
      })
    );
    expect(result.ok).toBe(true);
    expect(result.params).toEqual({
      type: 'Note',
      content: 'Hello',
      audience: 'https://www.w3.org/ns/activitystreams#Public',
      context: 'https://example.test/thread/1'
    });
  });

  test('builds targeted activities with the authenticated outbox owner', () => {
    expect(
      buildIntentActivity('Announce', { object: 'https://example.test/post/1' }, 'https://pod.test/alice')
    ).toEqual({
      type: 'Announce',
      actor: 'https://pod.test/alice',
      object: 'https://example.test/post/1'
    });
  });

  test('builds Create with an embedded object and defaults to Note', () => {
    expect(
      buildIntentActivity('Create', { content: 'Hello', summary: 'CW' }, 'https://pod.test/alice')
    ).toEqual({
      type: 'Create',
      actor: 'https://pod.test/alice',
      object: { type: 'Note', content: 'Hello', summary: 'CW' }
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
