'use strict';

// Tests for the browser demo: the bundled engine (the real engine, shimmed for the browser) is loaded exactly as a
// page would load it and driven through the full story, and the browser crypto shim is checked against Node's.
// Usage: node tests-demo-web.js
const vm = require('vm');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { build } = require('./scripts/build-demo-web');
const { makeChecker } = require('./test-helpers');

async function main() {
  const { check, results } = makeChecker();
  await build();
  const html = fs.readFileSync(path.join(__dirname, 'demo-web', 'OnSite-demo.html'), 'utf8');
  const fragment = fs.readFileSync(path.join(__dirname, 'dist', 'onsite-demo.fragment.html'), 'utf8');

  console.log('\n==================== Browser demo: engine bundle, shims and page ====================');
  check('standalone page is a complete document; the publishable fragment has no <html>/<head>/<body>', /^<!doctype html>/i.test(html) && !/<(html|head|body)[\s>]/i.test(fragment));
  check('page has a name-style <title> within the first 8 KB (artifact rule)', /<title>[^<]{3,40}<\/title>/.test(fragment.slice(0, 8192)));
  check('page loads no scripts from outside (everything inline, nothing blocked by the artifact CSP)', !/<script[^>]+src=/i.test(fragment) && !/https?:\/\/[^"' )]+\.js/i.test(fragment));
  check('only Google Fonts stylesheets are linked (the one allowed external host)', [...fragment.matchAll(/<link[^>]+href="([^"]+)"/g)].every((m) => /fonts\.(googleapis|gstatic)\.com/.test(m[1])));
  check('page is under the 16 MB artifact limit', Buffer.byteLength(fragment) < 16 * 1024 * 1024, `${Math.round(Buffer.byteLength(fragment) / 1024)} KB`);

  // Browser crypto shim must agree with Node's HMAC-SHA256.
  const shim = require('./demo-web/shims/crypto.js');
  const same = ['', 'abc', '{"id":"evt_1","amount_cents":92500}', 'x'.repeat(1000)].every((m) => shim.createHmac('sha256', 'whsec_demo').update(m).digest('hex') === crypto.createHmac('sha256', 'whsec_demo').update(m).digest('hex'));
  check('browser HMAC-SHA256 shim matches Node crypto on several inputs', same);
  check('browser constant-time compare accepts equal and rejects different bytes', shim.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')) && !shim.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd')));

  // Load the bundle the way a page does (a script defining a global) and drive the whole story.
  const code = /<script>(var OnSiteEngine=[\s\S]*?)<\/script>/.exec(fragment);
  check('the engine bundle is inlined as a global script', !!code);
  vm.runInThisContext(code[1]);
  const events = [];
  const engine = global.OnSiteEngine.createEngine({ mode: 'diversion', holdMinutes: 60, onEvent: (e) => events.push(e) });
  const say = async (t) => engine.say(t);

  let r = await say('Hi, any sites next weekend for 4 of us with a dog?');
  check('availability answered from the simulated NewBook, asking which site to book', /which one would you like me to book/i.test(r.text));
  await say('Site 12 please'); await say('Sam Taylor'); r = await say('Yes');
  check('read-back states the NewBook total and the park\'s hold time', /\$370/.test(r.text) && /an hour/.test(r.text));
  r = await say('Yes, go ahead');
  check('booking held with a ref, payment link texted, owner alerted', r.booking && r.booking.status === 'held' && events.some((e) => e.type === 'sms' && e.kind === 'payment_link') && events.some((e) => e.kind === 'ai_booking_held'));
  let snap = await engine.snapshot();
  check('owner snapshot shows the booking as held with a hold deadline an hour out', snap.bookings.length === 1 && snap.bookings[0].status === 'held' && Math.round((snap.bookings[0].holdExpires - snap.now) / 60000) === 60);
  check('a call still in progress is NOT on the bill yet (no premature closing)', snap.statement.billable_calls === 0 && snap.statement.lines.length === 0);

  const hung = await engine.hangUp();
  check('hanging up closes the call at its simulated length (5 exchanges x 20 s)', hung.seconds === 100 && hung.billable === true);
  snap = await engine.snapshot();
  check('the bill shows 1 call of 100 s: $100 + $3 = $103', snap.statement.billable_calls === 1 && snap.statement.lines[0].duration_seconds === 100 && snap.statement.total === 103);

  const paid = await engine.pay(snap.links[0].id);
  check('paying goes through the real signed-webhook handler and confirms the booking', paid.result === 'confirmed' && (await engine.snapshot()).bookings[0].status === 'confirmed' && events.some((e) => e.kind === 'booking_confirmation'));
  check('paying the same link twice does nothing', (await engine.pay(snap.links[0].id)).result === 'no such unpaid link');

  // Unpaid hold: reminder then expiry.
  await say('Hi, any sites next weekend for 4 of us with a dog?'); await say('Site 5 please'); await say('Alex Lee'); await say('Yes'); r = await say('Yes');
  await engine.hangUp();
  let h = await engine.wait(35);
  check('half-way through the hold a reminder text goes out', h.reminded.length === 1 && events.some((e) => e.kind === 'hold_reminder'));
  h = await engine.wait(40);
  check('then the unpaid hold expires and the site is released', h.released.length === 1 && events.some((e) => e.kind === 'hold_expired') && (await engine.snapshot()).bookings.some((b) => b.status === 'expired'));

  // Message taking when staff are busy, and live transfer after changing the setting.
  r = await say('This is terrible, I want to complain about my last stay');
  check('busy staff: no transfer, asks for a name', !r.transfer && /take your name/i.test(r.text));
  await say('Jo Smith'); r = await say('Yes');
  check('message taken, acknowledged by text, owner told', r.handoff && r.handoff.strategy === 'take_message' && events.some((e) => e.kind === 'message_taken' && /Jo Smith/.test(e.body)) && (await engine.snapshot()).messages.length === 1);
  await engine.hangUp();
  await engine.setSettings({ mode: 'full' });
  r = await say('This is terrible, I want to complain about my last stay');
  check('after the owner changes the setting, the same complaint is transferred to staff', r.transfer === true);
  const bad = await engine.setSettings({ hold_minutes: 5 });
  check('settings are validated (hold under 15 minutes rejected)', Array.isArray(bad.errors));

  const pass = results.every((x) => x.ok);
  console.log(`\n>>> demo-web: ${pass ? 'PASS' : 'FAIL'} (${results.filter((x) => x.ok).length}/${results.length} checks)`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
