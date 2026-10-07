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

  // Owner portal accounts. Owners cannot sign themselves up: the operator creates and disables them.
  router.get('/portal-users', async (req, res) => {
    const parkId = String(req.query.park_id || '');
    if (!(await deps.registry.get(parkId))) return res.status(404).json({ error: 'unknown park' });
    return res.json({ users: (await deps.portalAuth.listUsers(parkId)).map((u) => ({ email: u.email, name: u.name, disabled: !!u.disabled })) });
  });
  router.post('/portal-users', async (req, res) => {
    const out = await deps.portalAuth.createUser(req.body || {});
    return out.error ? res.status(400).json(out) : res.status(201).json({ email: out.user.email, park_id: out.user.park_id });
  });
  router.delete('/portal-users/:email', async (req, res) => {
    const out = await deps.portalAuth.disableUser(req.params.email);
    return out.error ? res.status(404).json(out) : res.json({ email: out.user.email, disabled: true });
  });

  router.post('/jobs/run', async (req, res) => res.json(await runAll(deps)));
  return router;
}

module.exports = { adminRouter };
