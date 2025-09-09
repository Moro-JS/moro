import { MiddlewareInterface } from '../../../types/hooks';
export declare const sse: (options?: {
  heartbeat?: number;
  retry?: number;
  cors?: boolean;
}) => MiddlewareInterface;
