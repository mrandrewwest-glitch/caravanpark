'use strict';

// Per-park provider credentials. A park's config holds only a REFERENCE, never the secret:
//   "env:NAME"  -> JSON in process.env.NAME (local dev and tests)
//   "arn:aws:secretsmanager:..." -> a Secrets Manager secret whose value is JSON
// Values are cached per container.
const cache = new Map();

async function loadJsonSecret(ref) {
  if (!ref) throw Object.assign(new Error('No credentials reference configured'), { code: 'CONFIG' });
  if (cache.has(ref)) return cache.get(ref);
  let raw;
  if (ref.startsWith('env:')) {
    raw = process.env[ref.slice(4)];
    if (!raw) throw Object.assign(new Error(`Environment variable ${ref.slice(4)} is not set`), { code: 'CONFIG' });
  } else if (ref.startsWith('arn:')) {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: ref }));
    raw = out.SecretString;
  } else {
    throw Object.assign(new Error(`Unsupported credentials reference "${ref.slice(0, 12)}..." (use env:NAME or a Secrets Manager ARN)`), { code: 'CONFIG' });
  }
  const value = JSON.parse(raw);
  cache.set(ref, value);
  return value;
}

const clearSecretCache = () => cache.clear();

module.exports = { loadJsonSecret, clearSecretCache };
