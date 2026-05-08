const urlJoin = require('url-join');
const { ControlledContainerMixin, arrayOf } = require('@semapps/ldp');
const { ACTIVITY_TYPES, OBJECT_TYPES, ActivitiesHandlerMixin } = require('@semapps/activitypub');
const CONFIG = require('../../config/config');

module.exports = {
  name: 'contacts.message',
  mixins: [ControlledContainerMixin, ActivitiesHandlerMixin],
  settings: {
    acceptedTypes: ['as:Note'],
    shapeTreeUri: urlJoin(CONFIG.SHAPE_REPOSITORY_URL, 'shapetrees/as/Note'),
    permissions: {},
    newResourcesPermissions: {},
    typeIndex: 'public'
  },
  activities: {
    createNote: {
      match: {
        type: ACTIVITY_TYPES.CREATE,
        object: {
          type: OBJECT_TYPES.NOTE
        }
      },
      async onEmit(ctx, activity, emitterUri) {
        // Ensure the recipients are in the contacts WebACL group of the emitter so they can see his profile (and respond him)
        for (let targetUri of arrayOf(activity.to)) {
          await ctx.call('webacl.group.addMember', {
            groupSlug: new URL(emitterUri).pathname + '/contacts',
            memberUri: targetUri,
            webId: emitterUri
          });
        }

        // Track conversation so the recipient appears in @mention autocomplete for future DMs
        const recipientUris = arrayOf(activity.to).filter(u => /^https?:\/\//.test(u));
        if (recipientUris.length >= 1) {
          const participantUris = [...new Set([emitterUri, ...recipientUris])];
          ctx
            .call('dm.conversations.upsert', {
              actorUri: emitterUri,
              participantUris,
              timestamp: activity.published
            })
            .catch(() => {});
        }
      },

      async onReceive(ctx, activity, recipientUri) {
        // Only notify for messages directly addressed to the recipient (not CC/followers-list)
        if (arrayOf(activity.to).includes(recipientUri)) {
          await ctx.call('mail-notifications.notify', {
            template: {
              title: {
                en: `{{#if activity.object.summary}}{{{activity.object.summary}}}{{else}}{{#if emitterProfile.vcard:given-name}}{{{emitterProfile.vcard:given-name}}}{{else}}{{{emitter.name}}}{{/if}} sent you a message{{/if}}`,
                fr: `{{#if activity.object.summary}}{{{activity.object.summary}}}{{else}}{{#if emitterProfile.vcard:given-name}}{{{emitterProfile.vcard:given-name}}}{{else}}{{{emitter.name}}}{{/if}} vous a envoyé un message{{/if}}`
              },
              content: '{{removeHtmlTags activity.object.content}}',
              actions: [
                {
                  caption: {
                    en: 'Reply',
                    fr: 'Répondre'
                  },
                  link: '/network/{{encodeUri emitter.id}}'
                }
              ]
            },
            recipientUri,
            activity,
            context: activity.object.id
          });
        }

        // Track conversation so this sender appears in @mention autocomplete
        const senderUri =
          typeof activity.actor === 'string'
            ? activity.actor
            : activity.actor && typeof activity.actor === 'object'
              ? activity.actor.id
              : null;

        if (senderUri && /^https?:\/\//.test(senderUri)) {
          const otherRecipients = arrayOf(activity.to).filter(u => u !== recipientUri && /^https?:\/\//.test(u));
          const participantUris = [...new Set([senderUri, recipientUri, ...otherRecipients])];

          ctx
            .call('dm.conversations.upsert', {
              actorUri: recipientUri,
              participantUris,
              timestamp: activity.published
            })
            .catch(() => {});

          // Submit remote media attachments to the media pipeline for safety/moderation
          for (const att of arrayOf(activity.object?.attachment || [])) {
            const url = typeof att === 'string' ? att : att?.url;
            if (url && /^https?:\/\//.test(url)) {
              ctx
                .call('media-pipeline-emitter.submitAttachment', {
                  url,
                  ownerId: recipientUri,
                  alt: att?.name || att?.alt || null,
                  isSensitive: !!activity.object?.sensitive
                })
                .catch(() => {});
            }
          }
        }
      }
    }
  }
};
