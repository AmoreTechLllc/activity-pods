import React, { useMemo, useState } from 'react';
import { useNotify } from 'react-admin';
import { useOutbox } from '@semapps/activitypub-components';
import { Alert, Box, Button, Card, CardActions, CardContent, Divider, Stack, Typography } from '@mui/material';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import BlockAnonymous from '../../common/BlockAnonymous';
import { buildIntentActivity, getWorkflowAction, parseIntentSearch } from './intentUtils';

const DISPLAY_KEYS = [
  'object',
  'type',
  'name',
  'summary',
  'content',
  'attachment',
  'tag',
  'startTime',
  'endTime',
  'describes'
];

function titleFor(type) {
  switch (type) {
    case 'Follow': return 'Follow this actor?';
    case 'Announce': return 'Share this object?';
    case 'Create': return 'Create this object?';
    case 'Object': return 'Open this object?';
    default: return 'Activity request';
  }
}

function IntentSummary({ type, params }) {
  return (
    <Stack spacing={1.25}>
      <Typography variant="h5">{titleFor(type)}</Typography>
      <Typography color="text.secondary">
        This request came from another application or website. Nothing will be sent until you confirm.
      </Typography>
      <Divider />
      {DISPLAY_KEYS.filter(key => params[key] !== undefined).map(key => (
        <Box key={key}>
          <Typography variant="caption" color="text.secondary">{key}</Typography>
          <Typography sx={{ overflowWrap: 'anywhere', whiteSpace: key === 'content' ? 'pre-wrap' : 'normal' }}>
            {params[key]}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

const IntentPage = () => {
  const { intentType = '' } = useParams();
  const type = intentType.charAt(0).toUpperCase() + intentType.slice(1).toLowerCase();
  const [searchParams] = useSearchParams();
  const parsed = useMemo(() => parseIntentSearch(type, searchParams), [type, searchParams]);
  const outbox = useOutbox();
  const notify = useNotify();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [workflow, setWorkflow] = useState(null);
  const [completed, setCompleted] = useState(false);

  const applyWorkflow = outcome => {
    if (!parsed.ok) return;
    const action = getWorkflowAction(parsed.params, outcome);
    if (action.kind === 'close') {
      window.close();
      if (!window.closed) navigate('/network', { replace: true });
      return;
    }
    if (action.kind === 'confirm-navigation') {
      setWorkflow(action);
      return;
    }
    navigate('/network', { replace: true });
  };

  const confirm = async () => {
    if (!parsed.ok) return;
    setBusy(true);
    try {
      if (type === 'Object') {
        setCompleted(true);
        setWorkflow({ kind: 'confirm-navigation', target: parsed.params.object });
        return;
      }
      const activity = buildIntentActivity(type, parsed.params, outbox.owner);
      await outbox.post(activity);
      setCompleted(true);
      notify(`${type} activity sent`, { type: 'success' });
      applyWorkflow('success');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!parsed.ok) {
    return (
      <BlockAnonymous>
        <Box sx={{ maxWidth: 720, mx: 'auto', mt: 6, px: 2 }}>
          <Alert severity="error">{parsed.error}</Alert>
          <Button sx={{ mt: 2 }} onClick={() => navigate('/network', { replace: true })}>Return to network</Button>
        </Box>
      </BlockAnonymous>
    );
  }

  return (
    <BlockAnonymous>
      <Box sx={{ maxWidth: 720, mx: 'auto', mt: 6, px: 2 }}>
        <Card>
          <CardContent>
            <IntentSummary type={type} params={parsed.params} />
            {completed && type !== 'Object' && (
              <Alert severity="success" sx={{ mt: 2 }}>The Activity was submitted to your outbox.</Alert>
            )}
            {workflow?.kind === 'confirm-navigation' && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                <Typography sx={{ mb: 1 }}>
                  The requesting site wants to send you to the address below. Verify it before continuing.
                </Typography>
                <Typography sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace', fontSize: '0.875rem' }}>
                  {workflow.target}
                </Typography>
              </Alert>
            )}
          </CardContent>
          <CardActions sx={{ justifyContent: 'flex-end', px: 2, pb: 2 }}>
            {workflow?.kind === 'confirm-navigation' ? (
              <>
                <Button onClick={() => navigate('/network', { replace: true })}>Stay here</Button>
                <Button
                  variant="contained"
                  onClick={() => window.location.assign(workflow.target)}
                >
                  Continue to site
                </Button>
              </>
            ) : (
              <>
                <Button disabled={busy} onClick={() => applyWorkflow('cancel')}>Cancel</Button>
                <Button disabled={busy || completed} variant="contained" onClick={confirm}>
                  {type === 'Object' ? 'Continue' : busy ? 'Sending…' : 'Confirm'}
                </Button>
              </>
            )}
          </CardActions>
        </Card>
      </Box>
    </BlockAnonymous>
  );
};

export default IntentPage;
