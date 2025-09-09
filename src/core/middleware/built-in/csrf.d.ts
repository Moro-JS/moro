import { MiddlewareInterface } from '../../../types/hooks';
export declare const csrf: (options?: {
  secret?: string;
  tokenLength?: number;
  cookieName?: string;
  headerName?: string;
  ignoreMethods?: string[];
  sameSite?: boolean;
}) => MiddlewareInterface;
