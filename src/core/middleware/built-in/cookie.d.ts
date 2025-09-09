import { MiddlewareInterface } from '../../../types/hooks';
export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  domain?: string;
  path?: string;
}
export declare const cookie: (options?: {
  secret?: string;
  signed?: boolean;
}) => MiddlewareInterface;
