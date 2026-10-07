'use strict';

const { SMS, short } = require('./messages');
const { sendSms, alertStaff } = require('./comms');
const { saveBooking, keys, TTL } = require('./repos');

// POST /payment-webhook. The provider calls this after the caller pays the hosted link.
// Order matters: verify signature -> dedupe -> amount check -> confirm in NewBook -> SMS.
// Never trust the body until the signature (made with the PARK's secret) verifies.

async function handlePaymentWebhook(req, res, deps) {
  const event = req.body || {};
  const park = typeof event.park_id === 'string' ? await deps.registry.get(event.park_id) : null;
  if (!park) return res.status(400).json({ error: 'unknown park' });
  const payments = deps.providers.payments(park);
  if (!payments.verifyWebhook(req.rawBody, req.get('x-onsite-signature'))) {
    deps.logger.warn('payment_webhook_bad_signature', { park_id: park.id });
    return res.status(401).json({ error: 'invalid signature' });
  }
  if (typeof event.id !== 'string' || typeof event.booking_ref !== 'string') return res.status(400).json({ error: 'malformed event' });
  if (event.type !== 'payment.succeeded') return res.json({ ignored: event.type });

  const recKey = keys.booking(park.id, event.booking_ref);
  try {
    // Cross-container lock (lease in DynamoDB): duplicate deliveries and the expiry job cannot interleave.
    const out = await deps.store.withLock(recKey, () => applyPayment(deps, park, payments, event, recKey));
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    // 5xx makes the provider retry; the event is not marked processed.
    deps.logger.error('payment_webhook_failed', { park_id: park.id, booking_ref: event.booking_ref, error: err.message });
    return res.status(500).json({ error: 'processing failed, will retry' });
  }
}

async function applyPayment(deps, park, payments, event, recKey) {
  const evKey = keys.event(park.id, event.id);
  const markDone = (result) => deps.store.set(evKey, { at: deps.now(), result }, { ttlSeconds: TTL.events });
  if (await deps.store.get(evKey)) return { body: { duplicate: true } };
  const rec = await deps.store.get(recKey);
  if (!rec) {
    await alertStaff(deps, park, { kind: 'payment_for_unknown_booking', summary: `Payment ${event.payment_id} for unknown booking ${event.booking_ref}. Check the payment provider.` });
    await markDone('unknown booking');
    return { body: { received: true, result: 'unknown booking' } };
  }
  const newbook = deps.providers.newbook(park);
  const done = async (result) => { await markDone(result); return { body: { received: true, result } }; };

  if (rec.status === 'confirmed' || rec.status === 'refunded') return done(`already ${rec.status}`);

  if (event.amount_cents !== rec.amount_due_cents) {
    // Don't confirm on a wrong amount; staff reconcile. The provider keeps the funds.
    await alertStaff(deps, park, { kind: 'payment_amount_mismatch', summary: `Booking ${rec.booking_ref}: expected ${rec.amount_due_cents} cents, received ${event.amount_cents} (payment ${event.payment_id}). Not confirmed.` });
    return done('amount mismatch');
  }

  const payment = { id: event.payment_id, amount_cents: event.amount_cents, currency: event.currency, at: new Date(deps.now()).toISOString() };

  if (rec.status === 'held') {
    await newbook.confirmBooking(rec.booking_ref, { payment }); // throws -> 500 -> provider retries
    rec.status = 'confirmed'; rec.paid_ms = deps.now(); rec.payment = payment;
    await saveBooking(deps.store, rec);
    await notifyPaid(deps, park, rec, event);
    return done('confirmed');
  }

  // Late payment: hold expired (status 'expired'). Re-book if the site is still free, else refund.
  const booking = await newbook.getBooking(rec.booking_ref);
  let rebooked = null;
  try {
    const availability = await newbook.getAvailability(rec.check_in, rec.check_out);
    if (availability.sites.some((s) => s.site_id === rec.site_id && s.available)) {
      const created = await newbook.createBooking({ idempotency_key: `${rec.park_id}:${rec.booking_ref}:late`, site_id: rec.site_id, check_in: rec.check_in, check_out: rec.check_out, guest: rec.guest, source: 'onsite-ai', status: 'provisional' });
      rebooked = await newbook.confirmBooking(created.booking_id, { payment });
    }
  } catch (err) {
    deps.logger.warn('late_payment_rebook_failed', { error: err.message });
  }
  if (rebooked) {
    rec.status = 'confirmed'; rec.paid_ms = deps.now(); rec.payment = payment; rec.rebooked_as = rebooked.booking_id;
    await saveBooking(deps.store, rec);
    await notifyPaid(deps, park, { ...rec, booking_ref: rebooked.booking_id }, event);
    await alertStaff(deps, park, { kind: 'late_payment_rebooked', summary: `Payment arrived after the hold on ${rec.booking_ref} expired; site was still free so it was re-booked as ${rebooked.booking_id}.` });
    return done('rebooked after late payment');
  }
  await payments.refund({ payment_id: event.payment_id, amount_cents: event.amount_cents, reason: 'hold expired and site no longer available' });
  rec.status = 'refunded'; rec.refunded_ms = deps.now();
  await saveBooking(deps.store, rec);
  try { await sendSms(deps, park, rec.mobile, SMS.refunded({ park, booking: { ...rec, site_name: rec.site_name } }), 'refund_notice', rec.call_sid); } catch (err) { deps.logger.warn('refund_sms_failed', { error: err.message }); }
  await alertStaff(deps, park, { kind: 'late_payment_refunded', summary: `Payment for ${rec.booking_ref} arrived after expiry and ${short(rec.site_name)} was taken; refunded ${event.amount_cents} cents. Customer ${rec.guest && rec.guest.name} ${rec.mobile}.` });
  return done('refunded: late payment, site unavailable');
}

async function notifyPaid(deps, park, rec, event) {
  try {
    await sendSms(deps, park, rec.mobile, SMS.confirmation({ park, booking: { booking_id: rec.booking_ref, site_name: rec.site_name, check_in: rec.check_in, check_out: rec.check_out, guest: rec.guest }, paidCents: event.amount_cents }), 'booking_confirmation', rec.call_sid);
  } catch (err) {
    deps.logger.error('confirmation_sms_failed', { booking_ref: rec.booking_ref, error: err.message });
    await alertStaff(deps, park, { kind: 'confirmation_sms_failed', summary: `Booking ${rec.booking_ref} is paid and confirmed but the confirmation text to ${rec.mobile} failed.` });
  }
  await alertStaff(deps, park, { kind: 'ai_booking_confirmed', summary: `Booking ${rec.booking_ref} paid and confirmed: ${short(rec.site_name)} ${rec.check_in} to ${rec.check_out}, ${rec.guest && rec.guest.name}.` });
}

module.exports = { handlePaymentWebhook };
