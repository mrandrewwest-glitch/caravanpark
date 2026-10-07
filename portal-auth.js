'use strict';

// Owner portal sign-in: a one-time code emailed to a registered address, then a server-side session.
// Accounts are created by the operator (not self-service). Everything lives in the store, so it works across
// Lambda containers.
//
// Threat model in brief: a stranger must not get in or learn which emails are registered; codes cannot be brute
// forced; a stolen cookie can be revoked (sessions are server-side and re-checked against the user record on
// every request); owners of one park never see another park's data (the park always comes from the session).
const crypto = require('crypto');
const repos = require('./repos');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normaliseEmail = (e) => (typeof e === 'string' && e.length <= 120 && EMAIL_RE.test(e.trim()) ? e.trim().toLowerCase() : null);
const safeEqual = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Fixed-window counter: returns true while under the limit. Stored with a TTL so abandoned counters vanish.
async function rateLimit(store, key, limit, windowMs, now) {
  let allowed = true;
  await store.update(`ratelimit:${key}`, (cur) => {
    const rec = cur && now - cur.start < windowMs ? cur : { start: now, count: 0 };
    rec.count += 1;
    allowed = rec.count <= limit;
    return rec;
  }, { ttlSeconds: Math.ceil(windowMs / 1000) + 60 });
  return allowed;
}

function createPortalAuth({ store, emailer, registry, now = Date.now, logger, devShowCode = false, appName = 'OnSite' }) {
  if (devShowCode && process.env.NODE_ENV === 'production') throw new Error('PORTAL_DEV_SHOW_CODE must never be enabled in production');

  const auth = {
    normaliseEmail,

    // Always answers the same way whether or not the address is registered.
    async requestCode(rawEmail, { ip = 'unknown' } = {}) {
      const generic = { ok: true, message: 'If that address is registered, a sign-in code is on its way. It expires in 10 minutes.' };
      const email = normaliseEmail(rawEmail);
      if (!email) return { ...generic, invalid: true };
      const t = now();
      if (!(await rateLimit(store, `req-ip:${sha256(ip)}`, 20, 3600e3, t)) || !(await rateLimit(store, `req-email:${email}`, 5, 3600e3, t))) {
        return { ok: false, rateLimited: true, message: 'Too many sign-in requests. Please wait a while and try again.' };
      }
      const user = await repos.getUser(store, email);
      const park = user && !user.disabled ? await registry.get(user.park_id) : null;
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const salt = crypto.randomBytes(16).toString('hex');
      if (user && park) {
        await store.set(`otp:${email}`, { hash: sha256(salt + code), salt, attempts: 0, expires_ms: t + CODE_TTL_MS }, { ttlSeconds: CODE_TTL_MS / 1000 + 60 });
        try {
          await emailer.send({ to: email, subject: `Your ${appName} sign-in code`, text: `Your ${appName} sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email; nobody can sign in without it.` });
        } catch (err) {
          logger?.error('portal_email_failed', { error: err.message });
        }
        if (devShowCode) return { ...generic, devCode: code };
      } else {
        sha256(salt + code); // comparable work whether or not the address is registered
      }
      return generic;
    },

    // Returns { token, user } on success, or { ok: false, reason }.
    async verifyCode(rawEmail, rawCode, { ip = 'unknown' } = {}) {
      const email = normaliseEmail(rawEmail);
      const code = typeof rawCode === 'string' ? rawCode.replace(/\s/g, '') : '';
      const fail = { ok: false, reason: 'That code is not right or has expired. Request a new one.' };
      if (!email || !/^\d{6}$/.test(code)) return fail;
      const t = now();
      if (!(await rateLimit(store, `verify-ip:${sha256(ip)}`, 30, 3600e3, t))) return { ok: false, reason: 'Too many attempts. Please wait a while and try again.' };
      let verdict = 'none';
      await store.update(`otp:${email}`, (otp) => {
        verdict = 'none';
        if (!otp || otp.used || otp.expires_ms <= t || otp.attempts >= MAX_CODE_ATTEMPTS) return undefined;
        if (safeEqual(sha256(otp.salt + code), otp.hash)) { verdict = 'ok'; return { ...otp, used: true }; } // marked used atomically: single use even if two requests race
        otp.attempts += 1;
        verdict = otp.attempts >= MAX_CODE_ATTEMPTS ? 'locked' : 'bad';
        return otp;
      }, { ttlSeconds: CODE_TTL_MS / 1000 + 60 });
      if (verdict !== 'ok') return fail;
      await store.delete(`otp:${email}`); // single use
      const user = await repos.getUser(store, email);
      if (!user || user.disabled) return fail;
      const token = crypto.randomBytes(32).toString('base64url');
      await store.set(`sessions:${sha256(token)}`, { email, park_id: user.park_id, created_ms: t, expires_ms: t + SESSION_TTL_MS }, { ttlSeconds: SESSION_TTL_MS / 1000 + 60 });
      await repos.appendAudit(store, user.park_id, { type: 'login', by: email }, t);
      return { ok: true, token, user: { email, park_id: user.park_id, name: user.name || null }, maxAgeSeconds: SESSION_TTL_MS / 1000 };
    },

    // Every request: the session must exist, be unexpired, and its user must still be active.
    async getSession(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const s = await store.get(`sessions:${sha256(token)}`);
      if (!s || s.expires_ms <= now()) return null;
      const user = await repos.getUser(store, s.email);
      if (!user || user.disabled || user.park_id !== s.park_id) return null;
      return { email: s.email, park_id: s.park_id, name: user.name || null, expires_ms: s.expires_ms };
    },

    async logout(token) {
      if (typeof token === 'string' && token) await store.delete(`sessions:${sha256(token)}`);
    },

    // ---- Account management (operator) ----
    async createUser({ email: rawEmail, park_id: parkId, name = null }) {
      const email = normaliseEmail(rawEmail);
      if (!email) return { error: 'a valid email address is required' };
      if (!(await registry.get(parkId))) return { error: 'unknown park' };
      const existing = await repos.getUser(store, email);
      if (existing && existing.park_id !== parkId) return { error: 'that email already belongs to another park' };
      const rec = { email, park_id: parkId, name: name ? String(name).slice(0, 80) : null, created_ms: existing ? existing.created_ms : now(), disabled: false };
      await repos.saveUser(store, rec);
      return { user: rec };
    },

    async disableUser(rawEmail) {
      const email = normaliseEmail(rawEmail);
      const user = email && (await repos.getUser(store, email));
      if (!user) return { error: 'no such user' };
      user.disabled = true;
      await repos.saveUser(store, user);
      return { user };
    },

    listUsers: (parkId) => repos.parkUsers(store, parkId),
  };
  return auth;
}

module.exports = { createPortalAuth, normaliseEmail, rateLimit, SESSION_TTL_MS, CODE_TTL_MS, MAX_CODE_ATTEMPTS };
