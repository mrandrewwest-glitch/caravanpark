'use strict';

// Multi-park registry. Each park has its own number(s), mode, booking policy,
// hold time, billing terms and provider credentials. Parks can adjust a small set
// of settings at runtime (persisted in the store); everything else is static config.
const fs = require('fs');
const { normaliseMobile } = require('./util');

const DEFAULT_PARK = {
  id: 'friend-caravan-park',
  name: 'Friends Caravan Park',
  timezone: 'Australia/Sydney',
  numbers: ['+61290000001'],
  mode: 'full', // 'full' = answer everything, live-transfer to staff | 'diversion' = overflow, take a message
  booking_mode: 'handoff', // 'handoff' = booking requests go to staff | 'ai_booking' = AI creates held bookings + payment link
  hold_minutes: 60,
  deposit_percent: 100,
  limits: { max_nights: 14, max_advance_days: 365, allow_same_day: false },
  staff: { alert_numbers: [], alert_emails: [], callback_promise: 'as soon as they can' },
  sms_from: '+61290000001',
  billing: { monthly_fee: 100, per_call: 3, currency: 'AUD', min_call_seconds: 15 },
  newbook: { type: 'mock' },
  payments: { type: 'mock', webhook_secret: 'whsec_mock_friend' },
};

const BOUNDS = { hold_minutes: [15, 1440], deposit_percent: [10, 100], max_nights: [1, 27] };
const ADJUSTABLE = ['hold_minutes', 'deposit_percent', 'mode', 'booking_mode', 'max_nights', 'name', 'callback_promise', 'staff_alert_numbers', 'staff_alert_emails'];
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

// Validates AND normalises an owner/operator settings change. Returns { value, errors }: `value` holds the cleaned
// fields (numbers in E.164, emails lowercased, text trimmed) and is what gets stored. Free text ends up in texts
// to callers and in alerts, so it is kept to plain words.
function normaliseSettings(patch) {
  const errors = [];
  const value = {};
  for (const k of Object.keys(patch)) {
    if (!ADJUSTABLE.includes(k)) { errors.push(`${k} is not adjustable`); continue; }
    value[k] = patch[k];
  }
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    if (k in value && !(Number.isInteger(value[k]) && value[k] >= lo && value[k] <= hi)) errors.push(`${k} must be a whole number between ${lo} and ${hi}`);
  }
  if ('mode' in value && !['full', 'diversion'].includes(value.mode)) errors.push('mode must be "full" or "diversion"');
  if ('booking_mode' in value && !['handoff', 'ai_booking'].includes(value.booking_mode)) errors.push('booking_mode must be "handoff" or "ai_booking"');
  if ('name' in value) {
    const n = typeof value.name === 'string' ? value.name.replace(/\s+/g, ' ').trim() : '';
    if (n.length < 2 || n.length > 60 || /[<>\u0000-\u001f]/.test(n)) errors.push('name must be 2 to 60 characters, without < or >');
    else value.name = n;
  }
  if ('callback_promise' in value) {
    const c = typeof value.callback_promise === 'string' ? value.callback_promise.replace(/\s+/g, ' ').trim() : '';
    if (c.length < 3 || c.length > 60 || !/^[A-Za-z0-9 ,.'\u2019-]+$/.test(c) || /https?|www/i.test(c)) errors.push('callback_promise must be 3 to 60 characters of plain words, such as "within the hour" (no links)');
    else value.callback_promise = c;
  }
  if ('staff_alert_numbers' in value) {
    const list = Array.isArray(value.staff_alert_numbers) ? value.staff_alert_numbers : null;
    const cleaned = list ? [...new Set(list.map((n) => normaliseMobile(n)))] : null;
    if (!list || list.length > 5 || cleaned.some((n) => !n)) errors.push('staff_alert_numbers must be up to 5 mobile numbers that can receive texts');
    else value.staff_alert_numbers = cleaned;
  }
  if ('staff_alert_emails' in value) {
    const list = Array.isArray(value.staff_alert_emails) ? value.staff_alert_emails : null;
    const cleaned = list ? [...new Set(list.map((e) => String(e).trim().toLowerCase()))] : null;
    if (!list || list.length > 5 || cleaned.some((e) => e.length > 120 || !EMAIL.test(e))) errors.push('staff_alert_emails must be up to 5 valid email addresses');
    else value.staff_alert_emails = cleaned;
  }
  return { value, errors };
}

const validateSettings = (patch) => normaliseSettings(patch).errors;

function mergePark(base, overrides) {
  const merged = { ...base, limits: { ...base.limits }, staff: { ...base.staff } };
  for (const k of ['hold_minutes', 'deposit_percent', 'mode', 'booking_mode', 'name']) if (overrides[k] !== undefined) merged[k] = overrides[k];
  if (overrides.max_nights !== undefined) merged.limits.max_nights = overrides.max_nights;
  if (overrides.callback_promise !== undefined) merged.staff.callback_promise = overrides.callback_promise;
  if (overrides.staff_alert_numbers !== undefined) merged.staff.alert_numbers = overrides.staff_alert_numbers;
  if (overrides.staff_alert_emails !== undefined) merged.staff.alert_emails = overrides.staff_alert_emails;
  return merged;
}

function loadParks(env = process.env) {
  if (env.PARKS_CONFIG) return JSON.parse(fs.readFileSync(env.PARKS_CONFIG, 'utf8'));
  return [DEFAULT_PARK];
}

// cacheMs: settings overrides are re-read from the store at most this often per container (saves a
// DynamoDB read per turn). A settings change is visible on other containers within cacheMs.
function createParkRegistry({ parks = loadParks(), store, defaultParkId = process.env.DEFAULT_PARK_ID, cacheMs = process.env.PARK_CACHE_MS === undefined ? 15000 : Number(process.env.PARK_CACHE_MS) }) {
  if (!parks.length) throw new Error('At least one park is required');
  const byId = new Map(parks.map((p) => [p.id, { ...DEFAULT_PARK, ...p, limits: { ...DEFAULT_PARK.limits, ...p.limits }, staff: { ...DEFAULT_PARK.staff, ...p.staff }, billing: { ...DEFAULT_PARK.billing, ...p.billing } }]));
  const byNumber = new Map();
  for (const p of byId.values()) for (const n of p.numbers || []) byNumber.set(n, p.id);
  const cache = new Map();
  const fallbackId = defaultParkId && byId.has(defaultParkId) ? defaultParkId : parks[0].id;

  const registry = {
    async get(id) {
      const base = byId.get(id);
      if (!base) return null;
      const hit = cache.get(id);
      if (cacheMs > 0 && hit && Date.now() - hit.at < cacheMs) return structuredClone(hit.park);
      const overrides = (await store.get(`park_settings:${id}`)) || {};
      const park = mergePark(base, overrides);
      if (cacheMs > 0) cache.set(id, { park, at: Date.now() });
      return structuredClone(park);
    },

    // Route by the number the caller dialled. No number supplied -> default park.
    // A number we don't recognise -> null (never guess which park's data to use).
    async resolve(calledNumber) {
      if (!calledNumber) return registry.get(fallbackId);
      const id = byNumber.get(calledNumber);
      return id ? registry.get(id) : null;
    },

    async updateSettings(id, patch) {
      if (!byId.has(id)) return { error: 'unknown park' };
      const { value, errors } = normaliseSettings(patch || {});
      if (errors.length) return { errors };
      const current = (await store.get(`park_settings:${id}`)) || {};
      await store.set(`park_settings:${id}`, { ...current, ...value });
      cache.delete(id);
      return { park: await registry.get(id) };
    },

    ids: () => [...byId.keys()],
  };
  return registry;
}

module.exports = { createParkRegistry, DEFAULT_PARK, validateSettings, normaliseSettings, BOUNDS, ADJUSTABLE };
