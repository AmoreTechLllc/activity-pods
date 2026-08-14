const { WebAclMiddleware, CacherMiddleware } = require('@semapps/webacl');
const { ObjectsWatcherMiddleware } = require('@semapps/sync');
const AppControlMiddleware = require('./middlewares/app-control');
const HashtagNormalizationMiddleware = require('./middlewares/hashtag-normalization');
const TrustEvaluatorMiddleware = require('./middlewares/trust-evaluator');
const ContentWarningMiddleware = require('./middlewares/content-warning');
const LinkPreviewMiddleware = require('./middlewares/link-preview');
const LongFormTextMiddleware = require('./middlewares/long-form-text');
const MediaAttachmentsMiddleware = require('./middlewares/media-attachments');
const PollsMiddleware = require('./middlewares/polls');
const ReplyPoliciesMiddleware = require('./middlewares/reply-policies');
const SearchConsentMiddleware = require('./middlewares/search-consent');
const QuotePostsMiddleware = require('./middlewares/quote-posts');
const ActorMetadataMiddleware = require('./middlewares/actor-metadata');
const AuthorAttributionMiddleware = require('./middlewares/author-attribution');
const Fep4adbMiddleware = require('./middlewares/fep-4adb');
const Fep5bf0CollectionViewsMiddleware = require('./middlewares/fep-5bf0-collection-views');
const SkipOrphanBlankNodesCleanupMiddleware = require('./middlewares/skip-orphan-blank-nodes-cleanup');
const { createPhase8Tier1Instrumentation } = require('./lib/apdm-phase8-tier1-instrumentation');
const CONFIG = require('./config/config');
const errorHandler = require('./config/errorHandler');
const RdfJSONSerializer = require('./RdfJSONSerializer');

Error.stackTraceLimit = Infinity;

// Use the cacher only if Redis is configured
const cacherConfig = CONFIG.REDIS_CACHE_URL
  ? {
      type: 'Redis',
      options: {
        prefix: 'action',
        ttl: 2592000, // Keep in cache for one month
        redis: CONFIG.REDIS_CACHE_URL
      }
    }
  : undefined;

const phase8Instrumentation = createPhase8Tier1Instrumentation({
  enabled: CONFIG.APDM_PHASE8_INSTRUMENTATION_ENABLED,
  outputPath: CONFIG.APDM_PHASE8_INSTRUMENTATION_OUTPUT,
  recipientCount: CONFIG.APDM_PHASE8_RECIPIENT_COUNT,
  caseLabel: CONFIG.APDM_PHASE8_CASE_LABEL,
  fusekiBase: CONFIG.FUSEKI_BASE,
  sparqlEndpoint: CONFIG.SPARQL_ENDPOINT
});

const middlewares = [
  CacherMiddleware(cacherConfig), // Set the cacher before the WebAcl middleware
  WebAclMiddleware({ baseUrl: CONFIG.BASE_URL, podProvider: true }),
  SkipOrphanBlankNodesCleanupMiddleware({ enabled: CONFIG.SKIP_ORPHAN_BLANK_NODE_CLEANUP }),
  ObjectsWatcherMiddleware({ baseUrl: CONFIG.BASE_URL, podProvider: true, postWithoutRecipients: true }),
  LongFormTextMiddleware(),
  ContentWarningMiddleware(),
  PollsMiddleware(),
  QuotePostsMiddleware(),
  ReplyPoliciesMiddleware(),
  ActorMetadataMiddleware(),
  AuthorAttributionMiddleware(),
  Fep4adbMiddleware(),
  Fep5bf0CollectionViewsMiddleware(CONFIG.BASE_URL),
  HashtagNormalizationMiddleware(),
  LinkPreviewMiddleware(),
  MediaAttachmentsMiddleware(),
  SearchConsentMiddleware(),
  TrustEvaluatorMiddleware(),
  AppControlMiddleware({ baseUrl: CONFIG.BASE_URL })
];

// Keep Phase 8 measurement entirely opt-in. When disabled, the production
// middleware stack is exactly the pre-P8 stack and no HTTP functions are patched.
if (phase8Instrumentation.middleware) middlewares.push(phase8Instrumentation.middleware);

/** @type {import('moleculer').BrokerOptions} */
module.exports = {
  nodeID: 'pod-provider',
  // You can set all ServiceBroker configurations here
  // See https://moleculer.services/docs/0.14/configuration.html
  middlewares,
  errorHandler,
  logger: [
    {
      type: 'Console',
      options: {
        formatter: 'short',
        level: 'info'
      }
    },
    {
      type: 'File',
      options: {
        formatter: 'short',
        level: 'error',
        folder: './logs',
        filename: 'moleculer-errors-{date}.log'
      }
    }
  ],
  transporter: CONFIG.REDIS_TRANSPORTER_URL || undefined,
  serializer: CONFIG.REDIS_TRANSPORTER_URL ? new RdfJSONSerializer() : undefined
};
