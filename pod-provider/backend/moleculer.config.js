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
const { createPhase11QueryAttribution } = require('./lib/apdm-phase11-query-attribution');
const CONFIG = require('./config/config');
const errorHandler = require('./config/errorHandler');
const {
  GROUP_POD_CELL,
  createMoleculerFabricConfig
} = require('./config/moleculer-fabric');

Error.stackTraceLimit = Infinity;

const fabric = createMoleculerFabricConfig();

function createPodCellMiddlewares() {
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

  // Phase 11 is measurement-only and fail-closed. It attributes triplestore.query
  // calls within the same real local-delivery lineage observed by Phase 8, but it
  // never changes a query, its result, or authorization context.
  const phase11QueryAttribution = createPhase11QueryAttribution({
    enabled: CONFIG.APDM_PHASE11_QUERY_ATTRIBUTION_ENABLED,
    outputPath: CONFIG.APDM_PHASE11_QUERY_ATTRIBUTION_OUTPUT,
    recipientCount: CONFIG.APDM_PHASE8_RECIPIENT_COUNT,
    caseLabel: CONFIG.APDM_PHASE8_CASE_LABEL,
    maxKeys: CONFIG.APDM_PHASE11_QUERY_ATTRIBUTION_MAX_KEYS,
    maxContexts: CONFIG.APDM_PHASE11_QUERY_ATTRIBUTION_MAX_CONTEXTS
  });

  // Keep the production Pod/SemApps cell middleware order exactly as before.
  // Non-production P1 groups intentionally do not attach these middlewares:
  // several of them have startup dependencies on LDP/WebACL/etc. that belong
  // to the colocated Pod cell and must not force every independent broker to
  // load the full production service graph.
  const middlewares = [
    CacherMiddleware(cacherConfig),
    WebAclMiddleware({ baseUrl: CONFIG.BASE_URL, podProvider: true }),
    SkipOrphanBlankNodesCleanupMiddleware({ enabled: CONFIG.SKIP_ORPHAN_BLANK_NODE_CLEANUP }),
    // Phase 10 remains default-OFF. When explicitly enabled it owns exactly one
    // process-global local-delivery scope seam and refuses ambiguous duplicate ownership.
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

  // Keep APDM measurement entirely opt-in. Phase 8 is installed first so
  // Phase 11 can safely chain its local-delivery observer in benchmark runs.
  if (phase8Instrumentation.middleware) middlewares.push(phase8Instrumentation.middleware);
  if (phase11QueryAttribution.middleware) middlewares.push(phase11QueryAttribution.middleware);
  return middlewares;
}

const middlewares = fabric.serviceGroup === GROUP_POD_CELL ? createPodCellMiddlewares() : [];

// Locality telemetry is fabric-safe and may be enabled for either the real Pod
// cell or an isolated proof group. It observes routing only; it has no service
// dependencies and does not change endpoint selection.
const localityTelemetry = AdspActionLocalityMiddleware({
  enabled: process.env.SEMAPPS_MOLECULER_LOCALITY_TELEMETRY_ENABLED === 'true',
  maxActions: Number(process.env.SEMAPPS_MOLECULER_LOCALITY_MAX_ACTIONS) || 200,
  outputPath: process.env.SEMAPPS_MOLECULER_LOCALITY_TELEMETRY_OUTPUT || undefined
});
if (localityTelemetry) middlewares.push(localityTelemetry);

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
