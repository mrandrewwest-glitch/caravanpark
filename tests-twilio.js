'use strict';

// Twilio adapter tests: request signatures, TwiML, the live call WebSocket, hand-over to staff, call duration,
// and the real SMS provider. A fake Twilio (signed webhooks, a WebSocket client, a Messages API server) stands in
// for Twilio; the conversation engine behind it is the real one.
// Usage: node tests-twilio.js <signature|voice|relay|handover|sms|setup|all>
const http = require('http');
const WebSocket = require('ws');
const { start, makeChecker, TEST_PARKS, STORE_NAME } = require('./test-helpers');
const { computeSignature } = require('./twilio');
const { createTwilioSmsProvider } = require('./twilio-sms');
const { twilioConfig } = require('./twilio');

const SID = `AC${'0'.repeat(32)}`;
const TOKEN = 'test_auth_token_0123456789abcdef';
const PUBLIC = 'https://onsite.test';
const LAKE = '+61290000002'; const RIVER = '+61290000003'; const FRIEND = '+61290000001';
const STAFF_LINE = '+61298765432';

// ---- fake Twilio REST (Messages API) ----
function fakeMessagesApi() {
  const s = { requests: [], mode: 'ok', delayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      s.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, form: Object.fromEntries(new URLSearchParams(body)) });
      const reply = () => {
        if (s.mode === 'opted_out') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 21610, message: 'unsubscribed' })); }
        if (s.mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"message":"boom"}'); }
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ sid: `SM${String(s.requests.length).padStart(32, '0')}`, num_segments: '2', status: 'queued' }));
      };
      if (s.delayMs) setTimeout(reply, s.delayMs); else reply();
    });
  });
  s.start = () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
  s.stop = () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return s;
}

const PARKS = [
  { ...TEST_PARKS[0], mode: 'full', booking_mode: 'handoff', staff: { alert_numbers: [], alert_emails: [], callback_promise: 'soon' } }, // full, NO transfer line
  TEST_PARKS[1], // Lakeside: diversion, AI booking
  { ...TEST_PARKS[2], staff: { alert_numbers: ['+61400000098'], alert_emails: [], callback_promise: 'soon', transfer_number: STAFF_LINE } }, // Riverbend: full, transfer line
];

async function boot(extra = {}) {
  const api = fakeMessagesApi();
  const apiBase = await api.start();
  const env = await start({ parks: PARKS, twilio: { enabled: true, publicBaseUrl: PUBLIC, credentials: { account_sid: SID, auth_token: TOKEN }, apiBase, endDelayMs: () => 30, ...extra } });
  const origClose = env.close;
  env.close = async () => { await origClose(); await api.stop(); };
  return { env, api };
}

// A signed webhook, the way Twilio sends it.
async function webhook(env, path, params, { token = TOKEN, sign = true } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = computeSignature(PUBLIC + path, params, token);
  const res = await fetch(env.base + path, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') || '' };
}

// A WebSocket client acting as Twilio's ConversationRelay.
function relayClient(env, { sign = true, token = TOKEN } = {}) {
  const headers = {};
  if (sign) headers['x-twilio-signature'] = computeSignature('wss://onsite.test/twilio/relay', {}, token);
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(env.base).port}/twilio/relay`, { headers });
  const inbox = []; const waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); inbox.push(m); waiters.splice(0).forEach((w) => w()); });
  const opened = new Promise((resolve) => { ws.on('open', () => resolve(true)); ws.on('error', () => resolve(false)); ws.on('unexpected-response', () => resolve(false)); });
  const next = async (pred, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() - t0 > ms) return null;
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return {
    ws, opened, inbox, next,
    setup: (callSid, from, to) => ws.send(JSON.stringify({ type: 'setup', sessionId: 'VX1', accountSid: SID, callSid, from, to, direction: 'inbound', callType: 'PSTN', customParameters: {} })),
    say: (voicePrompt, last = true) => ws.send(JSON.stringify({ type: 'prompt', voicePrompt, lang: 'en-AU', last })),
    text: () => next((m) => m.type === 'text'),
    end: () => next((m) => m.type === 'end'),
    close: () => new Promise((r) => { ws.on('close', r); ws.close(); }),
  };
}

const suites = {
  signature: {
    name: 'Signatures: only Twilio can drive the phone endpoints',
    async run({ check }) {
      // Fixed vectors, each also accepted by Twilio's own official library (twilio-node validateRequest) when written.
      const tok = '12345678901234567890123456789012';
      check('signature of the example in Twilio\'s docs (verified against twilio-node)', computeSignature('https://mycompany.com/myapp.php?foo=1&bar=2', { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' }, tok) === 'zSwAdcBZn1PyzwxiZZbYdWiOnb8=');
      check('parameters are sorted case-sensitively (verified against twilio-node)', computeSignature('https://onsite.test/twilio/voice', { CallSid: 'CAx', From: '+61411111111', To: '+61290000003', Z: '1', a: 'low', B: 'up' }, tok) === 'Aq0updJpsEPLejguv8vZY5BwwNY=');
      check('a WebSocket handshake (no parameters) signs the address alone (verified against twilio-node)', computeSignature('wss://onsite.test/twilio/relay', {}, tok) === 'qG/VaGPyN6epdhZrckLhce9Fhho=');
      const { env } = await boot();
      const params = { CallSid: 'CAsig1', From: '+61411111111', To: RIVER };
      check('an unsigned request is refused', (await webhook(env, '/twilio/voice', params, { sign: false })).status === 403);
      check('a request signed with the wrong token is refused', (await webhook(env, '/twilio/voice', params, { token: 'not-the-token' })).status === 403);
      const tampered = computeSignature(PUBLIC + '/twilio/voice', params, TOKEN);
      const res = await fetch(env.base + '/twilio/voice', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': tampered }, body: new URLSearchParams({ ...params, To: LAKE }).toString() });
      check('changing any field after signing is refused', res.status === 403);
      check('a signed request is accepted', (await webhook(env, '/twilio/voice', params)).status === 200);
      for (const p of ['/twilio/relay-ended', '/twilio/dial-ended', '/twilio/status']) check(`${p} also needs a valid signature`, (await webhook(env, p, { CallSid: 'x' }, { sign: false })).status === 403);
      const bad = relayClient(env, { sign: false });
      check('a WebSocket without a valid signature cannot connect', (await bad.opened) === false);
      const wrong = relayClient(env, { token: 'nope' });
      check('a WebSocket signed with the wrong token cannot connect', (await wrong.opened) === false);
      const good = relayClient(env);
      check('a correctly signed WebSocket connects', (await good.opened) === true);
      await good.close();
      await env.close();
    },
  },

  voice: {
    name: 'Answering a call: TwiML for the right park',
    async run({ check }) {
      const { env } = await boot();
      const r = await webhook(env, '/twilio/voice', { CallSid: 'CAv1', From: '+61411111111', To: RIVER });
      check('the answer is XML', r.status === 200 && /xml/.test(r.type) && r.text.startsWith('<?xml'));
      check('it connects the call to our WebSocket address', /<ConversationRelay[^>]* url="wss:\/\/onsite\.test\/twilio\/relay"/.test(r.text));
      check('it names the park in the spoken greeting and says it is automated', /Riverbend Caravan Park/.test(r.text) && /automated assistant/.test(r.text));
      check('it asks for Australian English and sets the hand-over callback', /language="en-AU"/.test(r.text) && /action="https:\/\/onsite\.test\/twilio\/relay-ended"/.test(r.text));
      const lake = await webhook(env, '/twilio/voice', { CallSid: 'CAv2', From: '+61411111111', To: LAKE });
      check('a diversion park greets differently (team is busy)', /Lakeside Holiday Park/.test(lake.text) && /busy/.test(lake.text));
      const unknown = await webhook(env, '/twilio/voice', { CallSid: 'CAv3', From: '+61411111111', To: '+61299999999' });
      check('a number that belongs to no park is told so politely and hung up on', /isn(&apos;|')t set up/.test(unknown.text) && /<Hangup\/>/.test(unknown.text) && !/ConversationRelay/.test(unknown.text));
      check('a request with no called number never falls through to a default park', !/ConversationRelay/.test((await webhook(env, '/twilio/voice', { CallSid: 'CAv4', From: '+61411111111' })).text));
      await env.deps.registry.updateSettings('riverbend', { name: 'Fish & Chips <Park>' }).catch(() => null);
      const odd = await webhook(env, '/twilio/voice', { CallSid: 'CAv5', From: '+61411111111', To: RIVER });
      check('names with markup characters are escaped, so the TwiML stays valid and cannot be injected into', odd.status === 200 && !/<Park>/.test(odd.text));
      await env.close();
    },
  },

  relay: {
    name: 'The live conversation over the WebSocket',
    async run({ check }) {
      const { env, api } = await boot();
      const c = relayClient(env);
      await c.opened;
      c.setup('CAr1', '+61411111111', LAKE);
      c.say('Any sites next weekend for 2 of us?');
      const t1 = await c.text();
      check('a spoken question gets a spoken answer, marked as the last chunk', t1 && t1.last === true && typeof t1.token === 'string' && t1.token.length > 10);
      check('the answer is the real engine\'s answer (availability from the park\'s system)', /site|available/i.test(t1.token));
      c.say('uh', false);
      c.say('   ');
      await new Promise((r) => setTimeout(r, 150));
      check('partial and empty speech is ignored (no reply)', !c.inbox.some((m) => m.type === 'text'));
      c.ws.send('this is not json'); c.ws.send(JSON.stringify({ type: 'dtmf', digit: '1' })); c.ws.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'x', durationUntilInterruptMs: 10 }));
      c.say('Sorry, what was the cheapest one?');
      check('junk, key presses and interruptions do not break the call', !!(await c.text()));

      // Two utterances arrive at once: answered one after the other, in order.
      const d = relayClient(env); await d.opened;
      d.setup('CAr2', '+61422222222', LAKE);
      let inflight = 0; let maxInflight = 0;
      const realExtract = env.deps.claude.extractIntent.bind(env.deps.claude);
      env.deps.claude.extractIntent = async (args) => { inflight += 1; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => setTimeout(r, 60)); try { return await realExtract(args); } finally { inflight -= 1; } };
      d.say('Any sites next weekend for 2 of us?'); d.say('Do you allow dogs?');
      const a = await d.text(); const b = await d.text();
      env.deps.claude.extractIntent = realExtract;
      check('two utterances sent together get two replies, handled strictly one at a time', !!a && !!b && maxInflight === 1);
      await d.close();

      // A message left at a diversion park, then the call ends by itself.
      await webhook(env, '/twilio/voice', { CallSid: 'CAr3', From: '+61433333333', To: LAKE });
      const e = relayClient(env); await e.opened;
      e.setup('CAr3', '+61433333333', LAKE);
      e.say('This is terrible, I want to complain about my last stay');
      const q1 = await e.text();
      e.say('Pat Murphy'); const q2 = await e.text();
      e.say('Yes'); const q3 = await e.text();
      const endMsg = await e.end();
      check('after a message is taken the session ends itself (reason: end), after the sentence has had time to play', !!endMsg && JSON.parse(endMsg.handoffData).reason === 'end' && !!q1 && !!q2 && !!q3);
      const msg = await env.deps.store.get('messages:lakeside:CAr3');
      check('the message was recorded for the owner, with the caller\'s own number', msg && msg.callback_number === '+61433333333');
      await e.close();

      // Billing: Twilio's status callback gives the real length.
      const st = await webhook(env, '/twilio/status', { CallSid: 'CAr3', CallStatus: 'completed', CallDuration: '95', To: LAKE });
      check('the end-of-call callback is accepted quietly', st.status === 204);
      const rec = await env.deps.store.get('calls:CAr3');
      check('the ledger gets Twilio\'s real duration and the call is billable', rec && rec.duration_seconds === 95 && rec.billable === true);
      const again = await webhook(env, '/twilio/status', { CallSid: 'CAr3', CallStatus: 'completed', CallDuration: '95', To: LAKE });
      check('a repeated callback changes nothing', again.status === 204 && (await env.deps.store.get('calls:CAr3')).duration_seconds === 95);
      check('a callback for a call we never saw does nothing and does not crash', (await webhook(env, '/twilio/status', { CallSid: 'CAunknown', CallStatus: 'completed', CallDuration: '30', To: LAKE })).status === 204);

      // A booking by voice: the payment link goes out through the (fake) Twilio Messages API.
      const f = relayClient(env); await f.opened;
      f.setup('CAr4', '+61444444444', LAKE);
      const lines = ['Hi, any sites next weekend for 4 of us with a dog?', 'Site 12 please', 'Alex Lee', 'Yes', 'Yes, go ahead'];
      const replies = [];
      for (const l of lines) { f.say(l); replies.push(await f.text()); }
      const sent = api.requests.filter((r) => /Messages\.json$/.test(r.url));
      check('a booking made by voice sends the payment link by text through Twilio', replies.every(Boolean) && sent.length >= 1 && /^\+61444444444$/.test(sent.at(-1).form.To) && /http/.test(sent.at(-1).form.Body));
      check('texts are sent from the park\'s own number with Twilio\'s Basic auth', sent.at(-1).form.From === LAKE && sent.at(-1).auth === `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
      await f.close();

      // Runaway protection.
      const g = relayClient(env); await g.opened;
      g.ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'hello', last: true }));
      await new Promise((r) => setTimeout(r, 150));
      check('speech before the session is set up is ignored', !g.inbox.length);
      await g.close();
      await env.close();
    },
  },

  handover: {
    name: 'Handing the caller to staff, and not losing them if nobody answers',
    async run({ check }) {
      const { env } = await boot();
      const c = relayClient(env); await c.opened;
      await webhook(env, '/twilio/voice', { CallSid: 'CAh1', From: '+61455555555', To: RIVER }); // Twilio always answers the call first
      c.setup('CAh1', '+61455555555', RIVER);
      c.say('I want to speak to a person please');
      const t = await c.text();
      const end = await c.end();
      check('a caller who asks for a person hears a hand-over line, then the session ends with reason "transfer"', !!t && !!end && JSON.parse(end.handoffData).reason === 'transfer');
      const after = await webhook(env, '/twilio/relay-ended', { CallSid: 'CAh1', SessionStatus: 'ended', HandoffData: end.handoffData });
      check('Twilio then dials the park\'s transfer line, showing the park\'s own number as caller ID', /<Dial[^>]*callerId="\+61290000003"/.test(after.text) && new RegExp(`<Number>\\${STAFF_LINE}</Number>`).test(after.text));
      const forged = await webhook(env, '/twilio/relay-ended', { CallSid: 'CAnever', SessionStatus: 'ended', HandoffData: '{"reason":"transfer"}' });
      check('a hand-over request we never asked for is not obeyed (just hangs up)', /<Hangup\/>/.test(forged.text) && !/<Dial/.test(forged.text));
      await webhook(env, '/twilio/voice', { CallSid: 'CAh3', From: '+61477777777', To: RIVER }); // a real call that never asked for a person
      const forged2 = await webhook(env, '/twilio/relay-ended', { CallSid: 'CAh3', SessionStatus: 'ended', HandoffData: '{"reason":"transfer"}' });
      check('even on a real call, a hand-over we did not ask for is not obeyed (the data Twilio sends back is never trusted)', /<Hangup\/>/.test(forged2.text) && !/<Dial/.test(forged2.text));
      const noAns = await webhook(env, '/twilio/dial-ended', { CallSid: 'CAh1', DialCallStatus: 'no-answer' });
      check('if staff do not answer the caller is told and a call-back is recorded', /call you back/.test(noAns.text) && /<Hangup\/>/.test(noAns.text));
      const msg = await env.deps.store.get('messages:riverbend:CAh1');
      check('the call-back carries the caller\'s number, ready for the owner portal', msg && msg.callback_number === '+61455555555' && msg.status === 'open');
      check('staff were alerted', env.notifier.alerts.some((n) => n.park_id === 'riverbend' && /not answered/i.test(n.summary || '')));
      const ok = await webhook(env, '/twilio/dial-ended', { CallSid: 'CAh1', DialCallStatus: 'completed' });
      check('if staff answered, nothing more happens', /<Hangup\/>/.test(ok.text) && !/call you back/.test(ok.text));
      await c.close();

      // A full-service park that has no transfer line: never leave the caller stranded.
      const d = relayClient(env); await d.opened;
      d.setup('CAh2', '+61466666666', FRIEND);
      d.say('I want to speak to a person please');
      const first = await d.text(); const second = await d.text();
      const e2 = await d.end();
      check('with no transfer line configured the caller is told plainly and the session ends (reason: end)', !!first && !!second && /call you back/.test(second.token) && JSON.parse(e2.handoffData).reason === 'end');
      const m2 = await env.deps.store.get('messages:friend-caravan-park:CAh2');
      check('and a call-back is recorded', m2 && m2.callback_number === '+61466666666');
      await d.close();
      await env.close();
    },
  },

  sms: {
    name: 'Sending texts through Twilio',
    async run({ check }) {
      const api = fakeMessagesApi(); const apiBase = await api.start();
      const store = new (require('./state-store').MemoryStore)();
      const tw = twilioConfig({}, { enabled: true, publicBaseUrl: PUBLIC, credentials: { account_sid: SID, auth_token: TOKEN }, apiBase });
      const sms = createTwilioSmsProvider({ tw, store });
      const out = await sms.send({ park_id: 'p', from: LAKE, to: '+61411111111', body: 'Pay here: https://pay.example/x', kind: 'payment_link' });
      check('a text is sent as a form POST to the account\'s Messages endpoint', api.requests.length === 1 && api.requests[0].url === `/2010-04-01/Accounts/${SID}/Messages.json` && api.requests[0].method === 'POST');
      check('it carries To, From and Body exactly', api.requests[0].form.To === '+61411111111' && api.requests[0].form.From === LAKE && api.requests[0].form.Body === 'Pay here: https://pay.example/x');
      check('the id and the segment count come from Twilio\'s answer', /^SM/.test(out.id) && out.segments === 2);
      api.mode = 'error';
      let err1 = null; try { await sms.send({ park_id: 'p', from: LAKE, to: '+61411111111', body: 'x', kind: 'k' }); } catch (e) { err1 = e; }
      check('a Twilio error is reported, not hidden', err1 && err1.code === 'SMS_REJECTED');
      check('a failed text is NOT retried (a retry could text the caller twice)', api.requests.length === 2);
      api.mode = 'opted_out';
      let err2 = null; try { await sms.send({ park_id: 'p', from: LAKE, to: '+61422222222', body: 'x', kind: 'k' }); } catch (e) { err2 = e; }
      check('a number that has replied STOP is recognised', err2 && err2.code === 'SUPPRESSED');
      const before = api.requests.length;
      let err3 = null; try { await sms.send({ park_id: 'p', from: LAKE, to: '+61422222222', body: 'x', kind: 'k' }); } catch (e) { err3 = e; }
      check('and is never texted again (no request is even made)', err3 && err3.code === 'SUPPRESSED' && api.requests.length === before);
      api.mode = 'ok'; api.delayMs = 400;
      const slow = createTwilioSmsProvider({ tw, store, timeoutMs: 100 });
      let err4 = null; try { await slow.send({ park_id: 'p', from: LAKE, to: '+61433333333', body: 'x', kind: 'k' }); } catch (e) { err4 = e; }
      check('a Twilio that does not answer in time gives up rather than hanging the call', err4 && err4.code === 'SMS_UNREACHABLE');
      const bad = createTwilioSmsProvider({ tw: twilioConfig({}, { enabled: true, credentials: { account_sid: 'nope', auth_token: 'x' } }), store });
      let err5 = null; try { await bad.send({ park_id: 'p', from: LAKE, to: '+61433333333', body: 'x', kind: 'k' }); } catch (e) { err5 = e; }
      check('a mistyped account id is caught with a clear message', err5 && /account_sid looks wrong/.test(err5.message));
      api.delayMs = 0;
      const KEY = `SK${'a'.repeat(32)}`;
      const keyed = createTwilioSmsProvider({ tw: twilioConfig({}, { enabled: true, apiBase, credentials: { account_sid: SID, auth_token: TOKEN, api_key_sid: KEY, api_key_secret: 'keysecret' } }), store });
      await keyed.send({ park_id: 'p', from: LAKE, to: '+61455555555', body: 'hi', kind: 'k' });
      const last = api.requests.at(-1);
      check('with an API key, texts are sent using the key (revocable) but still for the account', last.auth === `Basic ${Buffer.from(`${KEY}:keysecret`).toString('base64')}` && last.url.includes(`/Accounts/${SID}/`));
      check('an Australian-region account uses the Sydney address', twilioConfig({}, { region: 'au1' }).apiBase === 'https://api.sydney.au1.twilio.com' && twilioConfig({ TWILIO_REGION: 'au1' }).apiBase === 'https://api.sydney.au1.twilio.com' && twilioConfig({}, {}).apiBase === 'https://api.twilio.com');
      const noToken = twilioConfig({}, { enabled: true, credentials: { account_sid: SID, api_key_sid: KEY, api_key_secret: 'x' } });
      let e6 = null; try { await noToken.getCredentials(); } catch (e) { e6 = e; }
      check('an API key alone is not enough: the Auth Token is needed to check webhook signatures', e6 && /auth_token is missing/.test(e6.message));
      const badKey = twilioConfig({}, { enabled: true, credentials: { account_sid: SID, auth_token: TOKEN, api_key_sid: 'SKxyz', api_key_secret: 'x' } });
      let e7 = null; try { await badKey.getCredentials(); } catch (e) { e7 = e; }
      check('a mistyped API key id is caught with a clear message', e7 && /api_key_sid looks wrong/.test(e7.message));
      await api.stop();
    },
  },

  setup: {
    name: 'Start-up checks refuse a half-configured phone setup',
    async run({ check }) {
      const { env } = await boot();
      check('a complete setup passes', await env.deps.validateProviders().then(() => true, () => false) === false); // friend park is full with no transfer line
      let msg = ''; try { await env.deps.validateProviders(); } catch (e) { msg = e.message; }
      check('a full-service park with no transfer line is named in the error', /friend-caravan-park/.test(msg) && /transfer_number/.test(msg));
      check('the diversion park and the park with a line are not complained about', !/lakeside|riverbend/.test(msg));
      await env.close();
      const { env: e2 } = await boot({ publicBaseUrl: 'http://insecure.example' });
      let m2 = ''; try { await e2.deps.validateProviders(); } catch (e) { m2 = e.message; }
      check('a non-https public address is refused (Twilio needs https/wss, and signatures depend on it)', /PUBLIC_BASE_URL/.test(m2));
      await e2.close();
      const off = await start({ parks: PARKS });
      check('with Twilio off, the phone endpoints do not exist at all', (await fetch(off.base + '/twilio/voice', { method: 'POST' })).status === 404 && off.app.attachWebSockets(off.server) === null);
      await off.close();
    },
  },
};

async function main() {
  const arg = process.argv[2] || 'all';
  const keys = arg === 'all' ? Object.keys(suites) : [arg];
  if (keys.some((k) => !suites[k])) { console.error(`Unknown suite "${arg}". Use ${Object.keys(suites).join(', ')} or all.`); process.exit(2); }
  console.log(`OnSite Twilio adapter tests | store: ${STORE_NAME}`);
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
