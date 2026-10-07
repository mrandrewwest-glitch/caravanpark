'use strict';

// MOCK staff notifier. Real implementation: SMS to park.staff.alert_numbers and/or email
// to park.staff.alert_emails. Alerts must be reliable: failures are logged by the caller.
function createMockNotifier() {
  const notifier = {
    kind: 'mock',
    alerts: [],
    async notifyStaff(park, alert) {
      notifier.alerts.push({ park_id: park.id, to: { numbers: park.staff.alert_numbers, emails: park.staff.alert_emails }, ...alert });
    },
  };
  return notifier;
}

module.exports = { createMockNotifier };
