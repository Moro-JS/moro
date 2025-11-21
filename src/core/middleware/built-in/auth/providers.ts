// Extended Auth Provider Configurations
import { AuthProvider } from '../../../../types/auth.js';

/**
 * Popular OAuth Providers for Better Auth
 * These extend the basic providers with more options and popular services
 */
export const extendedProviders = {
  // Enhanced GitHub provider with more options
  github: (options: {
    clientId: string;
    clientSecret: string;
    scope?: string;
    allowSignup?: boolean;
  }): AuthProvider => ({
    id: 'github',
    name: 'GitHub',
    type: 'oauth' as const,
    authorization: {
      url: 'https://github.com/login/oauth/authorize',
      params: {
        scope: options.scope || 'read:user user:email',
        allow_signup: options.allowSignup ?? true,
      },
    },
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.id.toString(),
      name: profile.name || profile.login,
      email: profile.email,
      image: profile.avatar_url,
      username: profile.login,
    }),
  }),

  // Enhanced Google provider
  google: (options: {
    clientId: string;
    clientSecret: string;
    scope?: string;
    hostedDomain?: string;
  }): AuthProvider => ({
    id: 'google',
    name: 'Google',
    type: 'oauth' as const,
    authorization: {
      url: 'https://accounts.google.com/oauth/authorize',
      params: {
        scope: options.scope || 'openid email profile',
        response_type: 'code',
        ...(options.hostedDomain && { hd: options.hostedDomain }),
      },
    },
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.id,
      name: profile.name,
      email: profile.email,
      image: profile.picture,
      emailVerified: profile.verified_email,
    }),
  }),

  // Microsoft/Azure AD provider
  microsoft: (options: {
    clientId: string;
    clientSecret: string;
    tenant?: string;
    scope?: string;
  }): AuthProvider => ({
    id: 'microsoft',
    name: 'Microsoft',
    type: 'oauth' as const,
    authorization: {
      url: `https://login.microsoftonline.com/${options.tenant || 'common'}/oauth2/v2.0/authorize`,
      params: {
        scope: options.scope || 'openid email profile',
        response_type: 'code',
      },
    },
    token: `https://login.microsoftonline.com/${options.tenant || 'common'}/oauth2/v2.0/token`,
    userinfo: 'https://graph.microsoft.com/oidc/userinfo',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.sub,
      name: profile.name,
      email: profile.email,
      image: profile.picture,
    }),
  }),

  // Apple provider
  apple: (options: { clientId: string; clientSecret: string; scope?: string }): AuthProvider => ({
    id: 'apple',
    name: 'Apple',
    type: 'oauth' as const,
    authorization: {
      url: 'https://appleid.apple.com/auth/authorize',
      params: {
        scope: options.scope || 'name email',
        response_mode: 'form_post',
        response_type: 'code',
      },
    },
    token: 'https://appleid.apple.com/auth/token',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: (profile, _tokens) => ({
      id: profile.sub,
      name: profile.name ? `${profile.name.firstName} ${profile.name.lastName}` : null,
      email: profile.email,
      emailVerified: profile.email_verified === 'true',
    }),
  }),

  // LinkedIn provider
  linkedin: (options: {
    clientId: string;
    clientSecret: string;
    scope?: string;
  }): AuthProvider => ({
    id: 'linkedin',
    name: 'LinkedIn',
    type: 'oauth' as const,
    authorization: {
      url: 'https://www.linkedin.com/oauth/v2/authorization',
      params: {
        scope: options.scope || 'r_liteprofile r_emailaddress',
      },
    },
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    userinfo: 'https://api.linkedin.com/v2/me',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.id,
      name: `${profile.localizedFirstName} ${profile.localizedLastName}`,
      email: profile.emailAddress,
      image: profile.profilePicture?.['displayImage~']?.elements?.[0]?.identifiers?.[0]?.identifier,
    }),
  }),

  // Facebook provider
  facebook: (options: {
    clientId: string;
    clientSecret: string;
    scope?: string;
  }): AuthProvider => ({
    id: 'facebook',
    name: 'Facebook',
    type: 'oauth' as const,
    authorization: {
      url: 'https://www.facebook.com/v18.0/dialog/oauth',
      params: {
        scope: options.scope || 'email public_profile',
      },
    },
    token: 'https://graph.facebook.com/v18.0/oauth/access_token',
    userinfo: 'https://graph.facebook.com/me?fields=id,name,email,picture',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.id,
      name: profile.name,
      email: profile.email,
      image: profile.picture?.data?.url,
    }),
  }),

  // Twitter/X provider
  twitter: (options: {
    clientId: string;
    clientSecret: string;
    version?: '1.0a' | '2.0';
  }): AuthProvider => ({
    id: 'twitter',
    name: 'Twitter',
    type: 'oauth' as const,
    authorization: 'https://twitter.com/i/oauth2/authorize',
    token: 'https://api.twitter.com/2/oauth2/token',
    userinfo: 'https://api.twitter.com/2/users/me',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.data.id,
      name: profile.data.name,
      username: profile.data.username,
      image: profile.data.profile_image_url,
    }),
  }),

  // Slack provider
  slack: (options: { clientId: string; clientSecret: string; scope?: string }): AuthProvider => ({
    id: 'slack',
    name: 'Slack',
    type: 'oauth' as const,
    authorization: {
      url: 'https://slack.com/oauth/v2/authorize',
      params: {
        user_scope: options.scope || 'identity.basic identity.email identity.avatar',
      },
    },
    token: 'https://slack.com/api/oauth.v2.access',
    userinfo: 'https://slack.com/api/users.identity',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.user.id,
      name: profile.user.name,
      email: profile.user.email,
      image: profile.user.image_192,
    }),
  }),

  // GitLab provider
  gitlab: (options: {
    clientId: string;
    clientSecret: string;
    domain?: string;
    scope?: string;
  }): AuthProvider => ({
    id: 'gitlab',
    name: 'GitLab',
    type: 'oauth' as const,
    authorization: {
      url: `${options.domain || 'https://gitlab.com'}/oauth/authorize`,
      params: {
        scope: options.scope || 'read_user',
      },
    },
    token: `${options.domain || 'https://gitlab.com'}/oauth/token`,
    userinfo: `${options.domain || 'https://gitlab.com'}/api/v4/user`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.id.toString(),
      name: profile.name,
      email: profile.email,
      image: profile.avatar_url,
      username: profile.username,
    }),
  }),

  // Spotify provider
  spotify: (options: { clientId: string; clientSecret: string; scope?: string }): AuthProvider => ({
    id: 'spotify',
    name: 'Spotify',
    type: 'oauth' as const,
    authorization: {
      url: 'https://accounts.spotify.com/authorize',
      params: {
        scope: options.scope || 'user-read-email user-read-private',
      },
    },
    token: 'https://accounts.spotify.com/api/token',
    userinfo: 'https://api.spotify.com/v1/me',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.id,
      name: profile.display_name,
      email: profile.email,
      image: profile.images?.[0]?.url,
    }),
  }),

  // Twitch provider
  twitch: (options: { clientId: string; clientSecret: string; scope?: string }): AuthProvider => ({
    id: 'twitch',
    name: 'Twitch',
    type: 'oauth' as const,
    authorization: {
      url: 'https://id.twitch.tv/oauth2/authorize',
      params: {
        scope: options.scope || 'user:read:email',
      },
    },
    token: 'https://id.twitch.tv/oauth2/token',
    userinfo: 'https://api.twitch.tv/helix/users',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.data[0].id,
      name: profile.data[0].display_name,
      email: profile.data[0].email,
      image: profile.data[0].profile_image_url,
      username: profile.data[0].login,
    }),
  }),

  // Notion provider
  notion: (options: { clientId: string; clientSecret: string }): AuthProvider => ({
    id: 'notion',
    name: 'Notion',
    type: 'oauth' as const,
    authorization: 'https://api.notion.com/v1/oauth/authorize',
    token: 'https://api.notion.com/v1/oauth/token',
    userinfo: 'https://api.notion.com/v1/users/me',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.id,
      name: profile.name,
      email: profile.person?.email,
      image: profile.avatar_url,
    }),
  }),
};

/**
 * Enterprise/SAML providers
 */
export const enterpriseProviders = {
  // Generic SAML provider
  saml: (options: {
    name: string;
    entryPoint: string;
    issuer: string;
    cert: string;
    callbackUrl?: string;
  }): AuthProvider => ({
    id: 'saml',
    name: options.name,
    type: 'oauth' as const,
    authorization: options.entryPoint,
    clientId: options.issuer,
    // SAML-specific configuration would go here
    entryPoint: options.entryPoint,
    issuer: options.issuer,
    cert: options.cert,
    callbackUrl: options.callbackUrl,
  }),

  // Okta provider
  okta: (options: {
    clientId: string;
    clientSecret: string;
    domain: string;
    authorizationServerId?: string;
  }): AuthProvider => ({
    id: 'okta',
    name: 'Okta',
    type: 'oidc' as const,
    issuer: `${options.domain}/oauth2/${options.authorizationServerId || 'default'}`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.sub,
      name: profile.name,
      email: profile.email,
      username: profile.preferred_username,
    }),
  }),

  // Auth0 provider
  auth0: (options: {
    clientId: string;
    clientSecret: string;
    domain: string;
    audience?: string;
  }): AuthProvider => ({
    id: 'auth0',
    name: 'Auth0',
    type: 'oidc' as const,
    issuer: `https://${options.domain}`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorization: {
      url: `https://${options.domain}/authorize`,
      params: {
        audience: options.audience,
      },
    },
    profile: profile => ({
      id: profile.sub,
      name: profile.name,
      email: profile.email,
      image: profile.picture,
      emailVerified: profile.email_verified,
    }),
  }),

  // AWS Cognito provider
  cognito: (options: {
    clientId: string;
    clientSecret: string;
    domain: string;
    region?: string;
  }): AuthProvider => ({
    id: 'cognito',
    name: 'AWS Cognito',
    type: 'oidc' as const,
    issuer: `https://cognito-idp.${options.region || 'us-east-1'}.amazonaws.com/${options.domain}`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile: profile => ({
      id: profile.sub,
      name: profile.name,
      email: profile.email,
      username: profile['cognito:username'],
      emailVerified: profile.email_verified,
    }),
  }),
};

/**
 * Helper function to create custom OAuth provider
 */
export function createCustomOAuthProvider(config: {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope?: string;
  profileMapper?: (profile: any) => any;
}): AuthProvider {
  return {
    id: config.id,
    name: config.name,
    type: 'oauth' as const,
    authorization: {
      url: config.authorizationUrl,
      params: {
        scope: config.scope || 'openid email profile',
      },
    },
    token: config.tokenUrl,
    userinfo: config.userinfoUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    profile:
      config.profileMapper ||
      (profile => ({
        id: profile.id || profile.sub,
        name: profile.name,
        email: profile.email,
        image: profile.picture || profile.avatar_url,
      })),
  };
}

/**
 * Helper function to create custom OIDC provider
 */
export function createCustomOIDCProvider(config: {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  profileMapper?: (profile: any) => any;
}): AuthProvider {
  return {
    id: config.id,
    name: config.name,
    type: 'oidc' as const,
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    profile:
      config.profileMapper ||
      (profile => ({
        id: profile.sub,
        name: profile.name,
        email: profile.email,
        image: profile.picture,
        emailVerified: profile.email_verified,
      })),
  };
}
