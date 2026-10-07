'use strict';

const crypto = require('crypto');
const express = require('express');
const { runAll } = require('./jobs');

// Operator/park admin API. Disabled (404) unless ADMIN_TOKEN is set. Parks' own
// self-service login is a later phase; this is for the operator and tests.
function adminRouter(deps) {
  const router = express.Router();
  const token = deps.config.adminToken;

  router.use((req, res, next) => {
    if (!token) return res.status(404).end();
    const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer /, ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'unauthorized' });
    return next();
  });

  router.get('/parks/:id', async (req, res) => {
    const park = await deps.registry.get(req.params.id);
    if (!park) return res.status(404).json({ error: 'unknown park' });
    const { payments, ...safe } = park; // never echo credentials
    return res.json(safe);
  });

  router.patch('/parks/:id/settings', async (req, res) => {
    const out = await deps.registry.updateSettings(req.params.id, req.body || {});
    if (out.error) return res.status(404).json(out);
    if (out.errors) return res.status(400).json({ errors: out.errors });
    const { payments, ...safe } = out.park;
    return res.json(safe);
  });

  router.get('/usage/:id', async (req, res) => {
    const park = await deps.registry.get(req.params.id);
    if (!park) return res.status(404).json({ error: 'unknown park' });
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM is required' });
    return res.json(await deps.ledger.statement(park, month));
  });

  router.post('/jobs/run', async (req, res) => res.json(await runAll(deps)));
  return router;
}

module.exports = { adminRouter };
