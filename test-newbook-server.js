'use strict';

// A FAKE NewBook REST server for tests, built from NewBook's public documentation. It enforces the
// documented rules (Basic auth, region + api_key in the body, required fields, allowed statuses,
// cancellation needs a reason id, payments attach to an account) so the client is tested against the
// API's rules rather than against itself. It is NOT NewBook: anything the docs did not settle
// (error wording, hold semantics, search behaviour) is this author's assumption, and is what
// scripts/newbook-probe.js checks against a real sandbox.
const http = require('http');

const AUTH = { username: 'onsite', password: 'secret', api_key: 'key-123', region: 'au' };
const STATUSES = ['Arrived', 'Cancelled', 'Confirmed', 'Departed', 'No Guest Data (Incomplete)', 'No-Show', 'Owner Occupied', 'Quote', 'Unconfirmed', 'Waitlist'];
const nights = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const overlaps = (aIn, aOut, bIn, bOut) => aIn < bOut && bIn < aOut;
const FEATURE_NAMES = { power: 'Power', water: 'Water', wifi: 'WiFi', playground_nearby: 'Playground nearby', bbq: 'BBQ', ensuite: 'Ensuite', air_con: 'Air conditioning' };

// Build categories from OnSite's mock site list (one site per category, so results line up).
function categoriesFromSites(sites) {
  return sites.map((s) => ({
    category_id: s.site_id, category_name: s.name, price: s.price, units: 1,
    category_max_adults: s.max_guests, category_max_children: 0, category_max_combined: s.max_guests, category_max_animals: s.pet_friendly ? 2 : 0,
    features: s.amenities.map((a, i) => ({ feature_id: 900 + i, feature_name: FEATURE_NAMES[a] || a, feature_count: 1 })),
    sites: [{ site_id: 1000 + s.site_id, site_name: `Bay ${s.site_id}`, site_size: { id: 1, name: 'Std', length: s.vehicle_max_length, width: 4, height: 4, unit: 'm' } }],
  }));
}

function createFakeNewBook({ categories, latencyMs = 3 } = {}) {
  const state = { bookings: new Map(), payments: [], accounts: new Map(), seq: 5000, paySeq: 800, requests: [], windowCount: 0 };
  const hooks = { loseCreateResponse: false, failCreate: false, failAll: false, allowOverlap: false, totalDelta: 0, throttleNext: 0, hangNext: 0, failUpdateNext: 0, garbageNext: 0 };
  const reasons = [{ id: 1, name: 'Guest request', source: 'guest', active: true }, { id: 2, name: 'Unpaid hold', source: 'instance', active: true }];
  const paymentTypes = [{ id: 3, type: 'Credit Card', active_online: true, active_offline: true, is_card: true }, { id: 4, type: 'Cash', active_online: false, active_offline: true, is_card: false }];
  let server;

  const cat = (id) => categories.find((c) => Number(c.category_id) === Number(id));
  const busySites = (category, from, to, exceptId) => new Set([...state.bookings.values()].filter((b) => b.booking_id !== exceptId && ['Unconfirmed', 'Confirmed', 'Quote', 'Arrived'].includes(b.booking_status) && b.category_id === category.category_id && overlaps(b.booking_arrival.slice(0, 10), b.booking_departure.slice(0, 10), from, to)).map((b) => b.site_internal_id));
  const freeSites = (category, from, to) => category.sites.filter((s) => !busySites(category, from, to).has(s.site_id));

  const bookingData = (b) => ({
    booking_id: b.booking_id, guest_id: b.guest_id, invoice_ids: [], booking_arrival: b.booking_arrival, booking_departure: b.booking_departure,
    booking_length: nights(b.booking_arrival.slice(0, 10), b.booking_departure.slice(0, 10)), booking_status: b.booking_status,
    booking_adults: b.adults, booking_children: 0, booking_infants: 0, booking_animals: b.animals, booking_total: b.booking_total, tariff_total: b.booking_total,
    site_id: b.site_internal_id, site_name: b.site_name, category_id: b.category_id, category_name: b.category_name,
    account_id: b.account_id, default_client_account_id: b.account_id, notes: b.notes, guests: [{ firstname: b.firstname, lastname: b.lastname, contact_phone: b.phone }],
  });

  const fail = (message) => ({ success: 'false', message });
  const ok = (data) => ({ success: 'true', data, message: '' });

  const handlers = {
    auth_test: () => ok({ authenticated: true }),
    accommodation_categories_list: () => ok(categories.map(({ price, units, ...c }) => c)),
    bookings_cancellation_reasons: () => ok(reasons),
    payment_types: () => ok(paymentTypes),

    bookings_availability_pricing: (b) => {
      if (!b.period_from || !b.period_to) return fail('period_from and period_to are required');
      const n = nights(b.period_from, b.period_to);
      if (!(n > 0)) return fail('period_to must be after period_from');
      const list = (b.category_id ? categories.filter((c) => Number(c.category_id) === Number(b.category_id)) : categories);
      return ok(list.map((c) => {
        const free = freeSites(c, b.period_from, b.period_to).length;
        return { category_id: c.category_id, category_name: c.category_name, sites_available: free, sites_message: free ? '' : 'No sites available', tariffs_available: free ? [{ tariff_label: 'Standard rate', tariff_success: 'true', tariff_message: '', tariff_total: c.price * n, inventory_items: [], adjustment_fees: [] }] : [] };
      }));
    },

    bookings_create: (b) => {
      if (hooks.failCreate) return { __http: 500 };
      if (!b.period_from || !b.period_to) return fail('period_from and period_to are required');
      if (!b.category_id && !b.site_id) return fail('category_id or site_id is required');
      if (!b.guest_id) {
        for (const f of ['guest_firstname', 'guest_lastname', 'address_street', 'address_city', 'address_postcode']) if (!b[f]) return fail(`Missing required field: ${f}`);
        if (!b.guest_email && !b.guest_phone) return fail('guest_email or guest_phone is required');
      }
      if (b.status && !STATUSES.includes(b.status)) return fail(`Invalid status: ${b.status}`);
      const category = cat(b.category_id);
      if (!category) return fail('Unknown category');
      // allowOverlap simulates a NewBook that would accept a double booking (our own re-check is then the only guard)
      const free = hooks.allowOverlap ? category.sites : freeSites(category, b.period_from, b.period_to);
      if (!free.length) return fail('No sites available for the requested dates');
      state.seq += 1;
      const accountId = 7000 + state.seq;
      const rec = {
        booking_id: state.seq, guest_id: 3000 + state.seq, booking_arrival: `${b.period_from} 14:00:00`, booking_departure: `${b.period_to} 10:00:00`,
        booking_status: b.status || 'Unconfirmed', adults: b.adults || 0, animals: b.animals || 0,
        booking_total: category.price * nights(b.period_from, b.period_to) + hooks.totalDelta, site_internal_id: free[0].site_id, site_name: free[0].site_name,
        category_id: category.category_id, category_name: category.category_name, account_id: accountId, notes: b.notes || '',
        firstname: b.guest_firstname, lastname: b.guest_lastname, phone: b.guest_phone,
      };
      state.bookings.set(rec.booking_id, rec);
      state.accounts.set(accountId, rec.booking_id);
      if (hooks.loseCreateResponse) return { __hang: true }; // stored, but the caller never gets the reply
      return ok(bookingData(rec));
    },

    bookings_get: (b) => {
      const rec = state.bookings.get(Number(b.booking_id));
      return rec ? ok(bookingData(rec)) : fail('Booking not found');
    },

    bookings_list: (b) => {
      for (const f of ['period_from', 'period_to', 'list_type']) if (!b[f]) return fail(`Missing required field: ${f}`);
      const rows = [...state.bookings.values()].filter((r) => overlaps(r.booking_arrival.slice(0, 10), r.booking_departure.slice(0, 10), b.period_from, b.period_to) || b.period_from === b.period_to);
      return ok(rows.filter((r) => !b.search || JSON.stringify(bookingData(r)).includes(b.search)).map(bookingData));
    },

    bookings_update: (b) => {
      if (hooks.failUpdateNext > 0) { hooks.failUpdateNext -= 1; return { __http: 500 }; }
      const rec = state.bookings.get(Number(b.booking_id));
      if (!rec) return fail('Booking not found');
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return fail(`Invalid status: ${b.status}`);
        if (b.status === 'Cancelled' && !reasons.some((r) => r.id === Number(b.booking_cancelled_reason_id))) return fail('A valid booking_cancelled_reason_id is required to cancel a booking');
        rec.booking_status = b.status;
      }
      if (b.notes !== undefined) rec.notes = b.notes; // real NewBook behaviour unknown: we avoid sending notes on update
      return ok(bookingData(rec));
    },

    payments_create: (b) => {
      for (const f of ['account_id', 'amount', 'description', 'type']) if (b[f] === undefined || b[f] === '') return fail(`Missing required field: ${f}`);
      if (!state.accounts.has(Number(b.account_id))) return fail('Client account not found');
      if (!paymentTypes.some((t) => t.id === Number(b.type))) return fail('Invalid payment type');
      if (!(Number(b.amount) > 0)) return fail('amount must be positive');
      state.paySeq += 1;
      state.payments.push({ payment_id: state.paySeq, account_id: Number(b.account_id), amount: Number(b.amount), type: Number(b.type), type_reference: b.type_reference || '', description: b.description, deposit: b.deposit ? 1 : 0, generated_when: b.generated_when || null });
      return ok({ payment_id: state.paySeq, receipt_id: 9000 + state.paySeq });
    },

    payments_list: (b) => ok(state.payments.filter((p) => !b.account_id || p.account_id === Number(b.account_id))),
  };

  function handle(req, res, raw) {
    const method = req.url.replace(/^\/rest\//, '').split('?')[0];
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, fail('Invalid JSON')); }
    state.requests.push({ method, body, headers: req.headers });
    if (hooks.failAll) return send(500, fail('Internal error'));
    const expected = `Basic ${Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64')}`;
    if (req.headers.authorization !== expected) return send(401, fail('Unauthorized'));
    if (body.api_key !== AUTH.api_key || body.region !== AUTH.region) return send(200, fail('Invalid api_key or region'));
    if (hooks.garbageNext > 0) { hooks.garbageNext -= 1; res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>Gateway hiccup</html>'); }
    if (hooks.hangNext > 0) { hooks.hangNext -= 1; return undefined; } // never answers
    if (hooks.throttleNext > 0) { hooks.throttleNext -= 1; return send(200, fail('Request limit exceeded: 100 requests per minute')); }
    if (!handlers[method]) return send(404, fail(`Unknown method ${method}`));
    return setTimeout(() => {
      const out = handlers[method](body);
      if (out.__http) return send(out.__http, fail('Internal error'));
      if (out.__hang) return undefined;
      return send(200, out);
    }, latencyMs);
  }

  return {
    state, hooks, AUTH,
    async start() {
      server = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => handle(req, res, raw)); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}/rest`;
    },
    stop: () => new Promise((r) => { if (!server) return r(); server.closeAllConnections?.(); return server.close(r); }),
    freeSites, cat, categories,
    // Direct state injection used by tests ("someone else booked it").
    inject({ site_id: categoryId, check_in: from, check_out: to, name = 'Other Guest', status = 'Confirmed' }) {
      const category = cat(categoryId);
      const free = freeSites(category, from, to);
      state.seq += 1;
      const rec = { booking_id: state.seq, guest_id: 1, booking_arrival: `${from} 14:00:00`, booking_departure: `${to} 10:00:00`, booking_status: status, adults: 2, animals: 0, booking_total: category.price * nights(from, to), site_internal_id: (free[0] || category.sites[0]).site_id, site_name: (free[0] || category.sites[0]).site_name, category_id: category.category_id, category_name: category.category_name, account_id: 7000 + state.seq, notes: 'injected', firstname: name.split(' ')[0], lastname: name.split(' ').slice(1).join(' ') || 'X', phone: '' };
      state.bookings.set(rec.booking_id, rec);
      state.accounts.set(rec.account_id, rec.booking_id);
      return String(rec.booking_id);
    },
  };
}

// Presents a fake server through the same inspection surface the mock NewBook client has
// (bookings Map, calls, failure hooks, direct createBooking/getAvailability) so the existing platform
// tests can run unchanged against the REST client.
function harnessFor(fake) {
  const statusOf = (s) => ({ Unconfirmed: 'provisional', Confirmed: 'confirmed', Cancelled: 'released' }[s] || String(s).toLowerCase());
  const view = (r) => ({
    booking_id: String(r.booking_id), site_id: r.category_id, site_name: r.category_name, check_in: r.booking_arrival.slice(0, 10), check_out: r.booking_departure.slice(0, 10),
    total: r.booking_total, status: statusOf(r.booking_status), source: /OnSite AI/.test(r.notes) ? 'onsite-ai' : null,
    guest: { name: `${r.firstname} ${r.lastname}`.trim() }, payments: fake.state.payments.filter((p) => p.account_id === r.account_id),
  });
  const bookings = {
    get size() { return fake.state.bookings.size; },
    get: (id) => { const r = fake.state.bookings.get(Number(id)); return r ? view(r) : undefined; },
    values: () => [...fake.state.bookings.values()].map(view)[Symbol.iterator](),
    [Symbol.iterator]: () => [...fake.state.bookings.entries()].map(([k, r]) => [String(k), view(r)])[Symbol.iterator](),
  };
  const nameOf = { bookings_create: 'createBooking', bookings_availability_pricing: 'getAvailability', bookings_update: 'updateBooking', bookings_get: 'getBooking', payments_create: 'postPayment' };
  return {
    kind: 'newbook-rest (fake server)',
    fake, bookings,
    get calls() { return fake.state.requests.map((r) => ({ method: nameOf[r.method] || r.method, raw: r.method })); },
    set loseCreateResponse(v) { fake.hooks.loseCreateResponse = !!v; },
    get loseCreateResponse() { return fake.hooks.loseCreateResponse; },
    set createFailWith(v) { fake.hooks.failCreate = !!v; },
    get createFailWith() { return fake.hooks.failCreate; },
    set allowOverlap(v) { fake.hooks.allowOverlap = !!v; },
    get allowOverlap() { return fake.hooks.allowOverlap; },
    set totalDelta(v) { fake.hooks.totalDelta = v; },
    get totalDelta() { return fake.hooks.totalDelta; },
    set failWith(v) { fake.hooks.failAll = !!v; },
    get failWith() { return fake.hooks.failAll; },
    async createBooking({ site_id: id, check_in: from, check_out: to, guest = {} }) { return { booking_id: fake.inject({ site_id: id, check_in: from, check_out: to, name: guest.name }) }; },
    async getAvailability(from, to) { return { sites: fake.categories.map((c) => ({ site_id: c.category_id, available: fake.freeSites(c, from, to).length > 0 })) }; },
  };
}

module.exports = { createFakeNewBook, harnessFor, categoriesFromSites, AUTH };
