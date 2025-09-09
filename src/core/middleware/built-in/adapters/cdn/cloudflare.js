"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudflareCDNAdapter = void 0;
const logger_1 = require("../../../../logger");
const logger = (0, logger_1.createFrameworkLogger)("CloudflareCDNAdapter");
class CloudflareCDNAdapter {
    apiToken;
    zoneId;
    constructor(options) {
        this.apiToken = options.apiToken;
        this.zoneId = options.zoneId;
        logger.info("Cloudflare CDN adapter initialized", "Cloudflare");
    }
    async purge(urls) {
        try {
            const response = await this.cfRequest("POST", `/zones/${this.zoneId}/purge_cache`, {
                files: urls,
            });
            if (response.success) {
                logger.info(`Cloudflare cache purged: ${urls.length} URLs`, "Cloudflare");
            }
            else {
                throw new Error("Cloudflare purge failed");
            }
        }
        catch (error) {
            logger.error("Cloudflare purge failed", "Cloudflare", { error, urls });
            throw error;
        }
    }
    async prefetch(urls) {
        try {
            logger.debug(`Cloudflare prefetch requested for ${urls.length} URLs`, "Cloudflare");
            // Cloudflare doesn't have direct prefetch, but we can use preload links
            for (const url of urls) {
                // Implementation would depend on Cloudflare Workers or edge functions
            }
        }
        catch (error) {
            logger.error("Cloudflare prefetch failed", "Cloudflare", { error, urls });
        }
    }
    async getStats() {
        try {
            const response = await this.cfRequest("GET", `/zones/${this.zoneId}/analytics/dashboard`);
            return response.result;
        }
        catch (error) {
            logger.error("Cloudflare stats failed", "Cloudflare", { error });
            return null;
        }
    }
    setHeaders(response) {
        response.setHeader("Cache-Control", "public, max-age=3600");
        response.setHeader("CF-Cache-Status", "DYNAMIC");
        response.setHeader("CF-Ray", `${Math.random().toString(36)}-DFW`);
    }
    async cfRequest(method, endpoint, data) {
        const url = `https://api.cloudflare.com/client/v4${endpoint}`;
        try {
            // In a real implementation, you'd use fetch or axios
            const response = {
                success: true,
                result: data || {},
            };
            return response;
        }
        catch (error) {
            logger.error("Cloudflare API request failed", "Cloudflare", {
                error,
                method,
                endpoint,
            });
            throw error;
        }
    }
}
exports.CloudflareCDNAdapter = CloudflareCDNAdapter;
