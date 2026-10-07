'use strict';

// AWS Lambda entry points.
//   handler      : API Gateway (REST proxy) -> Express app (phone/sms/payment webhooks)
//   jobsHandler  : EventBridge schedule (rate(5 minutes)) -> hold expiry + call finalisation
const serverless = require('serverless-http');
const { createApp } = require('./index');
const { runAll } = require('./jobs');

let cachedApp;

// Optionally pull the Anthropic key from Secrets Manager at cold start.
// The AWS SDK v3 is bundled with the Node 20 Lambda runtime.
async function loadSecrets() {
  const arn = process.env.ANTHROPIC_SECRET_ARN;
  if (!arn || process.env.ANTHROPIC_API_KEY) return;
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  process.env.ANTHROPIC_API_KEY = out.SecretString.trim();
}

async function getApp() {
  if (!cachedApp) {
    // Held bookings, call state and the billing ledger must survive between Lambda containers.
    // Until a DynamoDB store exists, refuse to run in production rather than lose bookings silently.
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MEMORY_STORE !== 'true') {
      throw new Error('Durable store required: the in-memory store loses bookings between Lambda containers. Implement the DynamoDB store (see state-store.js) or set ALLOW_MEMORY_STORE=true for a throwaway test.');
    }
    await loadSecrets();
    cachedApp = createApp();
  }
  return cachedApp;
}

let cachedHandler;
exports.handler = async (event, context) => {
  if (!cachedHandler) cachedHandler = serverless(await getApp());
  return cachedHandler(event, context);
};

exports.jobsHandler = async () => {
  const app = await getApp();
  return runAll(app.deps);
};
