'use strict';

// MOCK NewBook client (Phase 1). Data comes from the build brief.
// The real client (WSSE auth, https://api.au.newbook.cloud/rest/) replaces
// createMockNewBookClient later; it must expose the same two methods.

const MOCK_SITES = [
  { site_id: 12, name: 'Site 12 - Large Family', price: 185, max_guests: 6, pet_friendly: true, amenities: ['power', 'water', 'wifi', 'playground_nearby', 'bbq'], vehicle_max_length: 9.5, available: true },
  { site_id: 15, name: 'Site 15 - Standard', price: 150, max_guests: 4, pet_friendly: false, amenities: ['power', 'water'], vehicle_max_length: 8.0, available: true },
  { site_id: 8, name: 'Site 8 - Powered Only', price: 120, max_guests: 2, pet_friendly: true, amenities: ['power'], vehicle_max_length: 6.5, available: true },
  { site_id: 20, name: 'Site 20 - Unpowered', price: 90, max_guests: 4, pet_friendly: false, amenities: ['water'], vehicle_max_length: 10.0, available: true },
  { site_id: 5, name: 'Site 5 - Deluxe', price: 250, max_guests: 8, pet_friendly: true, amenities: ['power', 'water', 'wifi', 'bbq', 'ensuite', 'air_con'], vehicle_max_length: 12.0, available: true },
];

const MOCK_SITE_DETAILS = {
  12: {
    site_id: 12,
    name: 'Site 12 - Large Family',
    description: 'Spacious family site with level ground, near playground',
    price: 185,
    max_guests: 6,
    pet_friendly: true,
    pet_policy: '2 pets max, no aggressive breeds',
    amenities: ['power', 'water', 'wifi', 'playground_nearby', 'bbq'],
    vehicle_max_length: 9.5,
    power_output: '15A',
    wifi_included: true,
    available: true,
    reviews: [{ rating: 5, comment: 'Perfect for families, kids loved the playground' }],
  },
};

const DETAILS_TTL_MS = 24 * 60 * 60 * 1000; // daily refresh per brief

const overlaps = (aIn, aOut, bIn, bOut) => aIn < bOut && bIn < aOut;
const nightsOf = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Test hooks: failWith (everything), createFailWith (createBooking rejects before storing),
// loseCreateResponse (booking IS stored but the caller sees a timeout, the dangerous case).
function createMockNewBookClient({ parkName = 'Friends Caravan Park', sites = MOCK_SITES, latencyMs = 50, failWith = null, createFailWith = null, loseCreateResponse = false, allowOverlap = false, totalDelta = 0 } = {}) {
  const detailsCache = new Map();
  const bookings = new Map();
  const byKey = new Map();
  let seq = 1000;
  const calls = [];
  const wait = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : null);
  const active = (b) => b.status === 'provisional' || b.status === 'confirmed';
  const taken = (checkIn, checkOut) => new Set([...bookings.values()].filter((b) => active(b) && overlaps(b.check_in, b.check_out, checkIn, checkOut)).map((b) => b.site_id));

  const client = {
    kind: 'mock',
    calls, // recorded so tests can assert what was (not) called
    bookings,
    failWith,
    createFailWith,
    loseCreateResponse,
    totalDelta, // test hook: NewBook's own total differs from the quote by this much
    allowOverlap, // test hook: a NewBook that does NOT reject conflicting creates (so our own re-check is the only guard)

    async getAvailability(checkIn, checkOut) {
      calls.push({ method: 'getAvailability', checkIn, checkOut });
      await wait();
      if (client.failWith) throw client.failWith;
      const busy = taken(checkIn, checkOut);
      const list = structuredClone(sites).map((s) => ({ ...s, available: s.available && !busy.has(s.site_id) }));
      return { sites: list, total_available: list.filter((s) => s.available).length, park_name: parkName, check_in: checkIn, check_out: checkOut };
    },

    // Price for a stay. The real total must come from NewBook, never from the LLM.
    async quote(siteId, checkIn, checkOut) {
      calls.push({ method: 'quote', siteId, checkIn, checkOut });
      await wait();
      if (client.failWith) throw client.failWith;
      const site = sites.find((x) => x.site_id === siteId);
      if (!site) throw new Error(`Unknown site ${siteId}`);
      const nights = nightsOf(checkIn, checkOut);
      return { site_id: siteId, nights, nightly: site.price, total: site.price * nights };
    },

    async createBooking({ idempotency_key: key, site_id: siteId, check_in: checkIn, check_out: checkOut, guest, hold_expires_at: holdExpiresAt, source, status = 'provisional' }) {
      calls.push({ method: 'createBooking', key, siteId, checkIn, checkOut });
      await wait();
      if (client.failWith) throw client.failWith;
      if (client.createFailWith) throw client.createFailWith;
      if (byKey.has(key)) return structuredClone(byKey.get(key)); // idempotent replay
      const site = sites.find((x) => x.site_id === siteId);
      if (!site) throw Object.assign(new Error(`Unknown site ${siteId}`), { code: 'UNKNOWN_SITE' });
      if (!site.available || (!client.allowOverlap && taken(checkIn, checkOut).has(siteId))) throw Object.assign(new Error('Site no longer available'), { code: 'SITE_UNAVAILABLE' });
      seq += 1;
      const booking = {
        booking_id: `NB${seq}`, idempotency_key: key, site_id: siteId, site_name: site.name, check_in: checkIn, check_out: checkOut,
        total: site.price * nightsOf(checkIn, checkOut) + client.totalDelta, status, hold_expires_at: holdExpiresAt || null, guest, source: source || null, payments: [],
      };
      bookings.set(booking.booking_id, booking);
      byKey.set(key, booking);
      if (client.loseCreateResponse) throw new Error('NewBook request timed out');
      return structuredClone(booking);
    },

    async findBookingByKey(key) {
      calls.push({ method: 'findBookingByKey', key });
      await wait();
      return byKey.has(key) ? structuredClone(byKey.get(key)) : null;
    },

    async confirmBooking(bookingId, { payment } = {}) {
      calls.push({ method: 'confirmBooking', bookingId });
      await wait();
      if (client.failWith) throw client.failWith;
      const b = bookings.get(bookingId);
      if (!b) throw new Error(`Unknown booking ${bookingId}`);
      if (b.status === 'released') throw Object.assign(new Error('Booking was released'), { code: 'BOOKING_RELEASED' });
      b.status = 'confirmed';
      if (payment) b.payments.push(payment); // external payment posted against the booking
      return structuredClone(b);
    },

    async releaseBooking(bookingId, reason) {
      calls.push({ method: 'releaseBooking', bookingId, reason });
      await wait();
      if (client.failWith) throw client.failWith;
      const b = bookings.get(bookingId);
      if (!b) throw new Error(`Unknown booking ${bookingId}`);
      if (b.status === 'provisional') b.status = 'released'; // never releases a confirmed booking
      return structuredClone(b);
    },

    async getBooking(bookingId) {
      const b = bookings.get(bookingId);
      return b ? structuredClone(b) : null;
    },

    // Details rarely change: cached locally with a daily refresh.
    async getSiteDetails(siteId) {
      const hit = detailsCache.get(siteId);
      if (hit && hit.expires > Date.now()) return hit.value;
      calls.push({ method: 'getSiteDetails', siteId });
      if (client.failWith) throw client.failWith;
      const value = MOCK_SITE_DETAILS[siteId];
      if (!value) throw new Error(`Unknown site ${siteId}`);
      detailsCache.set(siteId, { value, expires: Date.now() + DETAILS_TTL_MS });
      return structuredClone(value);
    },
  };
  return client;
}

module.exports = { createMockNewBookClient, MOCK_SITES, MOCK_SITE_DETAILS };
