// GraphQL Middleware - Hook-based integration
import { createFrameworkLogger } from '../../../logger/index.js';
import { GraphQLCore } from '../../../graphql/core.js';
import type { MiddlewareInterface } from '../../index.js';
import type { HookContext } from '../../../../types/hooks.js';
import type { GraphQLOptions } from '../../../graphql/types.js';

const logger = createFrameworkLogger('GraphQLHook');

/**
 * GraphQL Hook Middleware
 * Provides hook-based GraphQL integration with MoroJS middleware system
 */
export const graphql = (options: GraphQLOptions): MiddlewareInterface => ({
  name: 'graphql',
  version: '1.0.0',
  metadata: {
    name: 'graphql',
    version: '1.0.0',
    description: 'GraphQL middleware with Pothos support and GraphQL-JIT performance optimization',
    author: 'MoroJS Team',
    dependencies: ['graphql'],
    tags: ['graphql', 'api', 'pothos', 'performance'],
  },

  install: async (hooks: any, middlewareOptions: Partial<GraphQLOptions> = {}) => {
    logger.debug('Installing GraphQL middleware', 'Installation', { options: middlewareOptions });

    const config = { ...options, ...middlewareOptions };
    const graphqlCore = new GraphQLCore(config);

    // Initialize GraphQL
    await graphqlCore.initialize();

    const graphqlPath = config.path || '/graphql';
    const playgroundPath = config.playgroundPath || `${graphqlPath}/playground`;
    const enablePlayground =
      config.enablePlayground !== false && process.env.NODE_ENV !== 'production';

    logger.info('GraphQL endpoint configured', 'Configuration', {
      graphqlPath,
      playgroundPath: enablePlayground ? playgroundPath : 'disabled',
      jit: graphqlCore.getStats().jit.enabled,
    });

    // Register hooks for request processing
    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Handle GraphQL Playground
      if (enablePlayground && req.path === playgroundPath && req.method === 'GET') {
        logger.debug('Serving GraphQL Playground', 'Playground');
        res.setHeader('Content-Type', 'text/html');
        res.status(200).send(graphqlCore.getPlaygroundHTML(graphqlPath));
        return; // Stop processing
      }

      // Handle GraphQL endpoint
      if (req.path === graphqlPath) {
        logger.debug('Processing GraphQL request', 'Request', {
          method: req.method,
          operationName: req.body?.operationName,
        });

        // Handle OPTIONS for CORS
        if (req.method === 'OPTIONS') {
          res.status(200).end();
          return;
        }

        // Only allow GET and POST
        if (req.method !== 'GET' && req.method !== 'POST') {
          res.status(405).json({
            errors: [{ message: 'GraphQL only supports GET and POST requests' }],
          });
          return;
        }

        // Execute GraphQL request
        await graphqlCore.handleRequest(req, res);
        return; // Stop processing
      }

      // Not a GraphQL request, continue
    });

    // Expose GraphQL stats via context
    hooks.after('request', async (context: HookContext) => {
      const req = context.request as any;

      if (req.path === graphqlPath && req.graphqlMetrics) {
        logger.debug('GraphQL request completed', 'Metrics', req.graphqlMetrics);
      }
    });
  },
});
