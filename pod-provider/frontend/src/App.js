import React, { lazy, Suspense } from 'react';
import { Admin, Resource, CustomRoutes, localStorageStore } from 'react-admin';
import { BrowserRouter, Navigate, Route } from 'react-router-dom';
import { QueryClient } from 'react-query';
import { StyledEngineProvider } from '@mui/material/styles';

import authProvider from './config/authProvider';
import dataProvider from './config/dataProvider';
import i18nProvider from './config/i18nProvider';
import * as resources from './resources';

import Layout from './layout/Layout';
import theme from './config/theme';

const HomePage = lazy(() => import('./pages/HomePage'));
const DataPage = lazy(() => import('./pages/DataPage/DataListPage'));
const DataResourcePage = lazy(() => import('./pages/DataPage/DataShowPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage/SettingsPage'));
const SettingsOwnerDashboardPage = lazy(() => import('./pages/SettingsPage/SettingsOwnerDashboardPage'));
const SettingsProviderDashboardPage = lazy(() => import('./pages/SettingsPage/SettingsProviderDashboardPage'));
const SettingsAtprotoLinkPage = lazy(() => import('./pages/SettingsPage/SettingsAtprotoLinkPage'));
const AdvancedSettingsPage = lazy(() => import('./pages/SettingsPage/AdvancedSettingsPage'));
const SettingsPasswordPage = lazy(() => import('./pages/SettingsPage/SettingsPasswordPage'));
const SettingsEmailPage = lazy(() => import('./pages/SettingsPage/SettingsEmailPage'));
const SettingsExportPage = lazy(() => import('./pages/SettingsPage/SettingsExportPage'));
const SettingsDeletePage = lazy(() => import('./pages/SettingsPage/SettingsDeletePage'));
const ProfileCreatePage = lazy(() => import('./pages/ProfileCreatePage/ProfileCreatePage'));
const AuthorizePage = lazy(() => import('./pages/AuthorizePage/AuthorizePage'));
const UserPage = lazy(() => import('./pages/UserPage'));
const RedirectPage = lazy(() => import('./pages/RedirectPage'));
const InvitePage = lazy(() => import('./pages/InvitePage/InvitePage'));
const ApplicationsPage = lazy(() => import('./pages/ApplicationsPage/ApplicationsPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const NetworkPage = lazy(() => import('./pages/NetworkPage/NetworkPage'));
const NetworkActorPage = lazy(() => import('./pages/NetworkPage/NetworkActorPage'));
const NetworkRequestPage = lazy(() => import('./pages/NetworkPage/NetworkRequestPage'));
const SettingsLocalePage = lazy(() => import('./pages/SettingsPage/SettingsLocalePage'));
const SettingsProfilesPage = lazy(() => import('./pages/SettingsPage/ProfilesPage/SettingsProfilesPage'));
const CreateGroupPage = lazy(() => import('./pages/CreateGroupPage'));
const GroupSettingsPage = lazy(() => import('./pages/SettingsPage/GroupSettingsPage'));
const PublicProfilePage = lazy(() => import('./pages/SettingsPage/ProfilesPage/PublicProfilePage'));
const PrivateProfilePage = lazy(() => import('./pages/SettingsPage/ProfilesPage/PrivateProfilePage'));
const ModerationPage = lazy(() => import('./pages/SettingsPage/ModerationPage'));
const ModerationListsPage = lazy(() => import('./pages/SettingsPage/ModerationListsPage'));
const AppPermissionsPage = lazy(() => import('./pages/SettingsPage/AppPermissionsPage'));
const TrustSourcesPage = lazy(() => import('./pages/SettingsPage/TrustSourcesPage'));
const MrfControlPage = lazy(() => import('./pages/SettingsPage/MrfControlPage'));
const MrfTraceViewerPage = lazy(() => import('./pages/SettingsPage/MrfTraceViewerPage'));
const ProviderAnnouncementsPage = lazy(() => import('./pages/SettingsPage/ProviderAnnouncementsPage'));
const ProviderInvitationsPage = lazy(() => import('./pages/SettingsPage/ProviderInvitationsPage'));
const ProviderPodsPage = lazy(() => import('./pages/SettingsPage/ProviderPodsPage'));
const ProviderAuditLogPage = lazy(() => import('./pages/SettingsPage/ProviderAuditLogPage'));
const ProviderCrossProtocolModerationPage = lazy(
  () => import('./pages/SettingsPage/ProviderCrossProtocolModerationPage')
);
const ProviderSpamProtectionPage = lazy(() => import('./pages/SettingsPage/ProviderSpamProtectionPage'));
const OwnerModerationPage = lazy(() => import('./pages/SettingsPage/OwnerModerationPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // staleTime: 5 * 60 * 1000, // Considering data fresh for 5 minutes, might cause caching-related hard to find bugs..
      cacheTime: 30 * 60 * 1000, // Cache unused data for 30 minutes.
      retry: 3
    }
  }
});

const App = () => (
  <StyledEngineProvider injectFirst>
    <Suspense fallback={null}>
      <BrowserRouter>
        <Admin
          title={CONFIG.INSTANCE_NAME}
          authProvider={authProvider}
          dataProvider={dataProvider}
          i18nProvider={i18nProvider}
          loginPage={LoginPage}
          layout={Layout}
          theme={theme}
          store={localStorageStore()}
          queryClient={queryClient}
          disableTelemetry
        >
          {Object.entries(resources).map(([key, resource]) => (
            <Resource key={key} name={key} {...resource.config} />
          ))}
          <CustomRoutes noLayout>
            <Route path="/" element={<HomePage />} />
            <Route path="/u/:id" element={<UserPage />} />
            <Route path="/r" element={<RedirectPage />} />
            <Route path="/initialize" element={<ProfileCreatePage />} />
            <Route path="/authorize" element={<AuthorizePage />} />
            <Route path="/invite/:capability" element={<InvitePage />} />
            <Route path="/groups">
              <Route path="create" element={<CreateGroupPage />} />
            </Route>
          </CustomRoutes>
          <CustomRoutes>
            <Route path="/Profile" element={<Navigate to="/settings/profiles" replace />} />
            <Route path="/profile" element={<Navigate to="/settings/profiles" replace />} />
            <Route path="/network">
              <Route index element={<NetworkPage />} />
              <Route path="request" element={<NetworkRequestPage />} />
              <Route path=":webfingerId" element={<NetworkActorPage />} />
            </Route>
            <Route path="/apps" element={<ApplicationsPage />} />
            <Route path="/data">
              <Route index element={<DataPage />} />
              <Route path=":resourceUri" element={<DataResourcePage />} />
            </Route>
            <Route path="/settings">
              <Route index element={<SettingsPage />} />
              <Route path="owner" element={<SettingsOwnerDashboardPage />} />
              <Route path="provider" element={<SettingsProviderDashboardPage />} />
              <Route path="profiles">
                <Route index element={<SettingsProfilesPage />} />
                <Route path="public" element={<PublicProfilePage />} />
                <Route path="private" element={<PrivateProfilePage />} />
              </Route>
              <Route path="email" element={<SettingsEmailPage />} />
              <Route path="password" element={<SettingsPasswordPage />} />
              <Route path="atproto-link" element={<SettingsAtprotoLinkPage />} />
              <Route path="locale" element={<SettingsLocalePage />} />
              <Route path="advanced" element={<AdvancedSettingsPage />} />
              <Route path="export" element={<SettingsExportPage />} />
              <Route path="delete" element={<SettingsDeletePage />} />
              <Route path="moderation" element={<ModerationListsPage />} />
              <Route path="moderation/reports" element={<OwnerModerationPage />} />
              <Route path="moderation/rules" element={<ModerationPage />} />
              <Route path="apps" element={<AppPermissionsPage />} />
              <Route path="trust-sources" element={<TrustSourcesPage />} />
              <Route path="mrf" element={<MrfControlPage />} />
              <Route path="mrf/:moduleId" element={<MrfControlPage />} />
              <Route path="mrf/traces" element={<MrfTraceViewerPage />} />
              <Route path="mrf/traces/:traceId" element={<MrfTraceViewerPage />} />
              <Route path="provider/announcements" element={<ProviderAnnouncementsPage />} />
              <Route path="provider/invitations" element={<ProviderInvitationsPage />} />
              <Route path="provider/pods" element={<ProviderPodsPage />} />
              <Route path="provider/audit-log" element={<ProviderAuditLogPage />} />
              <Route path="provider/moderation" element={<ProviderCrossProtocolModerationPage />} />
              <Route path="provider/spam" element={<ProviderSpamProtectionPage />} />
            </Route>
            <Route path="/group/:groupId">
              <Route path="settings">
                <Route index element={<GroupSettingsPage />} />
                <Route path="profile" element={<PublicProfilePage />} />
                <Route path="export" element={<SettingsExportPage />} />
                <Route path="delete" element={<SettingsDeletePage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/network" replace />} />
          </CustomRoutes>
        </Admin>
      </BrowserRouter>
    </Suspense>
  </StyledEngineProvider>
);

export default App;
