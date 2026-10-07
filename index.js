'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const { phoneCallback, callEnded } = require('./dialpad-handler');
const { handlePaymentWebhook } = require('./payment-handler');
const { adminRouter } = require('./admin');
const { createClaudeClient } = require('./claude-client');
const { createMockNewBookClient } = require('./newbook-client');
const { createNewBookRestClient, validateRestConfig } = require('./newbook-rest-client');
const { loadJsonSecret } = require('./secrets');
const { createMockSmsProvider } = require('./sms-provider');
const { createMockPaymentProvider } = require('./payment-provider');
const { createMockNotifier } = require('./notifier');
const { createParkRegistry } = require('./parks');
const { createLedger } = require('./ledger');
const { MemoryStore } = require('./state-store');
const { DynamoStore } = require('./dynamo-store');
const { createLogger } = require('./logger');
const path = require('path');
const { createPortalAuth } = require('./portal-auth');
const { createMockEmailer, createSesEmailer } = require('./emailer');
const { portalRouter, securityHeaders } = require('./portal-api');
const { dateInZone } = require('./util');

// STORE_BACKEND=dynamodb (+ DYNAMODB_TABLE, optional DYNAMODB_ENDPOINT for local) | memory (default; dev/tests only)
function makeStore({ now, logger }) {
  if (process.env.STORE_BACKEND === 'dynamodb') {
    return DynamoStore.create({ table: process.env.DYNAMODB_TABLE, endpoint: process.env.DYNAMODB_ENDPOINT, now, logger });
  }
  return new MemoryStore({ now });
}

// overrides (tests): claude, store, logger, now, today, parks (array), registry, sms, notifier,
// newbooks ({parkId: client}), newbook (shorthand for the first park), payments ({parkId: provider}), config.
function buildDeps(overrides = {}) {
  const env = process.env;
  const logger = overrides.logger || createLogger();
  const now = overrides.now || (() => Date.now());
  const store = overrides.store || makeStore({ now, logger });
  const registry = overrides.registry || createParkRegistry({ parks: overrides.parks, store, ...(overrides.parkCacheMs !== undefined ? { cacheMs: overrides.parkCacheMs } : {}) });
  const firstParkId = registry.ids()[0];
  const sms = overrides.sms || createMockSmsProvider({ store });
  const newbooks = { ...(overrides.newbooks || {}) };
  if (overrides.newbook) newbooks[firstParkId] = overrides.newbook;
  const paymentProviders = { ...(overrides.payments || {}) };

  // Per-park provider instances, created lazily from each park's config.
  // Real providers read per-park credentials from Secrets Manager here.
  const providers = {
    newbook(park) {
      if (!newbooks[park.id]) {
        const nb = park.newbook || { type: 'mock' };
        newbooks[park.id] = nb.type === 'rest'
          ? createNewBookRestClient({ parkName: park.name, timezone: park.timezone, config: nb, getCredentials: () => loadJsonSecret(nb.credentials_ref), now, logger })
          : createMockNewBookClient({ parkName: park.name, ...(nb.sites ? { sites: nb.sites } : {}) });
      }
      return newbooks[park.id];
    },
    payments(park) {
      if (!paymentProviders[park.id]) paymentProviders[park.id] = createMockPaymentProvider({ webhookSecret: park.payments.webhook_secret });
      return paymentProviders[park.id];
    },
  };

  // Refuse to run with a real-NewBook park that is missing settings AI booking depends on.
  async function validateProviders() {
    for (const id of registry.ids()) {
      const park = await registry.get(id);
      if (park.newbook && park.newbook.type === 'rest') {
        const errors = validateRestConfig(park.newbook, { forBooking: park.booking_mode === 'ai_booking' });
        if (errors.length) throw new Error(`Park ${id} NewBook config: ${errors.join('; ')}`);
        // Best effort: a NewBook outage at cold start must not stop the app; the first call just pays for it.
        try { await providers.newbook(park).warm(); } catch (err) { logger.warn('newbook_warm_failed', { park_id: id, error: err.message }); }
      }
    }
  }

  const emailer = overrides.emailer || (env.PORTAL_FROM_EMAIL ? createSesEmailer({ from: env.PORTAL_FROM_EMAIL }) : createMockEmailer());
  const portalAuth = createPortalAuth({ store, emailer, registry, now, logger, devShowCode: overrides.portalDevShowCode ?? env.PORTAL_DEV_SHOW_CODE === 'true' });

  return {
    validateProviders,
    emailer,
    portalAuth,
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

  // Park owners' web portal: static pages + JSON API, with strict security headers (see portal-api.js).
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || true);
  const secure = overrides.portalSecure ?? process.env.NODE_ENV === 'production';
  app.use('/portal', securityHeaders({ secure }));
  app.use('/portal/api', portalRouter(deps, { secure }));
  app.use('/portal', express.static(path.join(__dirname, 'portal'), { index: 'index.html', etag: true, maxAge: 0, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

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
  app.deps.validateProviders().then(() => app.listen(port, () => app.deps.logger.info('listening', { port, claude_mode: app.deps.claude.mode }))).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { createApp, buildDeps, makeStore };
