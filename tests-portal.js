'use strict';

// Owner portal tests: sign-in security, tenant isolation, data accuracy, settings, billing, security headers.
// Everything goes through the real HTTP API of the real app (mock providers, in-memory or DynamoDB store).
// Usage: node tests-portal.js <auth|tenancy|data|static|all>
process.env.TRUST_PROXY = '1'; // so each test client can present its own address via X-Forwarded-For
const { start, makeChecker, NUMBERS, STORE_NAME } = require('./test-helpers');
const { createMockEmailer } = require('./emailer');
const { parseCookies } = require('./portal-api');

const HOUR = 3600e3;
const MIN = 60e3;

// A browser-like client with a cookie jar and its own network address.
function client(env, ip = '203.0.113.7') {
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const headers = { 'x-forwarded-for': ip, 'x-requested-with': 'onsite-portal', ...extra };
    if (body !== undefined && !('content-type' in headers)) headers['content-type'] = 'application/json';
    if (cookie && !('cookie' in headers)) headers.cookie = cookie;
    const res = await fetch(env.base + path, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const sc = setCookie.find((c) => c.startsWith('onsite_session='));
    if (sc) { const v = sc.split(';')[0]; cookie = v === 'onsite_session=' ? null : v; }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers, setCookie };
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

async function boot(overrides = {}) {
  const emailer = createMockEmailer();
  const env = await start({ emailer, ...overrides });
  const addr = env.app.listen ? null : null; void addr;
  // start() already listens; recover its base URL from a probe request path
  return { env, emailer };
}

const lastCode = (emailer, to) => { const m = emailer.sent.filter((e) => e.to === to).at(-1); return m ? /(\d{6})/.exec(m.text)[1] : null; };

async function signIn(c, emailer, email) {
  await c.call('POST', '/portal/api/auth/request', { email });
  const code = lastCode(emailer, email);
  return c.call('POST', '/portal/api/auth/verify', { email, code });
}

const say = (env, sid, text, { phone = '+61412345678', called = NUMBERS.lakeside } = {}) => env.post('/phone-callback', { call_sid: sid, transcript: text, caller_phone: phone, called_number: called, confidence: 0.95 });
async function book(env, sid, { called = NUMBERS.lakeside, phone = '+61412345678', name = 'Sam Taylor', site = 12, dates = 'Oct 10 to 15' } = {}) {
  for (const t of [`Hi, any sites ${dates} for 4 of us with a dog?`, `Site ${site} please`, name, 'Yes', 'Yes, go ahead']) await say(env, sid, t, { phone, called });
}
const endCall = (env, sid, seconds, called = NUMBERS.lakeside) => env.post('/call-ended', { call_sid: sid, called_number: called, duration_seconds: seconds });

// Two parks, a user each, and a day of real traffic in each.
async function seeded() {
  const { env, emailer } = await boot();
  const A = NUMBERS.lakeside; const B = NUMBERS.riverbend;
  await env.admin('POST', '/portal-users', { email: 'owner@lakeside.example', park_id: 'lakeside', name: 'Lee Lakeside' });
  await env.admin('POST', '/portal-users', { email: 'staff@lakeside.example', park_id: 'lakeside', name: 'Sam Staff' });
  await env.admin('POST', '/portal-users', { email: 'owner@riverbend.example', park_id: 'riverbend', name: 'Rae Riverbend' });
  // Lakeside: a paid booking, an unpaid hold, a left message, spam, a very short call.
  await book(env, 'la-1', { name: 'Sam Taylor' });
  await endCall(env, 'la-1', 140);
  const pay = await env.pay('lakeside');
  const { raw, headers } = pay.simulatePayment(pay.links.at(-1));
  await env.post('/payment-webhook', raw, headers);
  await book(env, 'la-2', { name: 'Alex Lee', dates: 'Nov 3 to 6', phone: '+61422222222' });
  await endCall(env, 'la-2', 150);
  await say(env, 'la-3', 'This is terrible, I want to complain about my last stay', { phone: '+61433333333' });
  await say(env, 'la-3', 'Jo Smith', { phone: '+61433333333' });
  await say(env, 'la-3', 'Yes', { phone: '+61433333333' });
  await endCall(env, 'la-3', 70);
  await say(env, 'la-4', 'Hi, this is about your extended warranty', { phone: '+61444444444' });
  await endCall(env, 'la-4', 20);
  await say(env, 'la-5', 'Any sites Oct 10 to 15?', { phone: '+61455555555' });
  await endCall(env, 'la-5', 6);
  // Riverbend: a held booking and a call.
  await book(env, 'rb-1', { called: B, site: 1, name: 'Riley Brown', phone: '+61466666666' });
  await endCall(env, 'rb-1', 130, B);
  await say(env, 'rb-2', 'Any sites Oct 10 to 15 for 2 of us?', { phone: '+61477777777', called: B });
  await endCall(env, 'rb-2', 60, B);
  void A;
  return { env, emailer };
}

const suites = {
  auth: {
    name: 'Portal sign-in: codes, sessions, limits, cross-site protection, headers',
    async run({ check }) {
      const { env, emailer } = await boot();
      const ok = await env.admin('POST', '/portal-users', { email: 'Owner@Lakeside.example ', park_id: 'lakeside', name: 'Lee' });
      check('operator creates an owner account (email normalised to lowercase)', ok.status === 201 && ok.body.email === 'owner@lakeside.example');
      check('creating accounts needs the operator token', (await env.request('POST', '/admin/portal-users', { email: 'x@y.example', park_id: 'lakeside' })).status === 401);
      check('bad email / unknown park are refused', (await env.admin('POST', '/portal-users', { email: 'nope', park_id: 'lakeside' })).status === 400 && (await env.admin('POST', '/portal-users', { email: 'z@z.example', park_id: 'nowhere' })).status === 400);
      check('one email cannot belong to two parks', (await env.admin('POST', '/portal-users', { email: 'owner@lakeside.example', park_id: 'riverbend' })).status === 400);

      const c = client(env);
      const reg = await c.call('POST', '/portal/api/auth/request', { email: 'owner@lakeside.example' });
      const unk = await c.call('POST', '/portal/api/auth/request', { email: 'stranger@nowhere.example' });
      const bad = await c.call('POST', '/portal/api/auth/request', { email: 'not an email' });
      check('a registered and an unregistered address get the identical answer (no way to discover who is registered)', reg.status === 200 && unk.status === 200 && bad.status === 200 && reg.body.message === unk.body.message && reg.body.message === bad.body.message);
      check('only the registered address receives an email, with a 6-digit code that says it expires', emailer.sent.length === 1 && emailer.sent[0].to === 'owner@lakeside.example' && /\b\d{6}\b/.test(emailer.sent[0].text) && /10 minutes/.test(emailer.sent[0].text));
      check('the code is never returned by the API outside demo mode', reg.body.devCode === undefined);

      const wrong = await c.call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code: '000000' });
      check('a wrong code is refused', wrong.status === 401 && !c.cookie);
      const code = lastCode(emailer, 'owner@lakeside.example');
      const good = await c.call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code });
      const sc = good.setCookie.find((x) => x.startsWith('onsite_session='));
      check('the right code signs in and sets a session cookie that is HttpOnly, SameSite=Strict, path-scoped and 12 hours long', good.status === 200 && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\/portal/.test(sc) && /Max-Age=43200/.test(sc));
      check('the cookie is not marked Secure on plain http (local use) ...', !/Secure/.test(sc));
      check('the session identifies the user and park', (await c.call('GET', '/portal/api/me')).body.park.id === 'lakeside');

      const replay = client(env);
      check('a code works only once (replay refused)', (await replay.call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code })).status === 401);

      // Concurrent use of one code, with a slow database: the code must be burned inside the same atomic step that checks it.
      const realDelete = env.deps.store.delete.bind(env.deps.store);
      env.deps.store.delete = async (k) => { if (String(k).startsWith('otp:')) await new Promise((r) => setTimeout(r, 120)); return realDelete(k); };
      await replay.call('POST', '/portal/api/auth/request', { email: 'owner@lakeside.example' });
      const slowCode = lastCode(emailer, 'owner@lakeside.example');
      const slowRacers = await Promise.all([1, 2, 3, 4].map((i) => client(env, `203.0.113.${40 + i}`).call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code: slowCode })));
      env.deps.store.delete = realDelete;
      check('even when the database is slow, four simultaneous attempts with one code give exactly one sign-in', slowRacers.filter((r) => r.status === 200).length === 1);
      // Concurrent use of one code: exactly one winner.
      await replay.call('POST', '/portal/api/auth/request', { email: 'owner@lakeside.example' });
      const c2 = lastCode(emailer, 'owner@lakeside.example');
      const racers = await Promise.all([1, 2, 3, 4].map(() => client(env, '203.0.113.9').call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code: c2 })));
      check('four simultaneous attempts with the same code produce exactly one sign-in', racers.filter((r) => r.status === 200).length === 1);

      // Lock-out after 5 wrong guesses.
      const guesser = client(env, '198.51.100.3');
      await guesser.call('POST', '/portal/api/auth/request', { email: 'owner@lakeside.example' });
      const real = lastCode(emailer, 'owner@lakeside.example');
      const wrongs = ['000001', '000002', '000003', '000004', '000005'].filter((w) => w !== real);
      for (const w of [...wrongs, '999999', '888888'].slice(0, 5)) await guesser.call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code: w });
      check('after 5 wrong guesses even the CORRECT code is refused', (await guesser.call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code: real })).status === 401);
      await guesser.call('POST', '/portal/api/auth/request', { email: 'owner@lakeside.example' });
      check('asking for a fresh code gets you back in', (await guesser.call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code: lastCode(emailer, 'owner@lakeside.example') })).status === 200);

      // Expiry.
      const late = client(env, '198.51.100.4');
      await late.call('POST', '/portal/api/auth/request', { email: 'owner@lakeside.example' });
      const lateCode = lastCode(emailer, 'owner@lakeside.example');
      env.clock.advance(11 * MIN);
      check('a code expires after 10 minutes', (await late.call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code: lateCode })).status === 401);

      // Rate limits (new window).
      env.clock.advance(2 * HOUR);
      const spammer = client(env, '198.51.100.5');
      const statuses = [];
      for (let i = 0; i < 7; i += 1) statuses.push((await spammer.call('POST', '/portal/api/auth/request', { email: 'owner@lakeside.example' })).status);
      check('more than 5 code requests an hour for one address is blocked (429)', statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429 && statuses[6] === 429);
      env.clock.advance(2 * HOUR);
      const ipSpam = client(env, '198.51.100.6');
      let blocked = 0;
      for (let i = 0; i < 25; i += 1) if ((await ipSpam.call('POST', '/portal/api/auth/request', { email: `user${i}@lakeside.example` })).status === 429) blocked += 1;
      check('more than 20 requests an hour from one network address is blocked, whatever the emails', blocked >= 4);

      // Sessions.
      env.clock.advance(2 * HOUR);
      const s = client(env, '198.51.100.7');
      await signIn(s, emailer, 'owner@lakeside.example');
      const tampered = client(env); tampered.cookie = `${s.cookie.slice(0, -3)}abc`;
      check('a tampered or made-up session cookie is refused', (await tampered.call('GET', '/portal/api/me')).status === 401 && (await client(env).call('GET', '/portal/api/me')).status === 401);
      await s.call('POST', '/portal/api/auth/logout', {});
      const stolen = client(env); const keep = s.cookie; void keep;
      check('logging out ends the session', (await s.call('GET', '/portal/api/me')).status === 401);

      const s2 = client(env, '198.51.100.8'); await signIn(s2, emailer, 'owner@lakeside.example');
      const cookieCopy = s2.cookie;
      await s2.call('POST', '/portal/api/auth/logout', {});
      stolen.cookie = cookieCopy;
      check('a copied cookie stops working once the owner logs out (sessions are revoked on the server)', (await stolen.call('GET', '/portal/api/me')).status === 401);

      const s3 = client(env, '198.51.100.9'); await signIn(s3, emailer, 'owner@lakeside.example');
      env.clock.advance(12 * HOUR + 5000); // past 12 h but before the store's own cleanup timer, so the explicit check is what ends it
      check('sessions end after 12 hours', (await s3.call('GET', '/portal/api/me')).status === 401);

      const s4 = client(env, '198.51.100.10'); await signIn(s4, emailer, 'owner@lakeside.example');
      await env.admin('DELETE', '/portal-users/owner@lakeside.example');
      check('disabling a user ends their live session immediately', (await s4.call('GET', '/portal/api/me')).status === 401);
      const s5 = client(env, '198.51.100.11');
      await s5.call('POST', '/portal/api/auth/request', { email: 'owner@lakeside.example' });
      check('and they can no longer sign in (no email is even sent)', emailer.sent.filter((e) => e.to === 'owner@lakeside.example').length === emailer.sent.filter((e) => e.to === 'owner@lakeside.example').length && (await s5.call('POST', '/portal/api/auth/verify', { email: 'owner@lakeside.example', code: lastCode(emailer, 'owner@lakeside.example') })).status === 401);

      // Cross-site protection and headers.
      await env.admin('POST', '/portal-users', { email: 'csrf@lakeside.example', park_id: 'lakeside' });
      const x = client(env, '198.51.100.12'); await signIn(x, emailer, 'csrf@lakeside.example');
      const settings = { hold_minutes: 30 };
      check('a state-changing request without our header is blocked (what a cross-site form would send)', (await x.call('PATCH', '/portal/api/settings', settings, { 'x-requested-with': '' })).status === 403);
      check('a request whose Origin is another site is blocked', (await x.call('PATCH', '/portal/api/settings', settings, { origin: 'https://evil.example' })).status === 403);
      check('only JSON is accepted for changes', (await x.call('PATCH', '/portal/api/settings', 'hold_minutes=30', { 'content-type': 'text/plain' })).status === 415);
      check('the same request from the portal itself works', (await x.call('PATCH', '/portal/api/settings', settings, { origin: env.base })).status === 200);
      const me = await x.call('GET', '/portal/api/me');
      check('API answers are never cached', /no-store/.test(me.headers.get('cache-control')));
      check('pages and API carry a strict content security policy and anti-framing headers', /default-src 'none'/.test(me.headers.get('content-security-policy')) && /script-src 'self'/.test(me.headers.get('content-security-policy')) && me.headers.get('x-frame-options') === 'DENY' && me.headers.get('x-content-type-options') === 'nosniff' && me.headers.get('referrer-policy') === 'no-referrer');
      await env.close();

      const prod = await boot({ portalSecure: true });
      await prod.env.admin('POST', '/portal-users', { email: 'o@lakeside.example', park_id: 'lakeside' });
      const pc = client(prod.env);
      const r = await signIn(pc, prod.emailer, 'o@lakeside.example');
      check('in production the cookie is Secure and HSTS is sent', /Secure/.test(r.setCookie.find((c) => c.startsWith('onsite_session='))) && /max-age=31536000/.test(r.headers.get('strict-transport-security')));
      await prod.env.close();

      const demo = await boot({ portalDevShowCode: true });
      await demo.env.admin('POST', '/portal-users', { email: 'o@lakeside.example', park_id: 'lakeside' });
      const dr = await client(demo.env).call('POST', '/portal/api/auth/request', { email: 'o@lakeside.example' });
      const unknownDemo = await client(demo.env).call('POST', '/portal/api/auth/request', { email: 'nobody@lakeside.example' });
      check('demo mode (explicit opt-in) reveals the code for registered addresses only', /^\d{6}$/.test(dr.body.devCode) && unknownDemo.body.devCode === undefined);
      await demo.env.close();
      let refused = null;
      const saved = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
      try { require('./portal-auth').createPortalAuth({ store: {}, emailer: {}, registry: {}, devShowCode: true }); } catch (e) { refused = e.message; }
      process.env.NODE_ENV = saved;
      check('demo mode cannot be switched on in production', refused && /never be enabled in production/.test(refused));
    },
  },

  tenancy: {
    name: 'Tenant isolation: one park can never see or change another',
    async run({ check }) {
      const { env, emailer } = await seeded();
      const a = client(env, '198.51.100.20'); const b = client(env, '198.51.100.21');
      await signIn(a, emailer, 'owner@lakeside.example');
      await signIn(b, emailer, 'owner@riverbend.example');
      const month = '2026-09';
      const aCalls = (await a.call('GET', `/portal/api/calls?month=${month}`)).body.calls;
      const bCalls = (await b.call('GET', `/portal/api/calls?month=${month}`)).body.calls;
      check('each park\'s call log holds only its own calls', aCalls.map((c) => c.id).sort().join() === 'la-1,la-2,la-3,la-4,la-5' && bCalls.map((c) => c.id).sort().join() === 'rb-1,rb-2');
      check('guessing another park\'s call id returns "not found", not data', (await a.call('GET', '/portal/api/calls/rb-1')).status === 404 && (await b.call('GET', '/portal/api/calls/la-1')).status === 404 && (await a.call('GET', '/portal/api/calls/la-1')).status === 200);
      check('a park query parameter is ignored: the park always comes from the session', (await a.call('GET', `/portal/api/calls?month=${month}&park_id=riverbend`)).body.calls.length === 5 && (await a.call('GET', '/portal/api/overview?park=riverbend')).body.park.id === 'lakeside');
      const aBookings = (await a.call('GET', '/portal/api/bookings')).body.bookings; const bBookings = (await b.call('GET', '/portal/api/bookings')).body.bookings;
      check('bookings are per park', aBookings.length === 2 && aBookings.every((x) => /Taylor|Lee/.test(x.guest)) && bBookings.length === 1 && bBookings[0].guest === 'Riley Brown');
      const aMsgs = (await a.call('GET', '/portal/api/messages')).body.messages; const bMsgs = (await b.call('GET', '/portal/api/messages')).body.messages;
      check('callback messages are per park', aMsgs.length === 1 && aMsgs[0].name === 'Jo Smith' && bMsgs.length === 0);
      check('another park\'s message cannot be marked done', (await b.call('PATCH', `/portal/api/messages/${aMsgs[0].id}`, { done: true })).status === 404 && (await a.call('GET', '/portal/api/messages')).body.messages[0].status === 'open');
      const aBefore = (await a.call('GET', '/portal/api/settings')).body.editable;
      const bBefore = (await b.call('GET', '/portal/api/settings')).body.editable;
      const patch = await a.call('PATCH', '/portal/api/settings', { hold_minutes: 20, name: 'Lakeside Deluxe' });
      check('changing settings changes only your own park', patch.status === 200 && (await b.call('GET', '/portal/api/settings')).body.editable.hold_minutes === bBefore.hold_minutes && (await b.call('GET', '/portal/api/settings')).body.editable.name === bBefore.name && (await a.call('GET', '/portal/api/settings')).body.editable.hold_minutes === 20 && aBefore.hold_minutes === 45);
      check('settings cannot be pointed at another park by putting park_id (or billing terms) in the request', (await a.call('PATCH', '/portal/api/settings', { park_id: 'riverbend', hold_minutes: 30 })).status === 400 && (await a.call('PATCH', '/portal/api/settings', { billing: { per_call: 0 } })).status === 400 && (await b.call('GET', '/portal/api/settings')).body.fixed.per_call_fee === 3);
      const aBill = (await a.call('GET', `/portal/api/billing/${month}`)).body; const bBill = (await b.call('GET', `/portal/api/billing/${month}`)).body;
      check('each park\'s bill lists only its own calls', aBill.lines.every((l) => l.call_sid.startsWith('la-')) && bBill.lines.every((l) => l.call_sid.startsWith('rb-')) && aBill.billable_calls === 3 && bBill.billable_calls === 2);
      const csv = (await a.call('GET', `/portal/api/billing/${month}.csv`)).text;
      check('and so does the CSV', /la-1/.test(csv) && !/rb-/.test(csv));
      const aAct = (await a.call('GET', '/portal/api/activity')).body.activity; const bAct = (await b.call('GET', '/portal/api/activity')).body.activity;
      check('the activity log is per park (login + settings change are Lakeside\'s only)', aAct.some((x) => x.type === 'settings') && !bAct.some((x) => x.type === 'settings') && aAct.every((x) => x.park_id === 'lakeside'));
      const staff = client(env, '198.51.100.22'); await signIn(staff, emailer, 'staff@lakeside.example');
      check('a second login for the same park sees the same data (several staff per park)', (await staff.call('GET', '/portal/api/calls?month=2026-09')).body.calls.length === 5 && (await staff.call('GET', '/portal/api/settings')).body.editable.name === 'Lakeside Deluxe');
      await env.close();
    },
  },

  data: {
    name: 'Portal data: call log, bookings, messages, settings, billing',
    async run({ check }) {
      const { env, emailer } = await seeded();
      const c = client(env, '198.51.100.30');
      await signIn(c, emailer, 'owner@lakeside.example');
      const month = '2026-09';
      const calls = (await c.call('GET', `/portal/api/calls?month=${month}`)).body.calls;
      const by = Object.fromEntries(calls.map((x) => [x.id, x]));
      check('outcomes are in plain terms: booking, message, spam, hung up quickly', by['la-1'].outcome === 'booking' && by['la-2'].outcome === 'booking' && by['la-3'].outcome === 'message' && by['la-4'].outcome === 'spam' && by['la-5'].outcome === 'hung_up');
      check('each call has a one-line summary (no transcript is kept in the log)', /Booking NB\d+ held/.test(by['la-1'].summary) && /Left a message/.test(by['la-3'].summary) && /Spam/.test(by['la-4'].summary) && calls.every((x) => !('transcript' in x) && !('conversation_history' in x)));
      check('the caller\'s number and name are shown once known', by['la-1'].caller_name === 'Sam Taylor' && by['la-1'].caller_phone === '+61412345678' && by['la-3'].caller_name === 'Jo Smith');
      check('billing facts per call: length, billed or not', by['la-1'].duration_seconds === 140 && by['la-1'].billable === true && by['la-5'].billable === false && by['la-4'].billable === false);
      check('newest first', calls.every((x, i) => i === 0 || calls[i - 1].started_ms >= x.started_ms));
      check('filtering by outcome works', (await c.call('GET', `/portal/api/calls?month=${month}&outcome=spam`)).body.calls.map((x) => x.id).join() === 'la-4' && (await c.call('GET', `/portal/api/calls?month=${month}&outcome=nonsense`)).status === 400);
      check('a month with no calls is empty, a malformed month is refused', (await c.call('GET', '/portal/api/calls?month=2026-01')).body.calls.length === 0 && (await c.call('GET', '/portal/api/calls?month=../../x')).status === 400);
      const detail = (await c.call('GET', '/portal/api/calls/la-3')).body;
      check('call detail carries the handoff and reason', detail.handoff.strategy === 'take_message' && /unhappy/.test(detail.handoff.reason));
      await say(env, 'la-live', 'Hi, any sites Oct 10 to 15?', { phone: '+61488888888' });
      check('a call still in progress shows as in progress and is not billable yet', (await c.call('GET', '/portal/api/calls/la-live')).body.outcome === 'in_progress' && (await c.call('GET', '/portal/api/calls/la-live')).body.billable === false);
      await env.post('/test-call', { call_sid: 'la-test', transcript: 'Any sites Oct 10 to 15?', caller_phone: '+61499999999', called_number: NUMBERS.lakeside, confidence: 0.95 });
      await endCall(env, 'la-test', 60);
      const withTest = (await c.call('GET', `/portal/api/calls?month=${month}`)).body.calls.find((x) => x.id === 'la-test');
      check('test calls are flagged as tests and never billed', withTest.test === true && withTest.billable === false);

      const ov = (await c.call('GET', '/portal/api/overview')).body;
      check('overview: calls (excluding tests), bookings, confirmed value, unpaid holds, open messages, bill so far', ov.calls_this_month === 6 && ov.bookings_this_month === 2 && ov.confirmed_value === 925 && ov.unpaid_holds === 1 && ov.open_messages === 1 && ov.bill_so_far === 109 && ov.currency === 'AUD');
      const bookings = (await c.call('GET', '/portal/api/bookings')).body.bookings;
      check('bookings show status, price and dates', bookings.find((b) => b.guest === 'Sam Taylor').status === 'confirmed' && bookings.find((b) => b.guest === 'Alex Lee').status === 'held' && bookings.find((b) => b.guest === 'Alex Lee').total === 555 && bookings.find((b) => b.guest === 'Alex Lee').check_in);

      const msg = (await c.call('GET', '/portal/api/messages')).body.messages[0];
      const done = await c.call('PATCH', `/portal/api/messages/${msg.id}`, { done: true });
      check('a callback can be marked done (who and when are recorded)', done.status === 200 && done.body.status === 'done' && done.body.done_by === 'owner@lakeside.example' && !!done.body.done_ms);
      check('overview no longer counts it as open', (await c.call('GET', '/portal/api/overview')).body.open_messages === 0);
      check('and it can be reopened', (await c.call('PATCH', `/portal/api/messages/${msg.id}`, { done: false })).body.status === 'open');

      // Settings
      const s = (await c.call('GET', '/portal/api/settings')).body;
      check('settings show what the owner may change and, separately, the fixed facts (numbers, price, id)', s.editable.hold_minutes === 45 && s.editable.callback_promise === 'within the hour' && s.fixed.park_id === 'lakeside' && s.fixed.per_call_fee === 3 && s.fixed.monthly_fee === 100 && !('payments' in s) && !JSON.stringify(s).includes('whsec'));
      const bad = await c.call('PATCH', '/portal/api/settings', { hold_minutes: 5, name: '<b>x</b>', staff_alert_numbers: ['02 9000 0001'], staff_alert_emails: ['nope'], callback_promise: 'see http://x.y' });
      check('invalid changes are rejected with a plain reason for each', bad.status === 400 && bad.body.errors.length === 5);
      check('nothing was changed by the rejected request', (await c.call('GET', '/portal/api/settings')).body.editable.hold_minutes === 45);
      const good = await c.call('PATCH', '/portal/api/settings', { hold_minutes: 30, callback_promise: 'within two hours', name: 'Lakeside Holiday Park & Cabins', staff_alert_numbers: ['0412 111 222', '+61412111222', '0412 333 444'], staff_alert_emails: ['Boss@Lakeside.example', 'boss@lakeside.example'], mode: 'full', max_nights: 10 });
      check('valid changes are saved and cleaned (numbers to +61 form, duplicates removed, emails lowercased)', good.status === 200 && JSON.stringify(good.body.editable.staff_alert_numbers) === '["+61412111222","+61412333444"]' && JSON.stringify(good.body.editable.staff_alert_emails) === '["boss@lakeside.example"]' && good.body.changed.length === 7);
      check('the audit log records who changed what, from and to', await (async () => { const a = (await c.call('GET', '/portal/api/activity')).body.activity.find((x) => x.type === 'settings'); return a && a.by === 'owner@lakeside.example' && a.changes.hold_minutes.from === 45 && a.changes.hold_minutes.to === 30; })());
      const unchanged = await c.call('PATCH', '/portal/api/settings', { hold_minutes: 30 });
      check('saving without a real change writes nothing to the audit log', unchanged.body.changed.length === 0 && (await c.call('GET', '/portal/api/activity')).body.activity.filter((x) => x.type === 'settings').length === 1);
      // The changes really drive the service.
      await book(env, 'la-new', { name: 'Pat New', dates: 'Dec 1 to 4', phone: '+61411000111' });
      const links = (await env.pay('lakeside')).links; void links;
      const held = (await c.call('GET', '/portal/api/bookings')).body.bookings.find((b) => b.guest === 'Pat New');
      check('the new hold time applies to the next booking (30 minutes)', held && Math.round((held.hold_expires_ms - held.created_ms) / MIN) === 30);
      const complaint = (phone) => say(env, `la-c-${phone}`, 'This is terrible, I want to complain about my last stay', { phone });
      const r1 = await complaint('+61422000001');
      check('the new mode applies: complaints are now transferred to staff', r1.body.transfer_to_human === true);
      await c.call('PATCH', '/portal/api/settings', { mode: 'diversion' });
      await say(env, 'la-m', 'This is terrible, I want to complain about my last stay', { phone: '+61422000002' });
      await say(env, 'la-m', 'Dee Dee', { phone: '+61422000002' });
      await say(env, 'la-m', 'Yes', { phone: '+61422000002' });
      check('the callback promise is used in the text sent to the caller', env.sms.sent.some((m) => m.kind === 'message_taken' && /within two hours/.test(m.body) && /Lakeside Holiday Park & Cabins/.test(m.body)));
      check('staff alerts go to the new numbers and emails', env.notifier.alerts.at(-1).to.numbers.join() === '+61412111222,+61412333444' && env.notifier.alerts.at(-1).to.emails.join() === 'boss@lakeside.example');

      // Billing
      const list = (await c.call('GET', '/portal/api/billing')).body;
      check('billing history lists 12 months, newest first, current month marked in progress', list.statements.length === 12 && list.statements[0].month === '2026-09' && list.statements[0].in_progress === true && list.statements[1].month === '2026-08' && list.statements[1].in_progress === false);
      check('terms are shown: $100 + $3 per answered call, before GST', list.terms.monthly_fee === 100 && list.terms.per_call === 3 && list.terms.excludes_gst === true);
      const sep = (await c.call('GET', `/portal/api/billing/${month}`)).body;
      check('the statement equals the usage ledger (three answered calls incl. the left message, plus the fee)', sep.billable_calls >= 3 && sep.total === 100 + 3 * sep.billable_calls && sep.lines.length === sep.billable_calls);
      // Earlier month: fabricate a call in August through the same ledger.
      const keep = env.clock.t; env.clock.t = Date.parse('2026-08-15T02:00:00Z');
      await say(env, 'la-aug', 'Hi, any sites Oct 10 to 15?', { phone: '+61400000555' });
      await endCall(env, 'la-aug', 90);
      env.clock.t = keep;
      const aug = (await c.call('GET', '/portal/api/billing')).body.statements.find((x) => x.month === '2026-08');
      check('history includes earlier months with their own totals', aug.billable_calls === 1 && aug.total === 103);
      check('invalid months are refused', (await c.call('GET', '/portal/api/billing/2026-13')).status === 400 && (await c.call('GET', '/portal/api/billing/abc.csv')).status === 400);
      const csvRes = await c.call('GET', `/portal/api/billing/${month}.csv`);
      check('the CSV downloads as an attachment with the statement, lines and totals', csvRes.status === 200 && /text\/csv/.test(csvRes.headers.get('content-type')) && /attachment; filename="onsite-statement-2026-09.csv"/.test(csvRes.headers.get('content-disposition')) && /Monthly fee,100/.test(csvRes.text) && /Total,\d+/.test(csvRes.text) && /la-1/.test(csvRes.text) && /Amounts exclude GST,yes/.test(csvRes.text));
      const { csvCell } = require('./portal-data');
      check('spreadsheet formulas in CSV cells are neutralised (=, +, -, @)', csvCell('=HYPERLINK("x")') === '"\'=HYPERLINK(""x"")"' && csvCell('+1') === "'+1" && csvCell('@a') === "'@a" && csvCell('a,b') === '"a,b"' && csvCell('plain') === 'plain');
      check('unknown API paths give a clean JSON 404', (await c.call('GET', '/portal/api/nothing-here')).status === 404);
      await env.close();
    },
  },
  static: {
    name: 'Portal pages: served with strict headers, no inline script, nothing outside the portal folder',
    async run({ check }) {
      const { env } = await boot();
      const page = await env.request('GET', '/portal/');
      const raw = await fetch(env.base + '/portal/');
      const html = await raw.text();
      const csp = raw.headers.get('content-security-policy') || '';
      check('the sign-in page is served as HTML', raw.status === 200 && /text\/html/.test(raw.headers.get('content-type')) && /OnSite/.test(html));
      check('it carries a strict content security policy and cannot be framed', /script-src 'self'/.test(csp) && /default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/unsafe-inline/.test(csp) && raw.headers.get('x-content-type-options') === 'nosniff');
      check('the page has no inline scripts, inline handlers or inline styles', !/<script(?![^>]*\bsrc=)/i.test(html) && !/\son[a-z]+\s*=/i.test(html) && !/<style/i.test(html) && !/\sstyle\s*=/i.test(html));
      const js = await fetch(env.base + '/portal/portal.js'); const css = await fetch(env.base + '/portal/portal.css');
      check('script and stylesheet have the right content types', js.status === 200 && /javascript/.test(js.headers.get('content-type')) && css.status === 200 && /text\/css/.test(css.headers.get('content-type')));
      check('responses are not cached by shared caches', /no-store|no-cache|private/.test(raw.headers.get('cache-control') || ''));
      let leaked = false;
      for (const p of ['/portal/../package.json', '/portal/%2e%2e/package.json', '/portal/..%2findex.js', '/portal/%2e%2e%2f.env', '/portal/../../etc/passwd']) {
        const t = await new Promise((resolve) => require('http').get({ host: '127.0.0.1', port: new URL(env.base).port, path: p }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); }).on('error', () => resolve('')));
        if (/"name"\s*:\s*"|require\(|root:/.test(t)) leaked = true;
      }
      check('path traversal cannot read files outside the portal folder', !leaked);
      void page;
      await env.close();
    },
  },
};

async function main() {
  const arg = process.argv[2] || 'all';
  const keys = arg === 'all' ? Object.keys(suites) : [arg];
  if (keys.some((k) => !suites[k])) { console.error(`Unknown suite "${arg}". Use ${Object.keys(suites).join(', ')} or all.`); process.exit(2); }
  console.log(`OnSite owner portal tests | store: ${STORE_NAME}`);
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

void parseCookies;
main();
