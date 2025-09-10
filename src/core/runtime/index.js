"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudflareWorkersAdapter = exports.AWSLambdaAdapter = exports.VercelEdgeAdapter = exports.NodeRuntimeAdapter = exports.BaseRuntimeAdapter = void 0;
exports.createRuntimeAdapter = createRuntimeAdapter;
exports.createNodeHandler = createNodeHandler;
exports.createEdgeHandler = createEdgeHandler;
exports.createLambdaHandler = createLambdaHandler;
exports.createWorkerHandler = createWorkerHandler;
// Runtime adapters export
var base_adapter_1 = require("./base-adapter");
Object.defineProperty(exports, "BaseRuntimeAdapter", { enumerable: true, get: function () { return base_adapter_1.BaseRuntimeAdapter; } });
var node_adapter_1 = require("./node-adapter");
Object.defineProperty(exports, "NodeRuntimeAdapter", { enumerable: true, get: function () { return node_adapter_1.NodeRuntimeAdapter; } });
var vercel_edge_adapter_1 = require("./vercel-edge-adapter");
Object.defineProperty(exports, "VercelEdgeAdapter", { enumerable: true, get: function () { return vercel_edge_adapter_1.VercelEdgeAdapter; } });
var aws_lambda_adapter_1 = require("./aws-lambda-adapter");
Object.defineProperty(exports, "AWSLambdaAdapter", { enumerable: true, get: function () { return aws_lambda_adapter_1.AWSLambdaAdapter; } });
var cloudflare_workers_adapter_1 = require("./cloudflare-workers-adapter");
Object.defineProperty(exports, "CloudflareWorkersAdapter", { enumerable: true, get: function () { return cloudflare_workers_adapter_1.CloudflareWorkersAdapter; } });
// Runtime factory functions
const node_adapter_2 = require("./node-adapter");
const vercel_edge_adapter_2 = require("./vercel-edge-adapter");
const aws_lambda_adapter_2 = require("./aws-lambda-adapter");
const cloudflare_workers_adapter_2 = require("./cloudflare-workers-adapter");
function createRuntimeAdapter(type) {
    switch (type) {
        case 'node':
            return new node_adapter_2.NodeRuntimeAdapter();
        case 'vercel-edge':
            return new vercel_edge_adapter_2.VercelEdgeAdapter();
        case 'aws-lambda':
            return new aws_lambda_adapter_2.AWSLambdaAdapter();
        case 'cloudflare-workers':
            return new cloudflare_workers_adapter_2.CloudflareWorkersAdapter();
        default:
            throw new Error(`Unsupported runtime type: ${type}`);
    }
}
// Convenience functions for creating runtime-specific handlers
function createNodeHandler(handler) {
    const adapter = new node_adapter_2.NodeRuntimeAdapter();
    return adapter.createServer(handler);
}
function createEdgeHandler(handler) {
    const adapter = new vercel_edge_adapter_2.VercelEdgeAdapter();
    return adapter.createServer(handler);
}
function createLambdaHandler(handler) {
    const adapter = new aws_lambda_adapter_2.AWSLambdaAdapter();
    return adapter.createServer(handler);
}
function createWorkerHandler(handler) {
    const adapter = new cloudflare_workers_adapter_2.CloudflareWorkersAdapter();
    return adapter.createServer(handler);
}
