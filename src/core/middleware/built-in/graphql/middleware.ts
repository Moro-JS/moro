// GraphQL Middleware - Standard middleware integration
import { StandardMiddleware } from '../../../../types/hooks.js';
import { GraphQLCore } from '../../../graphql/core.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import type { HttpRequest, HttpResponse } from '../../../../types/http.js';
import type { GraphQLOptions } from '../../../graphql/types.js';

const logger = createFrameworkLogger('GraphQLMiddleware');

/**
 * Create GraphQL standard middleware
 * For use in standard middleware chains (req, res, next)
 */
export function createGraphQLMiddleware(options: GraphQLOptions): StandardMiddleware {
  const graphqlCore = new GraphQLCore(options);
  let initialized = false;

  const graphqlPath = options.path || '/graphql';
  const playgroundPath = options.playgroundPath || `${graphqlPath}/playground`;
  const enablePlayground =
    options.enablePlayground !== false && process.env.NODE_ENV !== 'production';

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    // Initialize on first request
    if (!initialized) {
      await graphqlCore.initialize();
      initialized = true;

      logger.info('GraphQL middleware initialized', 'Initialization', {
        graphqlPath,
        playgroundPath: enablePlayground ? playgroundPath : 'disabled',
        jit: graphqlCore.getStats().jit.enabled,
      });
    }

    const reqAny = req as any;

    // Handle GraphQL Playground
    if (enablePlayground && reqAny.path === playgroundPath && req.method === 'GET') {
      (res as any).setHeader('Content-Type', 'text/html');
      (res as any).status(200).send(graphqlCore.getPlaygroundHTML(graphqlPath));
      return;
    }

    // Handle GraphQL endpoint
    if (reqAny.path === graphqlPath) {
      // Handle OPTIONS for CORS
      if (req.method === 'OPTIONS') {
        (res as any).status(200).end();
        return;
      }

      // Only allow GET and POST
      if (req.method !== 'GET' && req.method !== 'POST') {
        (res as any).status(405).json({
          errors: [{ message: 'GraphQL only supports GET and POST requests' }],
        });
        return;
      }

      // Execute GraphQL request
      await graphqlCore.handleRequest(req, res);
      return;
    }

    // Not a GraphQL request, continue
    await next();
  };
}
