import React, { useCallback, useEffect, useState } from 'react';
import { useCheckAuthenticated, PasswordStrengthIndicator, validatePasswordStrength } from '@semapps/auth-provider';
import { required, useAuthProvider, useNotify, useTranslate, SimpleForm, TextInput } from 'react-admin';
import {
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Divider,
  List,
  ListItem,
  ListItemText,
  Typography
} from '@mui/material';
import scorer from '../../config/scorer';
import { deletePasskey, listPasskeys, registerPasskey } from '../../utils/passkeys';

const validateConfirmNewPassword = [
  (value, { newPassword, confirmNewPassword }) => {
    if (!newPassword) return;
    if (newPassword !== confirmNewPassword) {
      return 'app.validation.confirmNewPassword';
    }
  }
];

const SettingsPasswordPage = () => {
  const translate = useTranslate();
  const notify = useNotify();
  const { identity } = useCheckAuthenticated();
  const authProvider = useAuthProvider();

  const [newPassword, setNewPassword] = React.useState('');
  const [passkeys, setPasskeys] = useState([]);
  const [passkeysLoading, setPasskeysLoading] = useState(true);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const formatTimestamp = value => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleString();
  };

  const loadPasskeys = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setPasskeys([]);
      setPasskeysLoading(false);
      return;
    }

    setPasskeysLoading(true);
    try {
      const data = await listPasskeys(token);
      setPasskeys(Array.isArray(data) ? data : []);
    } catch (error) {
      notify(error.message || 'app.notification.passkeys_load_failed', { type: 'error' });
    } finally {
      setPasskeysLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    loadPasskeys();
  }, [loadPasskeys]);

  const onSubmit = useCallback(
    async params => {
      try {
        await authProvider.updateAccountSettings({ ...params });
        notify('auth.message.account_settings_updated', 'success');
      } catch (error) {
        notify(error.message, { type: 'error' });
      }
    },
    [authProvider, notify]
  );

  const handleRegisterPasskey = async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      notify('app.notification.passkey_signin_required_register', { type: 'error' });
      return;
    }

    setPasskeyBusy(true);
    try {
      await registerPasskey(token);
      notify('app.notification.passkey_saved', { type: 'success' });
      await loadPasskeys();
    } catch (error) {
      notify(error.message || 'app.notification.passkey_registration_failed', { type: 'error' });
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handleDeletePasskey = async credentialId => {
    const token = localStorage.getItem('token');
    if (!token) {
      notify('app.notification.passkey_signin_required_remove', { type: 'error' });
      return;
    }

    setPasskeyBusy(true);
    try {
      await deletePasskey(token, credentialId);
      notify('app.notification.passkey_removed', { type: 'success' });
      await loadPasskeys();
    } catch (error) {
      notify(error.message || 'app.notification.passkey_remove_failed', { type: 'error' });
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (!identity?.id) return null;

  return (
    <>
      <Typography variant="h2" component="h1" noWrap sx={{ mt: 2 }}>
        {translate('app.page.settings_password')}
      </Typography>
      <Box mt={1}>
        <Card>
          <SimpleForm onSubmit={onSubmit}>
            <TextInput
              label={translate('app.input.current_password')}
              source="currentPassword"
              type="password"
              validate={required()}
              fullWidth
            />

            <Typography variant="body2" style={{ marginBottom: 3 }}>
              {translate('app.validation.password_strength')}:{' '}
            </Typography>
            <PasswordStrengthIndicator scorer={scorer} password={newPassword} sx={{ width: '100%' }} />
            <TextInput
              label={translate('app.input.new_password')}
              source="newPassword"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              validate={[validatePasswordStrength(scorer)]}
              fullWidth
            />

            <TextInput
              label={translate('app.input.confirm_new_password')}
              source="confirmNewPassword"
              type="password"
              validate={validateConfirmNewPassword}
              fullWidth
            />
          </SimpleForm>
        </Card>
      </Box>
      <Box mt={2}>
        <Card sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            {translate('app.message.passkeys_title')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {translate('app.message.passkeys_description')}
          </Typography>
          <Button variant="contained" onClick={handleRegisterPasskey} disabled={passkeyBusy}>
            {passkeyBusy ? translate('app.message.passkey_waiting') : translate('app.action.add_passkey')}
          </Button>
          <Divider sx={{ my: 3 }} />
          {passkeysLoading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <CircularProgress size={18} />
              <Typography variant="body2">{translate('app.message.passkeys_loading')}</Typography>
            </Box>
          ) : passkeys.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {translate('app.message.passkeys_empty')}
            </Typography>
          ) : (
            <List disablePadding>
              {passkeys.map(passkey => (
                <ListItem
                  key={passkey.credentialId}
                  divider
                  secondaryAction={
                    <Button
                      color="error"
                      onClick={() => handleDeletePasskey(passkey.credentialId)}
                      disabled={passkeyBusy}
                    >
                      {translate('app.action.remove')}
                    </Button>
                  }
                  sx={{ px: 0 }}
                >
                  <ListItemText
                    primary={
                      passkey.deviceType === 'multiDevice'
                        ? translate('app.message.passkey_synced')
                        : translate('app.message.passkey_device_bound')
                    }
                    secondary={
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
                        <Chip
                          size="small"
                          label={
                            passkey.backedUp
                              ? translate('app.message.passkey_backed_up')
                              : translate('app.message.passkey_not_backed_up')
                          }
                        />
                        <Chip
                          size="small"
                          label={
                            formatTimestamp(passkey.lastUsedAt)
                              ? translate('app.message.passkey_last_used', {
                                  date: formatTimestamp(passkey.lastUsedAt)
                                })
                              : translate('app.message.passkey_not_used_yet')
                          }
                        />
                        <Chip
                          size="small"
                          label={
                            formatTimestamp(passkey.createdAt)
                              ? translate('app.message.passkey_created', { date: formatTimestamp(passkey.createdAt) })
                              : translate('app.message.passkey_created_unavailable')
                          }
                        />
                      </Box>
                    }
                  />
                </ListItem>
              ))}
            </List>
          )}
        </Card>
      </Box>
    </>
  );
};

export default SettingsPasswordPage;
