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
  index: {
    gsi2: { pk: `bookings#${rec.park_id}`, sk: pad(rec.created_ms) }, // every booking, per park, by creation time (owner portal)
    ...(rec.status === 'held' ? { gsi1: { pk: 'bookings#held', sk: pad(rec.hold_expires_ms) } } : {}),
  },
});
const saveBooking = (store, rec) => store.set(keys.booking(rec.park_id, rec.booking_ref), rec, bookingOpts(rec));
const getBooking = (store, parkId, ref) => store.get(keys.booking(parkId, ref));
const heldBookings = (store) => store.query('gsi1', 'bookings#held');
const parkBookings = (store, parkId, fromMs = 0, toMs = 9e14) => store.query('gsi2', `bookings#${parkId}`, { skMin: pad(fromMs), skMax: pad(toMs) });

// ---- Take-a-message records, per park by creation time ----
const messageOpts = (rec) => ({ ttlSeconds: TTL.messages, index: { gsi2: { pk: `messages#${rec.park_id}`, sk: pad(rec.created_ms) } } });
const saveMessage = (store, rec) => store.set(keys.message(rec.park_id, rec.call_sid), rec, messageOpts(rec));
const getMessage = (store, parkId, callSid) => store.get(keys.message(parkId, callSid));
const parkMessages = (store, parkId) => store.query('gsi2', `messages#${parkId}`);

// ---- Owner portal users (one record per sign-in email), listed per park ----
const userKey = (email) => `users:${email}`;
const userOpts = (rec) => ({ index: { gsi2: { pk: `users#${rec.park_id}`, sk: pad(rec.created_ms) } } });
const saveUser = (store, rec) => store.set(userKey(rec.email), rec, userOpts(rec));
const getUser = (store, email) => store.get(userKey(email));
const parkUsers = (store, parkId) => store.query('gsi2', `users#${parkId}`);

// ---- Audit trail of what owners did (sign-ins, settings changes), per park ----
const AUDIT_TTL = 400 * DAY;
const appendAudit = (store, parkId, entry, now = Date.now(), rand = Math.random().toString(36).slice(2, 8)) => {
  const rec = { park_id: parkId, at: now, ...entry };
  return store.set(`audit:${parkId}:${pad(now)}:${rand}`, rec, { ttlSeconds: AUDIT_TTL, index: { gsi2: { pk: `audit#${parkId}`, sk: pad(now) } } }).then(() => rec);
};
const parkAudit = (store, parkId, limit = 100) => store.query('gsi2', `audit#${parkId}`).then((rows) => rows.slice(-limit).reverse());

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

module.exports = { TTL, pad, keys, bookingOpts, callOpts, saveBooking, getBooking, heldBookings, parkBookings, saveMessage, getMessage, parkMessages, saveUser, getUser, parkUsers, userKey, appendAudit, parkAudit, getCall, updateCall, openCallsBefore, parkCalls };
