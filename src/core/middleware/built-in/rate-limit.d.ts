import { MiddlewareInterface } from '../../../types/hooks';
export declare const rateLimit: (options?: {
  windowMs?: number;
  max?: number;
  message?: string;
}) => MiddlewareInterface;
