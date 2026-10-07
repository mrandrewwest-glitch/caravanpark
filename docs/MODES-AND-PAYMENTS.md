# OnSite — operating modes and SMS payments (draft v0.1)

Status: **requirements only.** This supersedes earlier "payment out of scope" and "always transfer to a human" statements in the other docs. **[ASSUMPTION]** items need confirming; open questions at the end.

## 1. Two operating modes (per park, configurable)

| | **Mode 1: Diversion (overflow / away)** | **Mode 2: Full service** |
|---|---|---|
| When | Owners are busy, sick or on leave and divert their phone to OnSite (always, after-hours, or ring-no-answer) | OnSite answers every call |
| AI does | Availability, questions, bookings, payment link, summaries | Same |
| "Escalate" means | **Nobody is free to take the call**, so: take a message / callback request, notify staff, SMS the caller | **Live transfer** to staff; if no answer, fall back to take-a-message |
| Opening line | "Thanks for calling X. The team's tied up right now, I'm their AI assistant and I can help with availability and bookings." | "Thanks for calling X, you've reached the AI assistant..." |

So the handoff step becomes a strategy chosen by mode and staff availability: `live_transfer` or `take_message`. The brief's "transfer to human" is only valid when a human can answer. `take_message` captures name, callback number (default caller ID), reason and urgency, texts the caller "we'll call you back", and alerts staff (SMS/email) with a "calls to return" list.

Both modes: the AI says it is an AI; announce that the call may be transcribed/recorded (Australian recording/privacy rules; confirm wording with the park's advisor).

## 2. End-to-end flow with payment

```
Call → AI answers questions + availability → caller picks a site → details collected →
read-back + explicit yes → booking created as PROVISIONAL (hold, with expiry) in NewBook →
SMS: secure payment link (amount from NewBook) → caller pays on their phone →
payment webhook verified → booking CONFIRMED in NewBook + payment recorded →
SMS: confirmation (booking ref, dates, site, how to find the park)
```

States: `held → payment_pending → paid → confirmed`, or `held → expired → released`. Caller is told at the end of the call exactly what happens: "I've held Site 12 for the next 60 minutes, and I'm texting you a link to pay."

### Requirements
- **Hosted payment page only** (e.g. Stripe Checkout / Payment Links). Card details never touch OnSite, Dialpad, Claude or our logs, which keeps us out of the heavy PCI scope. Card-digit redaction remains as a safety net if a caller reads out a card number (and the AI says "please don't read it out, I'll text a secure link").
- **Amount is set server-side from NewBook**, never by the LLM or caller. Deposit vs full amount follows the park's policy **[ASSUMPTION: configurable per park]**.
- **Hold expiry** (default 60 min **[ASSUMPTION]**): on expiry release the hold in NewBook and text "your hold has expired, call us to rebook". A reminder SMS at about half-time.
- **Payment webhook:** verify the provider signature, dedupe on event ID, and process idempotently. On success: confirm the booking, record the payment in NewBook, send the confirmation SMS, store the audit trail.
- **Late payment edge case:** payment arrives after the hold expired and the site is gone → automatic refund and an apology SMS + staff alert; if the site is still free, re-confirm.
- **Failure handling:** payment link SMS fails to send → retry, then take-a-message/alert staff while the hold is still valid. Provider outage → hold stays until expiry; staff alerted.
- **Wrong-number risk:** the link goes to the number the caller confirms; if it differs from caller ID, read it back digit by digit.
- **Refunds, cancellations, changes:** handled by staff in this phase (AI takes a message), via the payment provider dashboard and NewBook.

## 3. Commission model (needs a business and legal decision)

Taking a cut of booking value means money flows through your platform's rules, not just the park's:

- **Technical shape (recommended to investigate):** a payments platform with connected accounts (e.g. Stripe Connect) where each park is the merchant of record, the customer pays the park, and OnSite's commission is taken automatically as a platform fee per booking. That avoids OnSite holding funds. Alternatives: invoice parks monthly for commission from booking reports (simpler, no payments platform, but no automatic collection and parks may underreport; you'd compute from AI-created bookings in your own audit log).
- **Reconciliation with NewBook:** payments taken outside NewBook's own gateway must be recorded back into NewBook so the park's books and reports match. Need to confirm NewBook's API supports posting payments, or whether the park's own NewBook-connected gateway must be used (which may make automatic commission harder).
- **Who pays:** commission deducted from the park's payout, versus a booking fee added for the customer (the latter needs clear disclosure; consumer-law surcharge rules apply).
- **Tax/legal/contracts (get advice; I can't give it):** GST on the commission, a services agreement with each park (liability for AI mistakes, commission terms, cancellations/refunds responsibility, data processing), provider terms for platform payments in Australia, and whether your setup counts as a regulated payment service.
- **Reporting:** each park gets a monthly statement (bookings made by OnSite, value, commission, refunds). Dispute handling: what happens to commission on cancelled/refunded bookings.

## 4. Impact on the existing build

- **Handoff logic** (`conversation-logic.js`): replace the single `transfer_to_human` with `handoff: {strategy: live_transfer|take_message, reason, summary}`; keep `transfer_to_human` in the Dialpad response only for `live_transfer`. New message-taking sub-flow and staff alert.
- **Config per park:** mode, diversion trigger, hold minutes, deposit rule, limits, commission %, staff contacts, opening line.
- **New components:** booking state machine (see `BOOKING-REQUIREMENTS.md`), SMS provider interface (see `SMS-REQUIREMENTS.md`), payment provider interface (`createPaymentLink`, `verifyWebhook`, `refund`) with a mock for tests, expiry job (scheduled Lambda/EventBridge), DynamoDB persistence (now mandatory).
- **Multi-park:** this is now a multi-tenant product, so call/SMS routing keys on the dialled number to find the park config and credentials (per-park NewBook and payment accounts, stored in Secrets Manager). The current code assumes a single park.

## 5. Biggest technical risk: the voice channel

The brief assumes Dialpad sends transcripts to our webhook and reads our reply aloud. To my knowledge Dialpad's webhooks are event notifications, and I have **not verified** that Dialpad offers a turn-by-turn voice-agent integration with text-to-speech from our reply. If it doesn't, the realistic route is a voice-capable telephony provider (a number that does speech-to-text and text-to-speech and calls our webhook each turn), with the park's Dialpad forwarding calls to that number. Diversion mode (Mode 1) fits that well: the park simply forwards calls to the OnSite number. **This must be verified before further voice work; it determines the provider and the 3-second budget.**

## 6. Phasing

1. Verify the voice channel and SMS/payment provider choices (spikes, no product code).
2. Mock-first build: handoff strategies + take-message, booking state machine on mock NewBook, mock SMS and mock payments, expiry job, DynamoDB store, full scenario tests.
3. Real integrations in a sandbox: NewBook (booking + payment posting), payment provider (test mode), SMS.
4. Pilot with the friend's park in Mode 1 (diversion), staff reviewing every AI booking; then Mode 2.
5. Commission billing and monthly statements.

## 7. Open questions

1. Hold/expiry length, and deposit or full payment at booking?
2. Commission: percentage, and charged to the park (platform fee) or added for the customer? Have you spoken to an accountant/solicitor yet?
3. Does NewBook's API let us post an external payment against a booking, or must payment run through the park's NewBook gateway?
4. How do owners divert calls: Dialpad forwarding rules? Does the park have other numbers (mobile) that forward?
5. In take-message mode, how should staff be alerted (SMS to the owner, email, both) and how fast do they promise a callback?
6. Pilot park: which mode first? (I'd suggest Mode 1.)
