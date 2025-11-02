// GraphQL WebSocket Subscriptions Support
// TODO: Refactor to use adapter pattern
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('GraphQLSubscriptions');

/**
 * GraphQL Subscription Manager
 * Handles WebSocket-based GraphQL subscriptions
 *
 * NOTE: This needs to be refactored to use the new adapter pattern.
 * For now, subscriptions are disabled pending refactor.
 */
export class GraphQLSubscriptionManager {
  private subscriptions = new Map<string, any>();

  constructor(_schema: any, _contextFactory?: any) {
    logger.warn(
      'GraphQL subscriptions are temporarily disabled pending adapter refactor',
      'Subscriptions'
    );
  }

  // Placeholder methods
  async subscribe() {
    throw new Error('GraphQL subscriptions temporarily disabled');
  }

  unsubscribe() {
    // no-op
  }

  cleanup() {
    this.subscriptions.clear();
  }
}

/**
 * Setup GraphQL subscriptions on WebSocket
 *
 * NOTE: Temporarily disabled pending refactor to adapter pattern
 */
export function setupGraphQLSubscriptions(
  _websocketManager: any,
  schema: any,
  _options: any = {}
): GraphQLSubscriptionManager {
  logger.warn(
    'GraphQL subscriptions setup called but feature is temporarily disabled',
    'Subscriptions'
  );
  return new GraphQLSubscriptionManager(schema);
}
