const APODS = 'http://activitypods.org/ns/core#';

function sparqlLiteral(value) {
  return JSON.stringify(String(value));
}

function readQueryBinding(row, key) {
  const value = row?.[key];
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && typeof value.value === 'string') return value.value;
  return null;
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function parseCursor(cursor) {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (
      typeof parsed?.updatedAt !== 'string' ||
      parsed.updatedAt.length === 0 ||
      typeof parsed?.canonicalAccountId !== 'string' ||
      parsed.canonicalAccountId.length === 0
    ) {
      throw new Error('invalid');
    }
    return parsed;
  } catch (_err) {
    throw new Error('Invalid identity binding cursor');
  }
}

function encodeCursor(entry) {
  return Buffer.from(
    JSON.stringify({
      updatedAt: entry.updatedAt,
      canonicalAccountId: entry.canonicalAccountId
    }),
    'utf8'
  ).toString('base64url');
}

function buildIncrementalIdentityBindingQuery({ since, limit }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const cursor = parseCursor(since);
  const cursorFilter = cursor
    ? `
      FILTER(
        STR(?updatedAt) > ${sparqlLiteral(cursor.updatedAt)} ||
        (STR(?updatedAt) = ${sparqlLiteral(cursor.updatedAt)} &&
         STR(?canonicalAccountId) > ${sparqlLiteral(cursor.canonicalAccountId)})
      )`
    : '';

  return `
    PREFIX apods: <${APODS}>
    SELECT ?binding ?canonicalAccountId ?webId ?activityPubActorId ?activityPubHandle
           ?atprotoDid ?atprotoHandle ?atprotoSource ?atprotoManaged ?atprotoPdsUrl
           ?atSigningKeyRef ?atRotationKeyRef ?status
           ?repoInitialized ?repoRootCid ?repoRev ?createdAt ?updatedAt
    WHERE {
      ?binding a apods:AtprotoIdentityBindingIndex ;
               apods:canonicalAccountId ?canonicalAccountId ;
               apods:updatedAt ?updatedAt .
      OPTIONAL { ?binding apods:webId ?webId . }
      OPTIONAL { ?binding apods:activityPubActorId ?activityPubActorId . }
      OPTIONAL { ?binding apods:activityPubHandle ?activityPubHandle . }
      OPTIONAL { ?binding apods:atprotoDid ?atprotoDid . }
      OPTIONAL { ?binding apods:atprotoHandle ?atprotoHandle . }
      OPTIONAL { ?binding apods:atprotoSource ?atprotoSource . }
      OPTIONAL { ?binding apods:atprotoManaged ?atprotoManaged . }
      OPTIONAL { ?binding apods:atprotoPdsUrl ?atprotoPdsUrl . }
      OPTIONAL { ?binding apods:atSigningKeyRef ?atSigningKeyRef . }
      OPTIONAL { ?binding apods:atRotationKeyRef ?atRotationKeyRef . }
      OPTIONAL { ?binding apods:status ?status . }
      OPTIONAL { ?binding apods:repoInitialized ?repoInitialized . }
      OPTIONAL { ?binding apods:repoRootCid ?repoRootCid . }
      OPTIONAL { ?binding apods:repoRev ?repoRev . }
      OPTIONAL { ?binding apods:createdAt ?createdAt . }
      ${cursorFilter}
    }
    ORDER BY STR(?updatedAt) STR(?canonicalAccountId)
    LIMIT ${safeLimit}
  `;
}

function mapIdentityBindingRow(row) {
  return {
    id: readQueryBinding(row, 'binding'),
    canonicalAccountId: readQueryBinding(row, 'canonicalAccountId'),
    webId: readQueryBinding(row, 'webId'),
    activityPubActorId:
      readQueryBinding(row, 'activityPubActorId') || readQueryBinding(row, 'webId') || null,
    activityPubHandle: readQueryBinding(row, 'activityPubHandle'),
    atprotoDid: readQueryBinding(row, 'atprotoDid'),
    atprotoHandle: readQueryBinding(row, 'atprotoHandle'),
    atprotoSource: readQueryBinding(row, 'atprotoSource') || 'local',
    atprotoManaged: coerceBoolean(readQueryBinding(row, 'atprotoManaged')) ?? true,
    atprotoPdsUrl: readQueryBinding(row, 'atprotoPdsUrl'),
    atSigningKeyRef: readQueryBinding(row, 'atSigningKeyRef'),
    atRotationKeyRef: readQueryBinding(row, 'atRotationKeyRef'),
    status: readQueryBinding(row, 'status'),
    repoInitialized: coerceBoolean(readQueryBinding(row, 'repoInitialized')) ?? false,
    repoRootCid: readQueryBinding(row, 'repoRootCid'),
    repoRev: readQueryBinding(row, 'repoRev'),
    createdAt: readQueryBinding(row, 'createdAt'),
    updatedAt: readQueryBinding(row, 'updatedAt')
  };
}

module.exports = {
  buildIncrementalIdentityBindingQuery,
  mapIdentityBindingRow,
  encodeCursor,
  parseCursor
};
