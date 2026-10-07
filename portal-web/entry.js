// The owner portal as a standalone page: the REAL portal API, sign-in, data and settings code running in the
// browser against an in-memory store that is filled with realistic fake history when the page opens.
// fetch('/portal/api/...') is answered by that code; nothing leaves the page.
import { createParkRegistry } from '../parks';
import { MemoryStore } from '../state-store';
import { createStubClaudeClient } from '../claude-stub';
import { createMockNewBookClient } from '../newbook-client';
import { createMockSmsProvider } from '../sms-provider';
import { createMockPaymentProvider } from '../payment-provider';
import { createMockNotifier } from '../notifier';
import { createLedger } from '../ledger';
import { processCall } from '../conversation-logic';
import { handlePaymentWebhook } from '../payment-handler';
import { runAll } from '../jobs';
import { dateInZone } from '../util';
import { createMockEmailer } from '../emailer';
import { createPortalAuth } from '../portal-auth';
import { portalRouter, COOKIE } from '../portal-api';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const DAY = 86400000;
const PARKS = [
  { id: 'sunny-shores', name: 'Sunny Shores Caravan Park', timezone: 'Australia/Sydney', numbers: ['+61290000010'], sms_from: '+61290000010', mode: 'diversion', booking_mode: 'ai_booking', hold_minutes: 60,
    staff: { alert_numbers: ['+61400000010'], alert_emails: ['owner@sunnyshores.example'], callback_promise: 'within the hour' }, newbook: { type: 'mock' }, payments: { type: 'mock', webhook_secret: 'whsec_sunny' } },
  { id: 'lakeview', name: 'Lakeview Holiday Park', timezone: 'Australia/Sydney', numbers: ['+61290000020'], sms_from: '+61290000020', mode: 'full', booking_mode: 'ai_booking', hold_minutes: 120,
    staff: { alert_numbers: ['+61400000020'], alert_emails: ['owner@lakeview.example'], callback_promise: 'this afternoon' }, newbook: { type: 'mock' }, payments: { type: 'mock', webhook_secret: 'whsec_lakeview' } },
];
export const USERS = [['owner@sunnyshores.example', 'sunny-shores', 'Sam Owner'], ['staff@sunnyshores.example', 'sunny-shores', 'Taylor Staff'], ['owner@lakeview.example', 'lakeview', 'Lee Owner']];
const NAMES = ['Sam Taylor', 'Alex Lee', 'Jordan Wu', 'Casey Brown', 'Riley Evans', 'Morgan Ng', 'Drew Fox', 'Pat Murphy', 'Robin Clarke', 'Kim Patel'];

export async function start() {
  let offset = 0;
  const now = () => Date.now() + offset;
  const store = new MemoryStore({ now });
  const registry = createParkRegistry({ parks: PARKS, store, cacheMs: 0 });
  const nbs = {}; const pays = {};
  for (const p of PARKS) { nbs[p.id] = createMockNewBookClient({ parkName: p.name, latencyMs: 0 }); pays[p.id] = createMockPaymentProvider({ webhookSecret: p.payments.webhook_secret }); }
  const sms = createMockSmsProvider({ store });
  const emailer = createMockEmailer();
  const ledger = createLedger({ store, now, logger: silent });
  const portalAuth = createPortalAuth({ store, emailer, registry, now, logger: silent, devShowCode: true });
  const deps = {
    claude: createStubClaudeClient(), store, logger: silent, now, registry, sms, notifier: createMockNotifier(), ledger, emailer, portalAuth,
    today: (p) => dateInZone(now(), (p && p.timezone) || 'Australia/Sydney'),
    providers: { newbook: (p) => nbs[p.id], payments: (p) => pays[p.id] },
    config: { turnDeadlineMs: 2800, extractTimeoutMs: 1500, responseTimeoutMs: 1800 },
  };

  for (const [email, park_id, name] of USERS) await portalAuth.createUser({ email, park_id, name });

  // ---- History: two earlier months and the current one, made through the real call engine ----
  let n = 0;
  const call = async (park, lines, { seconds = 90 } = {}) => {
    n += 1;
    const sid = `${park.id}-${now()}-${n}`;
    const from = `+614${String(10000000 + ((n * 7919) % 89999999))}`;
    for (const t of lines) await processCall({ call_sid: sid, transcript: t, caller_phone: from, called_number: park.numbers[0], confidence: 0.95 }, deps);
    await ledger.finalizeCall(sid, await registry.get(park.id), { duration_seconds: seconds });
  };
  const book = async (park, i, pay) => {
    await call(park, ['Hi, any sites next weekend for 4 of us with a dog?', `Site ${i % 2 ? 12 : 5} please`, NAMES[i % NAMES.length], 'Yes', 'Yes, go ahead'], { seconds: 120 + (i % 5) * 20 });
    if (!pay) return;
    const provider = pays[park.id];
    const link = provider.links[provider.links.length - 1];
    if (!link) return;
    const { raw, headers } = provider.simulatePayment(link, { eventId: `evt_${park.id}_${now()}_${i}` });
    const req = { body: JSON.parse(raw), rawBody: raw, get: (h) => headers[h.toLowerCase()] };
    await handlePaymentWebhook(req, { status() { return this; }, json() { return this; } }, deps);
  };
  for (const monthsAgo of [2, 1, 0]) {
    offset = monthsAgo ? -(monthsAgo * 30 + 3) * DAY : -2 * DAY; // the current month ends before "now"
    for (const park of PARKS) {
      const calls = monthsAgo === 0 ? 6 : 9;
      for (let i = 0; i < calls; i += 1) {
        const k = i % 6;
        if (k === 0 || k === 3) await book(park, i + monthsAgo, true);
        else if (k === 1) await book(park, i + monthsAgo, false);
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

  // ---- The fake server: fetch('/portal/api/...') goes to the real router ----
  const router = portalRouter(deps, { secure: false });
  let cookie = '';
  async function handle(method, url, init) {
    const u = new URL(url, 'http://portal.local');
    const path = u.pathname.replace(/^\/portal\/api/, '') || '/';
    const headers = {}; Object.entries((init && init.headers) || {}).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
    if (cookie) headers.cookie = cookie;
    let body;
    if (init && init.body) { try { body = JSON.parse(init.body); } catch { body = undefined; } }
    const req = {
      method, path, headers, body, query: Object.fromEntries(u.searchParams), ip: '127.0.0.1',
      get: (h) => (h.toLowerCase() === 'host' ? 'portal.local' : headers[h.toLowerCase()]),
      is: (t) => (headers['content-type'] || '').includes(t),
    };
    const out = await router.handle(req);
    for (const c of out.setCookies) { const [pair, ...attrs] = c.split(';'); const [k, v] = pair.split('='); if (k === COOKIE) cookie = /Max-Age=0/i.test(attrs.join(';')) || !v ? '' : `${k}=${v}`; }
    return out;
  }
  const realFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === 'string' && url.startsWith('/portal/api')) {
      const out = await handle((init.method || 'GET').toUpperCase(), url, init);
      return new Response(out.body, { status: out.status, headers: out.headers });
    }
    return realFetch(url, init);
  };
  return { deps, handle, users: USERS };
}
