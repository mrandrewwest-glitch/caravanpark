'use strict';

// Everything the owner portal reads or changes, scoped to ONE park. The park always comes from the signed-in
// session, never from the request, and every record fetched by id is checked against that park before it is
// returned (so guessing another park's call or booking id yields "not found", not data).
const repos = require('./repos');
const { dateInZone } = require('./util');

const monthOf = (ms, tz) => dateInZone(ms, tz).slice(0, 7);
const validMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const monthRange = (month) => { const [y, m] = month.split('-').map(Number); return [Date.UTC(y, m - 1, 1) - 36 * 3600e3, Date.UTC(y, m, 1) + 36 * 3600e3]; };
const prevMonth = (month) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

// What an owner calls this outcome.
function outcomeOf(rec) {
  if (!rec.finalized_at) return 'in_progress';
  if (rec.outcome === 'spam') return 'spam';
  if (rec.outcome === 'abandoned') return 'hung_up';
  if (rec.outcome === 'failed') return 'problem';
  if (rec.bookings_created && rec.bookings_created.length) return 'booking';
  if (rec.handoff && rec.handoff.strategy === 'take_message') return 'message';
  if (rec.handoff && rec.handoff.strategy === 'live_transfer') return 'transferred';
  return 'answered';
}

const callView = (rec, tz) => ({
  id: rec.call_sid, started_ms: rec.started_at, month: monthOf(rec.started_at, tz), caller_phone: rec.caller_phone || null, caller_name: rec.caller_name || null,
  outcome: outcomeOf(rec), summary: rec.summary || '', duration_seconds: rec.duration_seconds ?? null, duration_source: rec.duration_source || null,
  billable: !!rec.billable, test: !!rec.is_test, bookings: rec.bookings_created || [], handoff: rec.handoff ? { strategy: rec.handoff.strategy, reason: rec.handoff.reason } : null,
  texts_sent: rec.sms_segments || 0,
});

async function listCalls(deps, park, { month, outcome } = {}) {
  const [from, to] = monthRange(month);
  const rows = (await repos.parkCalls(deps.store, park.id, from, to))
    .filter((r) => r.park_id === park.id && monthOf(r.started_at, park.timezone) === month)
    .map((r) => callView(r, park.timezone))
    .filter((c) => !outcome || c.outcome === outcome)
    .sort((a, b) => b.started_ms - a.started_ms);
  return rows;
}

async function getCall(deps, park, id) {
  const rec = typeof id === 'string' && id.length <= 128 ? await repos.getCall(deps.store, id) : null;
  return rec && rec.park_id === park.id ? callView(rec, park.timezone) : null;
}

const bookingView = (r) => ({
  ref: r.booking_ref, status: r.status, site: r.site_name, check_in: r.check_in, check_out: r.check_out, guest: r.guest ? r.guest.name : null, guests: r.guest ? r.guest.num_guests : null,
  mobile: r.mobile || null, total: r.total, amount_due: r.amount_due_cents / 100, created_ms: r.created_ms, hold_expires_ms: r.status === 'held' ? r.hold_expires_ms : null, paid_ms: r.paid_ms || null,
});
async function listBookings(deps, park) {
  return (await repos.parkBookings(deps.store, park.id)).filter((r) => r.park_id === park.id).map(bookingView).sort((a, b) => b.created_ms - a.created_ms);
}

const messageView = (m) => ({ id: m.call_sid, name: m.name, number: m.callback_number, reason: m.reason, summary: m.summary, notes: m.notes || [], status: m.status, created_ms: m.created_ms, done_ms: m.done_ms || null, done_by: m.done_by || null });
async function listMessages(deps, park) {
  return (await repos.parkMessages(deps.store, park.id)).filter((m) => m.park_id === park.id).map(messageView).sort((a, b) => b.created_ms - a.created_ms);
}
async function markMessageDone(deps, park, id, by, done = true) {
  const m = typeof id === 'string' && id.length <= 128 ? await repos.getMessage(deps.store, park.id, id) : null;
  if (!m || m.park_id !== park.id) return null;
  const updated = { ...m, status: done ? 'done' : 'open', done_ms: done ? deps.now() : null, done_by: done ? by : null };
  await repos.saveMessage(deps.store, updated);
  await repos.appendAudit(deps.store, park.id, { type: done ? 'message_done' : 'message_reopened', by, message: id, name: m.name }, deps.now());
  return messageView(updated);
}

// A month's statement (same numbers as the usage ledger) plus calls and what was not billed.
const statementOf = (deps, park, month) => deps.ledger.statement(park, month);

async function statements(deps, park, count = 12) {
  const now = deps.now();
  let month = monthOf(now, park.timezone);
  const current = month;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const st = await statementOf(deps, park, month);
    out.push({ month, billable_calls: st.billable_calls, calls_total: st.calls_total, usage_charges: st.usage_charges, monthly_fee: st.monthly_fee, total: st.total, currency: st.currency, in_progress: month === current });
    month = prevMonth(month);
  }
  return out;
}

// CSV for accountants. Cells that a spreadsheet could read as a formula are neutralised.
const csvCell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function statementCsv(park, st) {
  const rows = [
    ['Statement', `${park.name} ${st.month}`], ['Currency', st.currency], ['Amounts exclude GST', 'yes'], [],
    ['Date', 'Call', 'Length (seconds)', 'Length is', 'Bookings made', 'Handed off'],
    ...st.lines.map((l) => [l.date, l.call_sid, l.duration_seconds, l.duration_source, l.bookings, l.handoff || '']),
    [],
    ['Monthly fee', st.monthly_fee], [`Answered calls (${st.billable_calls} x ${st.per_call_fee})`, st.usage_charges], ['Total', st.total],
  ];
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

async function overview(deps, park) {
  const month = monthOf(deps.now(), park.timezone);
  const [calls, bookings, messages, st] = await Promise.all([listCalls(deps, park, { month }), listBookings(deps, park), listMessages(deps, park), statementOf(deps, park, month)]);
  const inMonth = bookings.filter((b) => monthOf(b.created_ms, park.timezone) === month);
  return {
    month, park: { id: park.id, name: park.name },
    calls_this_month: calls.filter((c) => !c.test).length, answered_billable: st.billable_calls,
    bookings_this_month: inMonth.length, confirmed_value: inMonth.filter((b) => b.status === 'confirmed').reduce((n, b) => n + b.total, 0),
    unpaid_holds: bookings.filter((b) => b.status === 'held').length, open_messages: messages.filter((m) => m.status === 'open').length,
    bill_so_far: st.total, currency: st.currency, recent_calls: calls.slice(0, 5),
  };
}

// Owner-editable settings and the read-only facts shown beside them.
const settingsView = (park) => ({
  editable: {
    name: park.name, mode: park.mode, booking_mode: park.booking_mode, hold_minutes: park.hold_minutes, deposit_percent: park.deposit_percent, max_nights: park.limits.max_nights,
    callback_promise: park.staff.callback_promise, staff_alert_numbers: park.staff.alert_numbers, staff_alert_emails: park.staff.alert_emails,
  },
  fixed: { park_id: park.id, phone_numbers: park.numbers, texts_sent_from: park.sms_from, timezone: park.timezone, monthly_fee: park.billing.monthly_fee, per_call_fee: park.billing.per_call, currency: park.billing.currency },
});
const diffSettings = (before, after) => { const out = {}; for (const k of Object.keys(after)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { from: before[k], to: after[k] }; return out; };

module.exports = { listCalls, getCall, listBookings, listMessages, markMessageDone, statements, statementOf, statementCsv, overview, settingsView, diffSettings, validMonth, monthOf, outcomeOf, csvCell };
