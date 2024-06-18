const QueueMixin = require('moleculer-bull');
const { triple, namedNode } = require('@rdfjs/data-model');
const { MIME_TYPES } = require('@semapps/mime-types');
const { ACTOR_TYPES } = require('@semapps/activitypub');
const { arrayOf } = require('@semapps/ldp');
const { interopContext } = require('@activitypods/core');
const { ClassDescriptionService, AccessDescriptionSetService } = require('@activitypods/description');
const AccessNeedsService = require('./services/registration/access-needs');
const AccessNeedsGroupsService = require('./services/registration/access-needs-groups');
const ActorsService = require('./services/registration/actors');
const AppRegistrationsService = require('./services/registration/app-registrations');
const AccessGrantsService = require('./services/registration/access-grants');
const DataGrantsService = require('./services/registration/data-grants');
const RegistrationService = require('./services/registration/registration');
const PodActivitiesWatcherService = require('./services/pod-handling/pod-activities-watcher');
const PodCollectionsService = require('./services/pod-handling/pod-collections');
const PodContainersService = require('./services/pod-handling/pod-containers');
const PodNotificationService = require('./services/pod-handling/pod-notification');
const PodOutboxService = require('./services/pod-handling/pod-outbox');
const PodPermissionsService = require('./services/pod-handling/pod-permissions');
const PodResourcesService = require('./services/pod-handling/pod-resources');
const PodWacGroupsService = require('./services/pod-handling/pod-wac-groups');
const TimerService = require('./services/utils/timer');
const TranslatorService = require('./services/utils/translator');

module.exports = {
  name: 'app',
  settings: {
    app: {
      name: null,
      description: null,
      author: null,
      thumbnail: null,
      frontUrl: null
    },
    oidc: {
      clientUri: null,
      redirectUris: null,
      postLogoutRedirectUris: [],
      tosUri: null
    },
    accessNeeds: {
      required: [],
      optional: []
    },
    classDescriptions: {},
    queueServiceUrl: null
  },
  dependencies: [
    'activitypub',
    'activitypub.follow', // Ensure the /followers and /following collection are registered
    'auth.account',
    'ldp.container',
    'ldp.registry',
    'ldp.resource',
    'actors'
  ],
  created() {
    if (!this.settings.queueServiceUrl) {
      throw new Error(`The setting queueServiceUrl is mandatory`);
    }

    this.broker.createService(ActorsService);

    this.broker.createService(RegistrationService);

    this.broker.createService(AccessNeedsService);
    this.broker.createService(AccessNeedsGroupsService, {
      settings: {
        accessNeeds: this.settings.accessNeeds
      }
    });

    this.broker.createService(AppRegistrationsService);
    this.broker.createService(DataGrantsService);
    this.broker.createService(AccessGrantsService);

    this.broker.createService(AccessDescriptionSetService);
    this.broker.createService(ClassDescriptionService);

    // Pod handling
    this.broker.createService(PodActivitiesWatcherService, {
      mixins: [QueueMixin(this.settings.queueServiceUrl)]
    });
    this.broker.createService(PodNotificationService, {
      settings: {
        frontUrl: this.settings.app.frontUrl
      }
    });
    this.broker.createService(PodCollectionsService);
    this.broker.createService(PodContainersService);
    this.broker.createService(PodOutboxService);
    this.broker.createService(PodPermissionsService);
    this.broker.createService(PodResourcesService);
    this.broker.createService(PodWacGroupsService);

    // Utils
    this.broker.createService(TimerService, {
      mixins: [QueueMixin(this.settings.queueServiceUrl)]
    });
    this.broker.createService(TranslatorService);
  },
  async started() {
    let actorExist = false,
      actorUri;

    const actorAccount = await this.broker.call('auth.account.findByUsername', { username: 'app' });

    if (actorAccount) {
      actorUri = actorAccount.webId;
      actorExist = await this.broker.call('ldp.resource.exist', {
        resourceUri: actorUri
      });
    }

    if (!actorExist) {
      this.logger.info(`Actor ${actorUri} does not exist yet, creating it...`);

      const account = await this.broker.call(
        'auth.account.create',
        {
          username: 'app'
        },
        { meta: { isSystemCall: true } }
      );

      try {
        actorUri = await this.broker.call('actors.post', {
          slug: 'app',
          resource: {
            '@context': ['https://www.w3.org/ns/activitystreams', interopContext],
            type: [ACTOR_TYPES.APPLICATION, 'interop:Application'],
            preferredUsername: 'app',
            name: this.settings.app.name,
            'interop:applicationName': this.settings.app.name,
            'interop:applicationDescription': this.settings.app.description,
            'interop:applicationAuthor': this.settings.app.author,
            'interop:applicationThumbnail': this.settings.app.thumbnail,
            'oidc:client_name': this.settings.app.name,
            'oidc:redirect_uris': this.settings.oidc.redirectUris,
            'oidc:post_logout_redirect_uris': this.settings.oidc.postLogoutRedirectUris,
            'oidc:client_uri': this.settings.oidc.clientUri,
            'oidc:logo_uri': this.settings.app.thumbnail,
            'oidc:tos_uri': this.settings.oidc.tosUri,
            'oidc:scope': 'openid profile offline_access webid',
            'oidc:grant_types': ['refresh_token', 'authorization_code'],
            'oidc:response_types': ['code'],
            'oidc:default_max_age': 3600,
            'oidc:require_auth_time': true
          },
          contentType: MIME_TYPES.JSON,
          webId: 'system'
        });

        await this.broker.call(
          'auth.account.attachWebId',
          {
            accountUri: account['@id'],
            webId: actorUri
          },
          { meta: { isSystemCall: true } }
        );
      } catch (e) {
        // Delete account if resource creation failed, or it may cause problems when retrying
        await this.broker.call('auth.account.remove', { id: account['@id'] });
        throw e;
      }

      this.appActor = await this.broker.call('activitypub.actor.awaitCreateComplete', { actorUri });

      await this.broker.waitForServices(['access-needs-groups']);
      const accessNeedGroupUris = await this.broker.call('access-needs-groups.initialize');

      await this.broker.call('ldp.resource.patch', {
        resourceUri: this.appActor.id,
        triplesToAdd: arrayOf(accessNeedGroupUris).map(accessNeedGroupUri =>
          triple(
            namedNode(this.appActor.id),
            namedNode('http://www.w3.org/ns/solid/interop#hasAccessNeedGroup'),
            namedNode(accessNeedGroupUri)
          )
        ),
        webId: 'system'
      });
    } else {
      await this.broker.waitForServices('activitypub.actor');
      this.appActor = await this.broker.call('activitypub.actor.awaitCreateComplete', { actorUri });
    }

    await this.broker.waitForServices(['class-description', 'access-description-set']);

    for (const [type, classDescription] of Object.entries(this.settings.classDescriptions)) {
      // Create one ClassDescription per language
      const results = await this.broker.call('class-description.register', {
        type,
        appUri: this.appActor.id,
        label: classDescription.label,
        labelPredicate: classDescription.labelPredicate,
        openEndpoint: classDescription.openEndpoint
      });

      for (const [locale, classDescriptionUri] of Object.entries(results)) {
        // Attach ClassDescription to corresponding AccessDescriptionSet (create it if necessary)
        const accessDescriptionSetUri = await this.broker.call('access-description-set.attachClassDescription', {
          locale,
          classDescriptionUri
        });

        // Attach the AccessDescriptionSet to the Application
        await this.broker.call('ldp.resource.patch', {
          resourceUri: this.appActor.id,
          triplesToAdd: [
            triple(
              namedNode(this.appActor.id),
              namedNode('http://www.w3.org/ns/solid/interop#hasAccessDescriptionSet'),
              namedNode(accessDescriptionSetUri)
            )
          ],
          webId: 'system'
        });
      }
    }

    await this.broker.call('nodeinfo.addLink', {
      rel: 'https://www.w3.org/ns/activitystreams#Application',
      href: this.appActor.id
    });
  },
  actions: {
    get() {
      return this.appActor;
    }
  }
};
