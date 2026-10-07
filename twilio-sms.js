'use strict';

// Real SMS through Twilio's Messages API. Same interface as the mock: send({park_id, from, to, body, kind}) ->
// {id, segments}. Never retried here: a retry after a lost response could text the caller twice.
//
// AUSTRALIA: Twilio's Australian LOCAL (landline-style) numbers are voice-only. A park's `sms_from` must be an
// SMS-capable Australian mobile number or a registered alphanumeric sender ID. Check what Twilio allows for your
// account before choosing; the provider just passes `from` through.
const { segmentsFor } = require('./sms-provider');
const repos = require('./repos');

const OPTED_OUT = 21610; // "Attempt to send to unsubscribed recipient"

function createTwilioSmsProvider({ tw, store = null, fetchImpl = fetch, timeoutMs = 6000, logger = null }) {
  return {
    kind: 'twilio',
    async send({ park_id: parkId, from, to, body }) {
      if (store && (await store.get(repos.keys.suppression(to)))) throw Object.assign(new Error('Recipient has opted out'), { code: 'SUPPRESSED' });
      const creds = await tw.getCredentials();
      const sid = creds.account_sid;
      // An API key (SK...) is the safer way to send: it can be revoked without touching the account's Auth Token.
      const user = creds.api_key_sid || sid; const secret = creds.api_key_sid ? creds.api_key_secret : creds.auth_token;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${tw.apiBase}/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
          signal: ctl.signal,
        });
      } catch (err) {
        throw Object.assign(new Error(err.name === 'AbortError' ? 'Twilio SMS timed out' : `Twilio SMS failed: ${err.message}`), { code: 'SMS_UNREACHABLE' });
      } finally { clearTimeout(timer); }
      let json = null;
      try { json = await res.json(); } catch { /* not JSON */ }
      if (!res.ok || !json || !json.sid) {
        if (json && json.code === OPTED_OUT && store) {
          await store.set(repos.keys.suppression(to), { at: Date.now(), via: 'twilio_21610' });
          throw Object.assign(new Error('Recipient has opted out'), { code: 'SUPPRESSED' });
        }
        if (logger) logger.warn('twilio_sms_rejected', { park_id: parkId, status: res.status, twilio_code: json && json.code });
        throw Object.assign(new Error(`Twilio rejected the text (${res.status}${json && json.code ? `, code ${json.code}` : ''})`), { code: 'SMS_REJECTED', twilioCode: json && json.code });
      }
      return { id: json.sid, segments: Number(json.num_segments) || segmentsFor(body) };
    },
  };
}

module.exports = { createTwilioSmsProvider };
