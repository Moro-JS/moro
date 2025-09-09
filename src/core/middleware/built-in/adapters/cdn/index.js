"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureCDNAdapter = exports.CloudFrontCDNAdapter = exports.CloudflareCDNAdapter = void 0;
exports.createCDNAdapter = createCDNAdapter;
// CDN Adapters
var cloudflare_1 = require("./cloudflare");
Object.defineProperty(exports, "CloudflareCDNAdapter", { enumerable: true, get: function () { return cloudflare_1.CloudflareCDNAdapter; } });
var cloudfront_1 = require("./cloudfront");
Object.defineProperty(exports, "CloudFrontCDNAdapter", { enumerable: true, get: function () { return cloudfront_1.CloudFrontCDNAdapter; } });
var azure_1 = require("./azure");
Object.defineProperty(exports, "AzureCDNAdapter", { enumerable: true, get: function () { return azure_1.AzureCDNAdapter; } });
const cloudflare_2 = require("./cloudflare");
const cloudfront_2 = require("./cloudfront");
const azure_2 = require("./azure");
// Adapter factory function for auto-loading
function createCDNAdapter(type, options = {}) {
    switch (type.toLowerCase()) {
        case "cloudflare":
            return new cloudflare_2.CloudflareCDNAdapter(options);
        case "cloudfront":
            return new cloudfront_2.CloudFrontCDNAdapter(options);
        case "azure":
            return new azure_2.AzureCDNAdapter(options);
        default:
            throw new Error(`Unknown CDN adapter type: ${type}`);
    }
}
