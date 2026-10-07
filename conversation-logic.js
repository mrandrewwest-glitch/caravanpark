'use strict';

const D = require('./dates');
const { MSG, LIVE, LEAD } = require('./messages');
const { redactCardNumbers } = require('./redact');
const { bookingTurn, startMessageFlow, messageTurn } = require('./booking-flow');
const { alertStaff } = require('./comms');
const { TTL, keys } = require('./repos');

const MAX_HISTORY = 80; // keeps the call-state item well under DynamoDB's 400 KB limit

const MAX_CLARIFICATIONS = 2; // a third would-be clarification hands off instead
const EXTENDED_STAY_NIGHTS = 28;
const YES = /^\s*(yes|yeah|yep|yup|correct|that'?s (right|correct)|right|sure|please do)\b/i;
const NO = /^\s*(no|nope|nah|not quite|wrong|incorrect)\b/i;

function newState(call, park) {
  return {
    call_sid: call.call_sid,
    park_id: park.id,
    caller_phone: call.caller_phone,
    turn_number: 0,
    extracted_data: {},
    conversation_history: [],
    available_sites: [],
    availability_query: null,
    clarifications: 0,
    pending_confirmation: false,
    booking: null, // booking flow state (see booking-flow.js)
    flow: null, // take-a-message flow state
    status: 'gathering_info', // gathering_info | showing_availability | ready_to_transfer | message_taken | ended
  };
}

const KEYS = ['check_in_date', 'check_out_date', 'num_guests', 'vehicle_type', 'has_pet', 'special_requests'];

function mergeExtracted(prev, next) {
  const merged = { ...prev };
  for (const k of KEYS) if (next[k] !== null && next[k] !== undefined) merged[k] = next[k];
  // A new check-in with no check-out must not inherit the old check-out.
  if (next.check_in_date && !next.check_out_date && next.check_in_date !== prev.check_in_date) merged.check_out_date = null;
  return merged;
}

function summarise(state, reason) {
  const d = state.extracted_data;
  const parts = [];
  if (d.num_guests) parts.push(`${d.num_guests} guests`);
  if (d.vehicle_type) parts.push(d.vehicle_type);
  if (d.check_in_date) parts.push(d.check_out_date ? `${d.check_in_date} to ${d.check_out_date}` : `from ${d.check_in_date}`);
  if (d.has_pet) parts.push('has a pet');
  if (d.special_requests) parts.push(`notes: ${d.special_requests}`);
  return `${parts.length ? `Customer: ${parts.join(', ')}. ` : ''}Reason for transfer: ${reason}.`;
}

function relevantSites(sites, data) {
  const wantsKids = /kid|child|family|playground/i.test(data.special_requests || '');
  return sites
    .filter((s) => s.available)
    .filter((s) => data.has_pet !== true || s.pet_friendly)
    .filter((s) => !data.num_guests || s.max_guests >= data.num_guests)
    .sort((a, b) => {
      // Kid-friendly first when asked; powered sites next (caravans need power); then cheapest.
      const score = (s) => (wantsKids && s.amenities.includes('playground_nearby') ? 2 : 0) + (s.amenities.includes('power') ? 1 : 0);
      return score(b) - score(a) || a.price - b.price;
    });
}

function createMeter() {
  const usage = [];
  return { usage, add(model, u) { if (u) usage.push({ model, input_tokens: u.input_tokens, output_tokens: u.output_tokens }); } };
}

// Runs one caller turn. Returns the Dialpad response plus a trace for logs/tests.
async function handleTurn(rawCall, deps, deadline, park) {
  const { claude, store, logger, config, ledger } = deps;
  const newbook = deps.providers.newbook(park);
  const today = deps.today(park);
  const started = Date.now();
  const stateKey = keys.state(rawCall.call_sid);
  const state = (await store.get(stateKey)) || newState(rawCall, park);
  state.turn_number += 1;
  if (rawCall.caller_phone) state.caller_phone = rawCall.caller_phone;
  const timeLeft = (cap) => Math.max(300, Math.min(cap, deadline - Date.now() - 100));
  const meter = createMeter();
  const bookingEnabled = park.booking_mode === 'ai_booking';

  // Card numbers must never reach storage, logs or Claude.
  const redaction = redactCardNumbers(rawCall.transcript);
  const call = { ...rawCall, transcript: redaction.text };

  const trace = {
    call_sid: call.call_sid, park_id: park.id, turn: state.turn_number, claude_mode: claude.mode, flow: 'availability',
    input: call.transcript, dialpad_confidence: call.confidence, extraction: null, newbook_query: null,
    newbook_sites_returned: null, sites_passed_to_claude: null, decision: null, response: null,
  };
  if (redaction.redacted) trace.card_number_redacted = true;

  state.conversation_history.push({ role: 'caller', text: call.transcript });

  const finish = async ({ text, decision, transfer = false, end = false, reason = null, handoff = null, extra = null, spam = false }) => {
    state.conversation_history.push({ role: 'ai', text });
    if (end) state.status = 'ended';
    else if (transfer) state.status = 'ready_to_transfer';
    trace.decision = decision;
    trace.response = text;
    trace.latency_ms = Date.now() - started;
    if (state.conversation_history.length > MAX_HISTORY) state.conversation_history = state.conversation_history.slice(-MAX_HISTORY);
    await store.set(stateKey, state, { ttlSeconds: TTL.state });
    const handoffInfo = handoff || (transfer ? { strategy: 'live_transfer', reason: reason || decision } : null);
    await ledger.recordTurn(call, park, { spam, handoff: handoffInfo, usage: meter.usage });
    const result = {
      response_text: text,
      transfer_to_human: transfer,
      metadata: { call_sid: call.call_sid, turn: state.turn_number, status: state.status, park_id: park.id },
      trace,
    };
    if (end) result.end_call = true;
    if (handoffInfo) result.handoff = handoffInfo;
    if (extra && extra.booking) result.booking = extra.booking;
    if (transfer) {
      result.transfer_details = {
        call_sid: call.call_sid, caller_phone: state.caller_phone, summary: summarise(state, reason || decision),
        available_sites: state.available_sites.map((s) => s.site_id), conversation_history: state.conversation_history,
      };
    }
    return result;
  };

  const ctx = { call, deps, park, state, trace, newbook, finish, extraction: null, data: null };
  ctx.summary = (reason) => summarise(state, reason);
  ctx.relevant = (availability) => relevantSites(availability.sites, state.extracted_data);

  // Nobody free (diversion) -> take a message; staff available (full) -> live transfer.
  ctx.handoff = async ({ kind, decision, reason = null }) => {
    const why = reason || (ctx.extraction && ctx.extraction.handoff_reason) || kind.replace(/_/g, ' ');
    if (park.mode === 'full') return finish({ text: LIVE[kind] || LIVE.generic, decision, transfer: true, reason: why });
    trace.decision = decision;
    return startMessageFlow(ctx, { kind, reason: why, lead: LEAD[kind] || LEAD.generic });
  };

  const inFlow = !!(state.flow || state.booking);

  const clarify = async (text, decision) => {
    if (state.clarifications >= MAX_CLARIFICATIONS) return ctx.handoff({ kind: 'cant_understand', decision: 'transfer: could not understand after clarifications', reason: 'AI could not understand after 2 clarifications' });
    state.clarifications += 1;
    return finish({ text, decision });
  };

  if (redaction.redacted) return finish({ text: MSG.cardWarning, decision: 'card digits redacted; asked caller not to read card details' });

  // Poor transcription: ask again without spending a Claude call.
  if (!call.transcript.trim() || (typeof call.confidence === 'number' && call.confidence < 0.5)) {
    if (inFlow) return finish({ text: MSG.didntCatch, decision: 'repeat: low transcript confidence' });
    return clarify(MSG.didntCatch, 'clarify: low transcript confidence');
  }

  // Answer to "Just to check, that's X to Y?"
  let extraction = null;
  if (state.pending_confirmation) {
    if (YES.test(call.transcript)) {
      state.pending_confirmation = false;
      trace.extraction = 'skipped (caller confirmed dates)';
    } else if (NO.test(call.transcript)) {
      state.pending_confirmation = false;
      state.extracted_data.check_in_date = null;
      state.extracted_data.check_out_date = null;
      trace.extraction = 'skipped (caller rejected dates)';
      return clarify(`No problem. ${MSG.askWhen}`, 'clarify: dates rejected');
    } else {
      state.pending_confirmation = false;
    }
  }

  if (!trace.extraction) {
    const lastAi = [...state.conversation_history].reverse().find((h) => h.role === 'ai');
    extraction = await claude.extractIntent({
      transcript: call.transcript,
      today,
      known: state.extracted_data,
      lastQuestion: lastAi ? lastAi.text : null,
      sitesOffered: state.available_sites.slice(0, 5).map((s) => ({ id: s.site_id, name: s.name })),
      timeoutMs: timeLeft(config.extractTimeoutMs),
      meter,
    });
    trace.extraction = extraction;
    state.extracted_data = mergeExtracted(state.extracted_data, extraction);
  }
  ctx.extraction = extraction;
  const data = state.extracted_data;
  ctx.data = data;

  // ---- Shared closures used by the availability and booking flows ----
  ctx.requireDates = async () => {
    if (!data.check_in_date) return clarify(MSG.askWhen, 'clarify: no dates');
    if (!data.check_out_date) return clarify(MSG.askNights, 'clarify: no check-out date');
    // Confidence describes THIS message, so only judge it when this message supplied dates.
    const suppliedDates = extraction && (extraction.check_in_date || extraction.check_out_date);
    if (suppliedDates && (extraction.confidence < 0.8 || extraction.needs_clarification) && extraction.intent !== 'booking') {
      state.pending_confirmation = true;
      return clarify(`Just to check, that's ${D.spoken(data.check_in_date)} to ${D.spoken(data.check_out_date)}, is that right?`, 'clarify: confirm dates (low confidence)');
    }
    state.clarifications = 0;
    return null;
  };

  // Query NewBook (live), falling back to this call's cached result for the same dates.
  ctx.fetchSites = async () => {
    const query = { check_in: data.check_in_date, check_out: data.check_out_date };
    trace.newbook_query = query;
    let availability;
    try {
      availability = await newbook.getAvailability(query.check_in, query.check_out);
      state.availability_query = query;
      state.available_sites = availability.sites.filter((s) => s.available);
    } catch (err) {
      logger.warn('newbook_failed', { call_sid: call.call_sid, error: err.message });
      const cached = state.availability_query;
      if (!(cached && cached.check_in === query.check_in && cached.check_out === query.check_out && state.available_sites.length)) {
        trace.newbook_error = err.message;
        return { reply: await ctx.handoff({ kind: 'newbook_down', decision: 'transfer: NewBook unavailable, no cache', reason: 'availability system down' }) };
      }
      trace.newbook_cache_used = true;
      availability = { sites: state.available_sites, park_name: park.name };
    }
    trace.newbook_sites_returned = availability.sites.length;
    const sites = relevantSites(availability.sites, data);
    trace.sites_passed_to_claude = sites.map((s) => s.site_id);
    if (!sites.length) return { reply: await ctx.handoff({ kind: 'no_availability', decision: 'transfer: no suitable availability', reason: 'no availability for requested dates/needs' }) };
    return { sites, availability };
  };

  ctx.offerSites = async (fetched, prefix, decision) => {
    const sites = relevantSites(fetched.availability.sites, data);
    if (!sites.length) return ctx.handoff({ kind: 'no_availability', decision: 'transfer: no suitable availability', reason: 'no availability for requested dates/needs' });
    trace.sites_passed_to_claude = sites.map((s) => s.site_id);
    const text = await claude.generateResponse({
      transcript: call.transcript, extracted: data, sites, totalAvailable: sites.length,
      parkName: fetched.availability.park_name || park.name, bookingEnabled, timeoutMs: timeLeft(config.responseTimeoutMs), meter,
    });
    state.status = 'showing_availability';
    return finish({ text: `${prefix}${text}`, decision });
  };

  // ---- Take-a-message flow in progress ----
  if (state.flow) {
    if (extraction && extraction.intent === 'spam') return finish({ text: MSG.spam, decision: 'end: spam/bot caller', end: true, spam: true });
    trace.flow = 'message';
    return messageTurn(ctx);
  }

  // ---- Escalation triggers ----
  if (extraction) {
    if (extraction.intent === 'spam') return finish({ text: MSG.spam, decision: 'end: spam/bot caller', end: true, spam: true });
    if (extraction.intent === 'complaint') return ctx.handoff({ kind: 'complaint', decision: 'transfer: unhappy caller' });
    if (extraction.intent === 'special_needs') return ctx.handoff({ kind: 'special_needs', decision: 'transfer: special request' });
    if (extraction.intent === 'out_of_scope') return ctx.handoff({ kind: 'out_of_scope', decision: 'transfer: out of scope' });
    if (extraction.wants_human) return ctx.handoff({ kind: 'wants_human', decision: 'transfer: caller asked for a person', reason: 'caller asked for a person / call back' });
    if (extraction.intent === 'booking' && !bookingEnabled) return ctx.handoff({ kind: 'booking', decision: 'transfer: booking intent', reason: extraction.handoff_reason || 'caller wants to book' });
  }
  if (data.check_in_date && data.check_out_date && D.nightsBetween(data.check_in_date, data.check_out_date) >= EXTENDED_STAY_NIGHTS) {
    return ctx.handoff({ kind: 'extended_stay', decision: 'transfer: extended stay', reason: 'extended stay' });
  }

  // ---- Booking made earlier in this call ----
  if (state.booking && state.booking.ref) {
    trace.flow = 'booking';
    return finish({ text: MSG.postBooking, decision: 'booking: already created, awaiting payment' });
  }

  // ---- AI booking flow ----
  const wantsBooking = bookingEnabled && (state.booking || (extraction && (extraction.intent === 'booking' || (extraction.chosen_site_id && state.status === 'showing_availability'))));
  if (wantsBooking) return bookingTurn(ctx);

  // ---- Availability enquiry ----
  const dateStop = await ctx.requireDates();
  if (dateStop) return dateStop;
  const fetched = await ctx.fetchSites();
  if (fetched.reply) return fetched.reply;
  return ctx.offerSites(fetched, '', 'respond: availability');
}

// Wraps handleTurn with park routing, the hard latency budget and the safe fallback.
async function processCall(call, deps) {
  const { config, logger, ledger } = deps;
  const started = Date.now();
  let park = null;
  try { park = await deps.registry.resolve(call.called_number); } catch (err) { logger.error('park_resolve_failed', { error: err.message }); }
  if (!park) {
    logger.error('unknown_park', { called_number: call.called_number });
    return { response_text: MSG.fallback, transfer_to_human: true, metadata: { call_sid: call.call_sid, turn: null, status: 'ready_to_transfer', error: 'unknown park' }, trace: { call_sid: call.call_sid, decision: 'fallback: unknown park', response: MSG.fallback, latency_ms: 0 } };
  }

  const deadline = started + config.turnDeadlineMs;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), config.turnDeadlineMs); });

  const fallback = async (why) => {
    const live = park.mode === 'full';
    const text = live ? MSG.fallback : MSG.fallbackMessage;
    const handoff = { strategy: live ? 'live_transfer' : 'take_message', reason: `system fallback: ${why}` };
    try {
      await ledger.recordTurn(call, park, { fallback: true, handoff });
      if (!live) {
        // Nobody to transfer to: record a minimal message so staff still call back.
        await deps.store.set(keys.message(park.id, call.call_sid), { id: `${park.id}:${call.call_sid}`, park_id: park.id, call_sid: call.call_sid, name: null, callback_number: call.caller_phone || null, caller_phone: call.caller_phone || null, reason: handoff.reason, notes: [], status: 'open', created_ms: deps.now(), summary: `System fallback (${why}); caller said: ${(call.transcript || '').slice(0, 200)}` }, { ttlSeconds: TTL.messages });
        await alertStaff(deps, park, { kind: 'callback_requested', summary: `System fallback; call back ${call.caller_phone || 'unknown number'}. Reason: ${why}` });
      }
    } catch (err) { logger.error('fallback_bookkeeping_failed', { error: err.message }); }
    return {
      response_text: text, transfer_to_human: live,
      metadata: { call_sid: call.call_sid, turn: null, status: live ? 'ready_to_transfer' : 'message_taken', error: why, park_id: park.id },
      handoff,
      trace: { call_sid: call.call_sid, park_id: park.id, input: call.transcript, decision: `fallback: ${why}`, response: text, latency_ms: Date.now() - started },
    };
  };

  try {
    const result = await Promise.race([handleTurn(call, deps, deadline, park), timeout]);
    if (result.timedOut) {
      logger.error('turn_deadline_exceeded', { call_sid: call.call_sid, budget_ms: config.turnDeadlineMs });
      return await fallback('deadline exceeded');
    }
    return result;
  } catch (err) {
    logger.error('turn_failed', { call_sid: call.call_sid, error: err.message });
    return await fallback(err.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { processCall, handleTurn, MSG, mergeExtracted, relevantSites };
