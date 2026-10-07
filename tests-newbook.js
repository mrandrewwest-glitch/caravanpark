'use strict';

// NewBook REST client tests, against a fake NewBook server built from the public docs and, for edge cases,
// a stubbed fetch. These prove the client follows the documented protocol and keeps its safety properties
// (idempotent payment posting, never cancelling a paid booking, never blindly retrying writes). They do NOT
// prove the real NewBook behaves like the fake: run scripts/newbook-probe.js against a sandbox for that.
// Usage: node tests-newbook.js [protocol|mapping|bookings|config|all]
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
const { createNewBookRestClient, NewBookError, validateRestConfig, bestTariff, mapStatus, splitName, amenitiesFrom, DEFAULTS } = require('./newbook-rest-client');
const { createFakeNewBook, categoriesFromSites, AUTH } = require('./test-newbook-server');
const { MOCK_SITES } = require('./newbook-client');
const { makeChecker } = require('./test-helpers');
const { createApp } = require('./index');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ADDRESS = { street: '1 Park Road', city: 'Testville', postcode: '2000', state: 'NSW' };
const baseCfg = (url, extra = {}) => ({ base_url: url, placeholder_address: ADDRESS, payment_type_name: 'Credit Card', cancel_reason_name: 'Unpaid hold', read_timeout_ms: 300, write_timeout_ms: 500, ...extra });

async function setup(cfgExtra = {}, opts = {}) {
  const fake = createFakeNewBook({ categories: categoriesFromSites(MOCK_SITES), latencyMs: 2 });
  const url = await fake.start();
  const client = createNewBookRestClient({ parkName: 'Test Park', config: baseCfg(url, cfgExtra), getCredentials: async () => AUTH, ...opts });
  return { fake, client, url, stop: () => fake.stop() };
}
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };
const GUEST = { name: 'Sam Taylor', mobile: '+61412345678', num_guests: 4, has_pet: true, vehicle_type: 'caravan' };
const mk = (client, extra = {}) => client.createBooking({ idempotency_key: 'k1', site_id: 12, check_in: '2026-10-10', check_out: '2026-10-15', guest: GUEST, hold_expires_at: '2026-10-01T00:45:00Z', source: 'onsite-ai', ...extra });

// A client whose HTTP layer returns canned bodies (for shapes the fake doesn't produce).
function stubbed(byMethod, cfgExtra = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    sent.push({ method, body: JSON.parse(init.body) });
    const out = byMethod[method];
    const body = typeof out === 'function' ? out(JSON.parse(init.body)) : out;
    return { status: 200, json: async () => ({ success: 'true', data: body, message: '' }) };
  };
  return { sent, client: createNewBookRestClient({ parkName: 'P', config: baseCfg('http://x/rest', cfgExtra), getCredentials: async () => AUTH, fetchImpl }) };
}

const suites = {
  protocol: {
    name: 'Protocol: URL, auth, envelope, errors, timeouts, retries, rate limit',
    async run({ check }) {
      let t = await setup();
      await t.client.ping();
      const r = t.fake.state.requests[0];
      check('POSTs to <base>/auth_test with HTTP Basic auth and region + api_key in the JSON body', r.method === 'auth_test' && r.headers.authorization === `Basic ${Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64')}` && r.body.region === 'au' && r.body.api_key === AUTH.api_key && r.headers['content-type'].includes('json'));
      const av = await t.client.getAvailability('2026-10-10', '2026-10-15');
      check('success:"true" string envelope is understood and data returned', av.sites.length === 5);
      await t.stop();

      t = await setup();
      const bad = createNewBookRestClient({ parkName: 'P', config: baseCfg(t.url), getCredentials: async () => ({ ...AUTH, password: 'wrong' }) });
      let e = await err(bad.ping());
      check('wrong password (HTTP 401) -> AUTH error, not retried', e && e.code === 'AUTH' && t.fake.state.requests.length === 1);
      const badKey = createNewBookRestClient({ parkName: 'P', config: baseCfg(t.url), getCredentials: async () => ({ ...AUTH, api_key: 'nope' }) });
      e = await err(badKey.ping());
      check('wrong api_key (success:"false") -> AUTH error', e && e.code === 'AUTH');
      await t.stop();

      t = await setup();
      t.fake.hooks.throttleNext = 1;
      await t.client.ping();
      check('a throttled READ is retried once and succeeds', t.fake.state.requests.filter((x) => x.method === 'auth_test').length === 2);
      t.fake.state.requests.length = 0;
      t.fake.hooks.throttleNext = 1;
      e = await err(mk(t.client));
      check('a throttled WRITE is not retried (THROTTLED, outcome known: not applied)', e && e.code === 'THROTTLED' && e.outcomeUnknown === false && t.fake.state.requests.filter((x) => x.method === 'bookings_create').length === 1 && t.fake.state.bookings.size === 0);
      await t.stop();

      t = await setup();
      t.fake.hooks.hangNext = 1;
      const started = Date.now();
      e = await err(t.client.ping());
      check('a hung READ times out at the read budget (TIMEOUT) and is not retried', e && e.code === 'TIMEOUT' && Date.now() - started < 1000 && t.fake.state.requests.filter((x) => x.method === 'auth_test').length === 1);
      t.fake.hooks.hangNext = 1;
      e = await err(mk(t.client, { idempotency_key: 'k-hang' }));
      check('a hung WRITE times out with outcomeUnknown=true (it may have been applied)', e && e.code === 'TIMEOUT' && e.outcomeUnknown === true);
      await t.stop();

      t = await setup();
      t.fake.hooks.failCreate = true;
      e = await err(mk(t.client));
      check('HTTP 500 on a write -> SERVER_ERROR, outcomeUnknown=true, sent exactly once', e && e.code === 'SERVER_ERROR' && e.outcomeUnknown === true && t.fake.state.requests.filter((x) => x.method === 'bookings_create').length === 1);
      t.fake.hooks.failCreate = false;
      t.fake.hooks.failAll = true;
      e = await err(t.client.ping());
      check('HTTP 500 on a read is retried once then reported', e && e.code === 'SERVER_ERROR' && t.fake.state.requests.filter((x) => x.method === 'auth_test').length === 2);
      t.fake.hooks.failAll = false;
      t.fake.hooks.garbageNext = 1;
      e = await err(mk(t.client, { idempotency_key: 'k-garbage' }));
      check('an unreadable reply to a write -> INVALID_RESPONSE with outcomeUnknown=true', e && e.code === 'INVALID_RESPONSE' && e.outcomeUnknown === true);
      await t.stop();

      t = await setup({ max_per_minute: 3 });
      await t.client.ping(); await t.client.ping(); await t.client.ping();
      const before = t.fake.state.requests.length;
      e = await err(t.client.ping());
      check('client-side limiter stops at max_per_minute without hitting NewBook (100/min limit)', e && e.code === 'THROTTLED' && t.fake.state.requests.length === before);
      await t.stop();

      // Secrets must not leak into logs.
      const lines = [];
      const logger = { info: (m, f) => lines.push(JSON.stringify([m, f])), warn: (m, f) => lines.push(JSON.stringify([m, f])), error: (m, f) => lines.push(JSON.stringify([m, f])), debug() {} };
      t = await setup({}, { logger });
      t.fake.hooks.throttleNext = 1;
      await t.client.getAvailability('2026-10-10', '2026-10-15');
      await mk(t.client);
      check('credentials (password, api_key) never appear in logs', !lines.join('\n').includes(AUTH.password) && !lines.join('\n').includes(AUTH.api_key));
      await t.stop();
    },
  },

  mapping: {
    name: 'Mapping NewBook categories/tariffs/statuses to OnSite sites',
    async run({ check }) {
      let t = await setup();
      const av = await t.client.getAvailability('2026-10-10', '2026-10-15');
      const s12 = av.sites.find((s) => s.site_id === 12);
      check('category -> site: id, name, nightly price from tariff_total / nights', s12.name === 'Site 12 - Large Family' && s12.price === 185 && s12.stay_total === 925);
      check('capacity, pets, size and amenities are derived from category data', s12.max_guests === 6 && s12.pet_friendly === true && s12.vehicle_max_length === 9.5 && JSON.stringify(s12.amenities) === '["power","water","wifi","playground_nearby","bbq"]');
      check('a category that does not allow animals is not pet friendly', av.sites.find((s) => s.site_id === 15).pet_friendly === false);
      const q = await t.client.quote(12, '2026-10-10', '2026-10-15', { guests: 4, animals: 1 });
      const sent = t.fake.state.requests.filter((x) => x.method === 'bookings_availability_pricing').at(-1).body;
      check('quote sends this party\'s occupancy (adults, animals) and the category', sent.adults === 4 && sent.animals === 1 && sent.category_id === 12);
      check('quote returns nights, nightly rate and the NewBook total', q.total === 925 && q.nights === 5 && q.nightly === 185);
      t.fake.inject({ site_id: 12, check_in: '2026-10-11', check_out: '2026-10-12' });
      const av2 = await t.client.getAvailability('2026-10-10', '2026-10-15');
      check('a fully booked category is marked unavailable; others stay available', av2.sites.find((s) => s.site_id === 12).available === false && av2.total_available === 4);
      const e = await err(t.client.quote(12, '2026-10-10', '2026-10-15'));
      check('quote for a category with no free site -> SITE_UNAVAILABLE', e && e.code === 'SITE_UNAVAILABLE');
      await t.stop();

      // Edge cases with canned bodies.
      const cats = [{ category_id: 1, category_name: 'Cabin', category_max_adults: 2, category_max_children: 2, category_max_combined: 0, category_max_animals: 0, features: [{ feature_name: 'Air-Con' }, { feature_name: 'Mountain view' }], sites: [{ site_size: { length: 30, unit: 'ft' } }, { site_size: { length: 6, unit: 'm' } }] }];
      const { client, sent: reqs } = stubbed({
        accommodation_categories_list: cats,
        bookings_availability_pricing: [
          { category_id: 1, category_name: 'Cabin', sites_available: 2, tariffs_available: [{ tariff_label: 'Bad', tariff_success: 'false', tariff_total: 1 }, { tariff_label: 'Dear', tariff_success: 'true', tariff_total: '500.00' }, { tariff_label: 'Cheap', tariff_success: 'true', tariff_total: '400.00' }] },
          { category_id: 99, category_name: 'Mystery', sites_available: 3, tariffs_available: [{ tariff_label: 'X', tariff_success: 'true', tariff_total: 100 }] },
        ],
      });
      const out = await client.getAvailability('2026-10-10', '2026-10-14');
      check('the cheapest SUCCESSFUL tariff is used (failed tariffs ignored), strings parsed to numbers', out.sites[0].stay_total === 400 && out.sites[0].price === 100 && out.sites[0].tariff_label === 'Cheap');
      check('capacity falls back to adults + children when no combined limit; unknown features are slugged; ft converted to m (largest site)', out.sites[0].max_guests === 4 && JSON.stringify(out.sites[0].amenities) === '["air_con","mountain_view"]' && out.sites[0].vehicle_max_length === 9.14);
      check('a category with no metadata is never offered (pets/size unknown)', out.sites.length === 1 && !out.sites.some((s) => s.site_id === 99));
      await client.getAvailability('2026-10-10', '2026-10-14');
      check('category metadata is cached (one accommodation_categories_list call)', reqs.filter((r) => r.method === 'accommodation_categories_list').length === 1);

      const warmFake = await setup();
      await warmFake.client.warm();
      await warmFake.client.getAvailability('2026-10-10', '2026-10-15');
      check('warm() fills the category cache so the first availability call does not fetch it', warmFake.fake.state.requests.filter((x) => x.method === 'accommodation_categories_list').length === 1);
      await warmFake.stop();
      check('bestTariff returns null when nothing is bookable', bestTariff({ tariffs_available: [{ tariff_success: 'false', tariff_total: 5 }] }) === null);
      check('statuses map to OnSite statuses', mapStatus('Unconfirmed', DEFAULTS) === 'provisional' && mapStatus('Confirmed', DEFAULTS) === 'confirmed' && mapStatus('Cancelled', DEFAULTS) === 'released' && mapStatus('Arrived', DEFAULTS) === 'confirmed');
      check('names split into first/last; single names get a placeholder surname', JSON.stringify(splitName('Sam Taylor')) === '{"first":"Sam","last":"Taylor"}' && JSON.stringify(splitName('Mary Jane Watson')) === '{"first":"Mary","last":"Jane Watson"}' && splitName('Cher').last === '(phone booking)' && splitName('').first === 'Guest');
      check('amenity mapping handles NewBook feature names', JSON.stringify(amenitiesFrom([{ feature_name: 'Electric power' }, { feature_name: 'Wi-Fi' }, { feature_name: 'Barbecue' }], DEFAULTS.amenity_map)) === '["power","wifi","bbq"]');
    },
  },

  bookings: {
    name: 'Bookings: create, find, confirm + payment, release',
    async run({ check }) {
      let t = await setup();
      const b = await mk(t.client);
      const body = t.fake.state.requests.find((x) => x.method === 'bookings_create').body;
      check('bookings_create sends every documented required field (guest name, placeholder address, phone, category, dates)', body.guest_firstname === 'Sam' && body.guest_lastname === 'Taylor' && body.address_street && body.address_city && body.address_postcode && body.guest_phone === '+61412345678' && body.category_id === 12 && body.period_from === '2026-10-10' && body.period_to === '2026-10-15');
      check('the hold is created as Unconfirmed, with occupancy, and our reference + expiry in the notes', body.status === 'Unconfirmed' && body.adults === 4 && body.animals === 1 && body.notes.includes('Ref: k1') && body.notes.includes('2026-10-01T00:45:00Z') && /placeholder/i.test(body.notes));
      check('result is mapped: id as string, provisional status, NewBook total, account id', b.booking_id === '5001' && b.status === 'provisional' && b.total === 925 && b.account_id && b.site_id === 12);

      check('findBookingByKey finds the booking from our reference in its notes', (await t.client.findBookingByKey('k1', { check_in: '2026-10-10', check_out: '2026-10-15' })).booking_id === b.booking_id);
      check('findBookingByKey returns null for an unknown key', (await t.client.findBookingByKey('nope', { check_in: '2026-10-10', check_out: '2026-10-15' })) === null);
      const e = await err(mk(t.client, { idempotency_key: 'k2' }));
      check('a second create for the same category/dates when it is full -> SITE_UNAVAILABLE', e && e.code === 'SITE_UNAVAILABLE');
      const one = await mk(t.client, { idempotency_key: 'k3', site_id: 15, guest: { ...GUEST, name: 'Cher', has_pet: false } });
      check('a one-word name is accepted (placeholder surname)', one.booking_id && t.fake.state.requests.filter((x) => x.method === 'bookings_create').at(-1).body.guest_lastname === '(phone booking)');
      check('getBooking maps an unknown booking to null', (await t.client.getBooking('99999')) === null);
      await t.stop();

      // Confirm + payment
      t = await setup();
      const hold = await mk(t.client);
      const pay = { id: 'pay_1', amount_cents: 92500, currency: 'AUD' };
      const confirmed = await t.client.confirmBooking(hold.booking_id, { payment: pay });
      const p = t.fake.state.payments[0];
      check('payment is posted to the booking\'s client ACCOUNT with our payment id as type_reference, Credit Card type, full amount (not a deposit)', t.fake.state.payments.length === 1 && p.account_id === Number(hold.account_id) && p.type_reference === 'pay_1' && p.type === 3 && p.amount === 925 && p.deposit === 0);
      check('booking is then set to Confirmed', confirmed.status === 'confirmed' && t.fake.state.bookings.get(Number(hold.booking_id)).booking_status === 'Confirmed');
      await t.client.confirmBooking(hold.booking_id, { payment: pay });
      check('confirming again does not post the payment twice', t.fake.state.payments.length === 1);

      const hold2 = await mk(t.client, { idempotency_key: 'k5', site_id: 5 });
      t.fake.hooks.failUpdateNext = 1;
      const partial = await err(t.client.confirmBooking(hold2.booking_id, { payment: { id: 'pay_2', amount_cents: 125000, currency: 'AUD' } }));
      check('if the status update fails AFTER the payment was posted, the error surfaces (provider will retry)', partial && partial.code === 'SERVER_ERROR' && t.fake.state.payments.length === 2);
      await t.client.confirmBooking(hold2.booking_id, { payment: { id: 'pay_2', amount_cents: 125000, currency: 'AUD' } });
      check('the retry does NOT double-post the payment and finishes the confirmation', t.fake.state.payments.length === 2 && t.fake.state.bookings.get(Number(hold2.booking_id)).booking_status === 'Confirmed');

      const hold3 = await mk(t.client, { idempotency_key: 'k6', site_id: 8 });
      await t.client.confirmBooking(hold3.booking_id, { payment: { id: 'pay_3', amount_cents: 20000, currency: 'AUD' } });
      check('a part-payment is flagged as a deposit', t.fake.state.payments.at(-1).deposit === 1 && t.fake.state.payments.at(-1).amount === 200);

      const hold4 = await mk(t.client, { idempotency_key: 'k7', site_id: 20 });
      await t.client.releaseBooking(hold4.booking_id, 'test');
      const before = t.fake.state.payments.length;
      const late = await err(t.client.confirmBooking(hold4.booking_id, { payment: { id: 'pay_4', amount_cents: 9000, currency: 'AUD' } }));
      check('confirming a CANCELLED booking is refused (BOOKING_RELEASED) and posts no payment', late && late.code === 'BOOKING_RELEASED' && t.fake.state.payments.length === before);
      await t.stop();

      // Release
      t = await setup();
      const h = await mk(t.client);
      const released = await t.client.releaseBooking(h.booking_id, 'hold expired');
      const upd = t.fake.state.requests.filter((x) => x.method === 'bookings_update').at(-1).body;
      check('release cancels an unpaid hold with the configured cancellation reason id (looked up by name)', released.status === 'released' && t.fake.state.bookings.get(Number(h.booking_id)).booking_status === 'Cancelled' && upd.status === 'Cancelled' && upd.booking_cancelled_reason_id === 2);
      check('release does not send notes (they could overwrite our reference)', upd.notes === undefined);
      const h2 = await mk(t.client, { idempotency_key: 'k9', site_id: 15, guest: { ...GUEST, has_pet: false } });
      await t.client.confirmBooking(h2.booking_id, {});
      const kept = await t.client.releaseBooking(h2.booking_id, 'should not happen');
      check('release NEVER cancels a booking that is no longer a hold (confirmed stays confirmed)', kept.status === 'confirmed' && t.fake.state.bookings.get(Number(h2.booking_id)).booking_status === 'Confirmed');
      const gone = await err(t.client.releaseBooking('424242', 'x'));
      check('releasing an unknown booking -> NOT_FOUND', gone && gone.code === 'NOT_FOUND');
      await t.stop();

      t = await setup({ cancel_reason_name: 'No such reason' });
      const h3 = await mk(t.client);
      const cfgErr = await err(t.client.releaseBooking(h3.booking_id, 'x'));
      check('a cancellation reason name that does not exist -> CONFIG error (and the booking is left alone)', cfgErr && cfgErr.code === 'CONFIG' && t.fake.state.bookings.get(Number(h3.booking_id)).booking_status === 'Unconfirmed');
      await t.stop();

      t = await setup({ payment_type_name: 'Bitcoin' });
      const h4 = await mk(t.client);
      const ptErr = await err(t.client.confirmBooking(h4.booking_id, { payment: { id: 'p', amount_cents: 100, currency: 'AUD' } }));
      check('an unknown payment type name -> CONFIG error, nothing posted, booking not confirmed', ptErr && ptErr.code === 'CONFIG' && t.fake.state.payments.length === 0 && t.fake.state.bookings.get(Number(h4.booking_id)).booking_status === 'Unconfirmed');
      await t.stop();
    },
  },

  config: {
    name: 'Configuration, validation and startup refusal',
    async run({ check }) {
      const complete = { credentials_ref: 'env:X', placeholder_address: ADDRESS, payment_type_name: 'Credit Card', cancel_reason_name: 'Unpaid hold' };
      check('a complete AI-booking config validates', validateRestConfig(complete).length === 0);
      const errs = validateRestConfig({ credentials_ref: 'env:X' });
      check('missing placeholder address, payment type and cancellation reason are all reported for AI booking', errs.length === 3 && errs.some((e) => /placeholder_address/.test(e)) && errs.some((e) => /payment_type/.test(e)) && errs.some((e) => /cancel/.test(e)));
      check('a handoff-only park needs only credentials', validateRestConfig({ credentials_ref: 'env:X' }, { forBooking: false }).length === 0 && validateRestConfig({}, { forBooking: false }).length === 1);
      check('unit_mode must be category or site', validateRestConfig({ ...complete, unit_mode: 'room' }).some((e) => /unit_mode/.test(e)));

      const parks = [{ id: 'real-park', name: 'Real Park', numbers: ['+61290000009'], mode: 'full', booking_mode: 'ai_booking', newbook: { type: 'rest', credentials_ref: 'env:X' } }];
      const app = createApp({ parks });
      const e = await err(app.deps.validateProviders());
      check('the app refuses to start a real-NewBook AI-booking park with an incomplete config', e && /real-park/.test(e.message) && /placeholder_address/.test(e.message));
      const ok = createApp({ parks: [{ ...parks[0], newbook: { type: 'rest', ...complete } }] });
      check('and starts when the config is complete', (await err(ok.deps.validateProviders())) === null);
      const mockOnly = createApp({ parks: [{ id: 'm', name: 'M', numbers: ['+61290000008'], booking_mode: 'ai_booking' }] });
      check('mock-NewBook parks are not subject to REST validation', (await err(mockOnly.deps.validateProviders())) === null);

      const t = await setup();
      const noCreds = createNewBookRestClient({ parkName: 'P', config: baseCfg(t.url), getCredentials: async () => { throw Object.assign(new Error('Environment variable NOPE is not set'), { code: 'CONFIG' }); } });
      const ce = await err(noCreds.ping());
      check('missing credentials surface as a CONFIG error (and nothing is sent)', ce && ce.code === 'CONFIG' && t.fake.state.requests.length === 0);
      const noAddr = createNewBookRestClient({ parkName: 'P', config: baseCfg(t.url, { placeholder_address: null }), getCredentials: async () => AUTH });
      const ae = await err(mk(noAddr));
      check('creating a booking without a placeholder address is refused before any request', ae && ae.code === 'CONFIG' && t.fake.state.requests.length === 0);
      const hostile = createNewBookRestClient({ parkName: 'P', config: baseCfg(t.url), getCredentials: async () => AUTH });
      const inj = await hostile.createBooking({ idempotency_key: 'k-inj', site_id: 12, check_in: '2026-11-10', check_out: '2026-11-12', guest: { name: 'Robert"); DROP TABLE--', mobile: '+61400000000', num_guests: 2, has_pet: false } });
      check('hostile caller-supplied names travel as plain JSON data (no breakage)', inj.booking_id && t.fake.state.bookings.get(Number(inj.booking_id)).firstname === 'Robert");');
      await t.stop();
      check('NewBookError carries code, method and outcomeUnknown', new NewBookError('x', { code: 'TIMEOUT', method: 'm', outcomeUnknown: true }).outcomeUnknown === true);
    },
  },

  probe: {
    name: 'scripts/newbook-probe.js runs end to end (against the fake server)',
    async run({ check }) {
      const t = await setup();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
      const file = path.join(dir, 'parks.json');
      fs.writeFileSync(file, JSON.stringify([{ id: 'probe-park', name: 'Probe Park', timezone: 'Australia/Sydney', newbook: { type: 'rest', base_url: t.url, placeholder_address: ADDRESS, payment_type_name: 'Credit Card', cancel_reason_name: 'Unpaid hold' } }]));
      const run = (extra) => new Promise((resolve) => {
        const child = spawn(process.execPath, ['scripts/newbook-probe.js', '--park', `${file}:probe-park`, ...extra], { env: { ...process.env, NEWBOOK_CREDS: JSON.stringify(AUTH) } });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        child.on('close', (code) => resolve({ code, out }));
      });
      const ro = await run([]);
      check('read-only probe passes and makes no writes', ro.code === 0 && !/^FAIL /m.test(ro.out) && t.fake.state.bookings.size === 0 && t.fake.state.payments.length === 0);
      const rw = await run(['--write']);
      check('--write probe creates, finds, pays, confirms and tells you what to clean up', rw.code === 0 && !/^FAIL /m.test(rw.out) && /CLEAN UP/.test(rw.out) && t.fake.state.bookings.size === 1 && t.fake.state.payments.length === 1);
      t.fake.hooks.failAll = true;
      const bad = await run([]);
      check('a failing instance makes the probe exit non-zero and say what failed', bad.code !== 0 && /^FAIL /m.test(bad.out));
      const none = await run(['--park', 'x']);
      void none;
      await t.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  },
};

async function main() {
  const arg = process.argv[2] || 'all';
  const keys = arg === 'all' ? Object.keys(suites) : [arg];
  if (keys.some((k) => !suites[k])) { console.error(`Unknown suite "${arg}". Use ${Object.keys(suites).join(', ')} or all.`); process.exit(2); }
  console.log('OnSite NewBook REST client tests | fake NewBook server built from the public docs (not the real NewBook)');
  const all = [];
  for (const k of keys) {
    const s = suites[k];
    console.log(`\n==================== ${s.name} ====================`);
    const { check, results } = makeChecker();
    try { await s.run({ check }); } catch (e) { console.error(e); check(`suite threw: ${e.message}`, false); }
    const pass = results.every((r) => r.ok);
    console.log(`\n>>> ${k}: ${pass ? 'PASS' : 'FAIL'} (${results.filter((r) => r.ok).length}/${results.length} checks)`);
    all.push({ name: k, pass });
  }
  console.log('\n==================== SUMMARY ====================');
  for (const a of all) console.log(`${a.pass ? 'PASS' : 'FAIL'}  ${a.name}`);
  process.exit(all.every((a) => a.pass) ? 0 : 1);
}

main();
