'use strict';

// MOCK hosted-payment provider (Stripe Checkout / Payment Links shaped).
// Card details never touch OnSite: we only create a link and receive a signed webhook.
const crypto = require('crypto');

const sign = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

function createMockPaymentProvider({ webhookSecret }) {
  let n = 0;
  const provider = {
    kind: 'mock',
    links: [],
    refunds: [],
    failNext: 0,

    async createPaymentLink({ park_id: parkId, booking_ref: bookingRef, amount_cents: amountCents, currency, description, expires_at: expiresAt }) {
      if (provider.failNext > 0) {
        provider.failNext -= 1;
        throw new Error('Payment provider error');
      }
      n += 1;
      const link = { id: `pl_${n}`, url: `https://pay.mock.onsite.test/pl_${n}`, park_id: parkId, booking_ref: bookingRef, amount_cents: amountCents, currency, description, expires_at: expiresAt };
      provider.links.push(link);
      return structuredClone(link);
    },

    verifyWebhook(rawBody, signature) {
      if (!rawBody || !signature) return false;
      const expected = Buffer.from(sign(webhookSecret, rawBody));
      const given = Buffer.from(String(signature));
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    },

    async refund({ payment_id: paymentId, amount_cents: amountCents, reason }) {
      const r = { id: `re_${provider.refunds.length + 1}`, payment_id: paymentId, amount_cents: amountCents, reason };
      provider.refunds.push(r);
      return r;
    },

    // Test helper: what the provider would POST to /payment-webhook after the customer pays.
    simulatePayment(link, { eventId, amountCents, type = 'payment.succeeded' } = {}) {
      const event = {
        id: eventId || `evt_${link.id}`, type, park_id: link.park_id, booking_ref: link.booking_ref,
        payment_id: `pay_${link.id}`, amount_cents: amountCents ?? link.amount_cents, currency: link.currency,
      };
      const raw = JSON.stringify(event);
      return { raw, headers: { 'content-type': 'application/json', 'x-onsite-signature': sign(webhookSecret, raw) } };
    },
  };
  return provider;
}

module.exports = { createMockPaymentProvider, sign };
