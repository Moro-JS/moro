// Minimal stand-in for the part of the `better-auth` package the MoroJS
// adapter uses: betterAuth(options) returns { handler(request), api.getSession },
// and `socialProviders` lists the provider ids the package knows.
// better-auth is an optional peer and is not installed in this repository.
//
// Like the real package, the handler serves its routes under options.basePath
// and answers 404 for a request whose path is anywhere else; it refuses a
// provider id it does not know; starting a social sign-in takes a JSON body
// only, and answers 200 with a JSON body and a Location header; a request
// that carries cookies and names an origin that is not trusted is refused.
// Every instance records what it was given, so a test can read the exact
// request.
//
// It also stands in for the plugin modules (`better-auth/plugins/<name>` and
// the `better-auth/plugins` barrel): `twoFactor`, `organization`, `anonymous`
// and `bearer` return an object with the plugin's id and the options it was
// given. Two of them act: with `bearer` configured a session token is
// accepted as `Authorization: Bearer`, and with `organization` the session
// carries `activeOrganizationId`. A database object with `missingTables`
// makes every request fail the way the real package does when its schema has
// not been migrated; one with `neverAnswers` leaves a session lookup pending.
//
// With `rateLimit.enabled` and a rule for `/sign-in/*` it limits the sign-in
// routes per client address, read the way the real package reads it: the
// first header of `advanced.ipAddress.ipAddressHeaders` (default
// `x-forwarded-for`) that holds exactly one address.
/* global URL, URLSearchParams, Headers, Response */
'use strict';

const instances = [];

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com', image: null };
// A user row with the fields an application adds to it
const STAFF = {
  id: 'u2',
  name: 'Grace',
  email: 'grace@example.com',
  image: null,
  emailVerified: true,
  role: 'admin,editor',
  permissions: ['reports:read'],
  tenant: 'acme',
};

// A token of the real shape: "<id>.<base64 signature>". The signature holds
// characters that are percent-encoded in a cookie, as the real one does.
const SESSION_TOKEN = 'tok3n.sig+na/ture=';
const SESSION_COOKIE = `fake.session_token=${encodeURIComponent(SESSION_TOKEN)}`;
const STAFF_TOKEN = 'st4ff.sig+na/ture=';
const STAFF_COOKIE = `fake.session_token=${encodeURIComponent(STAFF_TOKEN)}`;

// The provider ids this stand-in "knows", as `better-auth/social-providers` does
const socialProviders = {
  github: () => ({}),
  google: () => ({}),
  discord: () => ({}),
  gitlab: () => ({}),
  microsoft: () => ({}),
  // One whose options are checked when it is built, as the real cognito's are
  cognito: options => {
    if (!options.domain || !options.region || !options.userPoolId) {
      throw new Error('DOMAIN_AND_REGION_REQUIRED');
    }
    return {};
  },
};

function readCookie(headers, name) {
  for (const pair of (headers.get('cookie') || '').split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === name) {
      try {
        return decodeURIComponent(pair.slice(eq + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// The plugin modules: each factory returns the plugin's id and its options
const plugin = id => options => ({ id, options });
const twoFactor = plugin('two-factor');
const organization = plugin('organization');
const anonymous = plugin('anonymous');
const bearer = plugin('bearer');

const hasPlugin = (options, id) =>
  Array.isArray(options.plugins) && options.plugins.some(entry => entry && entry.id === id);

const ACTIVE_ORGANIZATION = 'org1';

// The cookie value is decoded once, then compared: a value that reached the
// client percent-encoded twice does not match.
function sessionFor(headers, options = {}) {
  let token = readCookie(headers, 'fake.session_token');
  // The bearer plugin: a session token sent as `Authorization: Bearer`
  const authorization = headers.get('authorization') || '';
  if (token === undefined && hasPlugin(options, 'bearer') && authorization.startsWith('Bearer ')) {
    token = authorization.slice(7);
  }
  // The organization plugin keeps the active organization on the session
  const session = {
    expiresAt: '2030-01-01T00:00:00.000Z',
    ...(hasPlugin(options, 'organization') ? { activeOrganizationId: ACTIVE_ORGANIZATION } : {}),
  };
  if (token === SESSION_TOKEN) return { user: USER, session };
  if (token === STAFF_TOKEN) return { user: STAFF, session };
  return null;
}

// What the real package throws, from every request, while the database lacks
// tables its configuration writes
function schemaMismatch(tables) {
  const error = new Error(
    `Database schema mismatch\n\n  Missing tables\n    ${tables.join(', ')}\n\n` +
      '  help: Run `npx auth migrate` to add the missing tables and columns.'
  );
  error.code = 'SCHEMA_MISMATCH';
  error.findings = tables.map(table => ({ kind: 'missing-table', table }));
  return error;
}

function json(data, headers, status = 200) {
  const all = new Headers(headers);
  all.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { status, headers: all });
}

function betterAuth(options) {
  const basePath = options.basePath || '/api/auth';
  const trusted = options.trustedOrigins || [];

  for (const id of Object.keys(options.socialProviders || {})) {
    // What the real package does with an id it has no provider for
    if (typeof socialProviders[id] !== 'function') {
      throw new TypeError('socialProviders[key] is not a function');
    }
    socialProviders[id](options.socialProviders[id]);
  }

  // A state-changing request that carries cookies must name a trusted origin
  const originRefusal = request => {
    if (!request.headers.has('cookie')) return null;
    const origin = request.headers.get('origin');
    if (!origin) return json({ code: 'MISSING_OR_NULL_ORIGIN' }, undefined, 403);
    if (!trusted.includes(origin)) return json({ code: 'INVALID_ORIGIN' }, undefined, 403);
    return null;
  };

  const readBody = (request, body, allowForm) => {
    const type = (request.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('application/json')) return JSON.parse(body || '{}');
    if (allowForm && type.startsWith('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(body));
    }
    return null;
  };

  const missingTables = options.database && options.database.missingTables;

  // Sign-in attempts per client address, when a rule limits them
  const signInRule =
    options.rateLimit && options.rateLimit.enabled && options.rateLimit.customRules
      ? options.rateLimit.customRules['/sign-in/*']
      : undefined;
  const attempts = new Map();
  const clientAddress = headers => {
    const names = (options.advanced &&
      options.advanced.ipAddress &&
      options.advanced.ipAddress.ipAddressHeaders) || ['x-forwarded-for'];
    for (const name of names) {
      const value = headers.get(name);
      if (typeof value === 'string' && value !== '' && !value.includes(',')) return value.trim();
    }
    return 'no-trusted-ip';
  };

  const instance = {
    options,
    /** Every request the handler received: { method, pathname, search, body, headers } */
    requests: [],
    /** The headers of every api.getSession() call */
    sessionLookups: [],

    async handler(request) {
      if (missingTables) throw schemaMismatch(missingTables);
      const url = new URL(request.url);
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      const body = hasBody ? await request.text() : '';
      instance.requests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body,
        headers: Object.fromEntries(request.headers),
      });

      if (!url.pathname.startsWith(`${basePath}/`)) {
        return new Response(null, { status: 404 });
      }

      const route = `${request.method} ${url.pathname.slice(basePath.length)}`;
      if (signInRule && url.pathname.startsWith(`${basePath}/sign-in/`)) {
        const address = clientAddress(request.headers);
        const count = attempts.get(address) || 0;
        if (count >= signInRule.max) {
          return json({ message: 'Too many requests. Please try again later.' }, undefined, 429);
        }
        attempts.set(address, count + 1);
      }
      switch (route) {
        case 'GET /ok':
          return json({ ok: true });

        case 'GET /get-session':
          return json(sessionFor(request.headers, options));

        case 'POST /sign-in/social': {
          const refused = originRefusal(request);
          if (refused) return refused;
          const data = readBody(request, body, false);
          if (!data) return json({ code: 'UNSUPPORTED_MEDIA_TYPE' }, undefined, 415);
          const client = options.socialProviders && options.socialProviders[data.provider];
          if (!client) return json({ code: 'PROVIDER_NOT_FOUND' }, undefined, 404);
          const location =
            `https://provider.example/authorize?client_id=${client.clientId}` +
            (data.callbackURL ? `&next=${encodeURIComponent(data.callbackURL)}` : '');
          const headers = new Headers({ location });
          headers.append('set-cookie', 'fake.state=abc; Path=/; HttpOnly');
          return json({ url: location, redirect: true }, headers);
        }

        // Signs in with a password; a form post is accepted here
        case 'POST /sign-in/email': {
          const refused = originRefusal(request);
          if (refused) return refused;
          const data = readBody(request, body, true);
          if (!data) return json({ code: 'UNSUPPORTED_MEDIA_TYPE' }, undefined, 415);
          if (data.password !== 'correct horse') {
            return json({ code: 'INVALID_EMAIL_OR_PASSWORD' }, undefined, 401);
          }
          const headers = new Headers();
          if (data.callbackURL) headers.set('location', data.callbackURL);
          headers.append(
            'set-cookie',
            `${SESSION_COOKIE}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`
          );
          return json(
            { redirect: Boolean(data.callbackURL), url: data.callbackURL, user: USER },
            headers
          );
        }

        // An organization route called without a session: the real plugin
        // answers 401 with a JSON content type and an empty body
        case 'POST /organization/create': {
          const session = sessionFor(request.headers, options);
          if (!session) {
            return new Response(null, {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          }
          return json({ id: ACTIVE_ORGANIZATION, ...JSON.parse(body || '{}') });
        }

        case 'POST /sign-out': {
          const refused = originRefusal(request);
          if (refused) return refused;
          const headers = new Headers();
          headers.append('set-cookie', 'fake.session_token=; Max-Age=0; Path=/');
          headers.append('set-cookie', 'fake.session_data=; Max-Age=0; Path=/');
          return json({ success: true }, headers);
        }

        default:
          break;
      }

      // The provider's redirect back: issues the session cookie
      const callback = /^GET \/callback\/([^/]+)$/.exec(route);
      if (callback && options.socialProviders && options.socialProviders[callback[1]]) {
        const headers = new Headers({ location: '/dashboard' });
        headers.append('set-cookie', 'fake.state=; Max-Age=0; Path=/; HttpOnly');
        headers.append(
          'set-cookie',
          `${SESSION_COOKIE}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`
        );
        return new Response(null, { status: 302, headers });
      }

      return new Response(null, { status: 404 });
    },

    api: {
      async getSession({ headers }) {
        if (missingTables) throw schemaMismatch(missingTables);
        // A database that accepts the connection and never answers
        if (options.database && options.database.neverAnswers) return new Promise(() => {});
        instance.sessionLookups.push(Object.fromEntries(headers));
        return sessionFor(headers, options);
      },
    },
  };

  instances.push(instance);
  return instance;
}

module.exports = {
  betterAuth,
  socialProviders,
  twoFactor,
  organization,
  anonymous,
  bearer,
  instances,
  SESSION_COOKIE,
  STAFF_COOKIE,
  SESSION_TOKEN,
  ACTIVE_ORGANIZATION,
};
