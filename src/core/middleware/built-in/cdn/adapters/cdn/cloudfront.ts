// AWS CloudFront CDN Adapter
import { CDNAdapter } from '../../../../../../types/cdn.js';
import { createFrameworkLogger } from '../../../../../logger/index.js';
import { isPackageAvailable, resolveUserPackage } from '../../../../../utilities/package-utils.js';
import { warnIfPackageAffected } from '../../../../../utilities/package-notices.js';

const logger = createFrameworkLogger('CloudFrontCDNAdapter');

const SDK_V3 = '@aws-sdk/client-cloudfront';
const SDK_V2 = 'aws-sdk';

interface CloudFrontCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

// The two CloudFront calls the adapter makes, whichever SDK answers them
interface CloudFrontCalls {
  createInvalidation(params: any): Promise<any>;
  getDistribution(params: any): Promise<any>;
}

// AWS SDK v3: one client, one command object per call
async function loadSdkV3(options: CloudFrontCredentials): Promise<CloudFrontCalls> {
  const loaded = await import(resolveUserPackage(SDK_V3));
  const sdk = loaded.CloudFrontClient ? loaded : loaded.default;
  const { accessKeyId, secretAccessKey } = options;
  const client = new sdk.CloudFrontClient({
    region: options.region,
    // Without both keys the SDK finds credentials itself (environment, role)
    ...(accessKeyId && secretAccessKey && { credentials: { accessKeyId, secretAccessKey } }),
  });
  return {
    createInvalidation: params => client.send(new sdk.CreateInvalidationCommand(params)),
    getDistribution: params => client.send(new sdk.GetDistributionCommand(params)),
  };
}

// AWS SDK v2 (the `aws-sdk` package)
async function loadSdkV2(options: CloudFrontCredentials): Promise<CloudFrontCalls> {
  const awsPath = resolveUserPackage(SDK_V2);
  const AWS = await import(awsPath);
  warnIfPackageAffected(SDK_V2, awsPath);
  AWS.default.config.update({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
  });
  const cloudfront = new AWS.default.CloudFront();
  return {
    createInvalidation: params => cloudfront.createInvalidation(params).promise(),
    getDistribution: params => cloudfront.getDistribution(params).promise(),
  };
}

export class CloudFrontCDNAdapter implements CDNAdapter {
  private cloudfront!: CloudFrontCalls;
  private distributionId: string;

  constructor(options: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    distributionId: string;
  }) {
    this.distributionId = options.distributionId;
    this.initPromise = this.initialize(options);
  }

  private initPromise: Promise<void>;

  // @aws-sdk/client-cloudfront (AWS SDK v3) is used when the application has
  // it; otherwise the adapter falls back to the v2 `aws-sdk` package.
  private async initialize(options: CloudFrontCredentials): Promise<void> {
    try {
      this.cloudfront = isPackageAvailable(SDK_V3)
        ? await loadSdkV3(options)
        : await loadSdkV2(options);
      logger.info('CloudFront CDN adapter initialized', 'CloudFront');
    } catch {
      logger.error('AWS SDK not available', 'CloudFront');
      throw new Error(`AWS SDK not installed. Run: npm install ${SDK_V3}`);
    }
  }

  async purge(urls: string[]): Promise<void> {
    try {
      await this.initPromise;
      const params = {
        DistributionId: this.distributionId,
        InvalidationBatch: {
          CallerReference: `moro-${Date.now()}`,
          Paths: {
            Quantity: urls.length,
            Items: urls.map(url => (url.startsWith('/') ? url : `/${url}`)),
          },
        },
      };

      const result = await this.cloudfront.createInvalidation(params);
      logger.info(`CloudFront cache purged: ${urls.length} URLs`, 'CloudFront', {
        invalidationId: result.Invalidation.Id,
      });
    } catch (error) {
      logger.error('CloudFront purge failed', 'CloudFront', { error, urls });
      throw error;
    }
  }

  async prefetch(urls: string[]): Promise<void> {
    logger.debug(`CloudFront prefetch requested for ${urls.length} URLs`, 'CloudFront');
    // CloudFront doesn't have direct prefetch, but we can simulate with requests
  }

  async getStats(): Promise<any> {
    try {
      await this.initPromise;
      const params = { Id: this.distributionId };
      const distribution = await this.cloudfront.getDistribution(params);

      return {
        status: distribution.Distribution.Status,
        domainName: distribution.Distribution.DomainName,
        enabled: distribution.Distribution.DistributionConfig.Enabled,
      };
    } catch (error) {
      logger.error('CloudFront stats failed', 'CloudFront', { error });
      return null;
    }
  }

  setHeaders(response: any): void {
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.setHeader('CloudFront-Viewer-Country', 'US');
  }
}
