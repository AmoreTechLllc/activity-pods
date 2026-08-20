'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ACTION = 'activitypub.outbox.post';

function appendJsonLine(outputPath, record) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Evidence-only middleware used by ADSP fault-injection fixtures.
 *
 * When enabled it records the exact moment a selected local action has entered
 * a concrete broker process. Writes are deliberately best-effort: evidence
 * instrumentation must never alter ActivityPods request success/failure
 * semantics. Production is unaffected unless the explicit evidence flag and
 * output path are both supplied.
 */
function AdspRootEntryEvidenceMiddleware(options = {}) {
  if (options.enabled !== true) return null;

  const outputPath = options.outputPath ? path.resolve(options.outputPath) : undefined;
  if (!outputPath) throw new Error('ADSP root-entry evidence requires outputPath when enabled');

  const actionName = options.actionName || DEFAULT_ACTION;
  const nodeID = options.nodeID || process.env.SEMAPPS_MOLECULER_NODE_ID || null;
  const onEvidenceError = typeof options.onEvidenceError === 'function' ? options.onEvidenceError : () => {};

  return {
    name: 'AdspRootEntryEvidenceMiddleware',
    localAction(next, action) {
      if (action?.name !== actionName) return next;

      return async function adspRootEntryEvidenceAction(ctx) {
        try {
          appendJsonLine(outputPath, {
            version: 1,
            phase: 'ADSP-P2-ROOT-ENTRY',
            action: actionName,
            requestId: (ctx && (ctx.requestID || ctx.id)) || null,
            nodeID,
            enteredAt: new Date().toISOString(),
            enteredAtEpochMs: Date.now()
          });
        } catch (error) {
          try {
            onEvidenceError(error);
          } catch (_ignored) {
            // Evidence reporting cannot become an application failure source.
          }
        }
        return next(ctx);
      };
    }
  };
}

module.exports = AdspRootEntryEvidenceMiddleware;
module.exports.DEFAULT_ACTION = DEFAULT_ACTION;
module.exports.appendJsonLine = appendJsonLine;
