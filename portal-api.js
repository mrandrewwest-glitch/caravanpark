'use strict';

const express = require('express');
const data = require('./portal-data');
const repos = require('./repos');
const { ADJUSTABLE } = require('./parks');

const COOKIE = 'onsite_session';
const OUTCOMES = ['in_progress', 'answered', 'booking', 'message', 'transferred', 'hung_up', 'spam', 'problem'];

const parseCookies = (header = '') => Object.fromEntries(header.split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)]; }));

// Security headers for every /portal response (pages, scripts and the API). No inline script or style is allowed.
function securityHeaders({ secure }) {
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    });
    next();
  };
}

function portalRouter(deps, { secure = process.env.NODE_ENV === 'production' } = {}) {
  const router = express.Router();
  const { portalAuth: auth, registry, logger } = deps;
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => { logger.error('portal_error', { path: req.path, error: err.message }); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Cross-site request protection for anything that changes state: a custom header (which browsers will not send
  // cross-site without our consent), JSON bodies only, and a same-origin check when the browser reports an origin.
  router.use((req, res, next) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'onsite-portal') return res.status(403).json({ error: 'Request blocked.' });
    const origin = req.get('origin');
    if (origin) { let host = null; try { host = new URL(origin).host; } catch { /* malformed */ } if (host !== req.get('host')) return res.status(403).json({ error: 'Request blocked.' }); }
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON only.' });
    return next();
  });

  const cookieFor = (value, maxAge) => [`${COOKIE}=${value}`, 'Path=/portal', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`, ...(secure ? ['Secure'] : [])].join('; ');

  // ---- Sign in ----
  router.post('/auth/request', wrap(async (req, res) => {
    const out = await auth.requestCode(req.body && req.body.email, { ip: req.ip });
    return res.status(out.rateLimited ? 429 : 200).json({ ok: out.ok, message: out.message, ...(out.devCode ? { devCode: out.devCode } : {}) });
  }));

  router.post('/auth/verify', wrap(async (req, res) => {
    const out = await auth.verifyCode(req.body && req.body.email, req.body && req.body.code, { ip: req.ip });
    if (!out.ok) return res.status(401).json({ error: out.reason });
    res.append('Set-Cookie', cookieFor(out.token, out.maxAgeSeconds));
    const park = await registry.get(out.user.park_id);
    return res.json({ ok: true, user: { email: out.user.email, name: out.user.name }, park: { name: park.name } });
  }));

  router.post('/auth/logout', wrap(async (req, res) => {
    await auth.logout(parseCookies(req.headers.cookie)[COOKIE]);
    res.append('Set-Cookie', cookieFor('', 0));
    return res.json({ ok: true });
  }));

  // ---- Everything below needs a valid session; the park comes from the session ONLY ----
  router.use(wrap(async (req, res, next) => {
    const session = await auth.getSession(parseCookies(req.headers.cookie)[COOKIE]);
    if (!session) return res.status(401).json({ error: 'signed_out' });
    const park = await registry.get(session.park_id);
    if (!park) return res.status(401).json({ error: 'signed_out' });
    req.portal = { session, park };
    return next();
  }));

  router.get('/me', (req, res) => res.json({ email: req.portal.session.email, name: req.portal.session.name, park: { id: req.portal.park.id, name: req.portal.park.name, timezone: req.portal.park.timezone } }));
  router.get('/overview', wrap(async (req, res) => res.json(await data.overview(deps, req.portal.park))));

  router.get('/calls', wrap(async (req, res) => {
    const { park } = req.portal;
    const month = req.query.month || data.monthOf(deps.now(), park.timezone);
    if (!data.validMonth(month)) return res.status(400).json({ error: 'month must look like 2026-10' });
    const outcome = req.query.outcome || undefined;
    if (outcome && !OUTCOMES.includes(outcome)) return res.status(400).json({ error: 'unknown outcome' });
    return res.json({ month, calls: await data.listCalls(deps, park, { month, outcome }) });
  }));
  router.get('/calls/:id', wrap(async (req, res) => {
    const call = await data.getCall(deps, req.portal.park, req.params.id);
    return call ? res.json(call) : res.status(404).json({ error: 'Not found.' });
  }));

  router.get('/bookings', wrap(async (req, res) => res.json({ bookings: await data.listBookings(deps, req.portal.park) })));

  router.get('/messages', wrap(async (req, res) => res.json({ messages: await data.listMessages(deps, req.portal.park) })));
  router.patch('/messages/:id', wrap(async (req, res) => {
    const done = !(req.body && req.body.done === false);
    const m = await data.markMessageDone(deps, req.portal.park, req.params.id, req.portal.session.email, done);
    return m ? res.json(m) : res.status(404).json({ error: 'Not found.' });
  }));

  router.get('/settings', (req, res) => res.json(data.settingsView(req.portal.park)));
  router.patch('/settings', wrap(async (req, res) => {
    const { park, session } = req.portal;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body || !Object.keys(body).length) return res.status(400).json({ errors: ['Nothing to change.'] });
    const unknown = Object.keys(body).filter((k) => !ADJUSTABLE.includes(k));
    if (unknown.length) return res.status(400).json({ errors: unknown.map((k) => `${k} cannot be changed here`) });
    const before = data.settingsView(park).editable;
    const out = await registry.updateSettings(park.id, body);
    if (out.errors) return res.status(400).json({ errors: out.errors });
    const after = data.settingsView(out.park).editable;
    const changes = data.diffSettings(before, after);
    if (Object.keys(changes).length) await repos.appendAudit(deps.store, park.id, { type: 'settings', by: session.email, changes }, deps.now());
    return res.json({ ...data.settingsView(out.park), changed: Object.keys(changes) });
  }));

  router.get('/billing', wrap(async (req, res) => {
    const { park } = req.portal;
    return res.json({ terms: { monthly_fee: park.billing.monthly_fee, per_call: park.billing.per_call, currency: park.billing.currency, min_call_seconds: park.billing.min_call_seconds, excludes_gst: true }, statements: await data.statements(deps, park, 12) });
  }));
  router.get('/billing/:file', wrap(async (req, res) => {
    const { park } = req.portal;
    const csv = req.params.file.endsWith('.csv');
    const month = csv ? req.params.file.slice(0, -4) : req.params.file;
    if (!data.validMonth(month)) return res.status(400).json({ error: 'month must look like 2026-10' });
    const st = await data.statementOf(deps, park, month);
    if (!csv) return res.json(st);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="onsite-statement-${month}.csv"` });
    return res.send(data.statementCsv(park, st));
  }));

  router.get('/activity', wrap(async (req, res) => res.json({ activity: await repos.parkAudit(deps.store, req.portal.park.id, 100) })));

  router.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  return router;
}

module.exports = { portalRouter, securityHeaders, parseCookies, COOKIE };
