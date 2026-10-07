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
    // The in-memory store would silently lose them, so production requires DynamoDB.
    if (process.env.NODE_ENV === 'production' && process.env.STORE_BACKEND !== 'dynamodb' && process.env.ALLOW_MEMORY_STORE !== 'true') {
      throw new Error('Durable store required: set STORE_BACKEND=dynamodb and DYNAMODB_TABLE (the in-memory store loses bookings between Lambda containers). ALLOW_MEMORY_STORE=true is for throwaway tests only.');
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
