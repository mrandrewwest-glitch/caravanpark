'use strict';

// Twilio plumbing shared by voice and SMS: request signatures, TwiML, credentials.
//
// Every Twilio webhook (and the ConversationRelay WebSocket handshake) carries X-Twilio-Signature:
// base64(HMAC-SHA1(authToken, fullUrl + sortedParams)). We refuse anything that does not match, using the PUBLIC URL
// we configured (not whatever Host header arrived, which a proxy may rewrite).
const crypto = require('crypto');
const { loadJsonSecret } = require('./secrets');

function computeSignature(url, params, authToken) {
  let data = url;
  for (const k of Object.keys(params || {}).sort()) {
    const v = params[k];
    data += Array.isArray(v) ? v.slice().sort().map((x) => k + x).join('') : k + v;
  }
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// `urls` is a list of acceptable spellings of the same URL (Twilio's own docs suggest trying a trailing slash for
// WebSocket handshakes). All of them derive from OUR configured host, so accepting several costs nothing.
function validSignature({ urls, params, signature, authToken }) {
  if (!signature || !authToken) return false;
  return urls.some((u) => safeEqual(computeSignature(u, params, authToken), signature));
}

const XML = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => XML[c]);
const attrs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => ` ${k}="${esc(v)}"`).join('');

const twiml = {
  response: (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
  say: (text) => `<Say language="en-AU">${esc(text)}</Say>`,
  hangup: () => '<Hangup/>',
  relay: ({ url, action, greeting, language = 'en-AU', ttsProvider, voice, transcriptionProvider, hints, parameters = {} }) => {
    const params = Object.entries(parameters).map(([name, value]) => `<Parameter${attrs({ name, value })}/>`).join('');
    return `<Connect action="${esc(action)}"><ConversationRelay${attrs({ url, welcomeGreeting: greeting, language, ttsProvider, voice, transcriptionProvider, hints, interruptible: 'speech', dtmfDetection: 'false' })}>${params}</ConversationRelay></Connect>`;
  },
  dial: ({ number, callerId, action, timeout = 25 }) => `<Dial${attrs({ callerId, action, timeout, answerOnBridge: 'true' })}><Number>${esc(number)}</Number></Dial>`,
};

// Settings. Credentials come from TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN, or TWILIO_CREDENTIALS_REF
// (env:NAME / Secrets Manager ARN holding {"account_sid":"AC...","auth_token":"..."}).
function twilioConfig(env = process.env, overrides = {}) {
  if (overrides === false) return { enabled: false };
  const enabled = overrides.enabled ?? (env.TWILIO_ENABLED === 'true');
  const publicBaseUrl = String(overrides.publicBaseUrl || env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  let creds = null;
  const getCredentials = async () => {
    if (creds) return creds;
    let c = overrides.credentials || null;
    if (!c && env.TWILIO_CREDENTIALS_REF) c = await loadJsonSecret(env.TWILIO_CREDENTIALS_REF);
    if (!c && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) c = { account_sid: env.TWILIO_ACCOUNT_SID, auth_token: env.TWILIO_AUTH_TOKEN, api_key_sid: env.TWILIO_API_KEY_SID, api_key_secret: env.TWILIO_API_KEY_SECRET };
    if (!c) throw Object.assign(new Error('Twilio credentials are not configured (TWILIO_CREDENTIALS_REF, or TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)'), { code: 'CONFIG' });
    const bad = (m) => Object.assign(new Error(m), { code: 'CONFIG' });
    if (!/^AC[0-9a-f]{32}$/i.test(c.account_sid || '') && !overrides.allowAnySid) throw bad('Twilio account_sid looks wrong (expected AC followed by 32 hex characters)');
    // The Auth Token is what Twilio signs its webhooks with, so it is always required, even when texts are sent with an API key.
    if (!c.auth_token) throw bad('Twilio auth_token is missing (needed to check that webhooks really come from Twilio)');
    if (c.api_key_sid && !/^SK[0-9a-f]{32}$/i.test(c.api_key_sid)) throw bad('Twilio api_key_sid looks wrong (expected SK followed by 32 hex characters)');
    if (c.api_key_sid && !c.api_key_secret) throw bad('Twilio api_key_secret is missing');
    creds = c;
    return creds;
  };
  // Twilio data regions: an account/API key created in a region (such as Australia, "au1") only works through that
  // region's address, e.g. https://api.sydney.au1.twilio.com. Set TWILIO_REGION=au1 and TWILIO_EDGE=sydney.
  const region = overrides.region || env.TWILIO_REGION || '';
  const edge = overrides.edge || env.TWILIO_EDGE || (region === 'au1' ? 'sydney' : '');
  const regionalBase = region ? `https://api.${edge ? `${edge}.` : ''}${region}.twilio.com` : '';
  return {
    enabled, publicBaseUrl, getCredentials,
    apiBase: overrides.apiBase || env.TWILIO_API_BASE || regionalBase || 'https://api.twilio.com', region, edge,
    language: overrides.language || env.TWILIO_LANGUAGE || 'en-AU',
    ttsProvider: overrides.ttsProvider || env.TWILIO_TTS_PROVIDER || undefined,
    voice: overrides.voice || env.TWILIO_VOICE || undefined,
    transcriptionProvider: overrides.transcriptionProvider || env.TWILIO_STT_PROVIDER || undefined,
    // How long to let a closing sentence play before ending the session (the session is cut off when we send "end").
    endDelayMs: overrides.endDelayMs || ((text) => Math.min(15000, 1500 + String(text).length * 65)),
    maxCallMs: overrides.maxCallMs || 15 * 60 * 1000,
    maxTurns: overrides.maxTurns || 60,
    validate() {
      const errors = [];
      if (!/^https:\/\/[^/\s]+/.test(this.publicBaseUrl) && !(overrides.allowInsecure && /^http:\/\//.test(this.publicBaseUrl))) errors.push('PUBLIC_BASE_URL must be the public https address Twilio will call, such as https://calls.example.com');
      return errors;
    },
  };
}

module.exports = { computeSignature, validSignature, twiml, esc, twilioConfig };
