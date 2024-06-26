const dataServers = {
  podProvider: {
    authServer: true,
    baseUrl: CONFIG.BACKEND_URL,
    void: false
  },
  pod: {
    pod: true,
    default: true,
    baseUrl: null, // Calculated from the token
    sparqlEndpoint: null,
    containers: {
      pod: {
        'vcard:Location': ['/vcard/location'],
        'vcard:Individual': ['/vcard/individual'],
        'vcard:Group': ['/vcard/group'],
        'interop:ApplicationRegistration': ['/interop/application-registration'],
        'apods:ClassDescription': ['/apods/class-description']
      }
    },
    uploadsContainer: '/semapps/file'
  },
  activitypods: {
    baseUrl: process.env.ACTIVITYPODS_COMMON_CONF_URL || 'https://data.activitypods.org/',
    noProxy: true // HTTP signature is not supported on that server
  }
};

export default dataServers;
