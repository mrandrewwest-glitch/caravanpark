'use strict';

// REAL NewBook REST client. It exposes exactly the operations the rest of OnSite uses on the mock
// (newbook-client.js): getAvailability, quote, createBooking, findBookingByKey, confirmBooking,
// releaseBooking, getBooking.
//
// Built from NewBook's public REST documentation (https://developers.newbook.cloud/rest.php), NOT yet
// run against a real NewBook instance. Every assumption that could not be confirmed from the docs is
// marked ASSUMPTION below and exercised by scripts/newbook-probe.js against a sandbox. Do not point
// this at a live park until the probe passes.
//
// Facts taken from the docs:
//   POST https://api.newbook.cloud/rest/<method>  (test: https://testapi.newbook.cloud/rest/<method>)
//   HTTP Basic auth (username/password) + "region" and "api_key" in the JSON body
//   response: { success: "true"|"false", data, message }; 100 requests/minute; dates YYYY-MM-DD,
//   datetimes "YYYY-MM-DD HH:MM:SS"
//   availability = bookings_availability_pricing -> accommodation CATEGORIES with tariffs_available[]
//   bookings_create takes category_id (NewBook auto-allocates a site) or site_id; needs a guest with
//     firstname, lastname, street, city, postcode and phone or email
//   statuses: Quote, Unconfirmed, Confirmed, Cancelled, ...; cancelling needs booking_cancelled_reason_id
//   payments attach to the booking's client ACCOUNT (account_id), not the booking
//   NO idempotency support is documented
const D = require('./dates');

class NewBookError extends Error {
  // code: AUTH | THROTTLED | TIMEOUT | NETWORK | SERVER_ERROR | INVALID_RESPONSE | SITE_UNAVAILABLE |
  //       NOT_FOUND | BOOKING_RELEASED | CONFIG | API_ERROR
  // outcomeUnknown: for WRITES, true when the request may have been applied (timeout, dropped
  // connection, 5xx, unreadable reply). Callers must look the result up, never blindly retry.
  constructor(message, { code = 'API_ERROR', status = null, method = null, outcomeUnknown = false, details = null } = {}) {
    super(message);
    this.name = 'NewBookError';
    this.code = code;
    this.status = status;
    this.method = method;
    this.outcomeUnknown = outcomeUnknown;
    this.details = details;
  }
}

const DEFAULTS = {
  base_url: 'https://api.newbook.cloud/rest',
  unit_mode: 'category', // 'category' = book by category_id (NewBook picks the site). 'site' = ASSUMPTION: book a specific site_id
  default_adults: 2, // occupancy used for the pre-guest availability listing (rates can be per person)
  hold_status: 'Unconfirmed', // ASSUMPTION: holds the site like a normal unpaid booking ('Quote' may not hold inventory)
  confirmed_status: 'Confirmed',
  cancelled_status: 'Cancelled',
  cancel_reason_name: null, // match a name from bookings_cancellation_reasons, or set cancelled_reason_id
  cancelled_reason_id: null,
  payment_type_id: null, // from payment_types, or set payment_type_name
  payment_type_name: null,
  gl_category_id: null, // included on payments when set (some docs sections list it as required)
  source_id: null,
  method_id: null,
  placeholder_address: null, // REQUIRED for bookings: { street, city, postcode, state?, country? } (callers on the phone are not asked for an address)
  categories_cache_ms: 24 * 60 * 60 * 1000,
  read_timeout_ms: 1500,
  write_timeout_ms: 4000,
  max_per_minute: 80, // below NewBook's 100/min; per container (a hard cross-container limit needs a shared counter)
  amenity_map: [
    [/power|electric/i, 'power'], [/water/i, 'water'], [/wi-?fi|internet/i, 'wifi'], [/bbq|barbecue/i, 'bbq'],
    [/ensuite|bathroom/i, 'ensuite'], [/air.?con/i, 'air_con'], [/playground/i, 'playground_nearby'],
  ],
};

const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1';
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nightsOf = (a, b) => D.nightsBetween(a, b);
const asArray = (data) => (Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : []);

// Problems that would make the client unsafe to use for AI booking. Checked at startup.
function validateRestConfig(newbook, { forBooking = true } = {}) {
  const errors = [];
  const c = { ...DEFAULTS, ...newbook };
  if (!newbook.credentials_ref) errors.push('newbook.credentials_ref is required (env:NAME or a Secrets Manager ARN)');
  if (forBooking) {
    const a = c.placeholder_address;
    if (!a || !a.street || !a.city || !a.postcode) errors.push('newbook.placeholder_address {street, city, postcode} is required: NewBook needs a guest address and phone callers are not asked for one');
    if (!c.payment_type_id && !c.payment_type_name) errors.push('newbook.payment_type_id or payment_type_name is required to post online payments');
    if (!c.cancelled_reason_id && !c.cancel_reason_name) errors.push('newbook.cancelled_reason_id or cancel_reason_name is required to release unpaid holds');
  }
  if (!['category', 'site'].includes(c.unit_mode)) errors.push('newbook.unit_mode must be "category" or "site"');
  return errors;
}

// ---- Pure mapping helpers (exported for tests) ----
function amenitiesFrom(features, map) {
  const out = new Set();
  for (const f of features || []) {
    const name = String(f.feature_name || f.name || '');
    const hit = map.find(([re]) => re.test(name));
    out.add(hit ? hit[1] : name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  }
  out.delete('');
  return [...out];
}

function categoryMeta(cat, map) {
  const adults = Number(cat.category_max_adults || 0);
  const children = Number(cat.category_max_children || 0);
  const combined = Number(cat.category_max_combined || 0);
  const lengthsM = asArray(cat.sites).map((s) => s.site_size).filter((z) => z && Number(z.length) > 0).map((z) => (String(z.unit).toLowerCase().startsWith('f') ? Number(z.length) * 0.3048 : Number(z.length)));
  return {
    category_id: Number(cat.category_id),
    name: cat.category_name,
    max_guests: combined || adults + children,
    max_animals: Number(cat.category_max_animals || 0),
    amenities: amenitiesFrom(cat.features, map),
    vehicle_max_length: lengthsM.length ? round2(Math.max(...lengthsM)) : null,
  };
}

// The cheapest tariff that NewBook says is bookable for this category.
function bestTariff(category) {
  const ok = asArray(category.tariffs_available).filter((t) => isTrue(t.tariff_success) && Number.isFinite(Number(t.tariff_total)));
  return ok.length ? ok.reduce((a, b) => (Number(b.tariff_total) < Number(a.tariff_total) ? b : a)) : null;
}

// NewBook status -> the statuses the rest of OnSite uses.
function mapStatus(newbookStatus, cfg) {
  const s = String(newbookStatus || '').toLowerCase();
  if (s === cfg.hold_status.toLowerCase()) return 'provisional';
  if (['confirmed', 'arrived', 'departed'].includes(s)) return 'confirmed';
  if (s === 'cancelled' || s === 'no-show') return 'released';
  return s || 'unknown';
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: 'Guest', last: '(phone booking)' };
  if (parts.length === 1) return { first: parts[0], last: '(phone booking)' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function createNewBookRestClient({ parkName = 'Park', timezone = 'Australia/Sydney', config = {}, getCredentials, fetchImpl = globalThis.fetch, now = Date.now, logger = null } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (typeof getCredentials !== 'function') throw new Error('getCredentials is required');
  const stamps = []; // client-side rate limiter (sliding minute window)
  let categoryCache = null; // { at, byId: Map }
  let reasonId = cfg.cancelled_reason_id;
  let paymentTypeId = cfg.payment_type_id;
  const calls = [];

  const fmtDateTime = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: timezone }); // "YYYY-MM-DD HH:MM:SS"

  async function throttle(maxWaitMs) {
    const start = Date.now();
    for (;;) {
      const cutoff = Date.now() - 60000;
      while (stamps.length && stamps[0] < cutoff) stamps.shift();
      if (stamps.length < cfg.max_per_minute) { stamps.push(Date.now()); return; }
      const wait = stamps[0] + 60000 - Date.now();
      if (Date.now() - start + wait > maxWaitMs) throw new NewBookError('Client-side rate limit reached (NewBook allows 100 requests/minute)', { code: 'THROTTLED' });
      await sleep(Math.min(wait, 250));
    }
  }

  function classify(message) {
    const m = String(message || '');
    if (/throttl|too many requests|rate limit|100 requests/i.test(m)) return 'THROTTLED';
    if (/unauthori[sz]ed|authenticat|credential|invalid api.?key|api.?key (is )?(invalid|incorrect|missing)|login/i.test(m)) return 'AUTH';
    if (/not available|unavailable|no availability|no sites|fully booked|already (booked|allocated|occupied)|cannot be allocated|could not allocate/i.test(m)) return 'SITE_UNAVAILABLE'; // ASSUMPTION: wording; unknown failures fall into the safe lookup-then-hand-off path
    if (/not found|no such|invalid booking|does not exist/i.test(m)) return 'NOT_FOUND';
    return 'API_ERROR';
  }

  // One POST. writes: true for anything that changes NewBook (never auto-retried).
  async function request(method, body = {}, { write = false, timeoutMs } = {}) {
    const limit = timeoutMs || (write ? cfg.write_timeout_ms : cfg.read_timeout_ms);
    const attempts = write ? 1 : 2;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await throttle(limit);
      const creds = await getCredentials();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limit);
      calls.push({ method, write });
      try {
        let res;
        try {
          res = await fetchImpl(`${cfg.base_url.replace(/\/$/, '')}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}` },
            body: JSON.stringify({ region: creds.region || cfg.region || 'au', api_key: creds.api_key, ...body }),
            signal: controller.signal,
          });
        } catch (err) {
          const aborted = err && (err.name === 'AbortError' || controller.signal.aborted);
          throw new NewBookError(aborted ? `NewBook ${method} timed out after ${limit} ms` : `NewBook ${method} network error: ${err.message}`, { code: aborted ? 'TIMEOUT' : 'NETWORK', method, outcomeUnknown: write });
        }
        if (res.status === 401 || res.status === 403) throw new NewBookError(`NewBook rejected the credentials (HTTP ${res.status})`, { code: 'AUTH', status: res.status, method });
        if (res.status === 429) throw new NewBookError('NewBook throttled the request (HTTP 429)', { code: 'THROTTLED', status: 429, method });
        if (res.status >= 500) throw new NewBookError(`NewBook server error (HTTP ${res.status})`, { code: 'SERVER_ERROR', status: res.status, method, outcomeUnknown: write });
        let json;
        try { json = await res.json(); } catch (err) {
          throw new NewBookError(`NewBook ${method} returned an unreadable response`, { code: 'INVALID_RESPONSE', status: res.status, method, outcomeUnknown: write });
        }
        if (!isTrue(json.success)) {
          const code = classify(json.message);
          throw new NewBookError(json.message || `NewBook ${method} failed`, { code, status: res.status, method, details: json });
        }
        return json.data;
      } catch (err) {
        lastErr = err;
        const retryable = !write && ['THROTTLED', 'SERVER_ERROR', 'NETWORK'].includes(err.code) && attempt < attempts;
        if (!retryable) throw err;
        logger?.warn('newbook_retry', { method, code: err.code });
        await sleep(400);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // ---- Reference data (cached) ----
  async function categories() {
    if (categoryCache && now() - categoryCache.at < cfg.categories_cache_ms) return categoryCache.byId;
    try {
      const data = await request('accommodation_categories_list', {}, { timeoutMs: Math.max(cfg.read_timeout_ms, 2000) });
      const byId = new Map(asArray(data).map((c) => categoryMeta(c, cfg.amenity_map)).filter((m) => Number.isFinite(m.category_id)).map((m) => [m.category_id, m]));
      categoryCache = { at: now(), byId };
      return byId;
    } catch (err) {
      if (categoryCache) { logger?.warn('categories_refresh_failed_using_stale', { error: err.message }); return categoryCache.byId; }
      throw err;
    }
  }

  async function cancelReasonId() {
    if (reasonId) return reasonId;
    const list = asArray(await request('bookings_cancellation_reasons', {}));
    const hit = list.find((r) => String(r.name).toLowerCase() === String(cfg.cancel_reason_name).toLowerCase());
    if (!hit) throw new NewBookError(`No NewBook cancellation reason named "${cfg.cancel_reason_name}"`, { code: 'CONFIG' });
    reasonId = Number(hit.id);
    return reasonId;
  }

  async function paymentType() {
    if (paymentTypeId) return paymentTypeId;
    const list = asArray(await request('payment_types', {}));
    const hit = list.find((t) => String(t.type).toLowerCase() === String(cfg.payment_type_name).toLowerCase());
    if (!hit) throw new NewBookError(`No NewBook payment type named "${cfg.payment_type_name}"`, { code: 'CONFIG' });
    paymentTypeId = Number(hit.id);
    return paymentTypeId;
  }

  const pull = (params) => request('bookings_availability_pricing', { adults: cfg.default_adults, children: 0, animals: 0, ...params });

  const toBooking = (data, extra = {}) => ({
    booking_id: String(data.booking_id),
    site_id: extra.site_id ?? (data.category_id !== undefined ? Number(data.category_id) : null),
    site_name: data.category_name || data.site_name || extra.site_name || null,
    allocated_site: data.site_name || null,
    check_in: extra.check_in || String(data.booking_arrival || '').slice(0, 10),
    check_out: extra.check_out || String(data.booking_departure || '').slice(0, 10),
    total: Number(data.booking_total),
    status: mapStatus(data.booking_status, cfg),
    account_id: data.default_client_account_id ?? data.account_id ?? null,
    guest: extra.guest || null,
    source: extra.source || null,
    ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
  });

  const client = {
    kind: 'newbook-rest',
    calls,
    cfg,

    async ping() { return request('auth_test', {}); },

    // Resolves the cancellation reason and payment type this park is configured to use (read-only), so a
    // wrong name is found at setup time instead of when the first payment arrives.
    async verifyReferenceData() { return { cancelReasonId: await cancelReasonId(), paymentTypeId: await paymentType() }; },

    // Fill the category cache at startup so the first caller doesn't pay for it inside the voice budget.
    async warm() { await categories(); },

    async getAvailability(checkIn, checkOut) {
      const nights = nightsOf(checkIn, checkOut);
      const [meta, data] = await Promise.all([categories(), pull({ period_from: checkIn, period_to: checkOut })]);
      const sites = [];
      for (const cat of asArray(data)) {
        const m = meta.get(Number(cat.category_id));
        if (!m) { logger?.warn('availability_category_without_metadata', { category_id: cat.category_id }); continue; } // can't judge pets/size: never offer it
        const best = bestTariff(cat);
        sites.push({
          site_id: m.category_id, name: m.name, price: best ? round2(Number(best.tariff_total) / nights) : 0, stay_total: best ? Number(best.tariff_total) : null,
          tariff_label: best ? best.tariff_label : null, max_guests: m.max_guests, pet_friendly: m.max_animals > 0, amenities: m.amenities,
          vehicle_max_length: m.vehicle_max_length, available: Number(cat.sites_available) > 0 && !!best,
        });
      }
      return { sites, total_available: sites.filter((s) => s.available).length, park_name: parkName, check_in: checkIn, check_out: checkOut };
    },

    // Price for THIS party (rates can depend on occupancy): total for the stay, from NewBook.
    async quote(siteId, checkIn, checkOut, { guests = null, animals = 0 } = {}) {
      const nights = nightsOf(checkIn, checkOut);
      const data = await pull({ period_from: checkIn, period_to: checkOut, ...(cfg.unit_mode === 'site' ? { site_id: siteId } : { category_id: siteId }), adults: guests || cfg.default_adults, animals });
      const cat = asArray(data).find((c) => Number(c.category_id) === Number(siteId)) || (cfg.unit_mode === 'site' ? asArray(data)[0] : null);
      const best = cat && Number(cat.sites_available) > 0 ? bestTariff(cat) : null;
      if (!best) throw new NewBookError(`No bookable rate for ${siteId} ${checkIn} to ${checkOut}`, { code: 'SITE_UNAVAILABLE', method: 'bookings_availability_pricing' });
      const total = Number(best.tariff_total);
      return { site_id: siteId, nights, nightly: round2(total / nights), total, tariff_label: best.tariff_label };
    },

    async createBooking({ idempotency_key: key, site_id: siteId, check_in: checkIn, check_out: checkOut, guest = {}, hold_expires_at: holdExpiresAt, source, status = 'provisional' }) {
      const a = cfg.placeholder_address;
      if (!a || !a.street || !a.city || !a.postcode) throw new NewBookError('newbook.placeholder_address is not configured', { code: 'CONFIG' });
      const { first, last } = splitName(guest.name);
      const notes = [`OnSite AI phone booking. Ref: ${key}`, holdExpiresAt ? `Unpaid hold expires ${holdExpiresAt}.` : null, 'Address is a placeholder: collect the real address at check-in.', guest.has_pet ? 'Guest is bringing a pet.' : null, guest.vehicle_type ? `Vehicle: ${guest.vehicle_type}.` : null].filter(Boolean).join(' ');
      const body = {
        period_from: checkIn, period_to: checkOut,
        ...(cfg.unit_mode === 'site' ? { site_id: siteId } : { category_id: siteId }),
        guest_firstname: first, guest_lastname: last, guest_phone: guest.mobile,
        address_street: a.street, address_city: a.city, address_postcode: a.postcode,
        ...(a.state ? { address_state_name: a.state } : {}), ...(a.country ? { address_country_name: a.country } : {}),
        adults: guest.num_guests || cfg.default_adults, children: 0, animals: guest.has_pet ? 1 : 0,
        status: status === 'confirmed' ? cfg.confirmed_status : cfg.hold_status,
        notes,
        ...(cfg.source_id ? { source_id: cfg.source_id } : {}), ...(cfg.method_id ? { method_id: cfg.method_id } : {}),
      };
      // Writes are never retried. On a timeout/5xx the booking may exist: the caller looks it up by key.
      const data = await request('bookings_create', body, { write: true });
      return toBooking(data, { site_id: siteId, check_in: checkIn, check_out: checkOut, guest, source, idempotency_key: key });
    },

    // ASSUMPTION: bookings_list's `search` and returned fields can surface our key from `notes`.
    // We therefore match on the whole serialised record rather than a specific field name.
    async findBookingByKey(key, hint = {}) {
      const from = hint.check_in || D.toISO(new Date(now() - 2 * 86400000));
      const to = hint.check_out || D.toISO(new Date(now() + 400 * 86400000));
      const data = await request('bookings_list', { period_from: from, period_to: to, list_type: 'all', search: key });
      const hit = asArray(data).find((b) => JSON.stringify(b).includes(key));
      return hit ? toBooking(hit, { check_in: hint.check_in, check_out: hint.check_out, idempotency_key: key }) : null;
    },

    async getBooking(bookingId) {
      try {
        const data = await request('bookings_get', { booking_id: Number(bookingId) });
        return toBooking(Array.isArray(data) ? data[0] : data);
      } catch (err) {
        if (err.code === 'NOT_FOUND') return null;
        throw err;
      }
    },

    // Posts the payment against the booking's client account (idempotently by our payment id),
    // then confirms. Safe to call again after a partial failure: the provider retries the webhook.
    async confirmBooking(bookingId, { payment } = {}) {
      const current = await client.getBooking(bookingId);
      if (!current) throw new NewBookError(`Booking ${bookingId} not found`, { code: 'NOT_FOUND' });
      if (current.status === 'released') throw new NewBookError(`Booking ${bookingId} was cancelled`, { code: 'BOOKING_RELEASED' });
      if (payment) {
        if (!current.account_id) throw new NewBookError(`Booking ${bookingId} has no client account to post the payment to`, { code: 'API_ERROR' });
        const existing = asArray(await request('payments_list', { account_id: current.account_id }));
        const already = existing.some((p) => String(p.type_reference || '') === String(payment.id));
        if (!already) {
          const amount = round2(payment.amount_cents / 100);
          await request('payments_create', {
            account_id: current.account_id, amount, description: `Online payment ${payment.id} (OnSite)`, type: await paymentType(), type_reference: String(payment.id),
            deposit: amount < current.total ? 1 : 0, generated_when: fmtDateTime(now()), ...(cfg.gl_category_id ? { gl_category_id: cfg.gl_category_id } : {}),
          }, { write: true });
        }
      }
      if (current.status !== 'confirmed') await request('bookings_update', { booking_id: Number(bookingId), status: cfg.confirmed_status }, { write: true });
      return { ...current, status: 'confirmed' };
    },

    // Cancels an unpaid hold. Never touches a booking that is no longer a hold (e.g. confirmed).
    async releaseBooking(bookingId, reason) { // reason is logged only (see above)
      const current = await client.getBooking(bookingId);
      if (!current) throw new NewBookError(`Booking ${bookingId} not found`, { code: 'NOT_FOUND' });
      if (current.status !== 'provisional') return current;
      await request('bookings_update', { booking_id: Number(bookingId), status: cfg.cancelled_status, booking_cancelled_reason_id: await cancelReasonId() }, { write: true }); // no `notes` on update: it could overwrite the notes holding our reference key
      logger?.info('newbook_hold_released', { booking_id: bookingId, reason });
      return { ...current, status: 'released' };
    },
  };
  return client;
}

module.exports = { createNewBookRestClient, NewBookError, validateRestConfig, categoryMeta, bestTariff, mapStatus, splitName, amenitiesFrom, DEFAULTS };
