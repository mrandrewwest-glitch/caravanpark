'use strict';

const D = require('./dates');
const { normaliseMobile, maskPhone, spokenDuration, money } = require('./util');
const { MSG, SMS, range, short } = require('./messages');
const { sendSms, alertStaff } = require('./comms');
const { saveBooking, keys, TTL } = require('./repos');

// Deterministic booking state machine. Claude only extracts what the caller said;
// code decides what happens next, what the price is, and when the NewBook booking is
// created (only after an explicit "yes" to the read-back, and only once per
// idempotency key). The LLM never selects a site that wasn't in the availability result
// and never sets a price.

const MAX_ASKS = 3; // same question asked this many times without progress -> hand off

const digitsOnly = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 8 && d.length <= 15 ? d : null; };
const anyPhone = (raw) => normaliseMobile(raw) || (digitsOnly(raw) ? `+${digitsOnly(raw).replace(/^0/, '61')}` : null);

async function bookingTurn(ctx) {
  const { state, park, data, extraction: ex, call, trace, newbook } = ctx;
  const b = state.booking || (state.booking = { site_id: null, guest_name: null, mobile: null, mobile_confirmed: false, awaiting: null, readback_sig: null, asks: {} });
  trace.flow = 'booking';

  const sig = () => JSON.stringify([b.site_id, data.check_in_date, data.check_out_date, data.num_guests, data.has_pet, b.guest_name, b.mobile]);
  const callerMobile = normaliseMobile(call.caller_phone);
  const wasAwaiting = b.awaiting;
  const sigBefore = sig();
  const conf = ex ? ex.confirmation : null;
  const givenMobile = ex && ex.mobile ? normaliseMobile(ex.mobile) : null;

  if (ex) {
    if (ex.chosen_site_id) b.site_id = ex.chosen_site_id; // validated against availability below
    if (ex.guest_name) b.guest_name = ex.guest_name;
  }
  if (givenMobile) { b.mobile = givenMobile; b.mobile_confirmed = true; }
  if (wasAwaiting === 'mobile' && !givenMobile) {
    if (conf === 'yes' && callerMobile) { b.mobile = callerMobile; b.mobile_confirmed = true; }
    else if (conf === 'no') b.awaiting = 'mobile_number';
  }
  if (b.mobile_confirmed && (b.awaiting === 'mobile' || b.awaiting === 'mobile_number')) b.awaiting = null;

  const ask = async (field, text, decision) => {
    b.asks[field] = (b.asks[field] || 0) + 1;
    if (b.asks[field] > MAX_ASKS) return ctx.handoff({ kind: 'cant_understand', decision: `transfer: could not capture ${field}` });
    return ctx.finish({ text, decision: `booking: ask ${field}` });
  };

  // ---- Awaiting the answer to the read-back ----
  if (wasAwaiting === 'readback') {
    if (conf === 'yes' && sig() === b.readback_sig) return createBooking(ctx, b);
    if (conf === 'no') { b.awaiting = null; return ask('change', MSG.askChange); }
    if (sig() === sigBefore && !conf) return ask('readback', MSG.readbackAgain);
  }
  if (b.awaiting === 'readback') b.awaiting = null; // something changed: rebuild the read-back

  // ---- Dates, availability ----
  const dateStop = await ctx.requireDates();
  if (dateStop) return dateStop;

  const today = ctx.deps.today(park);
  const nights = D.nightsBetween(data.check_in_date, data.check_out_date);
  const advance = D.nightsBetween(today, data.check_in_date);
  if (data.check_in_date < today) {
    data.check_in_date = null; data.check_out_date = null;
    return ask('dates', `Sorry, that date has already passed. ${MSG.askWhen}`, 'booking: date in the past');
  }
  if (nights > park.limits.max_nights || advance > park.limits.max_advance_days || (advance === 0 && !park.limits.allow_same_day)) {
    return ctx.handoff({ kind: 'booking_limit', decision: 'transfer: outside AI booking limits', reason: `outside AI booking limits (${nights} nights, ${advance} days ahead)` });
  }

  const fetched = await ctx.fetchSites();
  if (fetched.reply) return fetched.reply;

  if (!b.site_id) return ctx.offerSites(fetched, '', 'respond: availability (booking)');
  const chosen = fetched.availability.sites.find((s) => s.site_id === b.site_id && s.available);
  if (!chosen) {
    const id = b.site_id; b.site_id = null;
    return ctx.offerSites(fetched, `Sorry, I can't book Site ${id} for those dates. `, 'booking: chosen site not available');
  }

  // ---- Party, pets ----
  if (!data.num_guests) return ask('guests', MSG.askGuests);
  if (chosen.max_guests < data.num_guests) {
    b.site_id = null;
    return ctx.offerSites(fetched, `${short(chosen.name)} sleeps up to ${chosen.max_guests}. `, 'booking: site too small');
  }
  if (data.has_pet === null || data.has_pet === undefined) return ask('pets', MSG.askPets);
  if (data.has_pet === true && !chosen.pet_friendly) {
    b.site_id = null;
    return ctx.offerSites(fetched, `${short(chosen.name)} isn't pet friendly. `, 'booking: site not pet friendly');
  }

  // ---- Guest details ----
  if (!b.guest_name) return ask('name', MSG.askName);
  if (!b.mobile_confirmed) {
    if (b.awaiting === 'mobile_number' || !callerMobile) { b.awaiting = 'mobile_number'; return ask('mobile', MSG.askMobile); }
    b.awaiting = 'mobile';
    return ask('mobile', `I'll text the payment link to the number you're calling from, ${maskPhone(callerMobile)}. Is that okay?`);
  }

  // ---- Read-back ----
  let quote;
  try { quote = await newbook.quote(b.site_id, data.check_in_date, data.check_out_date, { guests: data.num_guests, animals: data.has_pet ? 1 : 0 }); } catch (err) {
    ctx.deps.logger.warn('quote_failed', { call_sid: call.call_sid, error: err.message });
    return ctx.handoff({ kind: 'booking_error', decision: 'transfer: quote failed', reason: 'could not get a price from the booking system' });
  }
  b.total = quote.total;
  b.amount_cents = Math.round(quote.total * 100 * park.deposit_percent / 100);
  const due = park.deposit_percent < 100 ? `, with ${money(b.amount_cents / 100)} due now` : '';
  b.awaiting = 'readback';
  b.readback_sig = sig();
  trace.booking = { site_id: b.site_id, total: b.total, amount_cents: b.amount_cents };
  return ctx.finish({
    text: `That's ${short(chosen.name)}, ${range(data.check_in_date, data.check_out_date)}, ${data.num_guests} guests${data.has_pet ? ' with a pet' : ''}, under the name ${b.guest_name}. The total is ${money(b.total)}${due}. I'll hold it for ${spokenDuration(park.hold_minutes)} and text a secure payment link to the number ${maskPhone(b.mobile)}. Shall I go ahead?`,
    decision: 'booking: read-back',
  });
}

async function createBooking(ctx, b) {
  const { state, park, data, deps, newbook, call, trace } = ctx;
  const payments = deps.providers.payments(park);
  b.awaiting = null;

  // 1. Re-check availability right before creating.
  let availability;
  try { availability = await newbook.getAvailability(data.check_in_date, data.check_out_date); } catch (err) {
    return ctx.handoff({ kind: 'newbook_down', decision: 'transfer: availability check failed before create', reason: 'booking system down at create time' });
  }
  if (!availability.sites.some((s) => s.site_id === b.site_id && s.available)) {
    b.site_id = null;
    return ctx.offerSites({ availability, sites: ctx.relevant(availability) }, 'Sorry, that site was just taken. ', 'booking: site taken before create');
  }

  // 2. Create with an idempotency key (repeat "yes" / retries can't make a second booking).
  const key = `${park.id}:${call.call_sid}:${b.site_id}:${data.check_in_date}:${data.check_out_date}`;
  const holdExpiresMs = deps.now() + park.hold_minutes * 60000;
  let booking = null;
  try {
    booking = await newbook.createBooking({
      idempotency_key: key, site_id: b.site_id, check_in: data.check_in_date, check_out: data.check_out_date, status: 'provisional',
      hold_expires_at: new Date(holdExpiresMs).toISOString(), source: 'onsite-ai',
      guest: { name: b.guest_name, mobile: b.mobile, num_guests: data.num_guests, has_pet: data.has_pet, vehicle_type: data.vehicle_type || null },
    });
  } catch (err) {
    trace.booking_error = err.message;
    if (err.code === 'SITE_UNAVAILABLE') {
      b.site_id = null;
      return ctx.offerSites({ availability, sites: ctx.relevant(availability) }, 'Sorry, that site was just taken. ', 'booking: site taken at create');
    }
    // Unknown outcome: the booking may exist. Never retry blindly; look it up by key first.
    try { booking = await newbook.findBookingByKey(key, { check_in: data.check_in_date, check_out: data.check_out_date }); } catch (lookupErr) { trace.booking_lookup_error = lookupErr.message; }
    if (!booking) {
      deps.logger.error('booking_create_failed', { call_sid: call.call_sid, error: err.message });
      if (err.outcomeUnknown !== false) {
        // The request may have reached NewBook. Staff must check before anyone re-books.
        await alertStaff(deps, park, { kind: 'booking_outcome_unknown', summary: `UNKNOWN OUTCOME: creating a booking for ${b.guest_name} (${b.mobile}), site ${b.site_id}, ${data.check_in_date} to ${data.check_out_date} failed (${err.message}). It may exist in NewBook (look for key ${key}). Nothing was sent to the caller.` });
      }
      return ctx.handoff({ kind: 'booking_error', decision: 'transfer: booking create failed, no booking found', reason: 'booking create failed' });
    }
    trace.booking_recovered_by_key = true;
  }

  // 3. A booking exists in NewBook: record it before anything else can fail.
  const rec = {
    park_id: park.id, booking_ref: booking.booking_id, status: 'held', call_sid: call.call_sid, caller_phone: call.caller_phone || null,
    site_id: booking.site_id, site_name: booking.site_name, check_in: booking.check_in, check_out: booking.check_out,
    guest: booking.guest, total: booking.total, amount_due_cents: b.amount_cents ?? Math.round(booking.total * 100 * park.deposit_percent / 100),
    currency: park.billing.currency, mobile: b.mobile, hold_minutes: park.hold_minutes, hold_expires_ms: holdExpiresMs,
    created_ms: deps.now(), reminder_sent: false, sms_failed: false, payment_link: null,
  };
  await saveBooking(deps.store, rec);
  b.ref = rec.booking_ref;
  trace.booking = { ...(trace.booking || {}), ref: rec.booking_ref, status: 'held' };
  await deps.ledger.addBooking(call.call_sid, rec.booking_ref);

  // 3b. NewBook's own total must match the price the caller agreed to. If its rates produced a
  // different number, never take payment for it: release the hold and let a person sort it out.
  if (typeof b.total === 'number' && Math.abs(Number(booking.total) - b.total) > 0.005) {
    deps.logger.error('booking_total_mismatch', { call_sid: call.call_sid, quoted: b.total, actual: booking.total });
    try { await newbook.releaseBooking(booking.booking_id, 'price differs from read-back quote'); } catch (e) { deps.logger.error('release_failed', { error: e.message }); }
    rec.status = 'released'; rec.release_reason = 'price mismatch';
    await saveBooking(deps.store, rec);
    await alertStaff(deps, park, { kind: 'booking_price_mismatch', summary: `Booking ${rec.booking_ref} released: NewBook total ${booking.total} differs from the ${b.total} read back to ${b.guest_name} (${b.mobile}). Rates/occupancy may differ from the quote; please call them.` });
    return ctx.handoff({ kind: 'booking_error', decision: 'transfer: NewBook total differs from quote', reason: 'price differed from the quote read to the caller' });
  }

  // 4. Payment link (hosted page; card data never touches us).
  let link;
  try {
    link = await payments.createPaymentLink({
      park_id: park.id, booking_ref: rec.booking_ref, amount_cents: rec.amount_due_cents, currency: rec.currency,
      description: `${booking.site_name} ${booking.check_in} to ${booking.check_out}`, expires_at: new Date(holdExpiresMs).toISOString(),
    });
  } catch (err) {
    deps.logger.error('payment_link_failed', { call_sid: call.call_sid, error: err.message });
    try { await newbook.releaseBooking(booking.booking_id, 'payment link failed'); } catch (e) { deps.logger.error('release_failed', { error: e.message }); }
    rec.status = 'released'; rec.release_reason = 'payment link failed';
    await saveBooking(deps.store, rec);
    await alertStaff(deps, park, { kind: 'payment_link_failed', summary: `Payment link failed for ${rec.booking_ref}; hold released. Caller ${call.caller_phone || 'unknown'}.` });
    return ctx.handoff({ kind: 'booking_error', decision: 'transfer: payment link failed', reason: 'payment setup failed' });
  }
  rec.payment_link = { id: link.id, url: link.url };
  await saveBooking(deps.store, rec);

  // 5. Text the link. If that fails the hold stands; staff are told to send it.
  let smsOk = true;
  try {
    await sendSms(deps, park, rec.mobile, SMS.paymentLink({ park, booking, amountCents: rec.amount_due_cents, url: link.url, holdMinutes: park.hold_minutes }), 'payment_link', call.call_sid);
  } catch (err) {
    smsOk = false;
    rec.sms_failed = true;
    await saveBooking(deps.store, rec);
    deps.logger.error('payment_link_sms_failed', { call_sid: call.call_sid, error: err.message });
    await alertStaff(deps, park, { kind: 'payment_link_sms_failed', summary: `Could not text the payment link for ${rec.booking_ref} to ${rec.mobile}. Link: ${link.url}` });
  }

  await alertStaff(deps, park, { kind: 'ai_booking_held', summary: `AI held ${short(booking.site_name)} ${booking.check_in} to ${booking.check_out} for ${b.guest_name} (${rec.mobile}), ${money(booking.total)}. Ref ${rec.booking_ref}. Awaiting payment.` });

  return ctx.finish({
    text: smsOk
      ? `All done. I've held ${short(booking.site_name)} for you for ${spokenDuration(park.hold_minutes)} and I'm texting a secure payment link to the number ${maskPhone(rec.mobile)}. Once it's paid, your booking is confirmed. Is there anything else I can help with?`
      : MSG.smsFailed,
    decision: 'booking: created (held), payment link sent',
    extra: { booking: { ref: rec.booking_ref, status: 'held', hold_expires_at: new Date(holdExpiresMs).toISOString(), sms_sent: smsOk } },
  });
}

// ---- Take-a-message flow (used when nobody is free to take a live transfer) ----

async function startMessageFlow(ctx, { kind, reason, lead }) {
  const { state, extraction: ex } = ctx;
  const name = (state.booking && state.booking.guest_name) || (ex && ex.guest_name) || null;
  state.flow = { type: 'message', kind, reason, lead, name, number: null, number_confirmed: false, awaiting: null, notes: [], done: false };
  return advanceMessageFlow(ctx, lead);
}

async function messageTurn(ctx) {
  const { state, extraction: ex, call } = ctx;
  const f = state.flow;
  if (f.done) return ctx.finish({ text: MSG.postMessage, decision: 'message: already taken' });
  if (f.awaiting === 'name' && ex && ex.guest_name) f.name = ex.guest_name;
  const given = ex && ex.mobile ? anyPhone(ex.mobile) : null;
  if (given) { f.number = given; f.number_confirmed = true; f.awaiting = null; }
  else if (f.awaiting === 'number_confirm' && ex && ex.confirmation === 'yes') { f.number = call.caller_phone; f.number_confirmed = true; f.awaiting = null; }
  else if (f.awaiting === 'number_confirm' && ex && ex.confirmation === 'no') f.awaiting = 'number';
  if (call.transcript && f.awaiting !== 'name' && !(ex && (ex.mobile || ex.confirmation))) f.notes.push(call.transcript.slice(0, 300));
  return advanceMessageFlow(ctx, '');
}

async function advanceMessageFlow(ctx, lead) {
  const { state, park, call, deps } = ctx;
  const f = state.flow;
  const pre = lead ? `${lead} ` : '';
  if (!f.name) { f.awaiting = 'name'; return ctx.finish({ text: `${pre}Can I take your name?`, decision: 'message: ask name', handoff: { strategy: 'take_message', reason: f.reason } }); }
  if (!f.number_confirmed) {
    if (f.awaiting === 'number' || !call.caller_phone) {
      f.awaiting = 'number';
      return ctx.finish({ text: `${pre}What's the best number for them to call you back on?`, decision: 'message: ask number', handoff: { strategy: 'take_message', reason: f.reason } });
    }
    f.awaiting = 'number_confirm';
    return ctx.finish({ text: `${pre}They'll call you back on the number you're calling from, ${maskPhone(call.caller_phone)}. Is that right?`, decision: 'message: confirm number', handoff: { strategy: 'take_message', reason: f.reason } });
  }

  const id = `${park.id}:${call.call_sid}`;
  const record = {
    id, park_id: park.id, call_sid: call.call_sid, name: f.name, callback_number: f.number, caller_phone: call.caller_phone || null,
    reason: f.reason, notes: f.notes, status: 'open', created_ms: deps.now(), summary: ctx.summary(f.reason), conversation_history: state.conversation_history,
  };
  await deps.store.set(keys.message(park.id, call.call_sid), record, { ttlSeconds: TTL.messages });
  f.done = true;
  state.status = 'message_taken';
  const textable = normaliseMobile(f.number);
  if (textable) {
    try { await sendSms(deps, park, textable, SMS.messageTaken({ park, name: f.name }), 'message_taken', call.call_sid); } catch (err) { deps.logger.warn('message_ack_sms_failed', { error: err.message }); }
  }
  await alertStaff(deps, park, { kind: 'callback_requested', summary: `Call back ${f.name} on ${f.number}. ${record.summary}`, message_id: id });
  return ctx.finish({
    text: `Thanks ${f.name}, I've passed that on and the team will call you back ${park.staff.callback_promise}. Thanks for calling!`,
    decision: 'message: taken',
    handoff: { strategy: 'take_message', reason: f.reason, message_id: id },
  });
}

module.exports = { bookingTurn, startMessageFlow, messageTurn, advanceMessageFlow };
