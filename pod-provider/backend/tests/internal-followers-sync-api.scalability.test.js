const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../services/internal-followers-sync-api.service.js'),
  'utf8'
);

describe('internal-followers-sync-api SPARQL scalability', () => {
  test('reverse follow lookup leads with the bound remote membership pattern', () => {
    const section = source.slice(
      source.indexOf('getLocalFollowersOfRemote:'),
      source.indexOf('// =========================================================================\n    // POST /unfollow')
    );

    const selectiveMembership = section.indexOf('?followingUri as:items <${remoteActorUri}> .');
    const actorJoin = section.indexOf('?actorUri as:following ?followingUri .');

    expect(selectiveMembership).toBeGreaterThan(-1);
    expect(actorJoin).toBeGreaterThan(selectiveMembership);
    expect(section).toContain('SELECT DISTINCT ?actorUri');
    expect(section).not.toContain('?actorUri as:following ?followingUri .\n                ?followingUri as:items');
  });

  test('candidate actor lookups remain explicitly bounded', () => {
    expect(source).toContain('const MAX_CONCURRENT_LOOKUPS = 10;');
    expect(source).toContain('i += MAX_CONCURRENT_LOOKUPS');
    expect(source).toContain('actorUris.slice(i, i + MAX_CONCURRENT_LOOKUPS)');
  });
});
