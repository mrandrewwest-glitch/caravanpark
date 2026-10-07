'use strict';

// Outbound SMS + staff alerts. sendSms throws so callers can decide how to react;
// alertStaff never throws (an alert failure must not break a caller's turn).
async function sendSms(deps, park, to, body, kind, callSid = null) {
  const res = await deps.sms.send({ park_id: park.id, from: park.sms_from, to, body, kind });
  await deps.ledger.addSms(callSid, res.segments);
  deps.logger.info('sms_sent', { park_id: park.id, kind, segments: res.segments });
  return res;
}

async function alertStaff(deps, park, alert) {
  try {
    await deps.notifier.notifyStaff(park, alert);
  } catch (err) {
    deps.logger.error('staff_alert_failed', { park_id: park.id, kind: alert.kind, error: err.message });
  }
}

module.exports = { sendSms, alertStaff };
