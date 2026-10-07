'use strict';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
const { createApp } = require('./index');
const { newDynamoStore } = require('./test-dynamo');
const { createFakeNewBook, harnessFor, categoriesFromSites, AUTH } = require('./test-newbook-server');
const { MOCK_SITES } = require('./newbook-client');

const TODAY = process.env.TEST_TODAY || '2026-09-30'; // pinned so "next weekend" is deterministic (a Wednesday)
const BUDGET_MS = 3000;

const RIVER_SITES = [
  { site_id: 1, name: 'Site 1 - Riverside', price: 100, max_guests: 4, pet_friendly: true, amenities: ['power', 'water'], vehicle_max_length: 9, available: true },
  { site_id: 2, name: 'Site 2 - Garden', price: 80, max_guests: 4, pet_friendly: false, amenities: ['power'], vehicle_max_length: 8, available: true },
];

// Three parks with different modes/policies to exercise multi-tenancy.
const TEST_PARKS = [
  { id: 'friend-caravan-park', name: 'Friends Caravan Park', numbers: ['+61290000001'], mode: 'full', booking_mode: 'handoff' },
  {
    id: 'lakeside', name: 'Lakeside Holiday Park', numbers: ['+61290000002'], sms_from: '+61290000002', mode: 'diversion', booking_mode: 'ai_booking', hold_minutes: 45,
    staff: { alert_numbers: ['+61400000099'], alert_emails: ['owner@lakeside.example'], callback_promise: 'within the hour' }, payments: { type: 'mock', webhook_secret: 'whsec_lake' },
  },
  {
    id: 'riverbend', name: 'Riverbend Caravan Park', numbers: ['+61290000003'], sms_from: '+61290000003', mode: 'full', booking_mode: 'ai_booking', hold_minutes: 120,
    newbook: { type: 'mock', sites: RIVER_SITES }, payments: { type: 'mock', webhook_secret: 'whsec_river' },
  },
];
const NUMBERS = { friend: '+61290000001', lakeside: '+61290000002', riverbend: '+61290000003' };

function makeClock(startIso = '2026-09-30T00:00:00Z') {
  const c = { t: Date.parse(startIso), advance(ms) { c.t += ms; } };
  return c;
}

// NEWBOOK=rest runs the suites through the REAL REST client against a fake NewBook HTTP server
// (one per park, built from NewBook's public docs) instead of the in-process mock.
const REST = process.env.NEWBOOK === 'rest';
async function restParks() {
  process.env.ONSITE_TEST_NEWBOOK_CREDS = JSON.stringify(AUTH);
  const fakes = {};
  const parks = [];
  for (const p of TEST_PARKS) {
    const fake = createFakeNewBook({ categories: categoriesFromSites((p.newbook && p.newbook.sites) || MOCK_SITES) });
    const base_url = await fake.start();
    fakes[p.id] = fake;
    parks.push({ ...p, newbook: { type: 'rest', base_url, credentials_ref: 'env:ONSITE_TEST_NEWBOOK_CREDS', placeholder_address: { street: '1 Park Road', city: 'Testville', postcode: '2000', state: 'NSW' }, payment_type_name: 'Credit Card', cancel_reason_name: 'Unpaid hold', read_timeout_ms: 800, write_timeout_ms: 1200 } });
  }
  return { fakes, parks };
}

async function start(overrides = {}) {
  const useRest = REST && !overrides.newbook && !overrides.newbooks && !overrides.parks;
  const rest = useRest ? await restParks() : null;
  const clock = overrides.clock || makeClock();
  // STORE=dynamo runs the whole suite against DynamoDB (dynalite) instead of the in-memory store.
  const store = overrides.store || (process.env.STORE === 'dynamo' ? await newDynamoStore({ now: () => clock.t }) : undefined);
  const app = createApp({
    store,
    parks: rest ? rest.parks : TEST_PARKS, parkCacheMs: 0, today: () => TODAY, now: () => clock.t, enableTestEndpoint: true,
    ...overrides, config: { adminToken: 'test-admin', ...overrides.config },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  if (app.attachWebSockets) app.attachWebSockets(server); // Twilio live-call WebSocket (only when Twilio is enabled)
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, body, headers = {}) => {
    const t = Date.now();
    const isRaw = typeof body === 'string';
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : (isRaw ? body : JSON.stringify(body)) });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json, ms: Date.now() - t };
  };
  const deps = app.deps;
  const firstPark = await deps.registry.get(deps.registry.ids()[0]);
  const harnesses = rest ? Object.fromEntries(Object.entries(rest.fakes).map(([id, f]) => [id, harnessFor(f)])) : null;
  return {
    app, deps, clock, request, base, server,
    post: (path, body, headers) => request('POST', path, body, headers),
    admin: (method, path, body) => request(method, `/admin${path}`, body, { authorization: 'Bearer test-admin' }),
    newbook: harnesses ? harnesses[firstPark.id] : deps.providers.newbook(firstPark),
    nb: async (parkId) => (harnesses ? harnesses[parkId] : deps.providers.newbook(await deps.registry.get(parkId))),
    pay: async (parkId) => deps.providers.payments(await deps.registry.get(parkId)),
    sms: deps.sms, notifier: deps.notifier,
    close: async () => { if (app.relay) app.relay.clients.forEach((ws) => ws.terminate()); await new Promise((r) => server.close(r)); if (rest) await Promise.all(Object.values(rest.fakes).map((f) => f.stop())); },
  };
}

const call = (sid, transcript, phone, confidence = 0.95, extra = {}) => ({ call_sid: sid, transcript, caller_phone: phone, confidence, ...extra });

function printFlow(title, r) {
  const t = r.body.trace || {};
  console.log(`\n--- ${title} ---`);
  console.log(`[claude_mode] ${t.claude_mode}`);
  console.log(`[caller]      "${t.input}" (dialpad confidence ${t.dialpad_confidence})`);
  console.log(`[extraction]  ${typeof t.extraction === 'string' ? t.extraction : JSON.stringify(t.extraction)}`);
  console.log(`[newbook]     ${t.newbook_query ? `getAvailability(${t.newbook_query.check_in}, ${t.newbook_query.check_out}) -> ${t.newbook_sites_returned ?? 'error'} sites; passed to Claude: [${(t.sites_passed_to_claude || []).join(', ')}]` : 'not queried'}`);
  console.log(`[decision]    ${t.decision}`);
  console.log(`[ai reply]    "${r.body.response_text}"`);
  console.log(`[dialpad out] ${JSON.stringify({ response_text: r.body.response_text, transfer_to_human: r.body.transfer_to_human, metadata: r.body.metadata })}`);
  if (r.body.transfer_details) console.log(`[handoff]     ${r.body.transfer_details.summary}`);
  console.log(`[latency]     ${r.ms} ms (budget ${BUDGET_MS} ms)`);
}

function makeChecker() {
  const results = [];
  const check = (label, ok) => { results.push({ label, ok: !!ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); };
  return { check, results };
}

module.exports = { STORE_NAME: process.env.STORE === 'dynamo' ? 'DynamoDB (dynalite)' : 'in-memory', NEWBOOK_NAME: REST ? 'REST client + fake NewBook server' : 'in-process mock', start, call, printFlow, makeChecker, makeClock, TODAY, BUDGET_MS, TEST_PARKS, NUMBERS, RIVER_SITES };
