'use strict';

// Multi-park registry. Each park has its own number(s), mode, booking policy,
// hold time, billing terms and provider credentials. Parks can adjust a small set
// of settings at runtime (persisted in the store); everything else is static config.
const fs = require('fs');

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
const ADJUSTABLE = ['hold_minutes', 'deposit_percent', 'mode', 'booking_mode', 'max_nights'];

function validateSettings(patch) {
  const errors = [];
  for (const k of Object.keys(patch)) if (!ADJUSTABLE.includes(k)) errors.push(`${k} is not adjustable`);
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    if (k in patch && !(Number.isInteger(patch[k]) && patch[k] >= lo && patch[k] <= hi)) errors.push(`${k} must be a whole number between ${lo} and ${hi}`);
  }
  if ('mode' in patch && !['full', 'diversion'].includes(patch.mode)) errors.push('mode must be "full" or "diversion"');
  if ('booking_mode' in patch && !['handoff', 'ai_booking'].includes(patch.booking_mode)) errors.push('booking_mode must be "handoff" or "ai_booking"');
  return errors;
}

function mergePark(base, overrides) {
  const merged = { ...base, limits: { ...base.limits } };
  for (const k of ['hold_minutes', 'deposit_percent', 'mode', 'booking_mode']) if (overrides[k] !== undefined) merged[k] = overrides[k];
  if (overrides.max_nights !== undefined) merged.limits.max_nights = overrides.max_nights;
  return merged;
}

function loadParks(env = process.env) {
  if (env.PARKS_CONFIG) return JSON.parse(fs.readFileSync(env.PARKS_CONFIG, 'utf8'));
  return [DEFAULT_PARK];
}

function createParkRegistry({ parks = loadParks(), store, defaultParkId = process.env.DEFAULT_PARK_ID }) {
  if (!parks.length) throw new Error('At least one park is required');
  const byId = new Map(parks.map((p) => [p.id, { ...DEFAULT_PARK, ...p, limits: { ...DEFAULT_PARK.limits, ...p.limits }, staff: { ...DEFAULT_PARK.staff, ...p.staff }, billing: { ...DEFAULT_PARK.billing, ...p.billing } }]));
  const byNumber = new Map();
  for (const p of byId.values()) for (const n of p.numbers || []) byNumber.set(n, p.id);
  const fallbackId = defaultParkId && byId.has(defaultParkId) ? defaultParkId : parks[0].id;

  const registry = {
    async get(id) {
      const base = byId.get(id);
      if (!base) return null;
      const overrides = (await store.get(`park_settings:${id}`)) || {};
      return mergePark(base, overrides);
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
      const errors = validateSettings(patch);
      if (errors.length) return { errors };
      const current = (await store.get(`park_settings:${id}`)) || {};
      await store.set(`park_settings:${id}`, { ...current, ...patch });
      return { park: await registry.get(id) };
    },

    ids: () => [...byId.keys()],
  };
  return registry;
}

module.exports = { createParkRegistry, DEFAULT_PARK, validateSettings, BOUNDS, ADJUSTABLE };
