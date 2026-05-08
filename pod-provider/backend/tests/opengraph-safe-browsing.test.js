'use strict';

// Tests for the Safe Browsing wrapper added to utils/opengraph.js.
// Covers feature-disabled (no key), positive/negative threat responses,
// fail-open default on API errors, and SAFE_BROWSING_FAIL_CLOSED override.

jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');
const path = require('path');

const og = require(path.resolve(__dirname, '../utils/opengraph'));

describe('opengraph passesSafeBrowsing', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GOOGLE_SAFE_BROWSING_API_KEY;
    delete process.env.SAFE_BROWSING_API_KEY;
    delete process.env.SAFE_BROWSING_FAIL_CLOSED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fetch.mockReset();
  });

  it('returns true when no API key is configured (feature disabled)', async () => {
    delete process.env.GOOGLE_SAFE_BROWSING_API_KEY;
    delete process.env.SAFE_BROWSING_API_KEY;
    
    await expect(og.passesSafeBrowsing('https://example.com/')).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns true when API responds with empty threats array', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'k';
    fetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ threats: [] })
    });
    
    await expect(og.passesSafeBrowsing('https://example.com/')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, opts] = fetch.mock.calls[0];
    expect(endpoint).toMatch(/safebrowsing\.googleapis\.com\/v5alpha1\/urls:search/);
    expect(opts.headers['x-goog-api-key']).toBe('k');
  });

  it('returns false when API reports threats', async () => {
    process.env.SAFE_BROWSING_API_KEY = 'k';
    fetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ threats: [{ type: 'MALWARE' }] })
    });
    
    await expect(og.passesSafeBrowsing('https://malware.example/')).resolves.toBe(false);
  });

  it('fails open by default when API returns non-2xx', async () => {
    process.env.SAFE_BROWSING_API_KEY = 'k';
    fetch.mockResolvedValue({ ok: false, text: async () => '' });
    
    await expect(og.passesSafeBrowsing('https://example.com/')).resolves.toBe(true);
  });

  it('fails open by default when fetch rejects', async () => {
    process.env.SAFE_BROWSING_API_KEY = 'k';
    fetch.mockRejectedValue(new Error('network'));
    
    await expect(og.passesSafeBrowsing('https://example.com/')).resolves.toBe(true);
  });

  it('fails closed when SAFE_BROWSING_FAIL_CLOSED=1 and API errors', async () => {
    process.env.SAFE_BROWSING_API_KEY = 'k';
    process.env.SAFE_BROWSING_FAIL_CLOSED = '1';
    fetch.mockRejectedValue(new Error('network'));
    
    await expect(og.passesSafeBrowsing('https://example.com/')).resolves.toBe(false);
  });

  it('fails open on malformed JSON response (default mode)', async () => {
    process.env.SAFE_BROWSING_API_KEY = 'k';
    fetch.mockResolvedValue({ ok: true, text: async () => 'not json' });
    
    await expect(og.passesSafeBrowsing('https://example.com/')).resolves.toBe(true);
  });

  it('prefers GOOGLE_SAFE_BROWSING_API_KEY over SAFE_BROWSING_API_KEY', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'primary';
    process.env.SAFE_BROWSING_API_KEY = 'secondary';
    fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ threats: [] }) });
    
    await og.passesSafeBrowsing('https://example.com/');
    expect(fetch.mock.calls[0][1].headers['x-goog-api-key']).toBe('primary');
  });
});
