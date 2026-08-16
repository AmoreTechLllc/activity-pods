'use strict';

/**
 * DM Conversations Service
 *
 * Tracks direct message conversations for local actors so that:
 *   1. The DM inbox can enumerate conversations with participants and timestamps.
 *   2. The participant autocomplete API can return actors already in a
 *      conversation with a given local actor.
 *
 * A "conversation" is identified by its sorted participant URI set. When the
 * same participants exchange messages again the existing conversation record is
 * updated rather than a new one being created.
 */

const crypto = require('crypto');
const { getDatasetFromUri } = require('@semapps/ldp');
const { retryWithBackoff } = require('../utils/backoff');

const DM_NS = 'https://activitypods.org/ns/dm#';
const DCTERMS_NS = 'http://purl.org/dc/terms/';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRetryable(err) {
  const code = Number(err?.code);
  if (err?.name === 'TimeoutError') return true;
  if (Number.isFinite(code) && (code === 408 || code === 425 || code === 429 || code >= 500)) return true;
  return /timeout|temporar|unavailable|econn|socket/i.test(String(err?.message || ''));
}

function sparqlStr(value) {
  return JSON.stringify(String(value));
}

function conversationsGraph(actorUri) {
  return `${actorUri.replace(/\/$/, '')}/dm-conversations`;
}

function conversationNodeUri(actorUri, convId) {
  return `${actorUri.replace(/\/$/, '')}/dm-conversations/${convId}`;
}

function readBinding(row, key) {
  const v = row?.[key];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.value === 'string') return v.value;
  return null;
}

function participantFingerprint(uris) {
  const sorted = [...uris]
    .map(u => u.trim())
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 32);
}

module.exports = {
  name: 'dm.conversations',

  dependencies: ['triplestore', 'auth.account', 'activitypub.actor'],

  methods: {
    async triQuery(ctx, query, dataset) {
      return retryWithBackoff(() => ctx.call('triplestore.query', { query, dataset, webId: 'system' }), {
        maxRetries: 3,
        baseDelayMs: 60,
        maxDelayMs: 1200,
        retryIf: isRetryable
      });
    },

    async triUpdate(ctx, query, dataset) {
      return retryWithBackoff(() => ctx.call('triplestore.update', { query, dataset, webId: 'system' }), {
        maxRetries: 3,
        baseDelayMs: 60,
        maxDelayMs: 1200,
        retryIf: isRetryable
      });
    },

    requireActorUri(actorUri) {
      if (!actorUri || typeof actorUri !== 'string') throw new Error('actorUri is required');
      try {
        const p = new URL(actorUri);
        if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error();
      } catch {
        throw new Error(`actorUri must be a valid http(s) URL: ${actorUri}`);
      }
    },

    requireParticipantUris(participantUris) {
      if (!Array.isArray(participantUris) || participantUris.length < 2) {
        throw new Error('participantUris must be an array of at least 2 actor URIs');
      }
      for (const uri of participantUris) {
        if (!uri || typeof uri !== 'string') throw new Error(`Invalid participant URI: ${uri}`);
        try {
          const p = new URL(uri);
          if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error();
        } catch {
          throw new Error(`participantUris must be valid http(s) URLs: ${uri}`);
        }
      }
    }
  },

  actions: {
    async upsert(ctx) {
      const { actorUri, participantUris, timestamp } = ctx.params;

      this.requireActorUri(actorUri);
      this.requireParticipantUris(participantUris);

      const now = timestamp && typeof timestamp === 'string' ? timestamp : new Date().toISOString();
      const fingerprint = participantFingerprint(participantUris);
      const dataset = getDatasetFromUri(actorUri);
      const graph = conversationsGraph(actorUri);

      const existing = await this.triQuery(
        ctx,
        `
        PREFIX dm: <${DM_NS}>
        SELECT ?convId WHERE {
          GRAPH <${graph}> {
            ?node dm:fingerprint ${sparqlStr(fingerprint)} ;
                  dm:conversationId ?convId .
          }
        }
        LIMIT 1
        `,
        dataset
      );

      const existingRow = Array.isArray(existing) ? existing[0] : null;
      const existingConvId = existingRow ? readBinding(existingRow, 'convId') : null;

      if (existingConvId) {
        const nodeUri = conversationNodeUri(actorUri, existingConvId);
        await this.triUpdate(
          ctx,
          `
          PREFIX dm: <${DM_NS}>
          WITH <${graph}>
          DELETE { <${nodeUri}> dm:lastMessageAt ?old }
          INSERT { <${nodeUri}> dm:lastMessageAt ${sparqlStr(now)} }
          WHERE  { <${nodeUri}> dm:lastMessageAt ?old }
          `,
          dataset
        );

        this.logger.debug('[dm.conversations] conversation updated', { actorUri, conversationId: existingConvId });
        return { conversationId: existingConvId, isNew: false };
      }

      const convId = crypto.randomUUID();
      const nodeUri = conversationNodeUri(actorUri, convId);

      const participantTriples = participantUris
        .map(uri => `<${nodeUri}> dm:participant <${uri}> ;`)
        .join('\n              ');

      await this.triUpdate(
        ctx,
        `
        PREFIX dm: <${DM_NS}>
        PREFIX dcterms: <${DCTERMS_NS}>
        INSERT DATA {
          GRAPH <${graph}> {
            <${nodeUri}>
              a dm:Conversation ;
              dm:conversationId ${sparqlStr(convId)} ;
              dm:fingerprint ${sparqlStr(fingerprint)} ;
              ${participantTriples}
              dm:lastMessageAt ${sparqlStr(now)} ;
              dcterms:created ${sparqlStr(now)} .
          }
        }
        `,
        dataset
      );

      this.logger.debug('[dm.conversations] conversation created', { actorUri, conversationId: convId });
      return { conversationId: convId, isNew: true };
    },

    async list(ctx) {
      const { actorUri, limit = 50, offset = 0 } = ctx.params;
      this.requireActorUri(actorUri);

      const dataset = getDatasetFromUri(actorUri);
      const graph = conversationsGraph(actorUri);
      const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
      const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));

      // Select/page conversation nodes in a subquery before expanding their
      // multi-valued participant relation. This keeps one Fuseki snapshot and
      // one round trip while removing the old implicit 20-participant paging
      // assumption and bounding unrelated-row transfer.
      const rows = await this.triQuery(
        ctx,
        `
        PREFIX dm: <${DM_NS}>
        PREFIX dcterms: <${DCTERMS_NS}>
        SELECT ?node ?convId ?participant ?lastMessageAt ?created WHERE {
          {
            SELECT ?node ?convId ?lastMessageAt ?created WHERE {
              GRAPH <${graph}> {
                ?node a dm:Conversation ;
                      dm:conversationId ?convId ;
                      dm:lastMessageAt ?lastMessageAt ;
                      dcterms:created ?created .
              }
            }
            ORDER BY DESC(?lastMessageAt) ?convId
            LIMIT ${safeLimit}
            OFFSET ${safeOffset}
          }
          GRAPH <${graph}> {
            ?node dm:participant ?participant .
          }
        }
        ORDER BY DESC(?lastMessageAt) ?convId
        `,
        dataset
      );

      const convMap = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        const node = readBinding(row, 'node');
        const convId = readBinding(row, 'convId');
        const participant = readBinding(row, 'participant');
        const lastMessageAt = readBinding(row, 'lastMessageAt');
        const createdAt = readBinding(row, 'created');
        if (!node || !convId || !participant) continue;

        if (!convMap.has(node)) {
          convMap.set(node, {
            conversationId: convId,
            participantUris: [],
            lastMessageAt,
            createdAt
          });
        }
        convMap.get(node).participantUris.push(participant);
      }

      return [...convMap.values()];
    },

    async listParticipants(ctx) {
      const { actorUri, query = '', limit = 20 } = ctx.params;
      this.requireActorUri(actorUri);

      const dataset = getDatasetFromUri(actorUri);
      const graph = conversationsGraph(actorUri);
      const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
      const normalizedQuery = typeof query === 'string' ? query.toLowerCase() : '';
      const queryFilter = normalizedQuery
        ? `FILTER(CONTAINS(LCASE(STR(?participant)), ${sparqlStr(normalizedQuery)}))`
        : '';

      // Apply the autocomplete predicate before LIMIT. The old implementation
      // fetched an arbitrary limit*10 prefix and filtered in Node, which could
      // omit valid matches solely because they appeared later in the graph.
      const rows = await this.triQuery(
        ctx,
        `
        PREFIX dm: <${DM_NS}>
        SELECT DISTINCT ?participant WHERE {
          GRAPH <${graph}> {
            ?node a dm:Conversation ;
                  dm:participant ?participant .
            FILTER(?participant != <${actorUri}>)
            ${queryFilter}
          }
        }
        LIMIT ${safeLimit}
        `,
        dataset
      );

      return (Array.isArray(rows) ? rows : [])
        .map(row => readBinding(row, 'participant'))
        .filter(Boolean);
    },

    async delete(ctx) {
      const { actorUri, conversationId } = ctx.params;
      this.requireActorUri(actorUri);

      if (!conversationId || typeof conversationId !== 'string') {
        throw new Error('conversationId is required');
      }
      if (!UUID_V4_RE.test(conversationId)) {
        throw new Error('conversationId must be a valid UUID v4');
      }

      const dataset = getDatasetFromUri(actorUri);
      const graph = conversationsGraph(actorUri);
      const nodeUri = conversationNodeUri(actorUri, conversationId);

      await this.triUpdate(
        ctx,
        `
        PREFIX dm: <${DM_NS}>
        WITH <${graph}>
        DELETE { <${nodeUri}> ?p ?o }
        WHERE  { <${nodeUri}> ?p ?o }
        `,
        dataset
      );

      this.logger.debug('[dm.conversations] conversation deleted', { actorUri, conversationId });
    }
  }
};
