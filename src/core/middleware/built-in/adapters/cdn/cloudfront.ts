// AWS CloudFront CDN Adapter
import { CDNAdapter } from "../../../../../types/cdn";
import { createFrameworkLogger } from "../../../../logger";

const logger = createFrameworkLogger("CloudFrontCDNAdapter");

export class CloudFrontCDNAdapter implements CDNAdapter {
  private cloudfront: any;
  private distributionId: string;

  constructor(options: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    distributionId: string;
  }) {
    this.distributionId = options.distributionId;

    try {
      const AWS = require("aws-sdk");
      AWS.config.update({
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region: options.region,
      });

      this.cloudfront = new AWS.CloudFront();
      logger.info("CloudFront CDN adapter initialized", "CloudFront");
    } catch (error) {
      logger.error("AWS SDK not available", "CloudFront");
      throw new Error("AWS SDK not installed. Run: npm install aws-sdk");
    }
  }

  async purge(urls: string[]): Promise<void> {
    try {
      const params = {
        DistributionId: this.distributionId,
        InvalidationBatch: {
          CallerReference: `moro-${Date.now()}`,
          Paths: {
            Quantity: urls.length,
            Items: urls.map((url) => (url.startsWith("/") ? url : `/${url}`)),
          },
        },
      };

      const result = await this.cloudfront.createInvalidation(params).promise();
      logger.info(
        `CloudFront cache purged: ${urls.length} URLs`,
        "CloudFront",
        {
          invalidationId: result.Invalidation.Id,
        },
      );
    } catch (error) {
      logger.error("CloudFront purge failed", "CloudFront", { error, urls });
      throw error;
    }
  }

  async prefetch(urls: string[]): Promise<void> {
    logger.debug(
      `CloudFront prefetch requested for ${urls.length} URLs`,
      "CloudFront",
    );
    // CloudFront doesn't have direct prefetch, but we can simulate with requests
  }

  async getStats(): Promise<any> {
    try {
      const params = { Id: this.distributionId };
      const distribution = await this.cloudfront
        .getDistribution(params)
        .promise();

      return {
        status: distribution.Distribution.Status,
        domainName: distribution.Distribution.DomainName,
        enabled: distribution.Distribution.DistributionConfig.Enabled,
      };
    } catch (error) {
      logger.error("CloudFront stats failed", "CloudFront", { error });
      return null;
    }
  }

  setHeaders(response: any): void {
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.setHeader("CloudFront-Viewer-Country", "US");
  }
}
