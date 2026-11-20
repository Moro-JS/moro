// Minimal stand-in for `@aws-sdk/client-sqs`, which is an optional peer and is
// not installed in this repository: a client that keeps the configuration it
// was constructed with and the commands it is sent.
'use strict';

// Looked up on every use: a test starts from a fresh record
const constructed = () => (globalThis.__moroFakeBrokerClients ??= { kafka: [], sqs: [] });

class SQSClient {
  constructor(config) {
    this.config = config;
    this.sent = [];
    constructed().sqs.push(this);
  }
  async send(command) {
    this.sent.push(command);
    return {};
  }
}

class Command {
  constructor(input) {
    this.input = input;
  }
}
class SendMessageCommand extends Command {}
class SendMessageBatchCommand extends Command {}
class ReceiveMessageCommand extends Command {}
class DeleteMessageCommand extends Command {}

module.exports = {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
};
