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
const ApdmLocalDeliveryDatasetExistMemoMiddleware = require('./middlewares/apdm-local-delivery-dataset-exist-memo');
const AdspActionLocalityMiddleware = require('./middlewares/adsp-action-locality');
const { createPhase8Tier1Instrumentation } = require('./lib/apdm-phase8-tier1-instrumentation');
const CONFIG = require('./config/config');
const errorHandler = require('./config/errorHandler');
const { createMoleculerFabricConfig } = require('./config/moleculer-fabric');

Error.stackTraceLimit = Infinity;

const cacherConfig = CONFIG.REDIS_CACHE_URL
  ? {
      type: 'Redis',
      options: {
        prefix: 'action',
        ttl: 2592000,
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
  CacherMiddleware(cacherConfig),
  WebAclMiddleware({ baseUrl: CONFIG.BASE_URL, podProvider: true }),
  SkipOrphanBlankNodesCleanupMiddleware({ enabled: CONFIG.SKIP_ORPHAN_BLANK_NODE_CLEANUP }),
  ApdmLocalDeliveryDatasetExistMemoMiddleware({ enabled: CONFIG.APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED }),
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

if (phase8Instrumentation.middleware) middlewares.push(phase8Instrumentation.middleware);

const localityTelemetry = AdspActionLocalityMiddleware({
  enabled: process.env.SEMAPPS_MOLECULER_LOCALITY_TELEMETRY_ENABLED === 'true',
  maxActions: Number(process.env.SEMAPPS_MOLECULER_LOCALITY_MAX_ACTIONS) || 200,
  outputPath: process.env.SEMAPPS_MOLECULER_LOCALITY_TELEMETRY_OUTPUT || undefined
});
if (localityTelemetry) middlewares.push(localityTelemetry);

const fabric = createMoleculerFabricConfig();

/** @type {import('moleculer').BrokerOptions} */
module.exports = {
  nodeID: fabric.nodeID,
  namespace: fabric.namespace,
  registry: fabric.registry,
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
  transporter: fabric.transporter,
  serializer: fabric.serializer
};
