'use strict';

// AWS Lambda entry point (handler: lambda.handler). Wraps the Express app for API Gateway.
const serverless = require('serverless-http');
const { createApp } = require('./index');

let cached;

// Optionally pull the Anthropic key from Secrets Manager at cold start.
// The AWS SDK v3 is bundled with the Node 20 Lambda runtime.
async function loadSecrets() {
  const arn = process.env.ANTHROPIC_SECRET_ARN;
  if (!arn || process.env.ANTHROPIC_API_KEY) return;
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  process.env.ANTHROPIC_API_KEY = out.SecretString.trim();
}

exports.handler = async (event, context) => {
  if (!cached) {
    await loadSecrets();
    cached = serverless(createApp());
  }
  return cached(event, context);
};
