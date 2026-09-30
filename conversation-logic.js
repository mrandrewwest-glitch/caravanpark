'use strict';

const D = require('./dates');

const MSG = {
  fallback: 'Our system is busy, let me transfer you to our team.',
  booking: 'Perfect, let me connect you with our team to confirm that.',
  complaint: "I'm sorry to hear that. Let me get one of our team to help you right away.",
  outOfScope: "That's one for our team to help with, so let me connect you now.",
  specialNeeds: 'Let me put you through to our team so they can look after that properly.',
  extendedStay: "For a longer stay it's best to speak with our team, so let me connect you.",
  noAvailability: "I'm sorry, I can't find anything available that suits those details. Let me connect you with our team to see what we can do.",
  newbookDown: "We can't check availability right now, let me get someone for you.",
  cantUnderstand: "I'm having trouble getting that, so let me put you through to our team.",
  spam: 'Thanks for calling, have a great day.',
  askWhen: 'When are you thinking of coming?',
  askNights: 'How many nights are you looking to stay?',
  didntCatch: "Sorry, I didn't quite catch that. Could you say that again?",
};

const MAX_CLARIFICATIONS = 2; // a third would-be clarification escalates instead
const EXTENDED_STAY_NIGHTS = 28;
const YES = /^\s*(yes|yeah|yep|yup|correct|that'?s (right|correct)|right|sure|please do)\b/i;
const NO = /^\s*(no|nope|nah|not quite|wrong|incorrect)\b/i;

function newState(call) {
  return {
    call_sid: call.call_sid,
    caller_phone: call.caller_phone,
    turn_number: 0,
    extracted_data: {},
    conversation_history: [],
    available_sites: [],
    availability_query: null,
    clarifications: 0,
    pending_confirmation: false,
    status: 'gathering_info', // gathering_info | showing_availability | ready_to_transfer | ended
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

// Runs one caller turn. Returns the Dialpad response plus a trace for logs/tests.
async function handleTurn(call, deps, deadline) {
  const { claude, newbook, store, logger, config } = deps;
  const today = deps.today();
  const started = Date.now();
  const state = (await store.get(call.call_sid)) || newState(call);
  state.turn_number += 1;
  if (call.caller_phone) state.caller_phone = call.caller_phone;
  const timeLeft = (cap) => Math.max(300, Math.min(cap, deadline - Date.now() - 100));

  const trace = {
    call_sid: call.call_sid,
    turn: state.turn_number,
    claude_mode: claude.mode,
    input: call.transcript,
    dialpad_confidence: call.confidence,
    extraction: null,
    newbook_query: null,
    newbook_sites_returned: null,
    sites_passed_to_claude: null,
    decision: null,
    response: null,
  };

  state.conversation_history.push({ role: 'caller', text: call.transcript });

  const finish = async ({ text, decision, transfer = false, end = false, reason = null }) => {
    state.conversation_history.push({ role: 'ai', text });
    if (end) state.status = 'ended';
    else if (transfer) state.status = 'ready_to_transfer';
    trace.decision = decision;
    trace.response = text;
    trace.latency_ms = Date.now() - started;
    await store.set(call.call_sid, state);
    const result = {
      response_text: text,
      transfer_to_human: transfer,
      metadata: { call_sid: call.call_sid, turn: state.turn_number, status: state.status },
      trace,
    };
    if (end) result.end_call = true;
    if (transfer) {
      result.transfer_details = {
        call_sid: call.call_sid,
        caller_phone: state.caller_phone,
        summary: summarise(state, reason || decision),
        available_sites: state.available_sites.map((s) => s.site_id),
        conversation_history: state.conversation_history,
      };
    }
    return result;
  };

  const clarify = async (text, decision) => {
    if (state.clarifications >= MAX_CLARIFICATIONS) {
      return finish({ text: MSG.cantUnderstand, decision: 'transfer: could not understand after clarifications', transfer: true, reason: 'AI could not understand after 2 clarifications' });
    }
    state.clarifications += 1;
    return finish({ text, decision });
  };

  // Poor transcription: ask again without spending a Claude call.
  if (!call.transcript.trim() || (typeof call.confidence === 'number' && call.confidence < 0.5)) {
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
      timeoutMs: timeLeft(config.extractTimeoutMs),
    });
    trace.extraction = extraction;
    state.extracted_data = mergeExtracted(state.extracted_data, extraction);
  }
  const data = state.extracted_data;

  // ---- Escalation triggers ----
  if (extraction) {
    const why = extraction.handoff_reason;
    switch (extraction.intent) {
      case 'spam':
        return finish({ text: MSG.spam, decision: 'end: spam/bot caller', end: true });
      case 'booking':
        return finish({ text: MSG.booking, decision: 'transfer: booking intent', transfer: true, reason: why || 'caller wants to book' });
      case 'complaint':
        return finish({ text: MSG.complaint, decision: 'transfer: unhappy caller', transfer: true, reason: why || 'caller unhappy' });
      case 'special_needs':
        return finish({ text: MSG.specialNeeds, decision: 'transfer: special request', transfer: true, reason: why || 'special request' });
      case 'out_of_scope':
        return finish({ text: MSG.outOfScope, decision: 'transfer: out of scope', transfer: true, reason: why || 'outside receptionist scope' });
      default:
    }
  }
  if (data.check_in_date && data.check_out_date && D.nightsBetween(data.check_in_date, data.check_out_date) >= EXTENDED_STAY_NIGHTS) {
    return finish({ text: MSG.extendedStay, decision: 'transfer: extended stay', transfer: true, reason: 'extended stay' });
  }

  // ---- Do we have enough to query NewBook? ----
  if (!data.check_in_date) return clarify(MSG.askWhen, 'clarify: no dates');
  if (!data.check_out_date) return clarify(MSG.askNights, 'clarify: no check-out date');
  if (extraction && (extraction.confidence < 0.8 || extraction.needs_clarification)) {
    state.pending_confirmation = true;
    return clarify(`Just to check, that's ${D.spoken(data.check_in_date)} to ${D.spoken(data.check_out_date)}, is that right?`, 'clarify: confirm dates (low confidence)');
  }
  state.clarifications = 0;

  // ---- Query NewBook (live), falling back to this call's cached result ----
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
      return finish({ text: MSG.newbookDown, decision: 'transfer: NewBook unavailable, no cache', transfer: true, reason: 'availability system down' });
    }
    trace.newbook_cache_used = true;
    availability = { sites: state.available_sites, park_name: config.parkName };
  }
  trace.newbook_sites_returned = availability.sites.length;

  const sites = relevantSites(availability.sites, data);
  trace.sites_passed_to_claude = sites.map((s) => s.site_id);
  if (!sites.length) {
    return finish({ text: MSG.noAvailability, decision: 'transfer: no suitable availability', transfer: true, reason: 'no availability for requested dates/needs' });
  }

  const text = await claude.generateResponse({
    transcript: call.transcript,
    extracted: data,
    sites,
    totalAvailable: sites.length,
    parkName: availability.park_name || config.parkName,
    timeoutMs: timeLeft(config.responseTimeoutMs),
  });
  state.status = 'showing_availability';
  return finish({ text, decision: 'respond: availability' });
}

// Wraps handleTurn with the hard latency budget and the safe fallback.
async function processCall(call, deps) {
  const { config, logger } = deps;
  const started = Date.now();
  const deadline = started + config.turnDeadlineMs;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), config.turnDeadlineMs);
  });
  const fallback = (why) => ({
    response_text: MSG.fallback,
    transfer_to_human: true,
    metadata: { call_sid: call.call_sid, turn: null, status: 'ready_to_transfer', error: why },
    trace: { call_sid: call.call_sid, input: call.transcript, decision: `fallback: ${why}`, response: MSG.fallback, latency_ms: Date.now() - started },
  });
  try {
    const result = await Promise.race([handleTurn(call, deps, deadline), timeout]);
    if (result.timedOut) {
      logger.error('turn_deadline_exceeded', { call_sid: call.call_sid, budget_ms: config.turnDeadlineMs });
      return fallback('deadline exceeded');
    }
    return result;
  } catch (err) {
    logger.error('turn_failed', { call_sid: call.call_sid, error: err.message });
    return fallback(err.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { processCall, handleTurn, MSG, mergeExtracted, relevantSites };
