'use strict';

const { processCall } = require('./conversation-logic');
const { MSG } = require('./messages');

const MAX_TRANSCRIPT_CHARS = 1000;

// Validates the Dialpad webhook body. Returns { call } or { error }.
function parseDialpadPayload(body) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const { call_sid: callSid, transcript, caller_phone: callerPhone, confidence, called_number: calledNumber } = body;
  if (typeof callSid !== 'string' || !callSid.trim() || callSid.length > 128) return { error: 'call_sid is required' };
  if (transcript !== undefined && typeof transcript !== 'string') return { error: 'transcript must be a string' };
  return {
    call: {
      call_sid: callSid.trim(),
      transcript: (transcript || '').slice(0, MAX_TRANSCRIPT_CHARS),
      caller_phone: typeof callerPhone === 'string' ? callerPhone.slice(0, 32) : null,
      confidence: typeof confidence === 'number' ? confidence : null,
      called_number: typeof calledNumber === 'string' ? calledNumber.slice(0, 32) : null,
    },
  };
}

// Dialpad-facing response shape; trace/details are extras for tests and human handoff.
function formatResponse(result, { includeTrace }) {
  const out = {
    response_text: result.response_text,
    transfer_to_human: result.transfer_to_human,
    metadata: result.metadata,
  };
  if (result.end_call) out.end_call = true;
  if (result.transfer_details) out.transfer_details = result.transfer_details;
  if (result.handoff) out.handoff = result.handoff;
  if (result.booking) out.booking = result.booking;
  if (includeTrace) out.trace = result.trace;
  return out;
}

function phoneCallback(deps, { includeTrace = false, isTest = false } = {}) {
  return async (req, res) => {
    const parsed = parseDialpadPayload(req.body);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error, response_text: MSG.fallback, transfer_to_human: true });
    }
    const result = await processCall({ ...parsed.call, is_test: isTest }, deps);
    deps.logger.info('turn', {
      call_sid: parsed.call.call_sid,
      turn: result.metadata.turn,
      decision: result.trace.decision,
      transfer: result.transfer_to_human,
      latency_ms: result.trace.latency_ms,
    });
    res.json(formatResponse(result, { includeTrace }));
  };
}

// Call-ended event: gives the ledger the real duration so billing doesn't rely on estimates.
function callEnded(deps) {
  return async (req, res) => {
    const { call_sid: callSid, duration_seconds: duration, called_number: calledNumber } = req.body || {};
    if (typeof callSid !== 'string' || !callSid) return res.status(400).json({ error: 'call_sid is required' });
    const park = await deps.registry.resolve(typeof calledNumber === 'string' ? calledNumber : null);
    if (!park) return res.status(404).json({ error: 'unknown park' });
    const rec = await deps.ledger.finalizeCall(callSid, park, { duration_seconds: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null });
    return res.json({ recorded: !!rec, billable: rec ? !!rec.billable : false });
  };
}

module.exports = { parseDialpadPayload, formatResponse, phoneCallback, callEnded };
