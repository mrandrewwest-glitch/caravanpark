'use strict';

// Data access for the records that need indexes or TTLs. Everything else (call state,
// message records, park settings, suppression, event dedupe) uses store.get/set directly with
// the TTLs below. One place owns key names, retention and index entries.

const DAY = 86400;
const retentionDays = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

const TTL = {
  state: 7 * DAY, // call state: a call (or SMS thread) is over long before this
  events: 35 * DAY, // payment webhook dedupe: must outlive the provider's retry window
  bookings: 90 * DAY, // held/confirmed AI booking records (late payments can arrive days later)
  messages: 90 * DAY, // take-a-message records
  // Billing ledger: kept until you decide otherwise. Set LEDGER_RETENTION_DAYS (e.g. 400) to purge
  // old call records (they contain caller phone numbers); statements need them until invoiced.
  calls: process.env.LEDGER_RETENTION_DAYS ? retentionDays(process.env.LEDGER_RETENTION_DAYS) * DAY : undefined,
};

const pad = (ms) => String(Math.round(ms)).padStart(15, '0'); // sortable string for epoch ms

const keys = {
  state: (sid) => `state:${sid}`,
  booking: (parkId, ref) => `bookings:${parkId}:${ref}`,
  call: (sid) => `calls:${sid}`,
  event: (parkId, eventId) => `events:${parkId}:${eventId}`,
  message: (parkId, sid) => `messages:${parkId}:${sid}`,
  suppression: (phone) => `suppression:${phone}`,
  parkSettings: (id) => `park_settings:${id}`,
};

// ---- Bookings: sparse index "bookings#held" ordered by hold expiry, only while status is 'held' ----
const bookingOpts = (rec) => ({
  ttlSeconds: TTL.bookings,
  index: rec.status === 'held' ? { gsi1: { pk: 'bookings#held', sk: pad(rec.hold_expires_ms) } } : undefined,
});
const saveBooking = (store, rec) => store.set(keys.booking(rec.park_id, rec.booking_ref), rec, bookingOpts(rec));
const getBooking = (store, parkId, ref) => store.get(keys.booking(parkId, ref));
const heldBookings = (store) => store.query('gsi1', 'bookings#held');

// ---- Calls (billing ledger) ----
// gsi2 "calls#<park>" by start time -> monthly statements. gsi1 "calls#open" by last activity ->
// idle finaliser; present only until the call is finalised.
const callOpts = (rec) => ({
  ttlSeconds: TTL.calls,
  index: {
    gsi2: { pk: `calls#${rec.park_id}`, sk: pad(rec.started_at) },
    ...(rec.finalized_at ? {} : { gsi1: { pk: 'calls#open', sk: pad(rec.last_turn_at) } }),
  },
});
const getCall = (store, sid) => store.get(keys.call(sid));
const updateCall = (store, sid, fn) => store.update(keys.call(sid), fn, callOpts);
const openCallsBefore = (store, beforeMs) => store.query('gsi1', 'calls#open', { skMax: pad(beforeMs) });
const parkCalls = (store, parkId, fromMs, toMs) => store.query('gsi2', `calls#${parkId}`, { skMin: pad(fromMs), skMax: pad(toMs) });

module.exports = { TTL, pad, keys, bookingOpts, callOpts, saveBooking, getBooking, heldBookings, getCall, updateCall, openCallsBefore, parkCalls };
