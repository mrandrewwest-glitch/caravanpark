'use strict';

const { dateInZone } = require('./util');
const repos = require('./repos');

// Per-call usage ledger. Billing ($ monthly fee + $ per answered call), statements and
// the pilot's cost analysis all read from here. In production this lives in a durable
// table WITHOUT a short TTL (billing records must outlive call state).
//
// A call is BILLABLE when it was answered, was not spam, was not a test call, had at
// least one real exchange, and lasted at least billing.min_call_seconds.

function createLedger({ store, now = Date.now, logger }) {
  const ledger = {
    // All writes are optimistic read-modify-writes (store.update): safe across Lambda containers.
    // The functions passed in must be pure (they can be re-run on a conflict).
    async recordTurn(call, park, t) {
      const ts = now();
      return repos.updateCall(store, call.call_sid, (existing) => {
        const r = existing || {
          call_sid: call.call_sid, park_id: park ? park.id : null, caller_phone: call.caller_phone || null,
          started_at: ts, last_turn_at: ts, turns: 0, real_exchanges: 0, spam: false, is_test: !!call.is_test,
          handoff: null, bookings_created: [], sms_segments: 0, tokens: {}, finalized_at: null,
        };
        r.last_turn_at = ts;
        r.turns += 1;
        if (!t.fallback && (call.transcript || '').trim()) r.real_exchanges += 1;
        if (t.spam) r.spam = true;
        if (t.handoff) r.handoff = t.handoff;
        if (t.fallback) r.fallback_turns = (r.fallback_turns || 0) + 1;
        // What the owner sees in the call log: a one-line summary and, once known, who it was. No transcript is kept here.
        if (t.summary) r.summary = t.summary;
        if (t.caller_name) r.caller_name = t.caller_name;
        if (t.decision) r.last_decision = t.decision;
        for (const u of (t.usage || [])) {
          const m = (r.tokens[u.model] ||= { input: 0, output: 0, calls: 0 });
          m.input += u.input_tokens || 0;
          m.output += u.output_tokens || 0;
          m.calls += 1;
        }
        return r;
      });
    },

    async addBooking(callSid, ref) {
      return repos.updateCall(store, callSid, (r) => { if (!r) return undefined; r.bookings_created.push(ref); return r; });
    },

    async addSms(callSid, segments) {
      if (!callSid) return null;
      return repos.updateCall(store, callSid, (r) => { if (!r) return undefined; r.sms_segments += segments; return r; });
    },

    // Called by the Dialpad call-ended event (real duration) or the idle finaliser (estimate).
    // Idempotent: a finalised call is never changed or billed twice. idleMs guards the idle
    // finaliser against a stale (eventually consistent) index: skip calls with recent activity.
    async finalizeCall(callSid, park, { duration_seconds: duration = null, idleMs = null } = {}) {
      let finalized = false;
      const rec = await repos.updateCall(store, callSid, (r) => {
        finalized = false;
        if (!r || r.finalized_at) return undefined;
        if (idleMs !== null && now() - r.last_turn_at < idleMs) return undefined;
        const estimated = duration === null;
        r.duration_seconds = estimated ? Math.round((r.last_turn_at - r.started_at) / 1000) : duration;
        r.duration_source = estimated ? 'estimated' : 'provider';
        const min = park ? park.billing.min_call_seconds : 15;
        if (r.spam) r.outcome = 'spam';
        else if (!r.real_exchanges || r.fallback_turns === r.turns) r.outcome = 'failed';
        else if (r.duration_seconds < min && !estimated) r.outcome = 'abandoned';
        else r.outcome = 'answered';
        r.billable = r.outcome === 'answered' && !r.is_test;
        r.finalized_at = now();
        finalized = true;
        return r;
      });
      if (finalized) logger?.info('call_finalized', { call_sid: callSid, outcome: rec.outcome, billable: rec.billable, duration_seconds: rec.duration_seconds });
      return rec;
    },

    // Finalise calls with no end event after idleMs (call-ended webhook missed).
    async finalizeIdle(parks, idleMs = 15 * 60 * 1000) {
      const done = [];
      for (const rec of await repos.openCallsBefore(store, now() - idleMs)) {
        const park = parks ? await parks.get(rec.park_id) : null;
        const out = await ledger.finalizeCall(rec.call_sid, park, { idleMs });
        if (out && out.finalized_at && !rec.finalized_at) done.push(out);
      }
      return done;
    },

    // Monthly statement for one park. month = "YYYY-MM" in the park's timezone.
    async statement(park, month) {
      // Index range is padded by 36h either side, then filtered exactly in the park's timezone.
      const [y, m] = month.split('-').map(Number);
      const candidates = await repos.parkCalls(store, park.id, Date.UTC(y, m - 1, 1) - 36 * 3600e3, Date.UTC(y, m, 1) + 36 * 3600e3);
      const rows = candidates.filter((r) => r.finalized_at && dateInZone(r.started_at, park.timezone).startsWith(month));
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
