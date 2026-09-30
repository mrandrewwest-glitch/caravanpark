'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const { phoneCallback } = require('./dialpad-handler');
const { createClaudeClient } = require('./claude-client');
const { createMockNewBookClient } = require('./newbook-client');
const { MemoryStore } = require('./state-store');
const { createLogger } = require('./logger');

function buildDeps(overrides = {}) {
  const env = process.env;
  return {
    claude: overrides.claude || createClaudeClient(),
    newbook: overrides.newbook || createMockNewBookClient(),
    store: overrides.store || new MemoryStore(),
    logger: overrides.logger || createLogger(),
    // Injectable so tests are deterministic about "next weekend" etc.
    today: overrides.today || (() => new Date().toLocaleDateString('en-CA', { timeZone: env.PARK_TIMEZONE || 'Australia/Sydney' })),
    config: {
      parkId: env.PARK_ID || 'friend-caravan-park',
      parkName: 'Friends Caravan Park',
      turnDeadlineMs: Number(env.TURN_DEADLINE_MS) || 2800,
      extractTimeoutMs: 1500,
      responseTimeoutMs: 1800,
      ...overrides.config,
    },
  };
}

function createApp(overrides = {}) {
  const deps = buildDeps(overrides);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok', claude_mode: deps.claude.mode, newbook: deps.newbook.kind }));
  app.post('/phone-callback', phoneCallback(deps));

  // Mock Dialpad entry point: same pipeline, plus a debug trace. Off in production.
  const testEnabled = overrides.enableTestEndpoint ?? (process.env.ENABLE_TEST_ENDPOINT !== 'false' && process.env.NODE_ENV !== 'production');
  if (testEnabled) app.post('/test-call', phoneCallback(deps, { includeTrace: true }));

  // Malformed JSON etc.: never leave Dialpad without a safe answer.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    deps.logger.error('request_error', { error: err.message });
    res.status(err.status || 500).json({ error: 'bad request', response_text: 'Our system is busy, let me transfer you to our team.', transfer_to_human: true });
  });

  app.deps = deps;
  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => app.deps.logger.info('listening', { port, claude_mode: app.deps.claude.mode }));
}

module.exports = { createApp, buildDeps };
