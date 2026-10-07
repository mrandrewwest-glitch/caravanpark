'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const { phoneCallback, callEnded } = require('./dialpad-handler');
const { handlePaymentWebhook } = require('./payment-handler');
const { adminRouter } = require('./admin');
const { createClaudeClient } = require('./claude-client');
const { createMockNewBookClient } = require('./newbook-client');
const { createMockSmsProvider } = require('./sms-provider');
const { createMockPaymentProvider } = require('./payment-provider');
const { createMockNotifier } = require('./notifier');
const { createParkRegistry } = require('./parks');
const { createLedger } = require('./ledger');
const { MemoryStore } = require('./state-store');
const { createLogger } = require('./logger');
const { dateInZone } = require('./util');

// overrides (tests): claude, store, logger, now, today, parks (array), registry, sms, notifier,
// newbooks ({parkId: client}), newbook (shorthand for the first park), payments ({parkId: provider}), config.
function buildDeps(overrides = {}) {
  const env = process.env;
  const store = overrides.store || new MemoryStore();
  const logger = overrides.logger || createLogger();
  const now = overrides.now || (() => Date.now());
  const registry = overrides.registry || createParkRegistry({ parks: overrides.parks, store });
  const firstParkId = registry.ids()[0];
  const sms = overrides.sms || createMockSmsProvider({ store });
  const newbooks = { ...(overrides.newbooks || {}) };
  if (overrides.newbook) newbooks[firstParkId] = overrides.newbook;
  const paymentProviders = { ...(overrides.payments || {}) };

  // Per-park provider instances, created lazily from each park's config.
  // Real providers read per-park credentials from Secrets Manager here.
  const providers = {
    newbook(park) {
      if (!newbooks[park.id]) newbooks[park.id] = createMockNewBookClient({ parkName: park.name, ...(park.newbook && park.newbook.sites ? { sites: park.newbook.sites } : {}) });
      return newbooks[park.id];
    },
    payments(park) {
      if (!paymentProviders[park.id]) paymentProviders[park.id] = createMockPaymentProvider({ webhookSecret: park.payments.webhook_secret });
      return paymentProviders[park.id];
    },
  };

  return {
    claude: overrides.claude || createClaudeClient(),
    store,
    logger,
    now,
    // Injectable so tests are deterministic about "next weekend" etc.
    today: overrides.today || ((park) => dateInZone(now(), (park && park.timezone) || env.PARK_TIMEZONE || 'Australia/Sydney')),
    registry,
    providers,
    sms,
    notifier: overrides.notifier || createMockNotifier(),
    ledger: overrides.ledger || createLedger({ store, now, logger }),
    newbooks,
    paymentProviders,
    config: {
      turnDeadlineMs: Number(env.TURN_DEADLINE_MS) || 2800,
      extractTimeoutMs: 1500,
      responseTimeoutMs: 1800,
      adminToken: env.ADMIN_TOKEN || null,
      ...overrides.config,
    },
  };
}

function createApp(overrides = {}) {
  const deps = buildDeps(overrides);
  const app = express();
  app.disable('x-powered-by');
  // Keep the raw body: payment webhook signatures are computed over the exact bytes.
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  app.get('/health', (req, res) => res.json({ status: 'ok', claude_mode: deps.claude.mode, parks: deps.registry.ids().length, providers: 'mock' }));
  app.post('/phone-callback', phoneCallback(deps));
  app.post('/call-ended', callEnded(deps));
  app.post('/payment-webhook', (req, res) => handlePaymentWebhook(req, res, deps));
  app.use('/admin', adminRouter(deps));

  // Mock Dialpad entry point: same pipeline, plus a debug trace; calls are flagged as tests
  // (never billable). Off in production.
  const testEnabled = overrides.enableTestEndpoint ?? (process.env.ENABLE_TEST_ENDPOINT !== 'false' && process.env.NODE_ENV !== 'production');
  if (testEnabled) app.post('/test-call', phoneCallback(deps, { includeTrace: true, isTest: true }));

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
