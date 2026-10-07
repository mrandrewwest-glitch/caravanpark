#!/usr/bin/env node
'use strict';

// Runs the owner portal locally with a few months of realistic fake history for TWO parks, so you can sign in and
// click around. Mock NewBook, texts and payments; nothing real is sent. The sign-in code is shown on the page
// (demo mode only: the app refuses that setting in production).
//   npm run portal:demo            then open http://localhost:3100/portal/
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
const { createApp } = require('../index');
const { runAll } = require('../jobs');

const PORT = Number(process.env.PORT) || 3100;
let offset = 0; // milliseconds added to the real clock while history is being created
const now = () => Date.now() + offset;
const DAY = 86400000;

const PARKS = [
  { id: 'sunny-shores', name: 'Sunny Shores Caravan Park', numbers: ['+61290000010'], sms_from: '+61290000010', mode: 'diversion', booking_mode: 'ai_booking', hold_minutes: 60,
    staff: { alert_numbers: ['+61400000010'], alert_emails: ['owner@sunnyshores.example'], callback_promise: 'within the hour' }, payments: { type: 'mock', webhook_secret: 'whsec_sunny' } },
  { id: 'lakeview', name: 'Lakeview Holiday Park', numbers: ['+61290000020'], sms_from: '+61290000020', mode: 'full', booking_mode: 'ai_booking', hold_minutes: 120,
    staff: { alert_numbers: ['+61400000020'], alert_emails: ['owner@lakeview.example'], callback_promise: 'this afternoon' }, payments: { type: 'mock', webhook_secret: 'whsec_lakeview' } },
];
const USERS = [['owner@sunnyshores.example', 'sunny-shores', 'Sam Owner'], ['staff@sunnyshores.example', 'sunny-shores', 'Taylor Staff'], ['owner@lakeview.example', 'lakeview', 'Lee Owner']];
const NAMES = ['Sam Taylor', 'Alex Lee', 'Jordan Wu', 'Casey Brown', 'Riley Evans', 'Morgan Ng', 'Drew Fox', 'Pat Murphy', 'Robin Clarke', 'Kim Patel'];

async function main() {
  const app = createApp({ parks: PARKS, now, portalDevShowCode: true, parkCacheMs: 0, enableTestEndpoint: false });
  const deps = app.deps;
  const server = await new Promise((resolve) => { const s = app.listen(PORT, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${PORT}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  let n = 0;
  const call = async (park, lines, { seconds = 90, phone = null } = {}) => {
    n += 1;
    const sid = `${park.id}-${now()}-${n}`;
    const from = phone || `+614${String(10000000 + ((n * 7919) % 89999999))}`;
    for (const t of lines) await post('/phone-callback', { call_sid: sid, transcript: t, caller_phone: from, called_number: park.numbers[0], confidence: 0.95 });
    await post('/call-ended', { call_sid: sid, called_number: park.numbers[0], duration_seconds: seconds });
  };
  const bookAndMaybePay = async (park, i, pay) => {
    const name = NAMES[i % NAMES.length];
    await call(park, ['Hi, any sites next weekend for 4 of us with a dog?', `Site ${i % 2 ? 12 : 5} please`, name, 'Yes', 'Yes, go ahead'], { seconds: 120 + (i % 5) * 20 });
    const provider = deps.providers.payments(await deps.registry.get(park.id));
    if (pay) { const { raw, headers } = provider.simulatePayment(provider.links.at(-1), { eventId: `evt_${park.id}_${now()}_${i}` }); await fetch(base + '/payment-webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }); }
  };

  for (const [email, parkId, name] of USERS) await deps.portalAuth.createUser({ email, park_id: parkId, name });

  // History: two earlier months and the current one.
  for (const monthsAgo of [2, 1, 0]) {
    offset = -(monthsAgo * 30 + (monthsAgo ? 3 : 0)) * DAY;
    for (const park of PARKS) {
      const calls = monthsAgo === 0 ? 6 : 9;
      for (let i = 0; i < calls; i += 1) {
        const k = i % 6;
        if (k === 0 || k === 3) await bookAndMaybePay(park, i + monthsAgo, true);
        else if (k === 1) await bookAndMaybePay(park, i + monthsAgo, false);
        else if (k === 2) await call(park, ['Any sites next weekend for 2 of us?'], { seconds: 55 });
        else if (k === 4) await call(park, ['This is terrible, I want to complain about my last stay', NAMES[(i + 3) % NAMES.length], 'Yes'], { seconds: 80 });
        else await call(park, [i % 2 ? 'Hi, this is about your extended warranty' : 'Any sites next weekend?'], { seconds: i % 2 ? 22 : 7 });
        offset += 3 * 3600e3 + i * 600e3;
      }
      offset += 5 * 3600e3;
      await runAll(deps);
    }
  }
  offset = 0;
  await runAll(deps);

  console.log('\nOnSite owner portal demo is running.\n');
  console.log(`  Open:   ${base}/portal/`);
  console.log('  Sign in with one of these (the code appears on the page in demo mode):');
  for (const [email, parkId] of USERS) console.log(`    ${email.padEnd(30)} ${parkId}`);
  console.log('\n  Try: the two parks cannot see each other\'s calls. Press Ctrl+C to stop.\n');
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
main().catch((e) => { console.error(e); process.exit(1); });
