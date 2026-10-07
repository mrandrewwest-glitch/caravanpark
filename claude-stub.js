'use strict';

// Offline, rule-based stand-in for the Claude client. It exists so the test
// suite and local dev work without an API key. It is NOT Claude: logs produced
// with it say `claude_mode: stub`. Set ANTHROPIC_API_KEY to use the live client.

const D = require('./dates');

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS[s]);
const NUM = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)';
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const SEP = '\\s*(?:-|–|—|to|until|till)\\s*';

const monthIndex = (s) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3));

function resolve(today, month, day) {
  const year = Number(today.slice(0, 4));
  let iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!D.isValidISO(iso)) return null;
  if (iso < today) iso = `${year + 1}${iso.slice(4)}`;
  return iso;
}

function parseDates(text, today) {
  let m = text.match(new RegExp(`${MON}\\.?\\s+${DAY}${SEP}(?:${MON}\\.?\\s+)?${DAY}`));
  if (m) {
    const inn = resolve(today, monthIndex(m[1]), +m[2]);
    const out = resolve(today, monthIndex(m[3] || m[1]), +m[4]);
    return { check_in: inn, check_out: out, explicit: true };
  }
  m = text.match(new RegExp(`${DAY}${SEP}${DAY}\\s+(?:of\\s+)?${MON}`));
  if (m) {
    return { check_in: resolve(today, monthIndex(m[3]), +m[1]), check_out: resolve(today, monthIndex(m[3]), +m[2]), explicit: true };
  }
  m = text.match(new RegExp(`${MON}\\.?\\s+${DAY}`)) || null;
  if (m) return { check_in: resolve(today, monthIndex(m[1]), +m[2]), check_out: null, explicit: true };
  m = text.match(new RegExp(`${DAY}\\s+(?:of\\s+)?${MON}`));
  if (m) return { check_in: resolve(today, monthIndex(m[2]), +m[1]), check_out: null, explicit: true };

  // Weekend = Friday check-in, two nights. "This weekend" is the coming Friday
  // (or today if it is already Fri/Sat/Sun); "next weekend" is the one after.
  if (/\bnext weekend\b|\bthis weekend\b|\bthe weekend\b|\bweekend\b/.test(text)) {
    const dow = D.weekday(today);
    const daysToFri = dow === 5 || dow === 6 || dow === 0 ? 0 : 5 - dow;
    const first = D.addDays(today, daysToFri);
    const start = /next weekend/.test(text) ? D.addDays(first, 7) : first;
    return { check_in: start, check_out: D.addDays(start, 2), explicit: false };
  }
  if (/\bnext week\b/.test(text)) {
    const dow = D.weekday(today);
    const monday = D.addDays(today, ((8 - dow) % 7) || 7);
    return { check_in: monday, check_out: null, explicit: false };
  }
  if (/\btomorrow\b/.test(text)) return { check_in: D.addDays(today, 1), check_out: null, explicit: false };
  return { check_in: null, check_out: null, explicit: false };
}

function parseNights(text) {
  let m = text.match(new RegExp(`${NUM}\\s+nights?`));
  if (m) return num(m[1]);
  m = text.match(new RegExp(`(?:for\\s+)?${NUM}\\s+weeks?`));
  if (m) return num(m[1]) * 7;
  if (/\b(a|one) week\b/.test(text)) return 7;
  return null;
}

function parseGuests(text) {
  const adults = text.match(new RegExp(`${NUM}\\s+(?:adults?|people|guests|of us)`));
  const kids = text.match(new RegExp(`${NUM}\\s+(?:kids?|children|little ones)`));
  if (adults) return num(adults[1]) + (kids ? num(kids[1]) : 0);
  if (kids) return 2 + num(kids[1]); // assumption: two adults travelling with the kids
  if (/\bcouple\b/.test(text)) return 2;
  if (/\bjust me\b|\bsolo\b/.test(text)) return 1;
  return null;
}

const YES = /^\s*(yes|yeah|yep|yup|correct|that'?s (right|correct)|right|sure|please do|go ahead|ok|okay|absolutely)\b/i;
const NO = /^\s*(no|nope|nah|not quite|wrong|incorrect)\b/i;

function parseName(text) {
  const m = text.match(/(?:my name is|name'?s|this is|it'?s|it is|i am|i'm|under|call me)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})/i);
  let raw = m ? m[1] : null;
  if (!raw && /^\s*[a-z][a-z'-]+(\s+[a-z][a-z'-]+){0,2}\s*[.!]?\s*$/i.test(text)) raw = text.replace(/[.!]/g, '').trim();
  if (!raw || /^(yes|no|yeah|nope|nah|ok|okay|sure|correct|thanks|hello|hi)$/i.test(raw)) return null;
  return raw.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function parseMobile(text) {
  const m = text.match(/(\+?\d[\d\s-]{7,16}\d)/);
  return m ? m[1].replace(/[\s-]/g, '') : null;
}

function extractIntent({ transcript, today, known = {}, lastQuestion = null }) {
  const t = transcript.toLowerCase();
  const q = (lastQuestion || '').toLowerCase();
  const out = {
    check_in_date: null, check_out_date: null, num_guests: null, vehicle_type: null,
    has_pet: null, special_requests: null, confidence: 0.4, needs_clarification: true,
    intent: 'availability_enquiry', handoff_reason: null,
    chosen_site_id: null, guest_name: null, mobile: null, confirmation: null, wants_human: false,
  };

  if (/warranty|robocall|telemarket|press (1|one)\b|you('ve| have) won|this is not a sales/.test(t)) {
    return { ...out, intent: 'spam', confidence: 0.9, needs_clarification: false, handoff_reason: 'spam' };
  }
  if (/complain|terrible|unacceptable|disgust|furious|angry|rude|fed up|refund/.test(t)) {
    return { ...out, intent: 'complaint', confidence: 0.9, needs_clarification: false, handoff_reason: 'unhappy caller' };
  }
  if (/wheelchair|disabilit|disabled|accessib|medical|oxygen|dialysis|mobility/.test(t)) {
    return { ...out, intent: 'special_needs', confidence: 0.9, needs_clarification: false, handoff_reason: 'special needs', special_requests: transcript.slice(0, 200) };
  }
  if (/long[- ]term|monthly|permanent|group (rate|booking)|corporate|wedding|\bevent\b/.test(t)) {
    return { ...out, intent: 'out_of_scope', confidence: 0.9, needs_clarification: false, handoff_reason: 'out-of-scope enquiry' };
  }
  out.wants_human = /(speak|talk) (to|with) (a |the |an )?(person|human|someone|owner|manager|staff|real)|call me back|ring me back|get (someone|a person)/.test(t);

  const wantsBooking = /\b(book|reserve|lock (it )?in|i'?ll take|we'?ll take)\b/.test(t);
  const d = parseDates(t, today);
  let checkOut = d.check_out;
  const nights = parseNights(t);
  const checkIn = d.check_in || (nights ? known.check_in_date || null : null);
  if (!checkOut && checkIn && nights) checkOut = D.addDays(checkIn, nights);
  const petMatch = /\b(no|without)\s+(pets?|dogs?)\b/.test(t) ? false : /\b(dog|dogs|puppy|cat|pet|pets)\b/.test(t) ? true : null;
  const vehicle = /motorhome|motor home/.test(t) ? 'motorhome' : /campervan|camper van/.test(t) ? 'campervan' : /caravan/.test(t) ? 'caravan' : null;
  const wantsKidStuff = /\b(kid|kids|child|children|family)\b/.test(t);

  out.check_in_date = checkIn;
  out.check_out_date = checkOut;
  out.num_guests = parseGuests(t);
  out.has_pet = petMatch;
  out.vehicle_type = vehicle;
  out.special_requests = wantsKidStuff ? 'family with kids' : null;
  out.intent = wantsBooking ? 'booking' : 'availability_enquiry';
  if (wantsBooking) out.handoff_reason = 'wants to book';
  if (checkIn && checkOut) out.confidence = d.explicit ? 0.95 : 0.9;
  else if (checkIn) out.confidence = d.explicit ? 0.85 : 0.8;
  else out.confidence = wantsBooking ? 0.95 : 0.4;
  out.needs_clarification = wantsBooking ? false : !(checkIn && checkOut) || out.confidence < 0.8;

  // Booking-flow answers, interpreted against the assistant's last question.
  const site = t.match(/\b(?:site|number)\s*(\d{1,3})\b/);
  if (site) out.chosen_site_id = Number(site[1]);
  if (YES.test(transcript)) out.confirmation = 'yes';
  else if (NO.test(transcript)) out.confirmation = 'no';
  if (/what name should|take your name/.test(q)) out.guest_name = parseName(transcript);
  else if (/(?:my name is|under the name)/.test(t)) out.guest_name = parseName(transcript);
  const mobile = parseMobile(transcript);
  if (mobile && /mobile|number/.test(q)) out.mobile = mobile;
  if (/how many (people|guests)|who.?s staying/.test(q) && out.num_guests === null) {
    const n = t.match(new RegExp(`\\b${NUM}\\b`));
    if (n && num(n[1])) out.num_guests = num(n[1]);
  }
  if (/bringing any pets/.test(q) && out.has_pet === null) {
    if (out.confirmation === 'yes') out.has_pet = true;
    else if (out.confirmation === 'no') out.has_pet = false;
  }
  if (/bringing any pets/.test(q) && out.confirmation && !wantsBooking) out.confirmation = null; // yes/no answered the pet question, not a read-back
  if (/how many nights/.test(q) && !checkOut && checkIn === null && known.check_in_date && nights === null) {
    const n = t.match(new RegExp(`\\b${NUM}\\b`));
    if (n && num(n[1])) { out.check_out_date = D.addDays(known.check_in_date, num(n[1])); out.confidence = 0.9; out.needs_clarification = false; }
  }
  return out;
}

const AMENITY_TEXT = { power: 'power', water: 'water', wifi: 'wifi', playground_nearby: 'a playground nearby', bbq: 'a BBQ', ensuite: 'an ensuite', air_con: 'air con' };

function describeSite(site, prefer) {
  const ordered = [...site.amenities].sort((a, b) => (prefer.includes(b) ? 1 : 0) - (prefer.includes(a) ? 1 : 0));
  const words = ordered.slice(0, 3).map((a) => AMENITY_TEXT[a] || a);
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.slice(-1)}` : words[0];
  return `${site.name.split(' - ')[0]} is $${site.price} a night with ${list}`;
}

function generateResponse({ extracted, sites, totalAvailable, bookingEnabled = false }) {
  const top = sites.slice(0, 2);
  const petsOnly = extracted.has_pet === true;
  const kids = /kid|family/.test(extracted.special_requests || '');
  const prefer = kids ? ['playground_nearby'] : [];
  const when = `${D.spoken(extracted.check_in_date)} to ${D.spoken(extracted.check_out_date)}`;
  const count = totalAvailable === 1 ? 'one site' : `${totalAvailable} sites`;
  const closer = bookingEnabled ? 'Which one would you like me to book?' : 'Would one of those suit you?';
  const lead = `Good news, we've got ${count} ${petsOnly ? 'that welcome pets ' : ''}for ${when}.`;
  const body = top.map((s) => describeSite(s, prefer)).join(', and ');
  return `${lead} ${body}. ${closer}`;
}

function createStubClaudeClient() {
  return {
    mode: 'stub',
    async extractIntent(args) { return extractIntent(args); },
    async generateResponse(args) { return generateResponse(args); },
  };
}

module.exports = { createStubClaudeClient };
