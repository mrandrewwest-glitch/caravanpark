'use strict';

const { dateInZone } = require('./util');

// Per-call usage ledger. Billing ($ monthly fee + $ per answered call), statements and
// the pilot's cost analysis all read from here. In production this lives in a durable
// table WITHOUT a short TTL (billing records must outlive call state).
//
// A call is BILLABLE when it was answered, was not spam, was not a test call, had at
// least one real exchange, and lasted at least billing.min_call_seconds.

function createLedger({ store, now = Date.now, logger }) {
  const key = (sid) => `calls:${sid}`;

  async function update(callSid, init, mutate) {
    const rec = (await store.get(key(callSid))) || init();
    mutate(rec);
    await store.set(key(callSid), rec);
    return rec;
  }

  const ledger = {
    async recordTurn(call, park, t) {
      const ts = now();
      return update(call.call_sid, () => ({
        call_sid: call.call_sid, park_id: park ? park.id : null, caller_phone: call.caller_phone || null,
        started_at: ts, last_turn_at: ts, turns: 0, real_exchanges: 0, spam: false, is_test: !!call.is_test,
        handoff: null, bookings_created: [], sms_segments: 0, tokens: {}, finalized_at: null,
      }), (r) => {
        r.last_turn_at = ts;
        r.turns += 1;
        if (!t.fallback && (call.transcript || '').trim()) r.real_exchanges += 1;
        if (t.spam) r.spam = true;
        if (t.handoff) r.handoff = t.handoff;
        if (t.fallback) r.fallback_turns = (r.fallback_turns || 0) + 1;
        for (const u of (t.usage || [])) {
          const m = (r.tokens[u.model] ||= { input: 0, output: 0, calls: 0 });
          m.input += u.input_tokens || 0;
          m.output += u.output_tokens || 0;
          m.calls += 1;
        }
      });
    },

    async addBooking(callSid, ref) {
      const existing = await store.get(key(callSid));
      if (!existing) return null;
      existing.bookings_created.push(ref);
      await store.set(key(callSid), existing);
      return existing;
    },

    async addSms(callSid, segments) {
      if (!callSid) return null;
      const existing = await store.get(key(callSid));
      if (!existing) return null;
      existing.sms_segments += segments;
      await store.set(key(callSid), existing);
      return existing;
    },

    // Called by the Dialpad call-ended event (real duration) or the idle finaliser (estimate).
    async finalizeCall(callSid, park, { duration_seconds: duration = null } = {}) {
      const rec = await store.get(key(callSid));
      if (!rec || rec.finalized_at) return rec; // idempotent: never double-bill
      const estimated = duration === null;
      rec.duration_seconds = estimated ? Math.round((rec.last_turn_at - rec.started_at) / 1000) : duration;
      rec.duration_source = estimated ? 'estimated' : 'provider';
      const min = park ? park.billing.min_call_seconds : 15;
      if (rec.spam) rec.outcome = 'spam';
      else if (!rec.real_exchanges || rec.fallback_turns === rec.turns) rec.outcome = 'failed';
      else if (rec.duration_seconds < min && !estimated) rec.outcome = 'abandoned';
      else rec.outcome = 'answered';
      rec.billable = rec.outcome === 'answered' && !rec.is_test;
      rec.finalized_at = now();
      await store.set(key(callSid), rec);
      logger?.info('call_finalized', { call_sid: callSid, outcome: rec.outcome, billable: rec.billable, duration_seconds: rec.duration_seconds });
      return rec;
    },

    // Finalise calls with no end event after idleMs (call-ended webhook missed).
    async finalizeIdle(parks, idleMs = 15 * 60 * 1000) {
      const done = [];
      for (const rec of await store.list('calls:')) {
        if (!rec.finalized_at && now() - rec.last_turn_at >= idleMs) {
          done.push(await ledger.finalizeCall(rec.call_sid, parks ? await parks.get(rec.park_id) : null));
        }
      }
      return done;
    },

    // Monthly statement for one park. month = "YYYY-MM" in the park's timezone.
    async statement(park, month) {
      const rows = (await store.list('calls:')).filter((r) => r.park_id === park.id && r.finalized_at && dateInZone(r.started_at, park.timezone).startsWith(month));
      const billable = rows.filter((r) => r.billable).sort((a, b) => a.started_at - b.started_at);
      const { monthly_fee: base, per_call: per, currency } = park.billing;
      const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
      return {
        park_id: park.id, month, currency, amounts_exclude_gst: true,
        monthly_fee: base, per_call_fee: per, billable_calls: billable.length,
        calls_total: rows.length,
        usage_charges: billable.length * per, total: base + billable.length * per,
        not_billed: rows.filter((r) => !r.billable).reduce((acc, r) => { const why = r.is_test ? 'test' : (r.outcome || 'unknown'); acc[why] = (acc[why] || 0) + 1; return acc; }, {}),
        lines: billable.map((r) => ({ call_sid: r.call_sid, date: dateInZone(r.started_at, park.timezone), duration_seconds: r.duration_seconds, duration_source: r.duration_source, handoff: r.handoff ? r.handoff.strategy : null, bookings: r.bookings_created.length })),
        // Our own cost drivers for the pilot's break-even analysis (rates are applied elsewhere).
        cost_drivers: {
          sms_segments: sum((r) => r.sms_segments), call_seconds: sum((r) => r.duration_seconds || 0),
          tokens: rows.reduce((acc, r) => { for (const [m, v] of Object.entries(r.tokens)) { const a = (acc[m] ||= { input: 0, output: 0, calls: 0 }); a.input += v.input; a.output += v.output; a.calls += v.calls; } return acc; }, {}),
        },
      };
    },
  };
  return ledger;
}

module.exports = { createLedger };
