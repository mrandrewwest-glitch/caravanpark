// The real OnSite engine, packaged for the browser. Same conversation logic, booking flow, payment webhook,
// hold-expiry job and billing ledger as the server; only the providers are simulated (NewBook, SMS, payments,
// staff alerts) and Claude is the offline rule-based stand-in. No network, no Express.
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
import { createSampleClaudeClient } from './claude-sample';

const NUMBER = '+61290000000';
const silent = { debug() {}, info() {}, warn() {}, error() {} };

// Failures after which Claude is switched off for the rest of the session (the viewer said no, or it cannot work here).
const PERMANENT = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'session_expired', 'tools_unavailable']);

// `sample` is the page's "ask Claude" capability when it has one. Claude is OFF until setUseClaude(true); whenever it
// fails the call falls back to the rule-based stand-in so the conversation never dies mid-demo.
export function createEngine({ mode = 'diversion', holdMinutes = 60, onEvent = () => {}, sample = null } = {}) {
  const clock = { t: Date.now(), advance(ms) { clock.t += ms; } };
  const park = {
    id: 'demo-park', name: 'Sunny Shores Caravan Park', timezone: 'Australia/Sydney', numbers: [NUMBER], sms_from: NUMBER,
    mode, booking_mode: 'ai_booking', hold_minutes: holdMinutes,
    staff: { alert_numbers: ['+61400000099'], alert_emails: ['owner@sunnyshores.example'], callback_promise: 'within the hour' },
    newbook: { type: 'mock' }, payments: { type: 'mock', webhook_secret: 'whsec_demo' },
  };
  const store = new MemoryStore({ now: () => clock.t });
  const registry = createParkRegistry({ parks: [park], store, cacheMs: 0 });
  const nb = createMockNewBookClient({ parkName: park.name, latencyMs: 0 });
  const pay = createMockPaymentProvider({ webhookSecret: park.payments.webhook_secret });
  const sms = createMockSmsProvider({ store });
  const notifier = createMockNotifier();
  const ledger = createLedger({ store, now: () => clock.t, logger: silent });
  const stub = createStubClaudeClient();
  let live = sample ? createSampleClaudeClient(sample) : null;
  let useClaude = false;
  let turnSources = [];
  const guarded = (method) => async (args) => {
    if (useClaude && live) {
      try { const out = await live[method](args); turnSources.push('claude'); return out; } catch (e) {
        const code = (e && e.code) || 'upstream_error';
        if (code !== 'cancelled') {
          if (PERMANENT.has(code)) useClaude = false;
          onEvent({ type: 'claude', status: PERMANENT.has(code) ? 'off' : 'fallback', code });
        }
      }
    }
    turnSources.push('stand-in');
    return stub[method](args);
  };
  const claude = { get mode() { return useClaude ? 'live' : 'stub'; }, extractIntent: guarded('extractIntent'), generateResponse: guarded('generateResponse') };
  const config = {
    // A phone call allows about 3 seconds; this demo waits much longer for Claude so the viewer sees its real answer.
    get turnDeadlineMs() { return useClaude ? 60000 : 2800; }, extractTimeoutMs: 1500, responseTimeoutMs: 1800,
  };
  const deps = {
    claude, store, logger: silent, now: () => clock.t,
    today: (p) => dateInZone(clock.t, (p && p.timezone) || park.timezone), registry,
    providers: { newbook: () => nb, payments: () => pay }, sms, notifier, ledger,
    config,
  };

  // Surface side effects the moment they happen.
  const send = sms.send.bind(sms);
  sms.send = async (msg) => { const out = await send(msg); onEvent({ type: 'sms', at: clock.t, ...msg, segments: out.segments }); return out; };
  const notify = notifier.notifyStaff.bind(notifier);
  notifier.notifyStaff = async (p, alert) => { await notify(p, alert); onEvent({ type: 'alert', at: clock.t, kind: alert.kind, summary: alert.summary }); };

  let callNo = 1; let callSid = 'web-call-1'; let turns = 0; let callerPhone = '+61412345678';
  const paid = new Set();

  const engine = {
    NUMBER,
    now: () => clock.t,
    get callerPhone() { return callerPhone; },
    setCallerPhone(p) { callerPhone = p; },
    get inCall() { return turns > 0; },

    get claudeAvailable() { return !!live; },
    attachSample(fn) { live = fn ? createSampleClaudeClient(fn) : null; if (!live) useClaude = false; },
    get useClaude() { return useClaude; },
    setUseClaude(v) { useClaude = !!v && !!live; return useClaude; },

    async say(text) {
      turns += 1;
      turnSources = [];
      const t0 = performance.now();
      const r = await processCall({ call_sid: callSid, transcript: text, caller_phone: callerPhone, called_number: NUMBER, confidence: 0.95 }, deps);
      const ex = r.trace && r.trace.extraction;
      return {
        text: r.response_text, transfer: !!r.transfer_to_human, handoff: r.handoff || null, booking: r.booking || null,
        end: !!r.end_call, ms: Math.round(performance.now() - t0), decision: r.trace && r.trace.decision,
        understood: ex && typeof ex === 'object' ? ex : null,
        source: !turnSources.length ? null : turnSources.every((x) => x === 'claude') ? 'claude' : turnSources.every((x) => x === 'stand-in') ? 'stand-in' : 'mixed',
      };
    },

    // Hang up and start a fresh call. Call length is simulated (about 20 seconds per exchange).
    async hangUp() {
      if (!turns) return null;
      const seconds = Math.max(turns * 20, 20);
      const rec = await ledger.finalizeCall(callSid, await registry.get(park.id), { duration_seconds: seconds });
      callNo += 1; callSid = `web-call-${callNo}`; turns = 0;
      return { seconds, billable: !!(rec && rec.billable), outcome: rec && rec.outcome };
    },

    // The caller pays a payment link: the provider's signed webhook goes through the real handler.
    async pay(linkId) {
      const link = pay.links.find((l) => l.id === linkId && !paid.has(l.id));
      if (!link) return { result: 'no such unpaid link' };
      const { raw, headers } = pay.simulatePayment(link, { eventId: `evt_web_${link.id}` });
      paid.add(link.id);
      let status = 200; let body;
      const req = { body: JSON.parse(raw), rawBody: raw, get: (h) => headers[h.toLowerCase()] };
      const res = { status(s) { status = s; return res; }, json(b) { body = b; return res; } };
      await handlePaymentWebhook(req, res, deps);
      return { status, result: body && (body.result || body.error) };
    },

    // Time passes (the caller has hung up): reminders go out, unpaid holds expire.
    async wait(minutes) {
      clock.advance(minutes * 60000);
      return (await runAll(deps)).holds;
    },

    async setSettings(patch) { return registry.updateSettings(park.id, patch); },
    async settings() { return registry.get(park.id); },

    async snapshot() {
      const bookingRecs = await store.list('bookings:');
      const messages = await store.list('messages:');
      const month = dateInZone(clock.t, park.timezone).slice(0, 7);
      return {
        now: clock.t,
        bookings: bookingRecs.map((r) => ({ ref: r.booking_ref, site: r.site_name, check_in: r.check_in, check_out: r.check_out, guest: r.guest && r.guest.name, total: r.total, due: r.amount_due_cents / 100, status: r.status, holdExpires: r.hold_expires_ms, linkId: r.payment_link && r.payment_link.id, nbStatus: (nb.bookings.get(r.booking_ref) || {}).status })).sort((a, b) => (a.ref < b.ref ? 1 : -1)),
        messages: messages.map((m) => ({ name: m.name, number: m.callback_number, reason: m.reason, created: m.created_ms })),
        links: pay.links.map((l) => ({ id: l.id, url: l.url, ref: l.booking_ref, cents: l.amount_cents, paid: paid.has(l.id) })),
        statement: await ledger.statement(await registry.get(park.id), month),
      };
    },
  };
  return engine;
}
