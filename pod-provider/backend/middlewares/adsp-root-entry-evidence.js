'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ACTION = 'activitypub.outbox.post';

function appendJsonLine(outputPath, record) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function reportEvidenceError(callback, error) {
  try {
    callback(error);
  } catch (_ignored) {
    // Evidence callbacks cannot become an application failure source.
  }
}

/**
 * Evidence-only middleware used by ADSP fault-injection fixtures.
 *
 * Normal evidence mode records root entry and never changes request semantics.
 * A dedicated fault lane may additionally select one request prefix for an
 * intentional post-action response hold: the real action is awaited first,
 * then a marker is written and the middleware never returns. SIGKILL at that
 * marker deterministically reproduces the commit-complete / response-unknown
 * ambiguity without changing production behavior. Both modes are disabled by
 * default and require explicit evidence configuration.
 */
function AdspRootEntryEvidenceMiddleware(options = {}) {
  if (options.enabled !== true) return null;

  const outputPath = options.outputPath ? path.resolve(options.outputPath) : undefined;
  if (!outputPath) throw new Error('ADSP root-entry evidence requires outputPath when enabled');

  const actionName = options.actionName || DEFAULT_ACTION;
  const nodeID = options.nodeID || process.env.SEMAPPS_MOLECULER_NODE_ID || null;
  const holdAfterAction = options.holdAfterAction === true;
  const holdRequestPrefix = String(options.holdRequestPrefix || '');
  if (holdAfterAction && !holdRequestPrefix) {
    throw new Error('ADSP root response hold requires a non-empty holdRequestPrefix');
  }
  const onEvidenceError = typeof options.onEvidenceError === 'function' ? options.onEvidenceError : () => {};

  function record(phase, requestId, extra = {}) {
    const now = Date.now();
    const observedAt = new Date(now).toISOString();
    appendJsonLine(outputPath, {
      version: 1,
      phase,
      action: actionName,
      requestId,
      nodeID,
      enteredAt: observedAt,
      enteredAtEpochMs: now,
      observedAt,
      observedAtEpochMs: now,
      ...extra
    });
  }

  return {
    name: 'AdspRootEntryEvidenceMiddleware',
    localAction(next, action) {
      if (action?.name !== actionName) return next;

      return async function adspRootEntryEvidenceAction(ctx) {
        const requestId = (ctx && (ctx.requestID || ctx.id)) || null;
        const shouldHold = holdAfterAction && typeof requestId === 'string' && requestId.startsWith(holdRequestPrefix);

        if (shouldHold) {
          const result = await next(ctx);
          try {
            record('ADSP-P2-ROOT-ENTRY', requestId, {
              boundary: 'root-action-complete-response-held'
            });
          } catch (error) {
            reportEvidenceError(onEvidenceError, error);
          }
          // The dedicated fault workflow kills this process after observing the
          // marker. Do not add a timer or synthetic error: either SIGKILL occurs
          // at the proven ambiguous boundary or the evidence lane times out.
          await new Promise(() => {});
          return result;
        }

        try {
          record('ADSP-P2-ROOT-ENTRY', requestId, { boundary: 'root-action-entry' });
        } catch (error) {
          reportEvidenceError(onEvidenceError, error);
        }
        return next(ctx);
      };
    }
  };
}

module.exports = AdspRootEntryEvidenceMiddleware;
module.exports.DEFAULT_ACTION = DEFAULT_ACTION;
module.exports.appendJsonLine = appendJsonLine;
