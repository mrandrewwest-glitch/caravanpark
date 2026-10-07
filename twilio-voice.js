'use strict';

// Phone calls through Twilio ConversationRelay.
//
//   caller -> Twilio number -> POST /twilio/voice  (we answer with TwiML: "connect this call to our WebSocket")
//          -> WebSocket /twilio/relay   Twilio turns speech into text and sends it; we reply with text, Twilio speaks it
//          -> POST /twilio/relay-ended  the session finished: hang up, or hand the call to staff (<Dial>)
//          -> POST /twilio/dial-ended   staff did not answer: take a message so the lead is not lost
//          -> POST /twilio/status       the call is over: real duration goes to the billing ledger
//
// The conversation itself is the same processCall() the rest of the system uses; this file only moves text.
const express = require('express');
const { WebSocketServer } = require('ws');
const { processCall } = require('./conversation-logic');
const { twiml, validSignature } = require('./twilio');
const { MSG } = require('./messages');
const { alertStaff } = require('./comms');
const repos = require('./repos');

const MAX_UTTERANCE = 1000;
const E164 = /^\+[1-9]\d{7,14}$/;
const isE164 = (n) => typeof n === 'string' && E164.test(n);
const str = (v, max = 64) => (typeof v === 'string' ? v.slice(0, max) : '');

const greeting = (park) => (park.mode === 'diversion'
  ? `Hi, thanks for calling ${park.name}. The team is busy right now, but I'm their automated assistant and I can help. What can I do for you?`
  : `Hi, you've reached ${park.name}. I'm the automated assistant. How can I help?`);

// ---- Signature checking ----
async function checkSignature(tw, { path, params, signature }) {
  let creds;
  try { creds = await tw.getCredentials(); } catch { return { ok: false, error: 'not configured' }; }
  const base = tw.publicBaseUrl + path;
  const urls = [base, base.endsWith('/') ? base.slice(0, -1) : `${base}/`];
  if (/^wss:/.test(base)) urls.push(...urls.map((u) => u.replace(/^wss:/, 'https:')));
  return { ok: validSignature({ urls, params, signature, authToken: creds.auth_token }) };
}

function twilioRouter(deps, tw) {
  const router = express.Router();
  const { registry, logger, store } = deps;
  router.use(express.urlencoded({ extended: false, limit: '20kb' }));

  // Nothing below runs unless the request really came from Twilio.
  router.use(async (req, res, next) => {
    const check = await checkSignature(tw, { path: req.originalUrl, params: req.body || {}, signature: req.get('x-twilio-signature') });
    if (!check.ok) { logger.warn('twilio_bad_signature', { path: req.path, reason: check.error || 'mismatch' }); return res.status(403).type('text/plain').send('Forbidden'); }
    return next();
  });
  const xml = (res, inner) => res.type('text/xml').send(twiml.response(inner));
  const guard = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      logger.error('twilio_webhook_error', { path: req.path, error: err.message });
      xml(res, `${twiml.say("Sorry, we're having a technical problem. Please try again shortly.")}${twiml.hangup()}`);
    }
  };

  router.post('/voice', guard(async (req, res) => {
    const to = str(req.body.To, 32); const callSid = str(req.body.CallSid);
    const park = to ? await registry.resolve(to) : null;
    if (!park || !callSid) {
      logger.error('twilio_unknown_number', { to });
      return xml(res, `${twiml.say("Sorry, this number isn't set up yet. Goodbye.")}${twiml.hangup()}`);
    }
    await repos.saveTwilioCall(store, callSid, { park_id: park.id, called: to, from: str(req.body.From, 32), started_ms: deps.now() });
    const wsUrl = `${tw.publicBaseUrl.replace(/^http/, 'ws')}/twilio/relay`;
    return xml(res, twiml.relay({
      url: wsUrl, action: `${tw.publicBaseUrl}/twilio/relay-ended`, greeting: greeting(park), language: tw.language,
      ttsProvider: tw.ttsProvider, voice: tw.voice, transcriptionProvider: tw.transcriptionProvider,
      hints: `${park.name},caravan,powered site,unpowered site,cabin,pet friendly,check in,check out`,
    }));
  }));

  // The session ended. If we asked for a handover, connect the caller to the park's transfer line.
  router.post('/relay-ended', guard(async (req, res) => {
    const callSid = str(req.body.CallSid);
    const rec = callSid ? await repos.getTwilioCall(store, callSid) : null;
    const park = rec ? await registry.get(rec.park_id) : null;
    const number = park && park.staff && park.staff.transfer_number;
    if (rec && rec.transfer && park && isE164(number)) {
      return xml(res, twiml.dial({ number, callerId: rec.called, action: `${tw.publicBaseUrl}/twilio/dial-ended` }));
    }
    return xml(res, twiml.hangup());
  }));

  // Staff did not pick up: the caller was promised a person, so record a call-back instead of dropping them.
  router.post('/dial-ended', guard(async (req, res) => {
    const callSid = str(req.body.CallSid);
    const status = str(req.body.DialCallStatus, 24);
    if (['completed', 'answered'].includes(status)) return xml(res, twiml.hangup());
    const rec = callSid ? await repos.getTwilioCall(store, callSid) : null;
    const park = rec ? await registry.get(rec.park_id) : null;
    if (park) {
      const from = rec.from || null;
      await repos.saveMessage(store, { id: `${park.id}:${callSid}`, park_id: park.id, call_sid: callSid, name: null, callback_number: from, caller_phone: from, reason: 'transfer to staff was not answered', notes: [], status: 'open', created_ms: deps.now(), summary: `Staff did not answer the transfer (${status || 'no answer'}); please call the caller back.` });
      await alertStaff(deps, park, { kind: 'callback_requested', summary: `Transfer not answered (${status || 'no answer'}); call back ${from || 'unknown number'}.` });
    }
    return xml(res, `${twiml.say("Sorry, the team couldn't get to the phone. I've noted your number and they'll call you back as soon as they can. Goodbye.")}${twiml.hangup()}`);
  }));

  // The call is over: the true duration (what Twilio bills and what we bill) goes to the ledger.
  router.post('/status', guard(async (req, res) => {
    const callSid = str(req.body.CallSid);
    const status = str(req.body.CallStatus, 24);
    if (callSid && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)) {
      const rec = await repos.getTwilioCall(store, callSid);
      const to = str(req.body.To, 32);
      const park = rec ? await registry.get(rec.park_id) : (to ? await registry.resolve(to) : null);
      if (park) {
        const secs = Number(req.body.CallDuration);
        await deps.ledger.finalizeCall(callSid, park, { duration_seconds: Number.isFinite(secs) && secs >= 0 ? Math.round(secs) : null });
      }
    }
    res.status(204).end();
  }));

  return router;
}

// ---- The live conversation ----
// One session per call. Transport-agnostic (send/close are passed in) so it can be tested without sockets.
function createRelaySession({ deps, tw, send, close }) {
  const { logger } = deps;
  const s = { callSid: null, from: null, to: null, turns: 0, queue: Promise.resolve(), endTimer: null, capTimer: null, closed: false };

  const say = (text, last = true) => send({ type: 'text', token: text, last });
  const endSession = (reason) => { s.endTimer = null; if (!s.closed) send({ type: 'end', handoffData: JSON.stringify({ reason }) }); };
  const endAfterSpeech = (text, reason) => { clearTimeout(s.endTimer); s.endTimer = setTimeout(() => endSession(reason), tw.endDelayMs(text)); };

  async function turn(text) {
    if (s.turns >= tw.maxTurns) { say(MSG.fallbackMessage); endAfterSpeech(MSG.fallbackMessage, 'end'); return; }
    s.turns += 1;
    clearTimeout(s.endTimer); // the caller spoke again, so the call is not over
    let result;
    try {
      result = await processCall({ call_sid: s.callSid, transcript: text.slice(0, MAX_UTTERANCE), caller_phone: s.from || null, called_number: s.to || null, confidence: null }, deps);
    } catch (err) {
      logger.error('twilio_turn_failed', { call_sid: s.callSid, error: err.message });
      say(MSG.fallbackMessage); endAfterSpeech(MSG.fallbackMessage, 'end'); return;
    }
    say(result.response_text);
    if (result.transfer_to_human) {
      const park = await deps.registry.resolve(s.to);
      if (park && isE164(park.staff && park.staff.transfer_number)) {
        const rec = (await repos.getTwilioCall(deps.store, s.callSid)) || { park_id: park.id, called: s.to, from: s.from, started_ms: deps.now() };
        await repos.saveTwilioCall(deps.store, s.callSid, { ...rec, transfer: true });
        endAfterSpeech(result.response_text, 'transfer');
      } else {
        // Full-service park without a transfer line configured: do not strand the caller, tell them and record a call-back.
        logger.error('twilio_no_transfer_number', { call_sid: s.callSid, park_id: park && park.id });
        const note = "Sorry, nobody is free to take your call right now. I've noted your number and the team will call you back.";
        say(note);
        if (park) {
          await repos.saveMessage(deps.store, { id: `${park.id}:${s.callSid}`, park_id: park.id, call_sid: s.callSid, name: null, callback_number: s.from, caller_phone: s.from, reason: 'transfer wanted but no transfer line is configured', notes: [], status: 'open', created_ms: deps.now(), summary: 'The caller needed a person but no transfer number is set up; please call them back.' });
          await alertStaff(deps, park, { kind: 'callback_requested', summary: `Transfer wanted but no transfer line configured; call back ${s.from || 'unknown number'}.` });
        }
        endAfterSpeech(note, 'end');
      }
    } else if (result.end_call || (result.metadata && result.metadata.status === 'message_taken')) {
      // Spam, or a message has been taken: nothing more to ask, so let the closing line play and hang up.
      endAfterSpeech(result.response_text, 'end');
    }
  }

  return {
    get state() { return s; },
    onMessage(raw) {
      let m;
      try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { logger.warn('twilio_relay_bad_json', {}); return; }
      if (!m || typeof m !== 'object') return;
      switch (m.type) {
        case 'setup': {
          if (s.callSid) return; // a session is set up once
          s.callSid = str(m.callSid); s.from = str(m.from, 32); s.to = str(m.to, 32);
          if (!s.callSid) { logger.warn('twilio_relay_setup_without_call', {}); close(); return; }
          s.capTimer = setTimeout(() => { logger.warn('twilio_call_too_long', { call_sid: s.callSid }); endSession('end'); }, tw.maxCallMs);
          // Normally /twilio/voice has already recorded the call; make sure it exists so the call-end callback can find it.
          deps.registry.resolve(s.to || null).then(async (park) => {
            if (park && s.to && !(await repos.getTwilioCall(deps.store, s.callSid))) await repos.saveTwilioCall(deps.store, s.callSid, { park_id: park.id, called: s.to, from: s.from, started_ms: deps.now() });
          }).catch((err) => logger.error('twilio_session_record_failed', { error: err.message }));
          logger.info('twilio_session_started', { call_sid: s.callSid });
          break;
        }
        case 'prompt': {
          if (!s.callSid || m.last === false || typeof m.voicePrompt !== 'string') return;
          const text = m.voicePrompt.trim();
          if (!text) return;
          // One turn at a time, in order: a second utterance must not run against half-updated call state.
          s.queue = s.queue.then(() => turn(text)).catch((err) => logger.error('twilio_queue_error', { error: err.message }));
          break;
        }
        case 'interrupt': logger.info('twilio_interrupted', { call_sid: s.callSid }); break;
        case 'error': logger.warn('twilio_relay_error', { call_sid: s.callSid, description: str(m.description, 200) }); break;
        default: break; // dtmf and anything new: ignored
      }
    },
    onClose() { s.closed = true; clearTimeout(s.endTimer); clearTimeout(s.capTimer); },
  };
}

// Accepts WebSocket upgrades for /twilio/relay on an http.Server, only when the handshake is signed by Twilio.
function attachRelay(server, deps, tw) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const reject = (socket, code, text) => { try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ } socket.destroy(); };
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/twilio/relay') return reject(socket, 404, 'Not Found');
      const wsBase = tw.publicBaseUrl.replace(/^http/, 'ws');
      const check = await checkSignature({ ...tw, publicBaseUrl: wsBase }, { path: url.pathname + url.search, params: {}, signature: req.headers['x-twilio-signature'] });
      if (!check.ok) { deps.logger.warn('twilio_ws_bad_signature', {}); return reject(socket, 403, 'Forbidden'); }
      return wss.handleUpgrade(req, socket, head, (ws) => {
        const session = createRelaySession({ deps, tw, send: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }, close: () => ws.close() });
        ws.on('message', (data) => session.onMessage(data));
        ws.on('close', () => session.onClose());
        ws.on('error', () => session.onClose());
      });
    } catch (err) { deps.logger.error('twilio_upgrade_failed', { error: err.message }); return reject(socket, 500, 'Error'); }
  });
  return wss; // wss.clients: live calls; terminate them on shutdown, an http server will not close while they are open
}

module.exports = { twilioRouter, attachRelay, createRelaySession, greeting, isE164 };
