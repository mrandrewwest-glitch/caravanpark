'use strict';

// MOCK SMS provider. The real one (Dialpad SMS or Twilio-style) must expose send();
// inbound handling and webhook verification come with the two-way SMS phase.
const segmentsFor = (body) => Math.max(1, Math.ceil(body.length / 160)); // approximation: GSM-7, no unicode handling

function createMockSmsProvider({ store = null } = {}) {
  let n = 0;
  const provider = {
    kind: 'mock',
    sent: [],
    failNext: 0, // simulate N provider failures

    async send({ park_id: parkId, from, to, body, kind }) {
      if (store && (await store.get(`suppression:${to}`))) {
        const e = new Error('Recipient has opted out');
        e.code = 'SUPPRESSED';
        throw e;
      }
      if (provider.failNext > 0) {
        provider.failNext -= 1;
        throw new Error('SMS provider error');
      }
      n += 1;
      const msg = { id: `sms_${n}`, park_id: parkId, from, to, body, kind, segments: segmentsFor(body) };
      provider.sent.push(msg);
      return { id: msg.id, segments: msg.segments };
    },
  };
  return provider;
}

module.exports = { createMockSmsProvider, segmentsFor };
