#!/usr/bin/env node
'use strict';

// Run the NewBook REST client against a REAL NewBook instance (use the TEST endpoint/sandbox) and report which
// of our assumptions hold. Read-only by default. With --write it creates ONE unconfirmed test booking, finds
// it by our reference, posts a small payment, confirms, then cancels... only on a sandbox instance.
//
//   NEWBOOK_CREDS='{"username":"...","password":"...","api_key":"...","region":"au"}' \
//   node scripts/newbook-probe.js --park ./parks.json:friend-caravan-park [--write]
//
// Config (placeholder address, payment/cancel names, base_url) comes from the park entry's `newbook` block.
// Output is a checklist; every FAIL is something to settle with NewBook Support BEFORE going live.
const fs = require('fs');
const { createNewBookRestClient, validateRestConfig } = require('./../newbook-rest-client');
const D = require('./../dates');

const args = process.argv.slice(2);
const write = args.includes('--write');
const parkArg = args[args.indexOf('--park') + 1] || '';
const [file, parkId] = parkArg.split(':');
if (!file || !parkId || !process.env.NEWBOOK_CREDS) {
  console.error('Usage: NEWBOOK_CREDS=\'{"username","password","api_key","region"}\' node scripts/newbook-probe.js --park <parks.json>:<park-id> [--write]');
  process.exit(2);
}
const park = JSON.parse(fs.readFileSync(file, 'utf8')).find((p) => p.id === parkId);
if (!park || !park.newbook || park.newbook.type !== 'rest') { console.error(`Park ${parkId} has no newbook {type:"rest"} block`); process.exit(2); }
const creds = JSON.parse(process.env.NEWBOOK_CREDS);
const cfgErrors = validateRestConfig({ ...park.newbook, credentials_ref: 'probe' }, { forBooking: true });
const client = createNewBookRestClient({ parkName: park.name, timezone: park.timezone, config: park.newbook, getCredentials: async () => creds, logger: null });

let fails = 0;
const report = (ok, label, detail = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`); };
const attempt = async (label, fn) => { try { const v = await fn(); report(true, label); return v; } catch (e) { report(false, label, `${e.code || ''} ${e.message}`); return undefined; } };

(async () => {
  console.log(`NewBook probe for ${park.name} (${park.newbook.base_url || 'https://api.newbook.cloud/rest'}) ${write ? 'WRITE MODE' : 'read-only'}\n`);
  report(cfgErrors.length === 0, 'park newbook config is complete for AI booking', cfgErrors.join('; '));
  await attempt('auth_test (credentials, region, api_key accepted)', () => client.ping());
  const from = D.addDays(D.toISO(new Date()), 60);
  const to = D.addDays(from, 3);
  const av = await attempt(`bookings_availability_pricing + accommodation_categories_list map to sites (${from} to ${to})`, () => client.getAvailability(from, to));
  if (av) {
    console.log(`        ${av.sites.length} categories; ${av.total_available} available:`);
    for (const s of av.sites) console.log(`        - [${s.site_id}] ${s.name}: $${s.price}/night (stay $${s.stay_total}), guests<=${s.max_guests}, pets=${s.pet_friendly}, length=${s.vehicle_max_length}m, ${s.available ? 'AVAILABLE' : 'unavailable'}, amenities=${s.amenities.join(',') || 'none'}`);
    report(av.sites.length > 0, 'at least one category returned with metadata');
    report(av.sites.every((s) => s.max_guests > 0), 'every category has a capacity (category_max_combined or adults+children)', 'if FAIL: check which category_max_* fields your instance populates');
  }
  const pick = av && av.sites.find((s) => s.available);
  if (pick) {
    const q = await attempt(`quote for category ${pick.site_id} with 2 guests`, () => client.quote(pick.site_id, from, to, { guests: 2, animals: 0 }));
    if (q) console.log(`        quote total ${q.total} (the listing said ${pick.stay_total}; a difference just means rates depend on occupancy)`);
  }
  const ref = await attempt('configured cancellation reason and payment type exist in NewBook (bookings_cancellation_reasons, payment_types)', () => client.verifyReferenceData());
  if (ref) console.log(`        cancellation reason id ${ref.cancelReasonId}, payment type id ${ref.paymentTypeId}`);
  if (!write) {
    console.log('\nRead-only run. Re-run with --write on a SANDBOX to check booking create / find / pay / confirm / cancel.');
    console.log(`\n${fails ? `${fails} check(s) failed` : 'All checks passed'}`);
    process.exit(fails ? 1 : 0);
  }
  if (!pick) { report(false, 'write checks need an available category'); process.exit(1); }

  const key = `onsite-probe-${Date.now()}`;
  const booking = await attempt('bookings_create (Unconfirmed hold, placeholder address, our reference in notes)', () => client.createBooking({ idempotency_key: key, site_id: pick.site_id, check_in: from, check_out: to, guest: { name: 'Probe Test', mobile: '+61400000000', num_guests: 2, has_pet: false }, hold_expires_at: new Date(Date.now() + 3600000).toISOString(), source: 'onsite-probe' }));
  if (!booking) process.exit(1);
  report(booking.status === 'provisional', `hold status "${park.newbook.hold_status || 'Unconfirmed'}" maps to a hold`, `NewBook says: ${booking.status}`);
  report(Boolean(booking.account_id), 'create response includes the client account id (needed to post payments)');
  const found = await attempt('findBookingByKey locates the booking from its notes (lost-response recovery)', () => client.findBookingByKey(key, { check_in: from, check_out: to }));
  report(Boolean(found && found.booking_id === booking.booking_id), 'findBookingByKey returned THIS booking', 'if FAIL: bookings_list search/notes do not surface our key; recovery from a lost response would hand off to staff instead');
  const avDuring = await client.getAvailability(from, to);
  const same = avDuring.sites.find((s) => s.site_id === pick.site_id);
  console.log(`        availability for the held category during the hold: ${same.available ? 'STILL AVAILABLE (another site free, or holds do not block)' : 'unavailable'}`);
  await attempt('payments_create posts a small payment to the booking account (idempotent by our reference) and confirms', () => client.confirmBooking(booking.booking_id, { payment: { id: `probe-${Date.now()}`, amount_cents: 100, currency: 'AUD' } }));
  const after = await client.getBooking(booking.booking_id);
  report(after && after.status === 'confirmed', 'booking is Confirmed after confirmBooking', `status: ${after && after.status}`);
  console.log('\nCLEAN UP: this probe left a confirmed test booking and a $1.00 payment in the sandbox. Void/cancel them in NewBook.');
  console.log(`  booking_id ${booking.booking_id}, reference ${key}`);
  console.log(`\n${fails ? `${fails} check(s) failed` : 'All checks passed'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
