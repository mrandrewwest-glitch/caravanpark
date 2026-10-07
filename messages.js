'use strict';

const D = require('./dates');
const { money, spokenDuration } = require('./util');

// Spoken wording. LIVE = park staff can take the call (mode "full"); LEAD = nobody is free
// (mode "diversion"), so we take a message instead of transferring.
const MSG = {
  fallback: 'Our system is busy, let me transfer you to our team.',
  fallbackMessage: "Sorry, we're having a technical problem. I've noted your number and the team will call you back as soon as they can.",
  cantUnderstand: "I'm having trouble getting that, so let me put you through to our team.",
  spam: 'Thanks for calling, have a great day.',
  askWhen: 'When are you thinking of coming?',
  askNights: 'How many nights are you looking to stay?',
  didntCatch: "Sorry, I didn't quite catch that. Could you say that again?",
  cardWarning: "Please don't read out any card details. I'll text you a secure payment link instead. Where were we?",
  askGuests: 'How many people will be staying?',
  askPets: 'Will you be bringing any pets?',
  askName: 'What name should the booking be under?',
  askMobile: 'What mobile number should I send the payment link to?',
  askChange: 'No problem. What would you like to change?',
  readbackAgain: 'Sorry, shall I go ahead and hold that booking? Just say yes or no.',
  postBooking: "You're all set. The payment link is on its way to your phone, and your booking is confirmed as soon as it's paid. Is there anything else I can help with?",
  postMessage: "I've passed your message on and the team will be in touch. Thanks for calling!",
  smsFailed: "I've held the site for you, but I couldn't send the text. I'll ask the team to send you the payment link.",
  paymentSetupFailed: "Sorry, I hit a problem setting up the payment, so I haven't held anything.",
};

const LIVE = {
  booking: 'Perfect, let me connect you with our team to confirm that.',
  complaint: "I'm sorry to hear that. Let me get one of our team to help you right away.",
  out_of_scope: "That's one for our team to help with, so let me connect you now.",
  special_needs: 'Let me put you through to our team so they can look after that properly.',
  extended_stay: "For a longer stay it's best to speak with our team, so let me connect you.",
  no_availability: "I'm sorry, I can't find anything available that suits those details. Let me connect you with our team to see what we can do.",
  newbook_down: "We can't check availability right now, let me get someone for you.",
  cant_understand: MSG.cantUnderstand,
  wants_human: 'Of course, let me put you through to our team.',
  booking_limit: "For that booking it's best to speak with our team, so let me connect you.",
  booking_error: "I'm having trouble with the booking system, so let me put you through to our team to finish this off.",
  generic: 'Let me put you through to our team.',
};

const LEAD = {
  booking: "I'd like to get that booked for you, but the team is tied up right now.",
  complaint: "I'm sorry to hear that. The team is tied up right now, but I'll make sure they call you back.",
  out_of_scope: "That's one for the team, and they're tied up right now, but I'll make sure they call you back.",
  special_needs: "The team will want to look after that personally, and they're tied up right now, so I'll make sure they call you back.",
  extended_stay: "For a longer stay the team will want to talk to you, and they're tied up right now, so I'll make sure they call you back.",
  no_availability: "I can't find anything that suits those details, but the team may be able to help. They're tied up right now, so I'll make sure they call you back.",
  newbook_down: "I can't check availability right now, so I'll get the team to call you back.",
  cant_understand: "I'm having trouble getting that, so I'll get the team to call you back.",
  wants_human: "The team is tied up right now, but I'll make sure they call you back.",
  booking_limit: "The team will want to handle that booking personally, and they're tied up right now, so I'll make sure they call you back.",
  booking_error: "I'm having trouble with the booking system, so I'll get the team to call you back and finish this off.",
  generic: "The team is tied up right now, but I'll make sure they call you back.",
};

const range = (a, b) => `${D.spoken(a)} to ${D.spoken(b)}`;
const short = (name) => name.split(' - ')[0];

const SMS = {
  paymentLink: ({ park, booking, amountCents, url, holdMinutes }) =>
    `${park.name}: we're holding ${short(booking.site_name)}, ${range(booking.check_in, booking.check_out)} for ${spokenDuration(holdMinutes)}. Pay ${money(amountCents / 100)} securely to confirm your booking: ${url}`,
  reminder: ({ park, booking, url, minutesLeft }) =>
    `${park.name}: reminder, your hold on ${short(booking.site_name)} (${range(booking.check_in, booking.check_out)}) ends in about ${minutesLeft} minutes. Pay to keep it: ${url}`,
  confirmation: ({ park, booking, paidCents }) =>
    `${park.name}: you're booked! Ref ${booking.booking_id}, ${short(booking.site_name)}, ${range(booking.check_in, booking.check_out)}${booking.guest && booking.guest.num_guests ? `, ${booking.guest.num_guests} guests` : ''}. Paid ${money(paidCents / 100)}. We look forward to seeing you.`,
  expired: ({ park, booking }) =>
    `${park.name}: your hold on ${short(booking.site_name)} (${range(booking.check_in, booking.check_out)}) has expired and the site has been released. Call us if you'd still like to book.`,
  refunded: ({ park, booking }) =>
    `${park.name}: sorry, your payment arrived after the hold on ${short(booking.site_name)} expired and the site is no longer free, so we've refunded you in full. Please call us and we'll help find another option.`,
  messageTaken: ({ park, name }) => `Hi ${name}, ${park.name} has your message and the team will call you back ${park.staff.callback_promise}.`,
};

module.exports = { MSG, LIVE, LEAD, SMS, range, short };
