'use strict';

// Platform tests: AI booking flow, SMS payment links, hold expiry, take-a-message,
// multi-park routing, billing ledger, resilience. All providers are mocks; no network.
// Usage: node tests-platform.js <booking|holds|payments|safety|messages|parks|billing|resilience|all>

const { start, makeChecker, makeClock, NUMBERS, STORE_NAME, NEWBOOK_NAME } = require('./test-helpers');
const { createClaudeClient } = require('./claude-client');
const { newDynamoStore } = require('./test-dynamo');
const { createMockNewBookClient } = require('./newbook-client');
const { createMockSmsProvider } = require('./sms-provider');
const { createMockPaymentProvider } = require('./payment-provider');
const { createMockNotifier } = require('./notifier');

const PHONE = '+61412345678';
const MONTH = '2026-09';
const MIN = 60000;

async function say(env, sid, text, { phone = PHONE, called = NUMBERS.lakeside, path = '/phone-callback', confidence = 0.95 } = {}) {
  const r = await env.post(path, { call_sid: sid, transcript: text, caller_phone: phone, called_number: called, confidence });
  const tag = r.body.transfer_to_human ? '  [LIVE TRANSFER]' : r.body.handoff && r.body.handoff.strategy === 'take_message' ? '  [TAKE MESSAGE]' : '';
  console.log(`    caller: "${text}"\n    ai:     "${r.body.response_text}"${tag}`);
  return r;
}

// Full happy-path booking conversation. Returns every turn's response.
async function book(env, { sid, called = NUMBERS.lakeside, phone = PHONE, site = 12, dates = 'Oct 10 to 15', guests = '4 of us', name = 'Sam Taylor', stopBefore = null } = {}) {
  const o = { phone, called };
  const turns = [
    `Hi, any sites ${dates} for ${guests} with a dog?`, `Site ${site} please`, name, 'Yes', 'Yes, go ahead',
  ];
  const out = [];
  for (const [i, t] of turns.entries()) {
    if (stopBefore === i) break;
    out.push(await say(env, sid, t, o));
  }
  return out;
}

const payLink = async (env, parkId, i = -1) => { const p = await env.pay(parkId); return p.links.at(i); };
const sendPayment = async (env, parkId, link, opts) => {
  const p = await env.pay(parkId);
  const { raw, headers } = p.simulatePayment(link, opts);
  return env.post('/payment-webhook', raw, headers);
};
const record = (env, parkId, ref) => env.deps.store.get(`bookings:${parkId}:${ref}`);
const alertKinds = (env) => env.notifier.alerts.map((a) => a.kind);

const suites = {
  booking: {
    name: 'AI booking: availability -> read-back -> held booking -> SMS payment link -> paid -> confirmed',
    async run({ check }) {
      const env = await start();
      const nb = await env.nb('lakeside');
      const r = await book(env, { sid: 'bk1' });
      check('availability reply ends by asking which site to book', /which one would you like me to book/i.test(r[0].body.response_text));
      check('asks for the name after the site is chosen', /what name/i.test(r[1].body.response_text));
      check('asks to use the caller ID number for the payment link', /ending 6 7 8/.test(r[2].body.response_text));
      check('read-back has site, total from NewBook ($925), name and hold time (45 min)', /Site 12/.test(r[3].body.response_text) && /\$925/.test(r[3].body.response_text) && /Sam Taylor/.test(r[3].body.response_text) && /45 minutes/.test(r[3].body.response_text));
      check('read-back turn creates nothing; createBooking is called exactly once overall', nb.calls.filter((c) => c.method === 'createBooking').length === 1 && r[3].body.booking === undefined);
      const created = r[4].body.booking;
      check('booking created once as provisional, with a ref', created && created.status === 'held' && nb.bookings.size === 1 && nb.bookings.get(created.ref).status === 'provisional');
      check('NewBook booking is tagged as AI-created with the guest details', nb.bookings.get(created.ref).source === 'onsite-ai' && nb.bookings.get(created.ref).guest.name === 'Sam Taylor');
      const link = await payLink(env, 'lakeside');
      check('payment link created for the NewBook total ($925 = 92500 cents)', link.amount_cents === 92500 && link.booking_ref === created.ref);
      const sms = env.sms.sent.filter((s) => s.kind === 'payment_link');
      check('payment link texted to the caller from the park number', sms.length === 1 && sms[0].to === PHONE && sms[0].from === NUMBERS.lakeside && sms[0].body.includes(link.url));
      check('staff alerted that an AI booking is held', alertKinds(env).includes('ai_booking_held'));
      check('card details never requested (no card wording in any reply)', r.every((x) => !/card number|expiry|cvv/i.test(x.body.response_text)));

      const again = await say(env, 'bk1', 'Yes');
      check('a repeated "yes" cannot create a second booking', nb.bookings.size === 1 && /all set/i.test(again.body.response_text));

      const paid = await sendPayment(env, 'lakeside', link);
      check('payment webhook confirms the booking in NewBook and records the payment', paid.body.result === 'confirmed' && nb.bookings.get(created.ref).status === 'confirmed' && nb.bookings.get(created.ref).payments.length === 1);
      check('confirmation SMS sent', env.sms.sent.some((s) => s.kind === 'booking_confirmation' && s.to === PHONE && s.body.includes(created.ref)));
      const dup = await sendPayment(env, 'lakeside', link);
      check('duplicate webhook is ignored (no second confirmation or payment)', dup.body.duplicate === true && env.sms.sent.filter((s) => s.kind === 'booking_confirmation').length === 1 && nb.bookings.get(created.ref).payments.length === 1);
      const rec = await record(env, 'lakeside', created.ref);
      check('internal record is confirmed', rec.status === 'confirmed');
      await env.close();
    },
  },

  holds: {
    name: 'Hold expiry: per-park and adjustable, reminder, release, idempotent job',
    async run({ check }) {
      const env = await start();
      const nbLake = await env.nb('lakeside');
      const nbRiver = await env.nb('riverbend');
      const a = await book(env, { sid: 'h1' });
      const b = await book(env, { sid: 'h2', called: NUMBERS.riverbend, site: 1, dates: 'Oct 10 to 15' });
      const t0 = env.clock.t;
      const lake = await record(env, 'lakeside', a[4].body.booking.ref);
      const river = await record(env, 'riverbend', b[4].body.booking.ref);
      check('lakeside holds for its configured 45 minutes', lake.hold_expires_ms === t0 + 45 * MIN);
      check('riverbend holds for its configured 120 minutes', river.hold_expires_ms === t0 + 120 * MIN);
      check('read-back to the caller states the park-specific hold', /45 minutes/.test(a[3].body.response_text) && /2 hours/.test(b[3].body.response_text));

      env.clock.advance(25 * MIN);
      let run = (await env.admin('POST', '/jobs/run')).body;
      check('reminder SMS goes out at half-time for the 45 min hold only', run.holds.reminded.length === 1 && env.sms.sent.filter((s) => s.kind === 'hold_reminder').length === 1);
      env.clock.advance(25 * MIN);
      run = (await env.admin('POST', '/jobs/run')).body;
      check('expired hold is released in NewBook and the caller is told', run.holds.released.length === 1 && nbLake.bookings.get(lake.booking_ref).status === 'released' && env.sms.sent.some((s) => s.kind === 'hold_expired'));
      check('released site is bookable again', (await nbLake.getAvailability('2026-10-10', '2026-10-15')).sites.find((s) => s.site_id === 12).available === true);
      check('the 120 minute hold is untouched', nbRiver.bookings.get(river.booking_ref).status === 'provisional');
      await env.admin('POST', '/jobs/run');
      check('running the job again does not re-release or re-text', env.sms.sent.filter((s) => s.kind === 'hold_expired').length === 1);

      const patch = await env.admin('PATCH', '/parks/lakeside/settings', { hold_minutes: 90 });
      check('park can change its hold time (applies to new holds)', patch.status === 200 && patch.body.hold_minutes === 90);
      check('another park is unaffected', (await env.admin('GET', '/parks/riverbend')).body.hold_minutes === 120);
      check('hold time outside 15..1440 minutes is rejected', (await env.admin('PATCH', '/parks/lakeside/settings', { hold_minutes: 5 })).status === 400);
      check('non-adjustable settings (e.g. billing) are rejected', (await env.admin('PATCH', '/parks/lakeside/settings', { billing: { per_call: 0 } })).status === 400);
      check('admin API requires the token', (await env.post('/admin/jobs/run', {})).status === 401 && (await env.request('PATCH', '/admin/parks/lakeside/settings', { hold_minutes: 30 })).status === 401);
      check('admin never echoes payment credentials', !JSON.stringify((await env.admin('GET', '/parks/lakeside')).body).includes('whsec'));
      const c = await book(env, { sid: 'h3', dates: 'Nov 3 to 6' });
      const rec3 = await record(env, 'lakeside', c[4].body.booking.ref);
      check('a new booking uses the new 90 minute hold', rec3.hold_expires_ms === env.clock.t + 90 * MIN && /90 minutes/.test(c[3].body.response_text));
      await env.close();
    },
  },

  payments: {
    name: 'Payment webhook: signature, amounts, unknown bookings, late payments',
    async run({ check }) {
      const env = await start();
      const nb = await env.nb('lakeside');
      const a = await book(env, { sid: 'p1' });
      const ref = a[4].body.booking.ref;
      const link = await payLink(env, 'lakeside');
      const lake = await env.pay('lakeside');
      const river = await env.pay('riverbend');

      const forged = lake.simulatePayment(link);
      check('bad signature -> 401, booking stays held', (await env.post('/payment-webhook', forged.raw, { ...forged.headers, 'x-onsite-signature': 'deadbeef' })).status === 401 && (await record(env, 'lakeside', ref)).status === 'held');
      const tampered = forged.raw.replace('92500', '100');
      check('tampered body with a valid old signature -> 401', (await env.post('/payment-webhook', tampered, forged.headers)).status === 401);
      const crossPark = river.simulatePayment({ id: 'x', park_id: 'lakeside', booking_ref: ref, amount_cents: 92500, currency: 'AUD' });
      check("event signed with another park's secret -> 401", (await env.post('/payment-webhook', crossPark.raw, crossPark.headers)).status === 401);
      check('unknown park -> 400', (await env.post('/payment-webhook', JSON.stringify({ id: 'e', park_id: 'nope', booking_ref: 'x' }), { 'x-onsite-signature': 'x' })).status === 400);

      const wrong = await sendPayment(env, 'lakeside', link, { amountCents: 100, eventId: 'evt_wrong' });
      check('wrong amount is NOT confirmed; staff alerted', wrong.body.result === 'amount mismatch' && (await record(env, 'lakeside', ref)).status === 'held' && alertKinds(env).includes('payment_amount_mismatch'));
      const unknown = await sendPayment(env, 'lakeside', { ...link, booking_ref: 'NB9999' }, { eventId: 'evt_unknown' });
      check('payment for an unknown booking alerts staff', unknown.body.result === 'unknown booking' && alertKinds(env).includes('payment_for_unknown_booking'));

      // Late payment, site still free -> re-booked and confirmed.
      env.clock.advance(50 * MIN);
      await env.admin('POST', '/jobs/run');
      check('hold expired and released first', (await record(env, 'lakeside', ref)).status === 'expired');
      const late = await sendPayment(env, 'lakeside', link, { eventId: 'evt_late' });
      const rebooked = (await record(env, 'lakeside', ref)).rebooked_as;
      check('late payment + site still free -> re-booked and confirmed', late.body.result === 'rebooked after late payment' && rebooked && nb.bookings.get(rebooked).status === 'confirmed');

      // Late payment, site taken by someone else -> refunded.
      const b = await book(env, { sid: 'p2', dates: 'Nov 10 to 15', phone: '+61411111111' });
      const ref2 = b[4].body.booking.ref;
      const link2 = await payLink(env, 'lakeside');
      env.clock.advance(50 * MIN);
      await env.admin('POST', '/jobs/run');
      const c = await book(env, { sid: 'p3', dates: 'Nov 10 to 15', phone: '+61422222222', name: 'Alex Lee' });
      const ref3 = c[4].body.booking.ref;
      const late2 = await sendPayment(env, 'lakeside', link2, { eventId: 'evt_late2' });
      check('late payment + site taken -> refunded in full, original payer told', late2.body.result.startsWith('refunded') && lake.refunds.length === 1 && lake.refunds[0].amount_cents === link2.amount_cents && env.sms.sent.some((s) => s.kind === 'refund_notice' && s.to === '+61411111111'));
      check("the other caller's booking is untouched", nb.bookings.get(ref3).status === 'provisional' && (await record(env, 'lakeside', ref2)).status === 'refunded');
      check('staff alerted about the refund', alertKinds(env).includes('late_payment_refunded'));

      console.log('\n[P-race] concurrency');
      const d = await book(env, { sid: 'p4', dates: 'Dec 1 to 5', phone: '+61433333333', name: 'Casey Wu' });
      const ref4 = d[4].body.booking.ref;
      const link4 = await payLink(env, 'lakeside');
      const both = await Promise.all([sendPayment(env, 'lakeside', link4, { eventId: 'evt_dup' }), sendPayment(env, 'lakeside', link4, { eventId: 'evt_dup' })]);
      check('the same webhook delivered twice at once is processed once', both.filter((x) => x.body.result === 'confirmed').length === 1 && nb.bookings.get(ref4).payments.length === 1 && env.sms.sent.filter((s) => s.kind === 'booking_confirmation' && s.to === '+61433333333').length === 1);

      const e = await book(env, { sid: 'p5', dates: 'Dec 10 to 14', phone: '+61444444444', name: 'Drew Fox' });
      const ref5 = e[4].body.booking.ref;
      const link5 = await payLink(env, 'lakeside');
      env.clock.advance(46 * MIN); // exactly when the expiry job would release it
      const [, raced] = await Promise.all([env.admin('POST', '/jobs/run'), sendPayment(env, 'lakeside', link5, { eventId: 'evt_race' })]);
      const rec5 = await record(env, 'lakeside', ref5);
      const live = [...nb.bookings.values()].filter((b) => b.site_id === 12 && b.check_in === '2026-12-10' && b.status === 'confirmed');
      check('payment racing the expiry job ends consistent: paid, exactly one confirmed NewBook booking, no refund', rec5.status === 'confirmed' && live.length === 1 && lake.refunds.length === 1 /* only the earlier p2 refund */ && raced.status === 200);
      await env.close();
    },
  },

  safety: {
    name: 'Booking safety: conflicts, lost responses, errors, limits, injection, corrections',
    async run({ check }) {
      let env = await start();
      let nb = await env.nb('lakeside');
      console.log('\n[S1] site taken between read-back and create');
      let r = await book(env, { sid: 's1', stopBefore: 4 });
      await nb.createBooking({ idempotency_key: 'other-caller', site_id: 12, check_in: '2026-10-10', check_out: '2026-10-15', guest: { name: 'Other' } });
      const yes = await say(env, 's1', 'Yes, go ahead');
      check('conflict at create -> apologises and offers alternatives, no AI booking made', /just taken/i.test(yes.body.response_text) && nb.bookings.size === 1 && (await env.pay('lakeside')).links.length === 0);
      await env.close();

      env = await start();
      nb = await env.nb('lakeside');
      console.log('\n[S1b] same conflict, but NewBook itself would accept a double booking');
      nb.allowOverlap = true;
      await book(env, { sid: 's1b', stopBefore: 4 });
      await nb.createBooking({ idempotency_key: 'other-caller-2', site_id: 12, check_in: '2026-10-10', check_out: '2026-10-15', guest: { name: 'Other' } });
      const yes2 = await say(env, 's1b', 'Yes, go ahead');
      check('our own pre-create availability re-check stops a double booking', /just taken/i.test(yes2.body.response_text) && nb.bookings.size === 1 && (await env.pay('lakeside')).links.length === 0);
      await env.close();

      env = await start();
      nb = await env.nb('lakeside');
      console.log('\n[S2] NewBook stores the booking but the response is lost (timeout)');
      nb.loseCreateResponse = true;
      r = await book(env, { sid: 's2', path: '/test-call' });
      check('recovered by idempotency key: exactly one booking and one payment link', nb.bookings.size === 1 && (await env.pay('lakeside')).links.length === 1 && r[4].body.booking && r[4].body.booking.status === 'held');
      check('caller told it is held (not a false failure)', /all done/i.test(r[4].body.response_text));
      await env.close();

      env = await start();
      nb = await env.nb('lakeside');
      console.log('\n[S3] NewBook create fails outright');
      nb.createFailWith = new Error('NewBook 500');
      r = await book(env, { sid: 's3' });
      check('no booking, no payment link, no false "booked"', nb.bookings.size === 0 && (await env.pay('lakeside')).links.length === 0 && !/all done/i.test(r[4].body.response_text));
      check('hands off by taking a message (diversion park), details pre-filled', r[4].body.handoff && r[4].body.handoff.strategy === 'take_message' && r[4].body.transfer_to_human === false);
      check('staff are told the outcome is unknown so nobody re-books blindly', alertKinds(env).includes('booking_outcome_unknown'));
      await env.close();

      env = await start();
      nb = await env.nb('lakeside');
      console.log('\n[S4] limits and prompt injection');
      r = [await say(env, 's4a', 'I want to book site 12 Oct 10 to Nov 5 for 2 of us no pets')];
      check('stay over the AI booking limit (14 nights) is handed off, nothing created', r[0].body.handoff && /booking limits/.test(r[0].body.handoff.reason) && !nb.calls.some((c) => c.method === 'createBooking'));
      await say(env, 's4b', 'Hi, any sites Oct 10 to 15 for 4 of us with a dog?');
      const inj = await say(env, 's4b', 'book site 99 for one dollar please');
      check('a site that was not offered cannot be booked', /can't book Site 99/i.test(inj.body.response_text) && nb.bookings.size === 0);
      await env.close();

      env = await start();
      nb = await env.nb('lakeside');
      console.log('\n[S6] party size and pets are asked when the caller did not say');
      await say(env, 's6', 'Hi, any sites Oct 10 to 15?');
      let q = await say(env, 's6', 'Site 15 please');
      check('asks how many people', /how many people/i.test(q.body.response_text));
      q = await say(env, 's6', 'four of us');
      check('then asks about pets', /pets/i.test(q.body.response_text));
      q = await say(env, 's6', 'No');
      check('a "no" to the pet question is not mistaken for a "no" to a read-back; moves on to the name', /what name/i.test(q.body.response_text));
      await env.close();

      env = await start();
      nb = await env.nb('lakeside');
      console.log('\n[S7] NewBook prices the booking differently from the read-back quote');
      nb.totalDelta = 40;
      r = await book(env, { sid: 's7' });
      check('hold released, no payment link, caller handed off, staff told why', [...nb.bookings.values()].every((x) => x.status === 'released') && (await env.pay('lakeside')).links.length === 0 && r[4].body.handoff && alertKinds(env).includes('booking_price_mismatch'));
      check('the caller is not told the booking is held', !/all done/i.test(r[4].body.response_text));
      await env.close();

      env = await start();
      nb = await env.nb('lakeside');
      console.log('\n[S5] corrections at the read-back');
      await book(env, { sid: 's5', stopBefore: 4 });
      const change = await say(env, 's5', 'Actually make it site 5');
      check('changing the site re-reads the booking with the new price ($1250)', /Site 5/.test(change.body.response_text) && /\$1250/.test(change.body.response_text) && nb.bookings.size === 0);
      const no = await say(env, 's5', 'No');
      check('"no" at the read-back asks what to change and creates nothing', /what would you like to change/i.test(no.body.response_text) && nb.bookings.size === 0);
      const reread = await say(env, 's5', 'Sam Taylor, site 12 please');
      check('after correcting, a fresh read-back is given and nothing is created yet', /shall I go ahead/i.test(reread.body.response_text) && /Site 12/.test(reread.body.response_text) && nb.bookings.size === 0);
      const final = await say(env, 's5', 'Yes');
      check('only the yes to the NEW read-back creates the booking (Site 12, once)', final.body.booking && nb.bookings.size === 1 && [...nb.bookings.values()][0].site_id === 12);
      await env.close();
    },
  },

  messages: {
    name: 'Handoff strategy: take-a-message (diversion) vs live transfer (full)',
    async run({ check }) {
      const env = await start();
      console.log('\n[M1] diversion park, unhappy caller');
      let r = await say(env, 'm1', 'This is terrible, I want to complain about my last stay');
      check('no live transfer; says the team is tied up and asks for a name', r.body.transfer_to_human === false && /tied up/i.test(r.body.response_text) && /your name/i.test(r.body.response_text) && r.body.handoff.strategy === 'take_message');
      r = await say(env, 'm1', 'Jo Smith');
      check('asks to confirm the callback number', /ending 6 7 8/.test(r.body.response_text));
      r = await say(env, 'm1', 'Yes');
      check('message taken, caller told when to expect a call (park promise)', /Jo Smith/.test(r.body.response_text) && /within the hour/.test(r.body.response_text) && r.body.transfer_to_human === false);
      const msg = await env.deps.store.get('messages:lakeside:m1');
      check('message record saved for staff', msg && msg.name === 'Jo Smith' && msg.callback_number === PHONE && msg.status === 'open');
      check('caller SMS acknowledgement + staff alert', env.sms.sent.some((s) => s.kind === 'message_taken' && s.to === PHONE) && alertKinds(env).includes('callback_requested'));
      r = await say(env, 'm1', 'Thanks');
      check('later turns do not create a second message', /passed your message on/i.test(r.body.response_text) && env.notifier.alerts.filter((a) => a.kind === 'callback_requested').length === 1);

      console.log('\n[M2] different callback number (landline, so no SMS)');
      await say(env, 'm2', 'Can I speak to someone please?');
      await say(env, 'm2', 'Pat Jones');
      await say(env, 'm2', 'No');
      const smsBefore = env.sms.sent.length;
      await say(env, 'm2', '02 9876 5432');
      const msg2 = await env.deps.store.get('messages:lakeside:m2');
      check('callback number taken as given; no SMS to a landline', msg2 && msg2.callback_number === '+61298765432' && env.sms.sent.length === smsBefore);

      console.log('\n[M3] full-service park, same complaint');
      r = await say(env, 'm3', 'This is terrible, I want to complain about my last stay', { called: NUMBERS.riverbend });
      check('live transfer to staff, no message flow', r.body.transfer_to_human === true && r.body.handoff.strategy === 'live_transfer' && !(await env.deps.store.get('messages:riverbend:m3')));

      console.log('\n[M4] booking request when the park has AI booking off');
      r = await say(env, 'm4', 'I want to book Site 12 for October 10th', { called: NUMBERS.friend });
      check('handoff-mode park still transfers booking requests (brief scenario 4)', r.body.transfer_to_human === true && r.body.handoff.strategy === 'live_transfer');
      await env.close();
    },
  },

  parks: {
    name: 'Multi-park routing and isolation',
    async run({ check }) {
      const env = await start();
      const t = (called) => env.post('/test-call', { call_sid: `pk-${called}`, transcript: 'Any sites Oct 10 to 15 for 4 of us with a dog?', caller_phone: PHONE, called_number: called, confidence: 0.95 });
      const lake = await t(NUMBERS.lakeside);
      const river = await t(NUMBERS.riverbend);
      const dflt = await env.post('/test-call', { call_sid: 'pk-none', transcript: 'Any sites Oct 10 to 15?', caller_phone: PHONE, confidence: 0.95 });
      check('lakeside is answered from its own availability (pet + 4 guests: sites 12, 5)', JSON.stringify(lake.body.trace.sites_passed_to_claude.slice().sort((a, b) => a - b)) === '[5,12]');
      check("riverbend is answered from ITS sites (only site 1 fits)", JSON.stringify(river.body.trace.sites_passed_to_claude) === '[1]');
      check('no called_number -> default (first) park', dflt.body.metadata.park_id === 'friend-caravan-park');
      const unknown = await t('+61299999999');
      check('unrecognised number -> safe fallback, never another park\'s data', unknown.body.transfer_to_human === true && unknown.body.trace.decision === 'fallback: unknown park');
      check('park id travels in the response metadata', lake.body.metadata.park_id === 'lakeside' && river.body.metadata.park_id === 'riverbend');
      const nbLake = await env.nb('lakeside');
      const nbRiver = await env.nb('riverbend');
      check('each park has its own NewBook client instance', nbLake !== nbRiver && nbLake.calls.length > 0 && nbRiver.calls.length > 0);
      await env.close();
    },
  },

  billing: {
    name: 'Usage ledger and monthly statement ($100/month + $3 per answered call)',
    async run({ check }) {
      const usageClaude = createClaudeClient({ mode: 'stub' });
      const metered = { mode: 'stub', extractIntent: async (a) => { a.meter && a.meter.add('stub-model', { input_tokens: 100, output_tokens: 20 }); return usageClaude.extractIntent(a); }, generateResponse: async (a) => { a.meter && a.meter.add('stub-model', { input_tokens: 200, output_tokens: 40 }); return usageClaude.generateResponse(a); } };
      const env = await start({ claude: metered });
      const ended = (sid, seconds, called = NUMBERS.lakeside) => env.post('/call-ended', { call_sid: sid, called_number: called, duration_seconds: seconds });

      await say(env, 'b1', 'Any sites Oct 10 to 15?');
      await say(env, 'b2', 'Any sites Oct 10 to 15?');
      await say(env, 'b3', 'Hi, this is about your extended warranty');
      await say(env, 'b4', 'Any sites Oct 10 to 15?', { path: '/test-call' });
      await say(env, 'b5', 'Any sites Oct 10 to 15?');
      const e1 = await ended('b1', 90);
      await ended('b2', 8);
      await ended('b3', 30);
      await ended('b4', 120);
      check('answered call of 90s is billable', e1.body.billable === true);
      const e1b = await ended('b1', 90);
      check('call-ended is idempotent (not billed twice)', e1b.body.billable === true);
      check('call-ended for an unknown number -> 404', (await ended('b1', 90, '+61299999999')).status === 404);

      env.clock.advance(20 * MIN);
      const run = (await env.admin('POST', '/jobs/run')).body;
      check('idle finaliser closes calls whose end event never arrived', run.calls_finalized === 1);

      const st = (await env.admin('GET', `/usage/lakeside?month=${MONTH}`)).body;
      check('billable = answered b1 + idle-finalised b5 (2 calls)', st.billable_calls === 2 && st.lines.length === 2);
      check('total = $100 monthly + 2 x $3 = $106', st.monthly_fee === 100 && st.per_call_fee === 3 && st.usage_charges === 6 && st.total === 106);
      check('not billed: abandoned (<15s), spam, test call', st.not_billed.abandoned === 1 && st.not_billed.spam === 1 && st.not_billed.test === 1);
      check('estimated durations are labelled as such on the statement', st.lines.some((l) => l.duration_source === 'estimated') && st.lines.some((l) => l.duration_source === 'provider'));
      check('cost drivers recorded (Claude tokens per model)', st.cost_drivers.tokens['stub-model'] && st.cost_drivers.tokens['stub-model'].calls >= 4);
      const rv = (await env.admin('GET', `/usage/riverbend?month=${MONTH}`)).body;
      check("another park's statement is separate: just the monthly fee", rv.billable_calls === 0 && rv.total === 100);
      check('statement requires month=YYYY-MM', (await env.admin('GET', '/usage/lakeside')).status === 400);
      await env.close();
    },
  },

  resilience: {
    name: 'Resilience: Claude down, SMS failure, suppression, payment-link failure, card numbers',
    async run({ check }) {
      let env = await start({ claude: { mode: 'broken', extractIntent: async () => { throw new Error('Claude 529 overloaded'); }, generateResponse: async () => { throw new Error('nope'); } } });
      console.log('\n[R1] Claude down at a diversion park');
      let r = await say(env, 'r1', 'Any sites Oct 10 to 15?');
      check('no transfer into a busy office: takes a message path instead', r.body.transfer_to_human === false && r.body.handoff.strategy === 'take_message' && /call you back/i.test(r.body.response_text));
      check('message record + staff alert still created', !!(await env.deps.store.get('messages:lakeside:r1')) && alertKinds(env).includes('callback_requested'));
      r = await say(env, 'r1b', 'Any sites Oct 10 to 15?', { called: NUMBERS.riverbend });
      check('full-service park falls back to the live transfer line', r.body.transfer_to_human === true && /system is busy/i.test(r.body.response_text));
      await env.close();

      env = await start();
      console.log('\n[R2] payment-link SMS fails');
      env.sms.failNext = 1;
      let a = await book(env, { sid: 'r2' });
      let ref = a[4].body.booking.ref;
      check('hold stands, caller told the team will send the link, staff get the link', a[4].body.booking.sms_sent === false && /ask the team to send/i.test(a[4].body.response_text) && env.notifier.alerts.some((x) => x.kind === 'payment_link_sms_failed' && x.summary.includes('pay.mock.onsite.test')));
      env.clock.advance(25 * MIN);
      await env.admin('POST', '/jobs/run');
      check('no reminder is sent for a link that was never delivered', env.sms.sent.every((s) => s.kind !== 'hold_reminder'));
      await env.close();

      env = await start();
      console.log('\n[R3] caller opted out of SMS');
      await env.deps.store.set(`suppression:${PHONE}`, { reason: 'stop' });
      a = await book(env, { sid: 'r3' });
      check('no SMS to an opted-out number; staff alerted instead', env.sms.sent.length === 0 && alertKinds(env).includes('payment_link_sms_failed'));
      await env.close();

      env = await start();
      console.log('\n[R4] payment provider cannot create a link');
      const lake = await env.pay('lakeside');
      lake.failNext = 1;
      a = await book(env, { sid: 'r4' });
      const nb = await env.nb('lakeside');
      check('hold released, nothing left dangling, caller handed off', [...nb.bookings.values()].every((b) => b.status === 'released') && alertKinds(env).includes('payment_link_failed') && a[4].body.handoff && a[4].body.handoff.strategy === 'take_message');
      await env.close();

      const seen = [];
      const stub = createClaudeClient({ mode: 'stub' });
      env = await start({ claude: { mode: 'spy', extractIntent: async (x) => { seen.push(x.transcript); return stub.extractIntent(x); }, generateResponse: stub.generateResponse } });
      console.log('\n[R5] caller reads out a card number');
      r = await say(env, 'r5', 'my card is 4242 4242 4242 4242, expiry 12/28');
      const stored = JSON.stringify(await env.deps.store.list('state:'));
      check('card number never reaches Claude, state or logs', seen.length === 0 && !/4242/.test(stored) && !/4242/.test(JSON.stringify(r.body)));
      check('caller is told not to read out card details', /don't read out any card details/i.test(r.body.response_text));
      r = await say(env, 'r5b', 'my number is 0412 345 678 and we want 4 nights');
      check('ordinary phone numbers are not mistaken for cards', !/removed/.test(r.body.response_text));
      await env.close();
    },
  },

  containers: {
    name: 'Two app instances (separate "Lambda containers") sharing one DynamoDB table',
    async run({ check }) {
      const clock = makeClock();
      const now = () => clock.t;
      const storeA = await newDynamoStore({ now });
      const storeB = await newDynamoStore({ now, tableName: storeA.table, create: false });
      const nb = createMockNewBookClient({ parkName: 'Lakeside Holiday Park', latencyMs: 5 });
      const provider = createMockPaymentProvider({ webhookSecret: 'whsec_lake' });
      const shared = { clock, newbooks: { lakeside: nb }, payments: { lakeside: provider }, sms: createMockSmsProvider({ store: storeA }), notifier: createMockNotifier() };
      const A = await start({ store: storeA, ...shared });
      const B = await start({ store: storeB, ...shared });
      const apps = [A, B];
      const sendTo = (env, evId, l) => { const { raw, headers } = provider.simulatePayment(l, { eventId: evId }); return env.post('/payment-webhook', raw, headers); };

      // Each turn of one call lands on the other container: call state must come from the database.
      const turns = ['Hi, any sites Oct 10 to 15 for 4 of us with a dog?', 'Site 12 please', 'Sam Taylor', 'Yes', 'Yes, go ahead'];
      let last;
      for (const [i, t] of turns.entries()) last = await say(apps[i % 2], 'ct1', t);
      check('a booking conversation alternating between containers completes with one NewBook booking', last.body.booking && last.body.booking.status === 'held' && nb.bookings.size === 1);

      const link = provider.links.at(-1);
      const both = await Promise.all([sendTo(A, 'evt_ct', link), sendTo(B, 'evt_ct', link), sendTo(A, 'evt_ct', link), sendTo(B, 'evt_ct', link)]);
      check('the same payment webhook delivered to both containers at once is applied exactly once', both.filter((x) => x.body.result === 'confirmed').length === 1 && [...nb.bookings.values()][0].payments.length === 1 && shared.sms.sent.filter((x) => x.kind === 'booking_confirmation').length === 1);

      let second;
      for (const [i, t] of ['Hi, any sites Dec 10 to 14 for 4 of us with a dog?', 'Site 12 please', 'Drew Fox', 'Yes', 'Yes, go ahead'].entries()) second = await say(apps[i % 2], 'ct2', t, { phone: '+61444444444' });
      const link2 = provider.links.at(-1);
      clock.advance(46 * MIN); // the hold is due to expire right now
      const [, raced] = await Promise.all([B.admin('POST', '/jobs/run'), sendTo(A, 'evt_ct2', link2)]);
      const confirmed = [...nb.bookings.values()].filter((b) => b.check_in === '2026-12-10' && b.status === 'confirmed');
      check('payment on one container racing the expiry job on the other ends consistent (paid, one confirmed booking)', second.body.booking && raced.status === 200 && confirmed.length === 1);

      await say(B, 'ct3', 'Any sites Oct 10 to 15?');
      await B.post('/call-ended', { call_sid: 'ct3', called_number: NUMBERS.lakeside, duration_seconds: 60 });
      const st = (await A.admin('GET', `/usage/lakeside?month=${MONTH}`)).body;
      check('billing ledger written by one container is visible from the other', st.billable_calls >= 1 && st.lines.some((l) => l.call_sid === 'ct3'));
      await A.close();
      await B.close();
    },
  },
};

async function main() {
  const arg = process.argv[2] || 'all';
  const keys = arg === 'all' ? Object.keys(suites) : [arg];
  if (keys.some((k) => !suites[k])) { console.error(`Unknown suite "${arg}". Use ${Object.keys(suites).join(', ')} or all.`); process.exit(2); }
  console.log(`OnSite platform tests | claude client: ${createClaudeClient().mode.toUpperCase()}${createClaudeClient().mode === 'stub' ? ' (offline rule-based stand-in, NOT Claude)' : ''} | SMS, payments, notifier: MOCK | store: ${STORE_NAME} | newbook: ${NEWBOOK_NAME} | pinned date: 2026-09-30`);
  const all = [];
  for (const k of keys) {
    const s = suites[k];
    console.log(`\n==================== ${s.name} ====================`);
    const { check, results } = makeChecker();
    try { await s.run({ check }); } catch (err) { console.error(err); check(`suite threw: ${err.message}`, false); }
    const pass = results.every((r) => r.ok);
    console.log(`\n>>> ${k}: ${pass ? 'PASS' : 'FAIL'} (${results.filter((r) => r.ok).length}/${results.length} checks)`);
    all.push({ name: k, pass });
  }
  console.log('\n==================== SUMMARY ====================');
  for (const a of all) console.log(`${a.pass ? 'PASS' : 'FAIL'}  ${a.name}`);
  process.exit(all.every((a) => a.pass) ? 0 : 1);
}

main();
