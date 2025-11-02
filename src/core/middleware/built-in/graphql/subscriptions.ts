// GraphQL WebSocket Subscriptions Support
import { createFrameworkLogger } from '../../../logger/index.js';
import { GraphQLSchema } from 'graphql';
import { GraphQLExecutor } from '../../../graphql/executor.js';
import type { GraphQLContext } from '../../../graphql/types.js';

const logger = createFrameworkLogger('GraphQLSubscriptions');

/**
 * GraphQL Subscription Manager
 * Handles WebSocket subscriptions for GraphQL
 */
export class GraphQLSubscriptionManager {
  private subscriptions = new Map<string, AsyncIterator<any>>();
  private executor: GraphQLExecutor;

  constructor(
    private schema: GraphQLSchema,
    private contextFactory?: (
      socket: any,
      connectionParams?: any
    ) => GraphQLContext | Promise<GraphQLContext>
  ) {
    this.executor = new GraphQLExecutor(schema);
  }

  /**
   * Handle subscription request
   */
  async subscribe(
    socket: any,
    subscriptionId: string,
    query: string,
    variables?: Record<string, any>,
    operationName?: string,
    connectionParams?: any
  ): Promise<void> {
    try {
      // Create context
      const context = this.contextFactory
        ? await this.contextFactory(socket, connectionParams)
        : this.createDefaultContext(socket, connectionParams);

      // Execute subscription
      const result = await this.executor.executeSubscription(
        query,
        variables,
        context,
        operationName
      );

      // Check if it's an async iterator (subscription) or error
      if ('errors' in result) {
        logger.error('Subscription execution error', 'Subscription', {
          subscriptionId,
          errors: result.errors,
        });

        socket.send(
          JSON.stringify({
            type: 'error',
            id: subscriptionId,
            payload: { errors: result.errors },
          })
        );
        return;
      }

      // Store subscription
      const iterator = result as AsyncIterableIterator<any>;
      this.subscriptions.set(subscriptionId, iterator);

      logger.info('Subscription started', 'Subscription', {
        subscriptionId,
        operationName,
      });

      // Listen for subscription events
      this.listenToSubscription(socket, subscriptionId, iterator);
    } catch (error) {
      logger.error('Failed to start subscription', 'Subscription', {
        subscriptionId,
        error,
      });

      socket.send(
        JSON.stringify({
          type: 'error',
          id: subscriptionId,
          payload: {
            errors: [
              {
                message: error instanceof Error ? error.message : 'Unknown error',
              },
            ],
          },
        })
      );
    }
  }

  /**
   * Listen to subscription events
   */
  private async listenToSubscription(
    socket: any,
    subscriptionId: string,
    iterator: AsyncIterableIterator<any>
  ): Promise<void> {
    try {
      for await (const result of iterator) {
        // Send result to client
        socket.send(
          JSON.stringify({
            type: 'data',
            id: subscriptionId,
            payload: result,
          })
        );
      }

      // Subscription completed
      socket.send(
        JSON.stringify({
          type: 'complete',
          id: subscriptionId,
        })
      );

      this.subscriptions.delete(subscriptionId);
    } catch (error) {
      logger.error('Subscription error', 'Subscription', {
        subscriptionId,
        error,
      });

      socket.send(
        JSON.stringify({
          type: 'error',
          id: subscriptionId,
          payload: {
            errors: [
              {
                message: error instanceof Error ? error.message : 'Unknown error',
              },
            ],
          },
        })
      );

      this.subscriptions.delete(subscriptionId);
    }
  }

  /**
   * Unsubscribe from a subscription
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const iterator = this.subscriptions.get(subscriptionId);

    if (iterator && typeof iterator.return === 'function') {
      await iterator.return();
      logger.info('Subscription stopped', 'Subscription', { subscriptionId });
    }

    this.subscriptions.delete(subscriptionId);
  }

  /**
   * Unsubscribe all subscriptions for a socket
   */
  async unsubscribeAll(_socket: any): Promise<void> {
    const toUnsubscribe: string[] = [];

    // Find all subscriptions for this socket
    for (const [subscriptionId] of this.subscriptions) {
      toUnsubscribe.push(subscriptionId);
    }

    // Unsubscribe from all
    await Promise.all(toUnsubscribe.map(id => this.unsubscribe(id)));

    logger.info('All subscriptions stopped for socket', 'Subscription', {
      count: toUnsubscribe.length,
    });
  }

  /**
   * Create default context
   */
  private createDefaultContext(socket: any, connectionParams?: any): GraphQLContext {
    return {
      request: {} as any,
      response: {} as any,
      socket,
      connectionParams,
    };
  }

  /**
   * Get subscription count
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }
}

/**
 * Setup GraphQL subscriptions on WebSocket
 */
export function setupGraphQLSubscriptions(
  websocketManager: any,
  schema: GraphQLSchema,
  options: {
    path?: string;
    contextFactory?: (
      socket: any,
      connectionParams?: any
    ) => GraphQLContext | Promise<GraphQLContext>;
    onConnect?: (connectionParams: any) => boolean | Promise<boolean>;
    onDisconnect?: (socket: any) => void | Promise<void>;
  } = {}
): GraphQLSubscriptionManager {
  const path = options.path || '/graphql/subscriptions';
  const subscriptionManager = new GraphQLSubscriptionManager(schema, options.contextFactory);

  logger.info('Setting up GraphQL subscriptions', 'Setup', { path });

  // Create WebSocket namespace for subscriptions
  const namespace = websocketManager.createNamespace(path);

  // Handle connections
  namespace.on('connection', async (socket: any) => {
    logger.debug('WebSocket connection established', 'Connection');

    // Handle connection initialization
    socket.on('connection_init', async (payload: any) => {
      try {
        // Call onConnect if provided
        if (options.onConnect) {
          const allowed = await options.onConnect(payload);
          if (!allowed) {
            socket.send(
              JSON.stringify({
                type: 'connection_error',
                payload: { message: 'Connection rejected' },
              })
            );
            socket.close();
            return;
          }
        }

        socket.send(
          JSON.stringify({
            type: 'connection_ack',
          })
        );

        logger.debug('WebSocket connection initialized', 'Connection');
      } catch (error) {
        logger.error('Connection initialization failed', 'Connection', { error });
        socket.close();
      }
    });

    // Handle subscription start
    socket.on('start', async (message: any) => {
      const { id, payload } = message;

      await subscriptionManager.subscribe(
        socket,
        id,
        payload.query,
        payload.variables,
        payload.operationName,
        payload.extensions?.connectionParams
      );
    });

    // Handle subscription stop
    socket.on('stop', async (message: any) => {
      const { id } = message;
      await subscriptionManager.unsubscribe(id);
    });

    // Handle connection termination
    socket.on('connection_terminate', async () => {
      await subscriptionManager.unsubscribeAll(socket);
      socket.close();
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      await subscriptionManager.unsubscribeAll(socket);

      if (options.onDisconnect) {
        await options.onDisconnect(socket);
      }

      logger.debug('WebSocket connection closed', 'Connection');
    });
  });

  return subscriptionManager;
}
