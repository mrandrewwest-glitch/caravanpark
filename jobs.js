'use strict';

const { withLock } = require('./util');
const { SMS } = require('./messages');
const { sendSms } = require('./comms');

// Scheduled work (EventBridge rate(5 minutes) in production; POST /admin/jobs/run in dev/tests).

async function expireHolds(deps) {
  const now = deps.now();
  const result = { released: [], reminded: [], errors: [] };
  for (const snapshot of await deps.store.list('bookings:')) {
    if (snapshot.status !== 'held') continue;
    const park = await deps.registry.get(snapshot.park_id);
    if (!park) continue;
    const recKey = `bookings:${snapshot.park_id}:${snapshot.booking_ref}`;
    await withLock(recKey, async () => {
      const rec = await deps.store.get(recKey); // re-read under the lock: a payment may have just landed
      if (!rec || rec.status !== 'held') return;
      const booking = { booking_id: rec.booking_ref, site_name: rec.site_name, check_in: rec.check_in, check_out: rec.check_out };
      try {
        if (now >= rec.hold_expires_ms) {
          await deps.providers.newbook(park).releaseBooking(rec.booking_ref, 'hold expired unpaid');
          rec.status = 'expired'; rec.expired_ms = now;
          await deps.store.set(recKey, rec);
          result.released.push(rec.booking_ref);
          if (rec.mobile) await sendSms(deps, park, rec.mobile, SMS.expired({ park, booking }), 'hold_expired', rec.call_sid).catch((e) => deps.logger.warn('expiry_sms_failed', { error: e.message }));
        } else if (!rec.reminder_sent && rec.payment_link && !rec.sms_failed && rec.hold_minutes >= 30 && now >= rec.created_ms + (rec.hold_expires_ms - rec.created_ms) / 2) {
          rec.reminder_sent = true;
          await deps.store.set(recKey, rec);
          result.reminded.push(rec.booking_ref);
          await sendSms(deps, park, rec.mobile, SMS.reminder({ park, booking, url: rec.payment_link.url, minutesLeft: Math.max(1, Math.round((rec.hold_expires_ms - now) / 60000)) }), 'hold_reminder', rec.call_sid).catch((e) => deps.logger.warn('reminder_sms_failed', { error: e.message }));
        }
      } catch (err) {
        // Leave it 'held' so the next run retries (e.g. NewBook down).
        deps.logger.error('hold_expiry_failed', { booking_ref: rec.booking_ref, error: err.message });
        result.errors.push({ booking_ref: rec.booking_ref, error: err.message });
      }
    });
  }
  return result;
}

async function runAll(deps) {
  const holds = await expireHolds(deps);
  const finalized = await deps.ledger.finalizeIdle(deps.registry);
  return { holds, calls_finalized: finalized.length };
}

module.exports = { expireHolds, runAll };
