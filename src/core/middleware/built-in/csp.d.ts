import { MiddlewareInterface } from '../../../types/hooks';
export declare const csp: (options?: {
  directives?: {
    defaultSrc?: string[];
    scriptSrc?: string[];
    styleSrc?: string[];
    imgSrc?: string[];
    connectSrc?: string[];
    fontSrc?: string[];
    objectSrc?: string[];
    mediaSrc?: string[];
    frameSrc?: string[];
    childSrc?: string[];
    workerSrc?: string[];
    formAction?: string[];
    upgradeInsecureRequests?: boolean;
    blockAllMixedContent?: boolean;
  };
  reportOnly?: boolean;
  reportUri?: string;
  nonce?: boolean;
}) => MiddlewareInterface;
