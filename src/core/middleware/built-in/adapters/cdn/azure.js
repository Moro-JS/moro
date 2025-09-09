"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureCDNAdapter = void 0;
const logger_1 = require("../../../../logger");
const logger = (0, logger_1.createFrameworkLogger)("AzureCDNAdapter");
class AzureCDNAdapter {
    endpoint;
    subscriptionId;
    resourceGroup;
    profileName;
    endpointName;
    constructor(options) {
        this.subscriptionId = options.subscriptionId;
        this.resourceGroup = options.resourceGroup;
        this.profileName = options.profileName;
        this.endpointName = options.endpointName;
        this.endpoint = options.endpoint;
        logger.info("Azure CDN adapter initialized", "AzureCDN");
    }
    async purge(urls) {
        try {
            const purgeUrl = `https://management.azure.com/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Cdn/profiles/${this.profileName}/endpoints/${this.endpointName}/purge`;
            const purgeData = {
                contentPaths: urls.map((url) => url.startsWith("/") ? url : `/${url}`),
            };
            logger.info(`Azure CDN cache purge requested: ${urls.length} URLs`, "AzureCDN");
            // Implementation would use Azure SDK or REST API calls
            // const response = await fetch(purgeUrl, { method: 'POST', body: JSON.stringify(purgeData) });
        }
        catch (error) {
            logger.error("Azure CDN purge failed", "AzureCDN", { error, urls });
            throw error;
        }
    }
    async prefetch(urls) {
        logger.debug(`Azure CDN prefetch requested for ${urls.length} URLs`, "AzureCDN");
        // Azure CDN prefetch implementation
    }
    setHeaders(response) {
        response.setHeader("Cache-Control", "public, max-age=3600");
        response.setHeader("Azure-CDN-Edge-Location", "US-East");
    }
}
exports.AzureCDNAdapter = AzureCDNAdapter;
