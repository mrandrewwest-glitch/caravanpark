#!/usr/bin/env node
'use strict';

// Interactive demo: you play the caller, OnSite answers, and you see what the system does behind the
// scenes (texts it sends, alerts to the park's staff, bookings in the mock NewBook). Runs the REAL app
// in-process with MOCK NewBook/SMS/payments, so no real texts are sent and no money moves.
//   npm run demo                 interactive
//   npm run demo -- --auto       watch a complete scripted booking
//   npm run demo -- --full --hold 30     live-transfer park, 30 minute holds
// Uses real Claude when ANTHROPIC_API_KEY is set (in .env or the environment), otherwise an offline
// rule-based stand-in that understands the example phrases but not free speech.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
const readline = require('readline');
const { createApp } = require('./index');
const { runAll } = require('./jobs');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };

if (flag('help') || flag('h')) {
  console.log('Usage: npm run demo -- [--auto] [--full] [--hold MINUTES]\n  --auto   play a complete scripted booking\n  --full   park live-transfers to staff (default: staff are busy, the AI takes messages)\n  --hold   minutes an unpaid booking is held (default 60)');
  process.exit(0);
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2'); const bold = paint('1'); const cyan = paint('36'); const green = paint('32'); const yellow = paint('33'); const magenta = paint('35'); const red = paint('31');

const NUMBER = '+61290000000';
const park = {
  id: 'demo-park', name: 'Sunny Shores Caravan Park', numbers: [NUMBER], sms_from: NUMBER, timezone: 'Australia/Sydney',
  mode: flag('full') ? 'full' : 'diversion', booking_mode: 'ai_booking', hold_minutes: Number(opt('hold', 60)) || 60,
  staff: { alert_numbers: ['+61400000099'], alert_emails: ['owner@sunnyshores.example'], callback_promise: 'within the hour' },
  newbook: { type: 'mock' }, payments: { type: 'mock', webhook_secret: 'whsec_demo' },
};

const clock = { t: Date.now(), advance(ms) { clock.t += ms; } };
const app = createApp({ parks: [park], now: () => clock.t, parkCacheMs: 0, enableTestEndpoint: false });
const deps = app.deps;
const nb = deps.providers.newbook(park);
const payments = deps.providers.payments(park);

// Show side effects the moment they happen.
const sendSms = deps.sms.send.bind(deps.sms);
deps.sms.send = async (msg) => {
  const out = await sendSms(msg);
  console.log(`   ${magenta('📱 SMS to')} ${msg.to} ${dim(`(${msg.kind}, ${out.segments} segment${out.segments > 1 ? 's' : ''})`)}\n      ${magenta(msg.body)}`);
  return out;
};
const notify = deps.notifier.notifyStaff.bind(deps.notifier);
deps.notifier.notifyStaff = async (p, alert) => {
  await notify(p, alert);
  console.log(`   ${yellow('🔔 Staff alert')} ${dim(`(${alert.kind})`)}: ${yellow(alert.summary)}`);
};

let server; let base;
let callNo = 1; let callSid = 'demo-call-1'; let callerPhone = '+61412345678'; let callStarted = null; let turns = 0;
const paidLinks = new Set();

const post = async (path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function say(text) {
  if (!callStarted) callStarted = Date.now();
  turns += 1;
  const t0 = Date.now();
  const r = await post('/phone-callback', { call_sid: callSid, transcript: text, caller_phone: callerPhone, called_number: NUMBER, confidence: 0.95 });
  const b = r.body || {};
  const tags = [];
  if (b.transfer_to_human) tags.push(red('▶ LIVE TRANSFER to a staff member'));
  if (b.handoff && b.handoff.strategy === 'take_message') tags.push(yellow('▶ taking a message for the team'));
  if (b.booking) tags.push(green(`▶ BOOKING ${b.booking.ref} HELD (awaiting payment)`));
  if (b.end_call) tags.push(dim('▶ call ended'));
  console.log(`${cyan(bold('OnSite'))}  ${b.response_text}${tags.length ? `\n        ${tags.join('  ')}` : ''}  ${dim(`${Date.now() - t0} ms`)}`);
}

const WHY = { abandoned: 'under 15 seconds, so not billed', spam: 'spam, so not billed', failed: 'no real conversation, so not billed', answered: null };

async function finalizeCall(seconds) {
  if (!turns) return;
  const duration = seconds ?? Math.max(1, Math.round((Date.now() - callStarted) / 1000));
  const out = await post('/call-ended', { call_sid: callSid, called_number: NUMBER, duration_seconds: duration });
  const b = out.body || {};
  const per = (await deps.registry.get(park.id)).billing.per_call;
  console.log(`   ${dim(`call ended after ${duration}s: ${b.billable ? `billable ($${per} for an answered call)` : `not billable (${WHY[b.outcome] || 'not an answered call'})`}`)}`);
}

// Hang up and start a fresh call, as happens between real callers.
async function hangUp() {
  await finalizeCall();
  callNo += 1; callSid = `demo-call-${callNo}`; callStarted = null; turns = 0;
}

function showState() {
  console.log(bold('\n  Bookings in NewBook (mock):'));
  if (!nb.bookings.size) console.log('    none');
  for (const b of nb.bookings.values()) console.log(`    ${b.booking_id}  ${b.site_name}  ${b.check_in} to ${b.check_out}  $${b.total}  ${b.status.toUpperCase()}  guest: ${b.guest && b.guest.name}  payments: ${b.payments.length}`);
  console.log(bold('  Payment links created:'));
  if (!payments.links.length) console.log('    none');
  for (const l of payments.links) console.log(`    ${l.url}  $${l.amount_cents / 100}  for ${l.booking_ref}  ${paidLinks.has(l.id) ? green('PAID') : 'unpaid'}`);
  console.log(bold('  Texts sent:'), deps.sms.sent.length, ' ', bold('Staff alerts:'), deps.notifier.alerts.length, '\n');
}

async function pay() {
  const link = [...payments.links].reverse().find((l) => !paidLinks.has(l.id));
  if (!link) { console.log(dim('   There is no unpaid payment link. Make a booking first.')); return; }
  const { raw, headers } = payments.simulatePayment(link, { eventId: `evt_demo_${link.id}` });
  paidLinks.add(link.id);
  console.log(dim(`   (the caller opens ${link.url} and pays $${link.amount_cents / 100}; the payment provider calls our webhook)`));
  const r = await post('/payment-webhook', raw, headers);
  console.log(`   ${green(`payment webhook: ${r.body && r.body.result}`)}`);
}

async function wait(minutes) {
  if (!(minutes > 0)) { console.log(dim('   Usage: /wait 30   (minutes to fast-forward)')); return; }
  if (turns) { console.log(dim('   (the caller hangs up first)')); await hangUp(); }
  clock.advance(minutes * 60000);
  console.log(dim(`   ⏩ ${minutes} minutes pass...`));
  const out = await runAll(deps);
  const { released, reminded } = out.holds;
  if (!released.length && !reminded.length) console.log(dim('   nothing needed doing (no holds due for a reminder or expiry)'));
  for (const ref of released) console.log(`   ${red(`hold ${ref} expired unpaid and was released in NewBook`)}`);
  for (const ref of reminded) console.log(`   ${yellow(`reminder sent for hold ${ref}`)}`);
}

async function statement() {
  await deps.ledger.finalizeIdle(deps.registry, 0);
  const month = new Date(clock.t).toLocaleDateString('en-CA', { timeZone: park.timezone }).slice(0, 7);
  const st = await deps.ledger.statement(await deps.registry.get(park.id), month);
  console.log(bold(`\n  Usage statement for ${park.name}, ${month}`));
  console.log(`    monthly fee $${st.monthly_fee} + ${st.billable_calls} answered call${st.billable_calls === 1 ? '' : 's'} x $${st.per_call_fee} = ${bold(`$${st.total}`)} ${dim('(excluding GST)')}\n`);
}

const HELP = `
  Just type what the caller says. Commands:
    /pay            the caller pays the payment link (watch the booking confirm)
    /wait 30        fast-forward 30 minutes (watch reminders and unpaid holds expire)
    /state          show bookings, payment links, texts and alerts
    /new            hang up and start a new call (a different caller if you use /phone)
                    (/wait also hangs up first, as holds expire after callers have gone)
    /phone +614...  change the caller's number (try a landline like +61298765432)
    /hold 15        change how long this park holds unpaid bookings
    /mode full      park staff can take transfers  |  /mode diversion  staff are busy (messages)
    /help   /quit
`;

async function command(line) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'pay': return pay();
    case 'wait': return wait(Number(arg));
    case 'state': return showState();
    case 'new': await hangUp(); console.log(dim(`   ☎️  new call (${callSid}) from ${callerPhone}`)); return undefined;
    case 'phone': callerPhone = arg || callerPhone; console.log(dim(`   caller number is now ${callerPhone}`)); return undefined;
    case 'hold': { const r = await deps.registry.updateSettings(park.id, { hold_minutes: Number(arg) }); console.log(r.errors ? red(`   ${r.errors.join('; ')}`) : dim(`   unpaid bookings are now held for ${r.park.hold_minutes} minutes (applies to new holds)`)); return undefined; }
    case 'mode': { const r = await deps.registry.updateSettings(park.id, { mode: arg }); console.log(r.errors ? red(`   ${r.errors.join('; ')}`) : dim(`   park mode is now "${r.park.mode}"`)); return undefined; }
    case 'help': console.log(HELP); return undefined;
    default: console.log(dim('   Unknown command. Type /help')); return undefined;
  }
}

const AUTO = [
  'Hi, any sites next weekend for 4 of us with a dog?', 'Site 12 please', 'Sam Taylor', 'Yes', 'Yes, go ahead',
  '/state', '/pay', '/state',
];

async function main() {
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const parkNow = await deps.registry.get(park.id);
  console.log(`\n${bold('OnSite demo')}  ${dim('(mock NewBook, texts and payments: nothing real is sent)')}`);
  console.log(`  Park: ${park.name}   mode: ${parkNow.mode === 'full' ? 'full service (staff can take transfers)' : 'diversion (staff are busy; the AI takes messages)'}   holds: ${parkNow.hold_minutes} min`);
  console.log(`  Claude: ${deps.claude.mode === 'live' ? green('live') : yellow('offline stand-in (understands the example phrases, not free speech; set ANTHROPIC_API_KEY for real Claude)')}`);
  console.log(`  Caller: ${callerPhone}   ${dim('Type /help for commands. Try:')} ${cyan('"Hi, any sites next weekend for 4 of us with a dog?"')}\n`);

  const lines = flag('auto') ? AUTO : readline.createInterface({ input: process.stdin, terminal: false });
  const interactive = !flag('auto') && process.stdin.isTTY;
  const prompt = () => { if (interactive) process.stdout.write(bold('Caller > ')); };
  prompt();
  for await (const raw of lines) {
    const line = String(raw).trim();
    if (!line) { prompt(); continue; }
    if (!interactive) console.log(`${bold('Caller')}  ${line}`);
    if (line === '/quit' || line === '/exit') break;
    try { await (line.startsWith('/') ? command(line) : say(line)); } catch (err) { console.log(red(`   error: ${err.message}`)); }
    prompt();
  }
  await finalizeCall(flag('auto') ? 95 : undefined);
  await statement();
  await new Promise((r) => server.close(r));
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
