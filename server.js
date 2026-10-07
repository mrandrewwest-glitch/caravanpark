'use strict';

// Always-on server entry (a container, not Lambda). Phone calls over Twilio ConversationRelay hold a WebSocket open
// for the length of the call, which Lambda behind API Gateway cannot do. This runs the same app as lambda.js, plus
// the live-call WebSocket and the five-minute background jobs (hold expiry, call finalisation) that EventBridge
// runs in the Lambda setup. Run ONE copy of the jobs: if you run several containers, set RUN_JOBS=false on the rest.
const { createApp } = require('./index');
const { runAll } = require('./jobs');

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.STORE_BACKEND !== 'dynamodb' && process.env.ALLOW_MEMORY_STORE !== 'true') {
    throw new Error('Durable store required: set STORE_BACKEND=dynamodb and DYNAMODB_TABLE (the in-memory store loses bookings on restart).');
  }
  const app = createApp();
  const { logger } = app.deps;
  await app.deps.validateProviders();
  const port = Number(process.env.PORT) || 3000;
  const server = await new Promise((resolve) => { const s = app.listen(port, () => resolve(s)); });
  app.attachWebSockets(server);
  logger.info('listening', { port, claude_mode: app.deps.claude.mode, twilio: app.deps.twilio.enabled });

  let timer = null;
  if (process.env.RUN_JOBS !== 'false') {
    let running = false;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try { await runAll(app.deps); } catch (err) { logger.error('jobs_failed', { error: err.message }); } finally { running = false; }
    }, 5 * 60 * 1000);
  }

  // Deploys: stop taking new calls, let live ones finish for a short while, then exit.
  const shutdown = (signal) => {
    logger.info('shutting_down', { signal });
    if (timer) clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => { if (app.relay) app.relay.clients.forEach((ws) => ws.close(1001, 'server restarting')); }, Number(process.env.DRAIN_MS) || 20000).unref();
    setTimeout(() => process.exit(0), (Number(process.env.DRAIN_MS) || 20000) + 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
main().catch((err) => { console.error(err.message); process.exit(1); });
