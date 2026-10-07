# OnSite — operating modes and SMS payments (draft v0.1)

Status: **requirements only.** This supersedes earlier "payment out of scope" and "always transfer to a human" statements in the other docs. **[ASSUMPTION]** items need confirming; open questions at the end.

## 1. Two operating modes (per park, configurable)

| | **Mode 1: Diversion (overflow / away)** | **Mode 2: Full service** |
|---|---|---|
| When | Owners are busy, sick or on leave and their calls come to OnSite instead of voicemail (set in their phone settings: Do Not Disturb / unavailable / no-answer forwarding) | OnSite answers every call |
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
- **Hold expiry is set per park and adjustable** by the park (default 60 min, allowed range 15 min to 24 h **[ASSUMPTION]**; changes apply to new holds only). On expiry release the hold in NewBook and text "your hold has expired, call us to rebook". A reminder SMS at about half-time.
- **Payment webhook:** verify the provider signature, dedupe on event ID, and process idempotently. On success: confirm the booking, record the payment in NewBook, send the confirmation SMS, store the audit trail.
- **Late payment edge case:** payment arrives after the hold expired and the site is gone → automatic refund and an apology SMS + staff alert; if the site is still free, re-confirm.
- **Failure handling:** payment link SMS fails to send → retry, then take-a-message/alert staff while the hold is still valid. Provider outage → hold stays until expiry; staff alerted.
- **Wrong-number risk:** the link goes to the number the caller confirms; if it differs from caller ID, read it back digit by digit.
- **Refunds, cancellations, changes:** handled by staff in this phase (AI takes a message), via the payment provider dashboard and NewBook.

## 3. Pricing and billing (decided: no commission)

- **Price:** fixed monthly fee (**$100/month**) plus **$3 per answered call**. **[ASSUMPTION]** amounts are AUD, per park, and the park's GST treatment is decided with an accountant.
- **What is an "answered call"?** Must be defined in the park agreement and enforced from the usage ledger. **[ASSUMPTION]** billable = OnSite answered and the caller was on the line for at least N seconds (e.g. 15) with at least one real exchange. Not billable: spam/robocalls, hang-ups before any exchange, test calls, calls that failed immediately to the system fallback. SMS conversations are not billed per message in this phase **[ASSUMPTION: confirm, SMS has real costs]**.
- **Usage ledger (mandatory):** per park and call: timestamps, duration, outcome (answered/spam/abandoned/failed), billable flag, handoff type, bookings created and paid, SMS segments sent, and the cost of voice minutes and Claude calls. Billing, monthly statements and the pilot's break-even analysis all read from it.
- **Billing:** monthly invoice generated from the ledger ($100 + $3 x billable calls), with a statement listing each billable call so parks can audit it; billed through an invoicing tool of your choice, not by OnSite itself. Consider a free pilot period and a cap or included-calls allowance if parks fear surprise bills.
- **Payments for bookings go straight to each park's own payment account**, with no platform fee, so OnSite never holds or splits funds. Each park supplies its own payment provider credentials (restricted keys, stored per park in Secrets Manager). We still need NewBook to record the payment against the booking (Q3).
- **Unit economics check (not yet measured):** $3 per call only works if the cost of voice minutes, speech services, Claude and SMS stays well under $3 for an average call. Measure this during the pilot from the ledger before fixing prices for other parks.

## 4. Impact on the existing build

- **Handoff logic** (`conversation-logic.js`): replace the single `transfer_to_human` with `handoff: {strategy: live_transfer|take_message, reason, summary}`; keep `transfer_to_human` in the Dialpad response only for `live_transfer`. New message-taking sub-flow and staff alert.
- **Config per park:** mode, diversion trigger, hold minutes (park-adjustable within bounds), deposit rule, limits, staff contacts, opening line, payment credentials, billing details.
- **New components:** booking state machine (see `BOOKING-REQUIREMENTS.md`), SMS provider interface (see `SMS-REQUIREMENTS.md`), payment provider interface (`createPaymentLink`, `verifyWebhook`, `refund`) with a mock for tests, expiry job (scheduled Lambda/EventBridge), DynamoDB persistence (now mandatory).
- **Multi-park:** this is now a multi-tenant product, so call/SMS routing keys on the dialled number to find the park config and credentials (per-park NewBook and payment accounts, stored in Secrets Manager); parks adjust their own settings (hold time, hours, mode) through an admin page or config process **[ASSUMPTION: simple admin page later; config file at first]**. The current code assumes a single park.

## 5. Biggest technical risk: the voice channel

The brief assumes Dialpad sends transcripts to our webhook and reads our reply aloud. To my knowledge Dialpad's webhooks are event notifications, and I have **not verified** that Dialpad offers a turn-by-turn voice-agent integration with text-to-speech from our reply. If it doesn't, the realistic route is a voice-capable telephony provider (a number that does speech-to-text and text-to-speech and calls our webhook each turn), with the park's Dialpad forwarding calls to that number. Diversion mode (Mode 1) fits that well: the park simply forwards calls to the OnSite number. **This must be verified before further voice work; it determines the provider and the 3-second budget.**

## 6. Phasing

1. Verify the voice channel and SMS/payment provider choices (spikes, no product code).
2. Mock-first build: handoff strategies + take-message, booking state machine on mock NewBook, mock SMS and mock payments, expiry job, DynamoDB store, full scenario tests.
3. Real integrations in a sandbox: NewBook (booking + payment posting), payment provider (test mode), SMS.
4. Pilot with the friend's park in Mode 1 (diversion), staff reviewing every AI booking; then Mode 2.
5. Usage ledger reports, monthly statements and invoicing; set final pricing from pilot costs.

## 7. Open questions

1. Deposit or full payment at booking, per park?
2. Pricing details: GST inclusive or exclusive, billable-call definition (min seconds), SMS costs included or passed on, free pilot period?
3. Does NewBook's API let us post an external payment against a booking, or must payment run through the park's NewBook gateway?
4. **Diversion mechanics, to verify:** can Dialpad's Do Not Disturb / unavailable setting forward to an external number instead of voicemail? Dialpad routing options (forward when unanswered, business-hours rules) may do this, and so may carrier forwarding on a mobile, but I have not confirmed how DND behaves. Test this on the friend's account.
5. In take-message mode, how should staff be alerted (SMS to the owner, email, both) and how fast do they promise a callback?
6. Pilot park: which mode first? (I'd suggest Mode 1.)
