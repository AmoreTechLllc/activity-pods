import urlJoin from 'url-join';

function authHeaders() {
  const token = localStorage.getItem('token');
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

export async function resolveFollowIntentTarget(object) {
  const endpoint = new URL(urlJoin(CONFIG.BACKEND_URL, '/api/intents/follow/resolve'));
  endpoint.searchParams.set('object', object);

  const response = await fetch(endpoint.toString(), {
    method: 'GET',
    headers: authHeaders()
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Follow target resolver returned an invalid response');
  }

  if (!response.ok || payload.error) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : payload.error?.message || payload.message || `Follow target resolution failed (${response.status})`;
    throw new Error(message);
  }

  if (typeof payload.recipient !== 'string' || payload.recipient.length === 0) {
    throw new Error('Follow target resolver did not return a recipient actor');
  }

  return payload.recipient;
}
